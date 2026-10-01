// Agent window orchestrator: startup, state machine, chat flow, commands,
// settings, voice input, idle chatter and overlay placement.

import { composeFrame, getAnimation, parseAcs, type AcsCharacter } from '../../shared/acs/index.ts';
import type { CharacterController } from '../../shared/character-controller.ts';
import { resolveGesture } from '../../shared/gestures.ts';
import type {
  AiError,
  AppCommand,
  BonziAgentApi,
  ChatEvent,
  ChatSendResult,
  ChatSource,
  QuickAction,
  SystemIdleState,
} from '../../shared/ipc.ts';
import { computeAgentLayout, LAYOUT, type AgentLayout } from '../../shared/layout.ts';
import { LIMITS, type PublicSettings } from '../../shared/settings.ts';
import { Balloon, BALLOON_MAX_HEIGHT } from './balloon.ts';
import { ChatBar } from './chat-bar.ts';
import {
  CHARACTER_ERROR_LINE,
  emptyReplyLine,
  errorLine,
  FUN_GESTURES,
  goodbyeLine,
  greetingLine,
  IDLE_CHATTER_PROMPT,
  introLines,
  MIC_LINES,
  QUICK_PROMPTS,
  RESET_LINE,
  timeLine,
  type LocalLine,
} from './lines.ts';
import { MicRecorder } from './mic.ts';
import { computePlacement, visibleArea, type CharacterAnchor } from './placement.ts';
import { PointerController } from './pointer.ts';
import { SpeechQueue, type AudioLogEntry, type VoiceSettings } from './speech/queue.ts';
import { cleanSpeechText } from './speech/clean.ts';
import { SentenceSplitter } from './speech/sentences.ts';
import { extractTags, TagParser } from './speech/tags.ts';

export type AgentState =
  | 'loading'
  | 'showing'
  | 'idle'
  | 'thinking'
  | 'speaking'
  | 'listening'
  | 'transcribing'
  | 'hiding'
  | 'hidden'
  | 'error';

export interface CreateCharacterOptions {
  audioContext?: AudioContext;
  random?: () => number;
  scale?: number;
  soundEnabled?: boolean;
  volume?: number;
  idleEnabled?: boolean;
}

export type CreateCharacterFn = (acs: AcsCharacter, options?: CreateCharacterOptions) => CharacterController;

export interface SpeechLogEntry {
  text: string;
  gestures: string[];
  at: number;
}

export interface BonziDebug {
  readonly character: CharacterController | null;
  getState(): string;
  speechLog: SpeechLogEntry[];
  /** One entry per playback attempt: engine, outcome, heard duration and peak analyser RMS. */
  audioLog: AudioLogEntry[];
  readonly lastError: AiError | null;
  playAnimation(name: string): Promise<unknown>;
  /** Runs an AppCommand as if main had sent it (tests only). */
  runCommand(cmd: AppCommand): Promise<void>;
}

export interface AgentAppOptions {
  api: BonziAgentApi;
  createCharacter: CreateCharacterFn;
  random?: () => number;
}

const SHOW_DELAY_MS = 150;
const POLL_MS = 250;
const IDLE_CHECK_MS = 30_000;
/** The OS reports the user as away after this many seconds without input; idle chatter waits. */
const AWAY_AFTER_SEC = 300;
/** Each failed idle-chatter request doubles the wait, up to 2^this. */
const CHATTER_BACKOFF_MAX = 4;
const INTRO_KEY = 'bonzi.introPlayed';
const SPEECH_LOG_MAX = 500;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

/** First row with an opaque pixel, or -1. */
function opaqueTop(data: Uint8ClampedArray, width: number, height: number): number {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if ((data[(y * width + x) * 4 + 3] ?? 0) > 0) return y;
  }
  return -1;
}

/** Gestures whose raised arms the chat bar should keep clear of. */
const REACH_ANIMATIONS = ['WAVE', 'GREET', 'EXPLAIN', 'PLEASED', 'ACKNOWLEDGE', 'CONGRATULATE'];

