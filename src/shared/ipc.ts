// IPC contract between the main process and the renderers.
// Preload scripts expose BonziAgentApi (agent window) and BonziSettingsApi
// (settings window) through contextBridge. Renderers never see the API key
// and never talk to the network; every AI call goes through the main process.

import type { PublicSettings, SettingsPatch } from './settings.ts';

export const IPC = {
  // Character
  characterLoad: 'character:load',

  // Chat (conversation history lives in the main process)
  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatReset: 'chat:reset',
  /** main -> agent renderer, payload ChatEvent */
  chatEvent: 'chat:event',

  // Voice
  ttsSynthesize: 'tts:synthesize',
  sttTranscribe: 'stt:transcribe',

  // Agent window
  winSetIgnoreMouse: 'win:set-ignore-mouse',
  /** main -> agent renderer, payload PointerSample: where the cursor is over the window. */
  winPointer: 'win:pointer',
  winDragStart: 'win:drag-start',
  winDragEnd: 'win:drag-end',
  winContextMenu: 'win:context-menu',
  winFocus: 'win:focus',
  /** agent renderer: give the keyboard back to the window under Bonzi */
  winReleaseFocus: 'win:release-focus',
  /** renderer finished its Hide animation; main may now hide the window */
  winHidden: 'win:hidden',
  /** renderer is loaded (invoke); main answers with AgentReadyResult */
  winReady: 'win:ready',

  // App
  /** main -> agent renderer, payload AppCommand */
  appCommand: 'app:command',
  appOpenSettings: 'app:open-settings',
  appQuit: 'app:quit',
  appInfo: 'app:info',
  appOpenExternal: 'app:open-external',
  /** agent renderer (invoke), payload threshold seconds: the OS idle state (SystemIdleState) */
  appIdleState: 'app:idle-state',

  // Settings
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsSetApiKey: 'settings:set-api-key',
  settingsTest: 'settings:test',
  settingsListModels: 'settings:list-models',
  settingsChooseCharacter: 'settings:choose-character',
  settingsResetCharacter: 'settings:reset-character',
  settingsClearHistory: 'settings:clear-history',
  /** Lists the Windows (SAPI) voices installed on this PC. */
  settingsListSystemVoices: 'settings:list-system-voices',
  /** main -> all renderers, payload PublicSettings */
  settingsChanged: 'settings:changed',
  /** settings -> main, payload boolean: the shortcut box is recording, so the global hotkey is suspended */
  settingsHotkeyCapture: 'settings:hotkey-capture',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// ---------------------------------------------------------------------------
// Errors

export type AiErrorKind =
  | 'no-key' // no API key configured
  | 'auth' // 401/403, invalid key
  | 'quota' // insufficient_quota / billing
  | 'rate-limit' // 429 rate limited (retryAfterSec may be set)
  | 'model' // model not found or not allowed for this key
  | 'bad-request' // other 400s (e.g. input too long)
  | 'network' // DNS, TLS, connection refused, offline
  | 'timeout'
  | 'server' // 5xx
  | 'cancelled'
  | 'unknown';

export interface AiError {
  kind: AiErrorKind;
  /** Short, user-presentable message (Bonzi may say a friendlier version). */
  message: string;
  status?: number;
  retryAfterSec?: number;
  /** x-request-id from the provider, useful for support. */
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Character

export interface CharacterPayload {
  /** Raw .acs file bytes; parsed in the renderer with src/shared/acs. */
  bytes: ArrayBuffer;
  fileName: string;
  isBundled: boolean;
}

// ---------------------------------------------------------------------------
// Chat

export type ChatSource = 'typed' | 'voice' | 'quick-action' | 'idle-chatter' | 'greeting';

export interface ChatSendRequest {
  text: string;
  source: ChatSource;
}

export type ChatSendResult = { ok: true; requestId: string } | { ok: false; error: AiError };

export type ChatEvent =
  | { type: 'start'; requestId: string }
  /** Raw model text delta, may contain [[Animation]] tags split across deltas. */
  | { type: 'delta'; requestId: string; text: string }
  | { type: 'done'; requestId: string; text: string; finishReason: string | null }
  | { type: 'error'; requestId: string; error: AiError };

// ---------------------------------------------------------------------------
// Voice

/**
 * Speech engines: 'openai' is OpenAI TTS (needs a key), 'system' is a Windows
 * SAPI voice rendered to WAV in the main process (offline, always available on
 * Windows).
 */
export type TtsEngine = 'openai' | 'system';

export interface TtsRequest {
  /** Plain text with tags and markdown already stripped. */
  text: string;
  /** Which engine renders the audio. Default 'openai'. */
  engine?: TtsEngine;
  /**
   * Optional overrides used by the settings window "Test voice" button.
   * With engine 'system', voice is a Windows voice name (else settings.systemVoiceName).
   */
  voice?: string;
  model?: string;
  instructions?: string;
}

export type TtsResult = { ok: true; audio: ArrayBuffer; mime: string } | { ok: false; error: AiError };

/** A Windows (SAPI) voice as reported by System.Speech. */
export interface SystemVoice {
  /** Exact name, e.g. "Microsoft David Desktop". */
  name: string;
  /** Culture name, e.g. "en-US" (empty when unknown). */
  culture: string;
  /** "Male", "Female", "Neutral" or "NotSet". */
  gender: string;
  /** "Adult", "Child", "Senior", "Teen" or "NotSet". */
  age: string;
  description: string;
}

export type SystemVoiceListResult =
  | {
      ok: true;
      voices: SystemVoice[];
      /** The voice Bonzi uses when settings.systemVoiceName is empty (null: the Windows default). */
      defaultVoice: string | null;
    }
  | { ok: false; error: AiError };

export interface SttRequest {
  audio: ArrayBuffer;
  /** e.g. "audio/webm;codecs=opus" from MediaRecorder */
  mime: string;
}

export type SttResult = { ok: true; text: string } | { ok: false; error: AiError };

// ---------------------------------------------------------------------------
// App commands (main -> agent renderer), from the tray, context menu and hotkeys

export type QuickAction = 'joke' | 'fact' | 'time' | 'compliment' | 'about';

export type AppCommand =
  | { type: 'open-chat' }
  | { type: 'quick-action'; action: QuickAction }
  | { type: 'play-animation'; name: string }
  | { type: 'stop' }
  /** Play the Hide animation, then call api.window.hidden(). */
  | { type: 'hide' }
  /** Window has just been shown again; play the Show animation. */
  | { type: 'show' }
  | { type: 'toggle-mic' }
  | { type: 'reset-conversation' }
  /** Say goodbye / play Hide, then call api.app.quit(). Main force-quits after a timeout. */
  | { type: 'exit' }
  /** The character file changed in settings; reload it. */
  | { type: 'reload-character' }
  /** Main ended a drag on its own (no cursor movement for the idle timeout); drop the drag state. */
  | { type: 'drag-cancelled' }
  /** The session was locked or unlocked, or the PC is suspending or has resumed. */
  | { type: 'power'; state: PowerState };

export type PowerState = 'suspend' | 'resume' | 'lock' | 'unlock';

/** Electron's powerMonitor.getSystemIdleState() result. */
export type SystemIdleState = 'active' | 'idle' | 'locked' | 'unknown';

/** Answer to win:ready. */
export interface AgentReadyResult {
  /** false when the user has Bonzi hidden; the renderer must then stay hidden until main sends {type:'show'}. */
  shown: boolean;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
}

// ---------------------------------------------------------------------------
// Settings

export interface ModelLists {
  chat: string[];
  tts: string[];
  stt: string[];
  all: string[];
}

export type ModelListResult = { ok: true; models: ModelLists } | { ok: false; error: AiError };

export type ConnectionTestResult =
  | { ok: true; latencyMs: number; modelCount: number; chatModelAvailable: boolean }
  | { ok: false; error: AiError };

export type ChooseCharacterResult =
  | { ok: true; settings: PublicSettings }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; message: string };

/** The only external URLs the settings window may ask the main process to open. */
export const EXTERNAL_LINKS = {
  openaiKeys: 'https://platform.openai.com/api-keys',
  openaiUsage: 'https://platform.openai.com/usage',
  openaiPricing: 'https://openai.com/api/pricing/',
} as const;
export type ExternalLinkId = keyof typeof EXTERNAL_LINKS;

// ---------------------------------------------------------------------------
// Preload-exposed APIs

export type Unsubscribe = () => void;

/**
 * Cursor position relative to the agent window's top-left, in CSS px (DIP),
 * sampled by the main process; null when the cursor is outside the window.
 * Windows does not deliver mouse moves to a click-through window reliably
 * (Electron's forwarding hook drops them, and toggling click-through fires
 * spurious mouseleave events), so hover detection is driven by these samples.
 */
export type PointerSample = { x: number; y: number } | null;

export interface BonziAgentApi {
  loadCharacter(): Promise<CharacterPayload>;
  chat: {
    send(req: ChatSendRequest): Promise<ChatSendResult>;
    /** Cancels the given request, or the active one when omitted. */
    cancel(requestId?: string): Promise<void>;
    reset(): Promise<void>;
    onEvent(cb: (ev: ChatEvent) => void): Unsubscribe;
  };
  tts: {
    synthesize(req: TtsRequest): Promise<TtsResult>;
  };
  stt: {
    transcribe(req: SttRequest): Promise<SttResult>;
  };
  window: {
    /** true = clicks pass through the window. Hover is tracked with onPointer, not forwarded events. */
    setIgnoreMouseEvents(ignore: boolean): void;
    /** Cursor samples from the main process while the window is visible (see PointerSample). */
    onPointer(cb: (p: PointerSample) => void): Unsubscribe;
    /** Main process follows the cursor until dragEnd(), keeping the grab offset. */
    /**
     * grab: where the button went down, in window CSS px. The drag only starts after a
     * small movement threshold, so main must not measure the grab point at that moment.
     */
    dragStart(grab?: { x: number; y: number }): void;
    dragEnd(): void;
    showContextMenu(): void;
    /** Gives the agent window keyboard focus (e.g. when the chat bar opens). */
    focus(): void;
    /** Hands keyboard focus back to the previous window (no-op unless the agent window is active). */
    releaseFocus(): void;
    hidden(): void;
    /** The renderer is loaded. shown is false when the user has Bonzi hidden; the renderer must then stay hidden. */
    ready(): Promise<AgentReadyResult>;
  };
  app: {
    openSettings(): void;
    quit(): void;
    getInfo(): Promise<AppInfo>;
    /** The OS idle state for the given threshold in seconds (clamped to 60..14400). */
    getIdleState(thresholdSec: number): Promise<SystemIdleState>;
    onCommand(cb: (cmd: AppCommand) => void): Unsubscribe;
  };
  settings: {
    get(): Promise<PublicSettings>;
    onChanged(cb: (s: PublicSettings) => void): Unsubscribe;
  };
}

export interface BonziSettingsApi {
  get(): Promise<PublicSettings>;
  update(patch: SettingsPatch): Promise<PublicSettings>;
  /** null clears the stored key. The key is validated for shape only, never echoed back. */
  setApiKey(key: string | null): Promise<PublicSettings>;
  testConnection(): Promise<ConnectionTestResult>;
  listModels(): Promise<ModelListResult>;
  chooseCharacter(): Promise<ChooseCharacterResult>;
  resetCharacter(): Promise<PublicSettings>;
  clearHistory(): Promise<void>;
  /** Synthesizes a sample with the current (or overridden) voice settings. */
  previewVoice(req: TtsRequest): Promise<TtsResult>;
  /** Windows (SAPI) voices installed on this PC. */
  listSystemVoices(): Promise<SystemVoiceListResult>;
  getInfo(): Promise<AppInfo>;
  openExternal(id: ExternalLinkId): void;
  /** Suspends (true) or restores (false) the global chat shortcut while the shortcut box records. */
  setHotkeyCapture(active: boolean): void;
  onChanged(cb: (s: PublicSettings) => void): Unsubscribe;
}
