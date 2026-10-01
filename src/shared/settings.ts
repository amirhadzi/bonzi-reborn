// Settings schema shared by the main process and both renderers.
// The API key is NOT part of Settings: it lives only in the main process,
// encrypted at rest with Electron safeStorage (Windows DPAPI).

export type VoiceMode = 'openai' | 'system' | 'off';
export type ReasoningEffort = 'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type BalloonStyle = 'modern' | 'classic';

export interface SavedPosition {
  /**
   * Screen coordinates (DIP) of the top-left corner of the character sprite box
   * (not the window). The window position is derived from it with
   * windowPositionForCharacter() in layout.ts, so changing the scale or the
   * layout padding keeps the character where the user left it.
   */
  x: number;
  y: number;
}

export interface Settings {
  schemaVersion: 1;

  // AI provider
  /** OpenAI-compatible base URL including the /v1 suffix. */
  baseUrl: string;
  chatModel: string;
  /** 'auto' means the parameter is not sent. Unsupported values are dropped automatically per model. */
  reasoningEffort: ReasoningEffort;
  /** 0 means no explicit limit is sent. */
  maxReplyTokens: number;
  /** How many past messages (user + assistant) are sent as context. */
  historyMessages: number;
  /** Persist the conversation between sessions (encrypted with safeStorage). */
  rememberConversation: boolean;
  /** Extra persona instructions appended to the built-in Bonzi system prompt. */
  customInstructions: string;
  /** What Bonzi should call the user. Empty means "friend". */
  userName: string;

  // Voice output
  voiceMode: VoiceMode;
  ttsModel: string;
  ttsVoice: string;
  /** Style instructions for TTS models that accept them (e.g. gpt-4o-mini-tts). */
  ttsInstructions: string;
  /** 0.25 to 4.0, 1 is normal. */
  ttsSpeed: number;
  /**
   * Windows (SAPI) voice used for voiceMode 'system' and as the fallback when
   * OpenAI TTS is unavailable. Empty = Bonzi's default (Microsoft David when installed).
   */
  systemVoiceName: string;
  /** 0.5 to 2, pitch multiplier for the Windows voice (1 = the voice's natural pitch). */
  systemVoicePitch: number;
  /** 0.5 to 2.5, perceived speaking speed of the Windows voice (1 = the voice's normal speed). */
  systemVoiceRate: number;
  /** Master volume 0 to 1 for speech and sound effects. */
  volume: number;
  /** Play the character's built-in sound effects. */
  soundEffects: boolean;

  // Voice input
  micEnabled: boolean;
  sttModel: string;

  // Character and behaviour
  /** Absolute path to a user-chosen .acs file, or null for the bundled Bonzi. */
  characterPath: string | null;
  /** Display scale of the character sprite: 1, 1.5, 2 ... */
  scale: number;
  alwaysOnTop: boolean;
  idleAnimations: boolean;
  /** Bonzi occasionally says something unprompted. Off by default (the original was notorious for this). */
  idleChatter: boolean;
  idleChatterMinutes: number;
  balloonStyle: BalloonStyle;

  // App
  launchAtLogin: boolean;
  /** Electron accelerator that summons the chat box. Empty disables it. */
  hotkey: string;
  position: SavedPosition | null;
  firstRunComplete: boolean;
  /** The one-time tray tip after the first Hide ("I'm still here, click the tray icon") was shown. */
  hideHintShown: boolean;
}

/** What renderers receive. Never contains the API key itself. */
export interface PublicSettings extends Settings {
  hasApiKey: boolean;
  /** e.g. "sk-...abcd" (last 4 characters only), null when no key. */
  apiKeyHint: string | null;
  apiKeySource: 'stored' | 'session' | 'env' | 'none';
  /** False when OS-level encryption is unavailable; the key is then kept in memory only. */
  safeStorageAvailable: boolean;
  /** Display name read from the loaded character file. */
  characterName: string;
  /** Set when the global hotkey could not be registered (e.g. taken by another app). */
  hotkeyError: string | null;
}