/** Opaque bounds of the rest pose, so the balloon tail points at the head. */
function computeLocalAnchor(acs: AcsCharacter): CharacterAnchor {
  const { width, height } = acs.info;
  const fallback = { headX: width / 2, top: 0, bottom: height, reachTop: 0 };
  const anim = getAnimation(acs, 'RESTPOSE') ?? acs.animations.find((a) => a.frames.length > 0);
  if (!anim || anim.frames.length === 0) return fallback;
  let img;
  try {
    img = composeFrame(acs, anim, 0);
  } catch {
    return fallback;
  }
  const top = opaqueTop(img.data, width, height);
  if (top < 0) return fallback;
  let bottom = top;
  for (let y = height - 1; y > top && bottom === top; y--) {
    for (let x = 0; x < width; x++) {
      if ((img.data[(y * width + x) * 4 + 3] ?? 0) > 0) {
        bottom = y;
        break;
      }
    }
  }
  const headRows = Math.max(1, Math.round((bottom - top + 1) * 0.25));
  let sum = 0;
  let count = 0;
  for (let y = top; y < top + headRows; y++) {
    for (let x = 0; x < width; x++) {
      if ((img.data[(y * width + x) * 4 + 3] ?? 0) > 0) {
        sum += x;
        count++;
      }
    }
  }
  let reachTop = top;
  const target = new Uint8ClampedArray(width * height * 4);
  for (const name of REACH_ANIMATIONS) {
    const a = getAnimation(acs, name);
    if (!a) continue;
    for (let i = 0; i < a.frames.length; i++) {
      try {
        const t = opaqueTop(composeFrame(acs, a, i, { target }).data, width, height);
        if (t >= 0) reachTop = Math.min(reachTop, t);
      } catch {
        // skip unreadable frames
      }
    }
  }
  return { headX: count ? sum / count : width / 2, top, bottom: bottom + 1, reachTop };
}

function introAlreadyPlayed(): boolean {
  try {
    return sessionStorage.getItem(INTRO_KEY) === '1';
  } catch {
    return false;
  }
}

function markIntroPlayed(): void {
  try {
    sessionStorage.setItem(INTRO_KEY, '1');
  } catch {
    // per-session memory only
  }
}

export class AgentApp {
  private readonly api: BonziAgentApi;
  private readonly makeCharacter: CreateCharacterFn;
  private readonly random: () => number;

  private readonly stage: HTMLElement;
  private readonly balloon: Balloon;
  private readonly chatBar: ChatBar;
  private readonly pointer: PointerController;
  private readonly queue: SpeechQueue;
  private readonly mic: MicRecorder;

  private settings: PublicSettings | null = null;
  private acs: AcsCharacter | null = null;
  private character: CharacterController | null = null;
  private layout: AgentLayout = computeAgentLayout(200, 160, 1);
  private localAnchor: CharacterAnchor = { headX: 100, top: 0, bottom: 160, reachTop: 0 };
  private state: AgentState = 'loading';
  private audioCtx: AudioContext | null = null;

  // Chat turn
  private sendToken = 0;
  private pendingSend = false;
  private buffered: ChatEvent[] = [];
  private currentRequestId: string | null = null;
  private tags = new TagParser();
  private splitter = new SentenceSplitter();
  private gotDelta = false;

  /** Source of the chat turn in flight (null when none). */
  private activeSource: ChatSource | null = null;

  private lastInteraction = Date.now();
  /** When checkIdleChatter last ran; a much larger gap means the PC was asleep. */
  private lastIdleTick = Date.now();
  /** Consecutive failed idle-chatter requests (backoff exponent). */
  private chatterFailures = 0;
  private chatterCheckPending = false;
  /** Session locked or PC suspended (main's power events). */
  private away = false;
  /** A character file is being loaded (startup or reload). */
  private characterLoading = false;
  /** First run without a key: settings opens when the intro's key line plays (or the intro is cut short). */
  private keySettingsPending = false;
  private introPlayed = false;
  /** firstRunComplete as read at startup; main marks it done as soon as the window is ready. */
  private firstRun = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private lastScreen = { x: Number.NaN, y: Number.NaN };
  private drainWaiters: Array<() => void> = [];
  private readonly speechLog: SpeechLogEntry[] = [];
  private readonly audioLog: AudioLogEntry[] = [];
  private debugEnabled = false;
  private lastError: AiError | null = null;

  constructor(options: AgentAppOptions) {
    this.api = options.api;
    this.makeCharacter = options.createCharacter;
    this.random = options.random ?? Math.random;

    this.stage = el('stage');
    this.balloon = new Balloon(el('balloon'), el('balloon-text'));
    this.balloon.onChange = () => this.overlaysChanged();

    this.chatBar = new ChatBar(
      { root: el('chat-bar'), input: el<HTMLInputElement>('chat-input'), send: el<HTMLButtonElement>('chat-send'), mic: el<HTMLButtonElement>('chat-mic') },
      () => this.api.window.focus(),
      {
        onSubmit: (text) => {
          if (this.mic.recording) this.mic.stop();
          else void this.sendChat(text, 'typed');
        },
        onEscape: () => this.onEscape(),
        onMic: () => void this.toggleMic(),
        onChange: () => this.overlaysChanged(),
        onActivity: () => this.noteInteraction(),
        releaseFocus: () => this.api.window.releaseFocus(),
      },
    );

    this.pointer = new PointerController(
      this.stage,
      {
        hitCharacter: (x, y) => this.hitCharacter(x, y),
        interactiveElements: () => {
          const out: HTMLElement[] = [];
          if (this.balloon.visible) out.push(this.balloon.el);
          if (this.chatBar.isOpen) out.push(this.chatBar.element);
          return out;
        },
      },
      {
        setIgnoreMouseEvents: (ignore) => this.api.window.setIgnoreMouseEvents(ignore),
        onClick: () => this.onCharacterClick(),
        onDoubleClick: () => this.onCharacterDoubleClick(),
        onContextMenu: () => this.api.window.showContextMenu(),
        onDragStart: (grab) => this.onDragStart(grab),
        onDragEnd: () => this.onDragEnd(),
        onActivity: () => this.noteInteraction(),
      },
    );

    this.queue = new SpeechQueue({
      getCharacter: () => this.character,
      balloon: this.balloon,
      getAudioContext: () => this.audio(),
      synthesize: (req) => this.api.tts.synthesize(req),
      getVoice: () => this.voiceSettings(),
      onSpoken: (item) => {
        if (!item.text) return;
        this.speechLog.push({ text: item.text, gestures: [...item.gestures], at: Date.now() });
        if (this.speechLog.length > SPEECH_LOG_MAX) this.speechLog.shift();
      },
      onDrained: () => this.onQueueDrained(),
      onTtsError: (err) => {
        this.lastError = err;
      },
      onAudio: (entry) => {
        if (!this.debugEnabled) return;
        this.audioLog.push(entry);
        if (this.audioLog.length > SPEECH_LOG_MAX) this.audioLog.shift();
      },
    });

    this.mic = new MicRecorder(() => this.audio());

    window.addEventListener('keydown', (e) => this.onGlobalKey(e), true);
    window.addEventListener('resize', () => this.placeOverlays());
  }

  // ------------------------------------------------------------------
  // Startup

  async start(): Promise<void> {
    this.setState('loading');
    this.characterLoading = true;
    this.api.chat.onEvent((ev) => this.onChatEvent(ev));
    this.api.app.onCommand((cmd) => void this.onCommand(cmd));
    this.api.window.onPointer((p) => this.pointer.onPointerSample(p));
    this.api.settings.onChanged((s) => this.applySettings(s));

    const [settings, info] = await Promise.all([this.api.settings.get(), this.api.app.getInfo().catch(() => null)]);
    this.applySettings(settings);
    this.firstRun = !settings.firstRunComplete;
    if (info && !info.isPackaged) this.exposeDebug();

    try {
      await this.loadCharacter();
    } catch (err) {
      this.characterLoading = false;
      console.error('character load failed', err);
      this.fail(CHARACTER_ERROR_LINE);
      void this.api.window.ready().catch(() => {});
      return;
    }
    this.characterLoading = false;

    // Main answers whether the user has Bonzi hidden (Hide during startup, or a
    // renderer reload while hidden). He then stays hidden until main sends 'show'.
    let shown = true;
    try {
      shown = (await this.api.window.ready()).shown !== false;
    } catch {
      // An IPC failure counts as shown: an invisible Bonzi is worse than an extra Show.
    }
    this.pointer.resync();
    this.idleTimer = setInterval(() => this.checkIdleChatter(), IDLE_CHECK_MS);
    if (!shown && this.is('loading')) this.setState('hidden');
    await delay(SHOW_DELAY_MS);
    // A Hide or Show that arrived meanwhile owns the state: no Show and no greeting here.
    if (!this.is('loading')) return;
    this.setState('showing');
    await this.character?.show();
    if (!this.is('showing')) return;
    this.setState('idle');
    this.greet();
  }

  private audio(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') this.audioCtx = new AudioContext();
    if (this.audioCtx.state === 'suspended') void this.audioCtx.resume().catch(() => {});
    return this.audioCtx;
  }

  private async loadCharacter(): Promise<void> {
    const payload = await this.api.loadCharacter();
    const acs = parseAcs(payload.bytes);
    const s = this.settings;
    const ch = this.makeCharacter(acs, {
      audioContext: this.audio(),
      random: this.random,
      scale: s?.scale ?? 1,
      soundEnabled: s?.soundEffects ?? true,
      volume: s?.volume ?? 0.8,
      idleEnabled: s?.idleAnimations ?? true,
    });
    ch.canvas.id = 'character';
    this.stage.replaceChildren(ch.canvas);
    this.acs = acs;
    this.character = ch;
    this.localAnchor = computeLocalAnchor(acs);
    this.balloon.setStyle(s?.balloonStyle ?? 'modern', acs.info.balloon);
    this.relayout();
  }

  private relayout(): void {
    const w = this.acs?.info.width ?? 200;
    const h = this.acs?.info.height ?? 160;
    const scale = this.settings?.scale ?? 1;
    this.layout = computeAgentLayout(w, h, scale);
    const ch = this.character;
    if (ch) {
      const cs = ch.canvas.style;
      cs.left = `${this.layout.charX}px`;
      cs.top = `${this.layout.charY}px`;
      cs.width = `${this.layout.charWidth}px`;
      cs.height = `${this.layout.charHeight}px`;
    }
    this.placeOverlays();
  }