export type SettingsPatch = Partial<Omit<Settings, 'schemaVersion'>>;

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,

  baseUrl: OPENAI_BASE_URL,
  // Low-latency, low-cost default per docs/RESEARCH.md (2026-10). Editable in settings.
  chatModel: 'gpt-6-luna',
  reasoningEffort: 'none',
  maxReplyTokens: 0,
  historyMessages: 20,
  rememberConversation: false,
  customInstructions: '',
  userName: '',

  voiceMode: 'openai',
  ttsModel: 'gpt-4o-mini-tts',
  ttsVoice: 'cedar',
  ttsInstructions:
    'Voice of a cheerful, goofy cartoon gorilla from a late-90s desktop assistant. Upbeat, friendly and a little cheesy, with a playful bounce. Speak clearly at a lively pace.',
  ttsSpeed: 1,
  systemVoiceName: '',
  // Cartoon-ish but intelligible: about 4.5 semitones up (Microsoft David's ~95 Hz
  // becomes ~124 Hz, toward the original TruVoice Bonzi's 140 Hz) at roughly the
  // original 157 words per minute. See docs/STATUS.md (Voice).
  systemVoicePitch: 1.3,
  systemVoiceRate: 1.05,
  volume: 0.8,
  soundEffects: true,

  micEnabled: true,
  sttModel: 'gpt-transcribe',

  characterPath: null,
  scale: 1,
  alwaysOnTop: true,
  idleAnimations: true,
  idleChatter: false,
  idleChatterMinutes: 20,
  balloonStyle: 'modern',

  launchAtLogin: false,
  hotkey: 'CommandOrControl+Shift+B',
  position: null,
  firstRunComplete: false,
  hideHintShown: false,
};

export const LIMITS = {
  modelName: 128,
  baseUrl: 512,
  customInstructions: 4000,
  userName: 64,
  ttsInstructions: 1000,
  ttsVoice: 64,
  systemVoiceName: 256,
  hotkey: 64,
  characterPath: 1024,
  historyMessages: { min: 0, max: 100 },
  maxReplyTokens: { min: 0, max: 32000 },
  ttsSpeed: { min: 0.25, max: 4 },
  systemVoicePitch: { min: 0.5, max: 2 },
  systemVoiceRate: { min: 0.5, max: 2.5 },
  volume: { min: 0, max: 1 },
  scale: { min: 0.5, max: 4 },
  idleChatterMinutes: { min: 1, max: 240 },
  /** Max chat message length accepted from the renderer. */
  chatText: 4000,
  /** Max TTS input in characters (OpenAI limit is 4096). */
  ttsText: 4096,
  /** Max recorded audio size for transcription (OpenAI limit is 25 MB). */
  sttBytes: 25 * 1024 * 1024,
} as const;