  private exposeDebug(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const app = this;
    this.debugEnabled = true;
    const debug: BonziDebug = {
      get character() {
        return app.character;
      },
      getState: () => this.state,
      speechLog: this.speechLog,
      audioLog: this.audioLog,
      get lastError() {
        return app.lastError;
      },
      playAnimation: (name: string) => this.character?.playNow(name) ?? Promise.resolve('missing'),
      runCommand: (cmd: AppCommand) => this.onCommand(cmd),
    };
    (window as unknown as { __bonziDebug?: BonziDebug }).__bonziDebug = debug;
  }

  private greet(): void {
    const s = this.settings;
    if (!s) return;
    if (this.firstRun && !this.introPlayed && !introAlreadyPlayed()) {
      this.introPlayed = true;
      markIntroPlayed();
      this.speakLocal(introLines(s.hasApiKey));
      // Armed after speakLocal, whose interrupt() would otherwise fire it at once.
      this.keySettingsPending = !s.hasApiKey;
    } else {
      this.speakLocal([greetingLine(s.userName, this.random)]);
    }
  }

  private fail(message: string): void {
    this.setState('error');
    this.balloon.showMessage(message, 'error');
  }

  // ------------------------------------------------------------------
  // State

  /** State check that TypeScript does not narrow across awaits. */
  private is(s: AgentState): boolean {
    return this.state === s;
  }

  private setState(s: AgentState): void {
    this.state = s;
    document.body.dataset.state = s;
  }

  private get busy(): boolean {
    return this.state === 'thinking' || this.state === 'speaking';
  }

  private get present(): boolean {
    return this.character !== null && this.state !== 'hidden' && this.state !== 'hiding' && this.state !== 'loading';
  }

  private noteInteraction(): void {
    this.lastInteraction = Date.now();
    this.character?.notifyUserActivity();
  }

  private voiceSettings(): VoiceSettings {
    const s = this.settings;
    return {
      mode: s?.voiceMode ?? 'off',
      volume: s?.volume ?? 0.8,
      hasApiKey: s?.hasApiKey ?? false,
      systemVoicePitch: s?.systemVoicePitch ?? 1,
    };
  }

  private applySettings(next: PublicSettings): void {
    const prev = this.settings;
    this.settings = next;
    const ch = this.character;
    if (ch) {
      if (!prev || prev.scale !== next.scale) {
        ch.setScale(next.scale);
        this.relayout();
      }
      ch.setSoundEnabled(next.soundEffects);
      ch.setVolume(next.volume);
      ch.setIdleEnabled(next.idleAnimations);
    }
    if (!prev || prev.balloonStyle !== next.balloonStyle) this.balloon.setStyle(next.balloonStyle, this.acs?.info.balloon ?? null);
    this.chatBar.setMicVisible(next.micEnabled);
    if (!next.micEnabled && this.mic.recording) this.mic.cancel();
  }

  // ------------------------------------------------------------------
  // Overlays (balloon + chat bar)

  private overlaysChanged(): void {
    this.placeOverlays();
    const needPoll = this.balloon.visible || this.chatBar.isOpen;
    if (needPoll && this.pollTimer === null) {
      this.pollTimer = setInterval(() => {
        if (window.screenX !== this.lastScreen.x || window.screenY !== this.lastScreen.y) this.placeOverlays();
      }, POLL_MS);
    } else if (!needPoll && this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private windowAnchor(): CharacterAnchor {
    const s = this.layout.scale;
    return {
      headX: this.layout.charX + this.localAnchor.headX * s,
      top: this.layout.charY + this.localAnchor.top * s,
      bottom: this.layout.charY + this.localAnchor.bottom * s,
      reachTop: this.layout.charY + (this.localAnchor.reachTop ?? this.localAnchor.top) * s,
    };
  }

  private placeOverlays(): void {
    const winScreen = { x: window.screenX, y: window.screenY };
    this.lastScreen = winScreen;
    const scr = window.screen as Screen & { availLeft?: number; availTop?: number };
    const screenRect = { x: scr.availLeft ?? 0, y: scr.availTop ?? 0, width: scr.availWidth, height: scr.availHeight };
    const win = { width: this.layout.width, height: this.layout.height };
    // With Bonzi parked at a screen edge the window hangs off screen: cap both
    // elements to the visible span before measuring, so text re-wraps instead of
    // running off screen. Inline max-width beats the stylesheet widths.
    const vis = visibleArea(win, winScreen, screenRect);
    const span = Math.max(0, Math.floor(vis.right - vis.left));
    this.balloon.el.style.maxWidth = `${Math.min(LAYOUT.balloonMaxWidth, span)}px`;
    this.chatBar.element.style.maxWidth = `${span}px`;
    const b = this.balloon.visible ? this.balloon.measure() : null;
    const c = this.chatBar.isOpen ? this.chatBar.measure() : null;
    if (b || c) {
      const p = computePlacement({
        window: win,
        windowScreen: winScreen,
        screen: screenRect,
        anchor: this.windowAnchor(),
        balloon: b,
        chat: c,
        gap: LAYOUT.gap,
        tailSize: this.balloon.tailSize,
        balloonMaxHeight: BALLOON_MAX_HEIGHT,
      });
      if (p.balloon) this.balloon.place(p.balloon);
      if (p.chat) this.chatBar.place(p.chat);
    }
    this.pointer.refresh();
  }

  private hitCharacter(x: number, y: number): boolean {
    const ch = this.character;
    if (!ch || this.state === 'hidden' || this.state === 'loading') return false;
    const r = ch.canvas.getBoundingClientRect();
    if (x < r.left || y < r.top || x >= r.right || y >= r.bottom) return false;
    return ch.hitTest(x - r.left, y - r.top);
  }

  // ------------------------------------------------------------------
  // Pointer

  private onCharacterClick(): void {
    if (!this.present) return;
    this.noteInteraction();
    if (this.state === 'listening') {
      this.mic.stop();
      return;
    }
    if (this.state === 'transcribing') return;
    if (this.busy) {
      this.interrupt(true);
      return;
    }
    if (!this.chatBar.isOpen) {
      this.chatBar.open();
      const ch = this.character;
      const ack = ch ? resolveGesture('Yes', (n) => ch.hasAnimation(n)) : null;
      if (ch && ack) void ch.play(ack);
    } else this.chatBar.focus();
  }

  private onCharacterDoubleClick(): void {
    if (!this.present) return;
    if (this.state !== 'idle' && this.state !== 'error') {
      this.onCharacterClick();
      return;
    }
    this.noteInteraction();
    const ch = this.character!;
    const options = FUN_GESTURES.map((g) => resolveGesture(g, (n) => ch.hasAnimation(n))).filter((n): n is string => n !== null);
    const name = options[Math.floor(this.random() * options.length)];
    if (name) void ch.playNow(name);
  }

  private onDragStart(grab: { x: number; y: number }): void {
    this.character?.startActivity('dragging');
    this.api.window.dragStart(grab);
  }

  private onDragEnd(): void {
    this.api.window.dragEnd();
    const ch = this.character;
    if (!ch) return;
    void ch.stopActivity();
    // Resume the activity the drag replaced.
    if (this.state === 'thinking') ch.startActivity('thinking');
    else if (this.state === 'listening') ch.startActivity('listening');
    else if (this.state === 'transcribing') ch.startActivity('processing');
    setTimeout(() => this.placeOverlays(), 50);
  }

  // ------------------------------------------------------------------
  // Keyboard

  private onGlobalKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && this.mic.recording) {
      e.preventDefault();
      e.stopPropagation();
      this.mic.stop();
      return;
    }
    if (e.key === 'Escape' && document.activeElement !== this.chatBar.element.querySelector('input')) {
      e.preventDefault();
      this.onEscape();
    }
  }

  private onEscape(): void {
    this.noteInteraction();
    if (this.mic.recording) {
      this.mic.cancel();
      return;
    }
    if (this.state === 'transcribing') {
      this.setState('idle');
      void this.character?.stopActivity();
      this.balloon.hide();
      return;
    }
    if (this.busy) this.interrupt(true);
    this.chatBar.close();
  }

  // ------------------------------------------------------------------
  // Speech

  /** Stops speech and the in-flight chat request. */
  private interrupt(resetCharacter: boolean): void {
    // The intro was cut short before its key line: open settings now so the user still gets there.
    this.openKeySettings();
    this.activeSource = null;
    this.sendToken++;
    this.pendingSend = false;
    this.buffered = [];
    const active = this.currentRequestId;
    this.currentRequestId = null;
    if (active) void this.api.chat.cancel(active).catch(() => {});
    const wasThinking = this.state === 'thinking';
    this.queue.stop({ resetCharacter, hideBalloon: true });
    if (wasThinking && !resetCharacter) void this.character?.stopActivity();
    if (this.busy) this.setState('idle');
    this.flushDrainWaiters();
  }

  /**
   * Speaks canned lines aloud. tts allows OpenAI TTS (default: when a key exists);
   * error lines default to the Windows voice so they stay audible when OpenAI is
   * the problem. Every line falls back to the Windows voice, then to paced text.
   */
  private speakLocal(lines: readonly LocalLine[], options: { tts?: boolean; error?: boolean; append?: boolean } = {}): void {
    if (!this.character) {
      const text = lines.map((l) => l.text).join(' ');
      this.balloon.showMessage(text, options.error ? 'error' : 'normal');
      this.balloon.scheduleHide(8000);
      return;
    }
    if (!options.append) this.interrupt(false);
    const tts = options.tts ?? (!options.error && (this.settings?.hasApiKey ?? false));
    this.queue.openStream(!options.append);
    for (const l of lines) {
      this.queue.enqueue(
        { text: l.text, gestures: l.gesture ? [l.gesture] : [] },
        { tts, variant: options.error ? 'error' : 'normal', onStart: l.openSettings ? () => this.openKeySettings() : undefined },
      );
    }
    this.queue.closeStream();
    if (this.queue.busy && this.state !== 'hidden' && this.state !== 'hiding') this.setState('speaking');
  }