const REASONING: readonly ReasoningEffort[] = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const VOICE_MODES: readonly VoiceMode[] = ['openai', 'system', 'off'];
const BALLOON_STYLES: readonly BalloonStyle[] = ['modern', 'classic'];

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function str(v: unknown, maxLen: number, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  // Strip control characters except newline and tab.
  const cleaned = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return cleaned.slice(0, maxLen);
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * Validates an OpenAI-compatible base URL. https is required except for
 * loopback hosts (local mock servers, Ollama, LM Studio).
 * Returns the normalised URL (no trailing slash) or null when invalid.
 */
export function normalizeBaseUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function sanitizePosition(v: unknown, fallback: SavedPosition | null): SavedPosition | null {
  if (v === null) return null;
  if (typeof v !== 'object' || v === undefined) return fallback;
  const p = v as Record<string, unknown>;
  if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return fallback;
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/**
 * Applies an untrusted patch on top of a trusted base, validating every field.
 * Unknown keys are ignored. Invalid values keep the base value.
 */
export function applySettingsPatch(base: Settings, patch: unknown): Settings {
  if (typeof patch !== 'object' || patch === null) return base;
  const p = patch as Record<string, unknown>;
  const has = (k: keyof Settings) => Object.prototype.hasOwnProperty.call(p, k);
  const next: Settings = { ...base };

  if (has('baseUrl')) {
    const u = typeof p.baseUrl === 'string' ? normalizeBaseUrl(p.baseUrl.slice(0, LIMITS.baseUrl)) : null;
    if (u) next.baseUrl = u;
  }
  if (has('chatModel')) next.chatModel = str(p.chatModel, LIMITS.modelName, base.chatModel).trim() || base.chatModel;
  if (has('reasoningEffort')) next.reasoningEffort = oneOf(p.reasoningEffort, REASONING, base.reasoningEffort);
  if (has('maxReplyTokens')) next.maxReplyTokens = Math.round(clampNum(p.maxReplyTokens, LIMITS.maxReplyTokens.min, LIMITS.maxReplyTokens.max, base.maxReplyTokens));
  if (has('historyMessages')) next.historyMessages = Math.round(clampNum(p.historyMessages, LIMITS.historyMessages.min, LIMITS.historyMessages.max, base.historyMessages));
  if (has('rememberConversation')) next.rememberConversation = bool(p.rememberConversation, base.rememberConversation);
  if (has('customInstructions')) next.customInstructions = str(p.customInstructions, LIMITS.customInstructions, base.customInstructions);
  if (has('userName')) next.userName = str(p.userName, LIMITS.userName, base.userName).replace(/[\r\n\t]/g, ' ').trim();

  if (has('voiceMode')) next.voiceMode = oneOf(p.voiceMode, VOICE_MODES, base.voiceMode);
  if (has('ttsModel')) next.ttsModel = str(p.ttsModel, LIMITS.modelName, base.ttsModel).trim() || base.ttsModel;
  if (has('ttsVoice')) next.ttsVoice = str(p.ttsVoice, LIMITS.ttsVoice, base.ttsVoice).trim() || base.ttsVoice;
  if (has('ttsInstructions')) next.ttsInstructions = str(p.ttsInstructions, LIMITS.ttsInstructions, base.ttsInstructions);
  if (has('ttsSpeed')) next.ttsSpeed = clampNum(p.ttsSpeed, LIMITS.ttsSpeed.min, LIMITS.ttsSpeed.max, base.ttsSpeed);
  if (has('systemVoiceName')) next.systemVoiceName = str(p.systemVoiceName, LIMITS.systemVoiceName, base.systemVoiceName);
  if (has('systemVoicePitch')) next.systemVoicePitch = clampNum(p.systemVoicePitch, LIMITS.systemVoicePitch.min, LIMITS.systemVoicePitch.max, base.systemVoicePitch);
  if (has('systemVoiceRate')) next.systemVoiceRate = clampNum(p.systemVoiceRate, LIMITS.systemVoiceRate.min, LIMITS.systemVoiceRate.max, base.systemVoiceRate);
  if (has('volume')) next.volume = clampNum(p.volume, LIMITS.volume.min, LIMITS.volume.max, base.volume);
  if (has('soundEffects')) next.soundEffects = bool(p.soundEffects, base.soundEffects);

  if (has('micEnabled')) next.micEnabled = bool(p.micEnabled, base.micEnabled);
  if (has('sttModel')) next.sttModel = str(p.sttModel, LIMITS.modelName, base.sttModel).trim() || base.sttModel;

  // characterPath is only ever set by the main process after a file dialog;
  // a renderer may reset it to null but never supply a path.
  if (has('characterPath') && p.characterPath === null) next.characterPath = null;
  if (has('scale')) next.scale = clampNum(p.scale, LIMITS.scale.min, LIMITS.scale.max, base.scale);
  if (has('alwaysOnTop')) next.alwaysOnTop = bool(p.alwaysOnTop, base.alwaysOnTop);
  if (has('idleAnimations')) next.idleAnimations = bool(p.idleAnimations, base.idleAnimations);
  if (has('idleChatter')) next.idleChatter = bool(p.idleChatter, base.idleChatter);
  if (has('idleChatterMinutes')) next.idleChatterMinutes = Math.round(clampNum(p.idleChatterMinutes, LIMITS.idleChatterMinutes.min, LIMITS.idleChatterMinutes.max, base.idleChatterMinutes));
  if (has('balloonStyle')) next.balloonStyle = oneOf(p.balloonStyle, BALLOON_STYLES, base.balloonStyle);

  if (has('launchAtLogin')) next.launchAtLogin = bool(p.launchAtLogin, base.launchAtLogin);
  if (has('hotkey')) next.hotkey = str(p.hotkey, LIMITS.hotkey, base.hotkey).trim();
  if (has('position')) next.position = sanitizePosition(p.position, base.position);
  if (has('firstRunComplete')) next.firstRunComplete = bool(p.firstRunComplete, base.firstRunComplete);
  if (has('hideHintShown')) next.hideHintShown = bool(p.hideHintShown, base.hideHintShown);

  return next;
}

/**
 * Loads settings from untrusted persisted JSON (e.g. settings.json on disk).
 * Starts from defaults so new fields get default values after an upgrade.
 * Unlike renderer patches, a persisted characterPath string is accepted here;
 * the main process must still verify the file exists and parses before use.
 */
export function loadSettings(raw: unknown): Settings {
  const s = applySettingsPatch(DEFAULT_SETTINGS, raw);
  if (typeof raw === 'object' && raw !== null) {
    const cp = (raw as Record<string, unknown>).characterPath;
    if (typeof cp === 'string' && cp.length > 0 && cp.length <= LIMITS.characterPath) s.characterPath = cp;
  }
  return s;
}