  /** Opens settings for the first-run key line, once, and only if there is still no key. */
  private openKeySettings(): void {
    if (!this.keySettingsPending) return;
    this.keySettingsPending = false;
    if (!this.settings?.hasApiKey) this.api.app.openSettings();
  }

  private onQueueDrained(): void {
    if (this.state === 'speaking') this.setState('idle');
    this.flushDrainWaiters();
  }

  private flushDrainWaiters(): void {
    const w = this.drainWaiters;
    this.drainWaiters = [];
    for (const f of w) f();
  }

  private waitForSpeech(maxMs: number): Promise<void> {
    if (!this.queue.busy) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, maxMs);
      this.drainWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  // ------------------------------------------------------------------
  // Chat

  private async sendChat(text: string, source: ChatSource): Promise<void> {
    const ch = this.character;
    const clean = text.trim().slice(0, LIMITS.chatText);
    if (!ch || !clean || !this.present) return;
    this.noteInteraction();
    this.interrupt(false);
    this.activeSource = source;
    // A real turn resets the idle-chatter backoff.
    if (source !== 'idle-chatter') this.chatterFailures = 0;

    const token = ++this.sendToken;
    this.pendingSend = true;
    this.buffered = [];
    this.setState('thinking');
    ch.startActivity('thinking');

    let res: ChatSendResult;
    try {
      res = await this.api.chat.send({ text: clean, source });
    } catch (err) {
      res = { ok: false, error: { kind: 'unknown', message: String(err) } };
    }
    if (token !== this.sendToken) return;
    this.pendingSend = false;

    if (!res.ok) {
      this.buffered = [];
      this.activeSource = null;
      void ch.stopActivity();
      this.setState('idle');
      // Nobody asked for idle chatter: never announce its failure, just back off.
      if (source === 'idle-chatter') this.noteChatterFailure(res.error);
      else this.showError(res.error, false);
      return;
    }

    this.currentRequestId = res.requestId;
    this.tags = new TagParser();
    this.splitter = new SentenceSplitter();
    this.gotDelta = false;
    this.queue.openStream(true);
    const early = this.buffered.filter((e) => e.requestId === res.requestId);
    this.buffered = [];
    for (const ev of early) this.onChatEvent(ev);
  }

  private onChatEvent(ev: ChatEvent): void {
    if (this.pendingSend) {
      if (this.buffered.length < 2000) this.buffered.push(ev);
      return;
    }
    if (!this.currentRequestId || ev.requestId !== this.currentRequestId) return;
    const ch = this.character;

    switch (ev.type) {
      case 'start':
        break;
      case 'delta': {
        if (!this.gotDelta) {
          this.gotDelta = true;
          void ch?.stopActivity();
          this.setState('speaking');
        }
        for (const item of this.splitter.push(this.tags.push(ev.text))) this.queue.enqueue(item);
        break;
      }
      case 'done': {
        const source = this.activeSource;
        this.activeSource = null;
        if (source === 'idle-chatter') this.chatterFailures = 0;
        this.currentRequestId = null;
        for (const item of this.splitter.push(this.tags.flush())) this.queue.enqueue(item);
        for (const item of this.splitter.flush()) this.queue.enqueue(item);
        // Finished without a single word (token limit, content filter): say so
        // instead of silently going back to idle. Unprompted chatter stays quiet.
        if (source !== 'idle-chatter' && !cleanSpeechText(extractTags(ev.text).text)) {
          const line = emptyReplyLine(ev.finishReason);
          this.queue.enqueue({ text: line.text, gestures: line.gesture ? [line.gesture] : [] });
        }
        if (!this.gotDelta) void ch?.stopActivity();
        if (this.queue.busy && this.state === 'thinking') this.setState('speaking');
        this.queue.closeStream();
        if (this.state === 'thinking') this.setState('idle');
        break;
      }
      case 'error': {
        const source = this.activeSource;
        this.activeSource = null;
        this.currentRequestId = null;
        if (!this.gotDelta) void ch?.stopActivity();
        if (ev.error.kind === 'cancelled') {
          this.queue.closeStream();
          if (this.state === 'thinking') this.setState('idle');
          return;
        }
        if (source === 'idle-chatter') {
          // Unprompted: finish whatever was complete, never announce the error, back off.
          this.noteChatterFailure(ev.error);
          this.queue.closeStream();
          if (this.queue.busy) this.setState('speaking');
          else if (this.state === 'thinking' || this.state === 'speaking') this.setState('idle');
          break;
        }
        // Drop the half-finished sentence; finish what was complete, then the error line.
        this.showError(ev.error, true);
        break;
      }
    }
  }

  private showError(error: AiError, append: boolean): void {
    this.lastError = error;
    const line = errorLine(error);
    if (append) {
      if (line) this.queue.enqueue({ text: line.text, gestures: line.gesture ? [line.gesture] : [] }, { tts: false, variant: 'error' });
      this.queue.closeStream();
      if (this.queue.busy) this.setState('speaking');
      else if (this.state === 'thinking') this.setState('idle');
    } else if (line) {
      this.speakLocal([line], { tts: false, error: error.kind !== 'no-key' });
    }
    if (error.kind === 'no-key') this.api.app.openSettings();
  }

  private async quickAction(action: QuickAction): Promise<void> {
    if (action === 'time') {
      this.noteInteraction();
      this.speakLocal([timeLine(new Date())]);
      return;
    }
    await this.sendChat(QUICK_PROMPTS[action], 'quick-action');
  }

  private noteChatterFailure(error: AiError): void {
    this.lastError = error;
    this.chatterFailures = Math.min(this.chatterFailures + 1, CHATTER_BACKOFF_MAX);
  }

  /** Idle chatter is due: enabled, Bonzi idle and untouched for the (backed-off) interval, user not away. */
  private chatterDue(now: number): boolean {
    const s = this.settings;
    if (!s || !s.idleChatter || !s.hasApiKey || this.state !== 'idle' || this.away) return false;
    if (this.chatBar.isTyping || this.queue.busy || this.mic.recording) return false;
    return now - this.lastInteraction >= s.idleChatterMinutes * 60_000 * 2 ** this.chatterFailures;
  }

  private checkIdleChatter(): void {
    const now = Date.now();
    // A gap far longer than the tick means the PC was asleep: restart the chatter clock from the resume.
    if (now - this.lastIdleTick > IDLE_CHECK_MS * 3) this.lastInteraction = now;
    this.lastIdleTick = now;
    if (this.chatterCheckPending || !this.chatterDue(now)) return;
    this.chatterCheckPending = true;
    void this.api.app
      .getIdleState(AWAY_AFTER_SEC)
      .catch((): SystemIdleState => 'unknown')
      .then((st) => {
        this.chatterCheckPending = false;
        if (st === 'idle' || st === 'locked') {
          // Nobody is there: start counting again, so chatter waits a full interval after the user is back.
          this.lastInteraction = Date.now();
          return;
        }
        if (!this.chatterDue(Date.now())) return;
        this.lastInteraction = Date.now();
        void this.sendChat(IDLE_CHATTER_PROMPT, 'idle-chatter');
      });
  }

  // ------------------------------------------------------------------
  // Voice input

  private async toggleMic(): Promise<void> {
    if (this.mic.recording) {
      this.mic.stop();
      return;
    }
    if (!this.present || this.state === 'transcribing') return;
    this.noteInteraction();
    if (!this.settings?.micEnabled) {
      this.speakLocal([{ text: MIC_LINES.disabled, gesture: 'Explain' }]);
      return;
    }
    this.interrupt(false);
    const ch = this.character!;
    this.chatBar.setMicRecording(false, true);

    const rec = await this.mic.record(() => {
      this.setState('listening');
      ch.startActivity('listening');
      this.chatBar.setMicRecording(true);
      this.balloon.showListening('Listening...', 'Click me or press Enter to stop');
    });
    this.chatBar.setMicRecording(false);

    if (!rec.ok) {
      if (this.state === 'listening') {
        void ch.stopActivity();
        this.setState('idle');
        this.balloon.hide();
      }
      const text =
        rec.reason === 'cancelled'
          ? null
          : rec.reason === 'empty'
            ? MIC_LINES.nothingHeard
            : rec.reason === 'denied'
              ? MIC_LINES.denied
              : rec.reason === 'no-device'
                ? MIC_LINES.noDevice
                : MIC_LINES.failed;
      if (text) this.speakLocal([{ text, gesture: 'Uncertain' }], { error: rec.reason !== 'empty' });
      return;
    }

    if (this.state !== 'listening') return;
    this.setState('transcribing');
    ch.startActivity('processing');
    this.chatBar.setMicRecording(false, true);
    this.balloon.showListening('One moment...', '');

    let stt;
    try {
      stt = await this.api.stt.transcribe({ audio: rec.audio, mime: rec.mime });
    } catch (err) {
      stt = { ok: false as const, error: { kind: 'unknown' as const, message: String(err) } };
    }
    this.chatBar.setMicRecording(false);
    if (!this.is('transcribing')) return;

    if (!stt.ok) {
      void ch.stopActivity();
      this.setState('idle');
      this.balloon.hide();
      if (stt.error.kind === 'cancelled') return;
      this.showError(stt.error, false);
      return;
    }
    const heard = stt.text.trim();
    if (!heard) {
      void ch.stopActivity();
      this.setState('idle');
      this.speakLocal([{ text: MIC_LINES.nothingHeard, gesture: 'Uncertain' }]);
      return;
    }
    if (!this.chatBar.isOpen) this.chatBar.open();
    this.chatBar.setText(heard);
    await delay(450);
    if (!this.is('transcribing')) return;
    this.chatBar.setText('');
    await this.sendChat(heard, 'voice');
  }

  // ------------------------------------------------------------------
  // Commands

  private async onCommand(cmd: AppCommand): Promise<void> {
    switch (cmd.type) {
      case 'open-chat':
        if (this.state === 'hidden' || this.state === 'hiding') await this.show();
        if (this.present) {
          this.noteInteraction();
          this.chatBar.open();
        }
        break;
      case 'quick-action':
        if (this.state === 'hidden' || this.state === 'hiding') await this.show();
        await this.quickAction(cmd.action);
        break;
      case 'play-animation':
        if (this.present) {
          this.noteInteraction();
          void this.character?.playNow(cmd.name);
        }
        break;
      case 'stop':
        this.noteInteraction();
        if (this.mic.recording) this.mic.cancel();
        this.interrupt(true);
        break;
      case 'hide':
        await this.hide();
        break;
      case 'show':
        await this.show();
        break;
      case 'toggle-mic':
        if (this.state === 'hidden' || this.state === 'hiding') await this.show();
        await this.toggleMic();
        break;
      case 'reset-conversation':
        this.interrupt(false);
        await this.api.chat.reset().catch(() => {});
        this.speakLocal([RESET_LINE]);
        break;
      case 'exit':
        await this.exit();
        break;
      case 'reload-character':
        await this.reloadCharacter();
        break;
      case 'drag-cancelled':
        this.pointer.cancelDrag();
        break;
      case 'power':
        this.away = cmd.state === 'suspend' || cmd.state === 'lock';
        // Back at the PC: idle chatter waits a full interval from now.
        if (!this.away) this.lastInteraction = Date.now();
        break;
    }
  }

  private async hide(): Promise<void> {
    if (this.state === 'hidden' || this.state === 'hiding') return;
    if (this.mic.recording) this.mic.cancel();
    this.interrupt(true);
    this.chatBar.close();
    this.balloon.hide(true);
    this.setState('hiding');
    try {
      await this.character?.hide();
    } finally {
      // A Show (or reload) requested during the Hide animation now owns the state: do not report hidden.
      if (this.is('hiding')) {
        this.setState('hidden');
        this.api.window.hidden();
      }
    }
  }

  private async show(): Promise<void> {
    if (this.state !== 'hidden' && this.state !== 'hiding') return;
    if (!this.character) {
      // Still loading: the load in progress plays Show when it finishes.
      if (this.characterLoading) this.setState('loading');
      // The character failed to load: show the error again rather than an empty window.
      else this.fail(CHARACTER_ERROR_LINE);
      return;
    }
    this.setState('showing');
    this.pointer.resync();
    await this.character?.show();
    if (this.is('showing')) this.setState('idle');
    this.noteInteraction();
  }

  private async exit(): Promise<void> {
    // Quitting mid-intro must not pop the settings window open on the way out.
    this.keySettingsPending = false;
    if (this.mic.recording) this.mic.cancel();
    this.chatBar.close();
    if (this.present) {
      this.speakLocal([goodbyeLine(this.random)]);
      await this.waitForSpeech(3500);
      this.balloon.hide();
      this.setState('hiding');
      await Promise.race([this.character?.hide(), delay(3000)]);
    }
    this.api.app.quit();
  }

  private async reloadCharacter(): Promise<void> {
    if (this.mic.recording) this.mic.cancel();
    this.interrupt(true);
    this.chatBar.close();
    this.balloon.hide(true);
    if (this.state === 'hiding') {
      // The Hide animation dies with the old character: report hidden now.
      this.setState('hidden');
      this.api.window.hidden();
    }
    const wasHidden = this.state === 'hidden';
    this.character?.dispose();
    this.character = null;
    this.acs = null;
    this.stage.replaceChildren();
    // Hidden stays hidden while loading. Show and Hide during the load only move
    // the state between 'hidden' and 'loading'; only 'loading' plays Show below.
    this.setState(wasHidden ? 'hidden' : 'loading');
    this.characterLoading = true;
    try {
      await this.loadCharacter();
    } catch (err) {
      console.error('character reload failed', err);
      this.characterLoading = false;
      if (!this.is('hidden')) this.fail(CHARACTER_ERROR_LINE);
      return;
    }
    this.characterLoading = false;
    if (!this.is('loading')) return;
    this.setState('showing');
    await (this.character as CharacterController | null)?.show();
    if (!this.is('showing')) return;
    this.setState('idle');
    this.speakLocal([greetingLine(this.settings?.userName ?? '', this.random)]);
  }
}

