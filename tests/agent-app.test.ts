// AgentApp lifecycle tests: the real renderer orchestrator against a minimal
// fake DOM, a fake character engine and a fake preload API. Voice mode is
// 'off', so speech is paced text driven entirely by (fake) timers.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterController, PlayOutcome } from '../src/shared/character-controller.ts';
import type {
  AgentReadyResult,
  AppCommand,
  BonziAgentApi,
  ChatEvent,
  ChatSendRequest,
  ChatSendResult,
  SystemIdleState,
} from '../src/shared/ipc.ts';
import { DEFAULT_SETTINGS, type PublicSettings } from '../src/shared/settings.ts';
import type { AgentApp as AgentAppType, BonziDebug } from '../src/renderer/agent/app.ts';

const ACS_BYTES = (() => {
  const b = readFileSync(fileURLToPath(new URL('../assets/characters/Bonzi.acs', import.meta.url)));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
})();

// ---------------------------------------------------------------------------
// Fake DOM: just enough of HTMLElement for Balloon, ChatBar and PointerController.

type Listener = (e: unknown) => void;

class FakeClassList {
  private readonly set = new Set<string>();
  add(...c: string[]): void {
    for (const x of c) this.set.add(x);
  }
  remove(...c: string[]): void {
    for (const x of c) this.set.delete(x);
  }
  toggle(c: string, force?: boolean): boolean {
    const on = force ?? !this.set.has(c);
    if (on) this.set.add(c);
    else this.set.delete(c);
    return on;
  }
  contains(c: string): boolean {
    return this.set.has(c);
  }
}

class FakeStyle {
  [key: string]: unknown;
  setProperty(k: string, v: string): void {
    this[k] = v;
  }
  removeProperty(k: string): void {
    delete this[k];
  }
}

class FakeEl {
  id = '';
  className = '';
  hidden = false;
  value = '';
  maxLength = 0;
  disabled = false;
  title = '';
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  offsetWidth = 200;
  offsetHeight = 40;
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  readonly classList = new FakeClassList();
  readonly style = new FakeStyle();
  readonly dataset: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private text = '';

  get textContent(): string {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this.text;
  }
  set textContent(v: string) {
    this.children = [];
    this.text = v;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(t: string, f: Listener): void {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(f);
  }
  removeEventListener(t: string, f: Listener): void {
    this.listeners.get(t)?.delete(f);
  }
  dispatch(t: string, e: Record<string, unknown> = {}): void {
    const ev = { preventDefault: () => {}, stopPropagation: () => {}, target: this, ...e };
    for (const f of [...(this.listeners.get(t) ?? [])]) f(ev);
  }
  appendChild(c: FakeEl): FakeEl {
    c.parent?.removeChild(c);
    c.parent = this;
    this.children.push(c);
    return c;
  }
  append(...cs: FakeEl[]): void {
    for (const c of cs) this.appendChild(c);
  }
  insertBefore(c: FakeEl, ref: FakeEl | null): FakeEl {
    if (!ref) return this.appendChild(c);
    c.parent?.removeChild(c);
    c.parent = this;
    this.children.splice(this.children.indexOf(ref), 0, c);
    return c;
  }
  removeChild(c: FakeEl): void {
    this.children = this.children.filter((x) => x !== c);
    c.parent = null;
  }
  replaceChildren(...cs: FakeEl[]): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...cs);
  }
  remove(): void {
    this.parent?.removeChild(this);
  }
  get lastElementChild(): FakeEl | null {
    return this.children[this.children.length - 1] ?? null;
  }
  get previousElementSibling(): FakeEl | null {
    const sib = this.parent?.children ?? [];
    return sib[sib.indexOf(this) - 1] ?? null;
  }
  /** Supports '.cls', ':scope > .cls' and a tag name, which is all the agent code uses. */
  querySelector(sel: string): FakeEl | null {
    const direct = sel.startsWith(':scope >');
    const want = sel.replace(':scope >', '').trim();
    const match = (e: FakeEl): boolean =>
      want.startsWith('.') ? e.className.split(/\s+/).includes(want.slice(1)) || e.classList.contains(want.slice(1)) : false;
    const walk = (e: FakeEl): FakeEl | null => {
      for (const c of e.children) {
        if (match(c)) return c;
        if (!direct) {
          const deep = walk(c);
          if (deep) return deep;
        }
      }
      return null;
    };
    return walk(this);
  }
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { left: 0, top: 0, right: this.offsetWidth, bottom: this.offsetHeight, width: this.offsetWidth, height: this.offsetHeight };
  }
  getClientRects(): unknown[] {
    return [];
  }
  focus(): void {
    doc.activeElement = this;
  }
  blur(): void {
    if (doc.activeElement === this) doc.activeElement = doc.body;
  }
  setSelectionRange(): void {}
  setPointerCapture(): void {}
}

interface FakeDocument {
  body: FakeEl;
  documentElement: FakeEl;
  activeElement: FakeEl;
  windowFocused: boolean;
  byId: Map<string, FakeEl>;
  getElementById(id: string): FakeEl | null;
  createElement(tag: string): FakeEl;
  hasFocus(): boolean;
}

let doc: FakeDocument;
let win: FakeEl & { screenX: number; screenY: number; screen: Record<string, number>; __bonziDebug?: BonziDebug };

function installDom(): void {
  const body = new FakeEl();
  const byId = new Map<string, FakeEl>();
  for (const id of ['stage', 'balloon', 'balloon-text', 'chat-bar', 'chat-input', 'chat-send', 'chat-mic']) {
    const e = new FakeEl();
    e.id = id;
    byId.set(id, e);
  }
  doc = {
    body,
    documentElement: new FakeEl(),
    activeElement: body,
    windowFocused: false,
    byId,
    getElementById: (id) => byId.get(id) ?? null,
    createElement: () => new FakeEl(),
    hasFocus: () => doc.windowFocused,
  };
  win = Object.assign(new FakeEl(), {
    screenX: 700,
    screenY: 100,
    screen: { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040 },
  });
  const store = new Map<string, string>();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running';
      async resume(): Promise<void> {}
    },
  );
}

// ---------------------------------------------------------------------------
// Fake character: Show and Hide run as serial jobs (like the engine's queue);
// the engine starts hidden, and Hide while hidden (or Show while shown) is instant.

const SHOW_MS = 1000;
const HIDE_MS = 2600;

interface FakeCharacter extends CharacterController {
  hiddenNow: boolean;
  shows: number;
  hides: number;
}

function fakeCharacter(): FakeCharacter {
  let chain: Promise<unknown> = Promise.resolve();
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const ok = async (): Promise<PlayOutcome> => 'completed';
  const ch = {
    name: 'Bonzi',
    width: 200,
    height: 160,
    canvas: new FakeEl() as unknown as HTMLCanvasElement,
    hiddenNow: true,
    shows: 0,
    hides: 0,
    hasAnimation: () => true,
    animationNames: () => [],
    show(): Promise<void> {
      const job = chain.then(async () => {
        if (!ch.hiddenNow) return;
        ch.shows++;
        ch.hiddenNow = false;
        await wait(SHOW_MS);
      });
      chain = job;
      return job;
    },
    hide(): Promise<void> {
      const job = chain.then(async () => {
        if (ch.hiddenNow) return;
        ch.hides++;
        await wait(HIDE_MS);
        ch.hiddenNow = true;
      });
      chain = job;
      return job;
    },
    play: ok,
    playNow: ok,
    look: ok,
    startActivity: () => {},
    stopActivity: async () => {},
    beginSpeaking: async () => {},
    endSpeaking: async () => {},
    setMouth: () => {},
    canSpeakDuring: () => false,
    stopAll: () => {},
    setIdleEnabled: () => {},
    notifyUserActivity: () => {},
    setScale: () => {},
    setSoundEnabled: () => {},
    setVolume: () => {},
    hitTest: () => true,
    onFrame: () => () => {},
    dispose: () => {},
  };
  return ch as unknown as FakeCharacter;
}

// ---------------------------------------------------------------------------
// Fake preload API.

interface Harness {
  app: AgentAppType;
  api: BonziAgentApi;
  ch: FakeCharacter;
  calls: {
    hidden: number;
    openSettings: number[];
    releaseFocus: number;
    sends: Array<ChatSendRequest & { at: number }>;
    idleQueries: number;
  };
  command(cmd: AppCommand): void;
  emit(ev: ChatEvent): void;
  debug(): BonziDebug;
  state(): string;
}

interface HarnessOptions {
  settings?: Partial<PublicSettings>;
  ready?: AgentReadyResult;
  send?: (req: ChatSendRequest) => Promise<ChatSendResult>;
  idleState?: () => SystemIdleState;
}

async function startApp(opts: HarnessOptions = {}): Promise<Harness> {
  const { AgentApp } = await import('../src/renderer/agent/app.ts');
  const settings: PublicSettings = {
    ...DEFAULT_SETTINGS,
    voiceMode: 'off',
    firstRunComplete: true,
    hasApiKey: true,
    apiKeyHint: 'sk-...test',
    apiKeySource: 'stored',
    safeStorageAvailable: true,
    characterName: 'Bonzi',
    hotkeyError: null,
    ...opts.settings,
  };
  const calls: Harness['calls'] = { hidden: 0, openSettings: [], releaseFocus: 0, sends: [], idleQueries: 0 };
  let onCommand: ((cmd: AppCommand) => void) | null = null;
  let onEvent: ((ev: ChatEvent) => void) | null = null;
  let reqId = 0;
  const api: BonziAgentApi = {
    loadCharacter: async () => ({ bytes: ACS_BYTES, fileName: 'Bonzi.acs', isBundled: true }),
    chat: {
      send: (req) => {
        calls.sends.push({ ...req, at: Date.now() });
        return opts.send ? opts.send(req) : Promise.resolve({ ok: true, requestId: `r${++reqId}` });
      },
      cancel: async () => {},
      reset: async () => {},
      onEvent: (cb) => {
        onEvent = cb;
        return () => {};
      },
    },
    tts: { synthesize: async () => ({ ok: false, error: { kind: 'unknown', message: 'unused' } }) },
    stt: { transcribe: async () => ({ ok: false, error: { kind: 'unknown', message: 'unused' } }) },
    window: {
      setIgnoreMouseEvents: () => {},
      onPointer: () => () => {},
      dragStart: () => {},
      dragEnd: () => {},
      showContextMenu: () => {},
      focus: () => {
        doc.windowFocused = true;
      },
      releaseFocus: () => {
        calls.releaseFocus++;
        doc.windowFocused = false;
      },
      hidden: () => {
        calls.hidden++;
      },
      ready: async () => opts.ready ?? { shown: true },
    },
    app: {
      openSettings: () => {
        calls.openSettings.push(Date.now());
      },
      quit: () => {},
      getInfo: async () => ({ name: 'x', version: '0', electron: '0', chrome: '0', node: '0', platform: 'win32', arch: 'x64', isPackaged: false }),
      getIdleState: async () => {
        calls.idleQueries++;
        return opts.idleState ? opts.idleState() : 'active';
      },
      onCommand: (cb) => {
        onCommand = cb;
        return () => {};
      },
    },
    settings: {
      get: async () => settings,
      onChanged: () => () => {},
    },
  };
  const ch = fakeCharacter();
  const app = new AgentApp({ api, createCharacter: () => ch, random: () => 0 });
  void app.start();
  return {
    app,
    api,
    ch,
    calls,
    command: (cmd) => onCommand!(cmd),
    emit: (ev) => onEvent!(ev),
    debug: () => win.__bonziDebug!,
    state: () => win.__bonziDebug!.getState(),
  };
}

/** Lets startup finish: load, ready, the 150 ms delay and the Show animation, but not the greeting. */
async function untilShown(): Promise<void> {
  await vi.advanceTimersByTimeAsync(150 + SHOW_MS + 50);
}

/** Lets all queued speech finish (paced text). */
async function drainSpeech(): Promise<void> {
  await vi.advanceTimersByTimeAsync(60_000);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  installDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('AgentApp hide and show', () => {
  it('a Show during the Hide animation wins (F03)', async () => {
    const h = await startApp();
    await untilShown();
    await drainSpeech();
    expect(h.state()).toBe('idle');

    h.command({ type: 'hide' });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.state()).toBe('hiding');
    h.command({ type: 'show' });
    await vi.advanceTimersByTimeAsync(HIDE_MS + SHOW_MS + 500);

    expect(h.state()).toBe('idle');
    expect(h.ch.hiddenNow).toBe(false);
    expect(h.ch.shows).toBe(2);
    expect(h.calls.hidden).toBe(0);
  });

  it('Hide, Show, Hide again reports hidden exactly once', async () => {
    const h = await startApp();
    await untilShown();
    await drainSpeech();
    h.command({ type: 'hide' });
    await vi.advanceTimersByTimeAsync(300);
    h.command({ type: 'show' });
    await vi.advanceTimersByTimeAsync(300);
    h.command({ type: 'hide' });
    await vi.advanceTimersByTimeAsync(3 * (HIDE_MS + SHOW_MS));
    expect(h.state()).toBe('hidden');
    expect(h.ch.hiddenNow).toBe(true);
    expect(h.calls.hidden).toBe(1);
  });

  it('open-chat during the Hide animation brings Bonzi back with the chat bar open', async () => {
    const h = await startApp();
    await untilShown();
    await drainSpeech();
    h.command({ type: 'hide' });
    await vi.advanceTimersByTimeAsync(400);
    h.command({ type: 'open-chat' });
    await vi.advanceTimersByTimeAsync(HIDE_MS + SHOW_MS + 500);
    expect(h.state()).toBe('idle');
    expect(doc.byId.get('chat-bar')!.classList.contains('open')).toBe(true);
    expect(h.calls.hidden).toBe(0);
  });
});

describe('AgentApp startup while hidden (F05)', () => {
  it('stays hidden and silent when main says the user has Bonzi hidden, then shows on request', async () => {
    const h = await startApp({ ready: { shown: false } });
    await untilShown();
    await drainSpeech();
    expect(h.state()).toBe('hidden');
    expect(h.ch.shows).toBe(0);
    expect(h.debug().speechLog).toEqual([]);

    h.command({ type: 'show' });
    await vi.advanceTimersByTimeAsync(SHOW_MS + 100);
    expect(h.state()).toBe('idle');
    expect(h.ch.shows).toBe(1);
    expect(h.ch.hiddenNow).toBe(false);
  });

  it('a Hide during the startup delay wins: no Show, no greeting', async () => {
    const h = await startApp();
    // Let loading and ready finish, then hide inside the 150 ms delay.
    await vi.advanceTimersByTimeAsync(50);
    h.command({ type: 'hide' });
    await drainSpeech();
    expect(h.state()).toBe('hidden');
    expect(h.ch.shows).toBe(0);
    expect(h.debug().speechLog).toEqual([]);
  });

  it('a Hide during the Show animation skips the greeting', async () => {
    const h = await startApp();
    await vi.advanceTimersByTimeAsync(150 + 300);
    expect(h.state()).toBe('showing');
    h.command({ type: 'hide' });
    await drainSpeech();
    expect(h.state()).toBe('hidden');
    expect(h.debug().speechLog).toEqual([]);
  });

  it('greets once shown on a normal start', async () => {
    const h = await startApp();
    await untilShown();
    await drainSpeech();
    expect(h.state()).toBe('idle');
    expect(h.debug().speechLog.length).toBe(1);
  });
});

describe('AgentApp first run without a key (F16)', () => {
  const firstRun = { firstRunComplete: false, hasApiKey: false, apiKeySource: 'none' as const, apiKeyHint: null };

  it('opens settings when the key line starts, not before', async () => {
    const h = await startApp({ settings: firstRun });
    await untilShown();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.calls.openSettings).toEqual([]);
    await drainSpeech();
    expect(h.calls.openSettings.length).toBe(1);
    const keyLine = h.debug().speechLog.find((e) => /API key/.test(e.text));
    expect(keyLine).toBeDefined();
    expect(h.calls.openSettings[0]).toBeGreaterThanOrEqual(keyLine!.at);
    expect(h.calls.openSettings[0]! - keyLine!.at).toBeLessThan(100);
  });

  it('still opens settings once when the intro is cut short', async () => {
    const h = await startApp({ settings: firstRun });
    await untilShown();
    await vi.advanceTimersByTimeAsync(1_000);
    h.command({ type: 'stop' });
    await drainSpeech();
    expect(h.calls.openSettings.length).toBe(1);
    expect(h.debug().speechLog.some((e) => /API key/.test(e.text))).toBe(false);
  });

  it('does not open settings when the user exits during the intro', async () => {
    const h = await startApp({ settings: firstRun });
    await untilShown();
    await vi.advanceTimersByTimeAsync(1_000);
    h.command({ type: 'exit' });
    await drainSpeech();
    expect(h.calls.openSettings).toEqual([]);
  });
});

describe('AgentApp idle chatter (F08)', () => {
  const chatter = { idleChatter: true, idleChatterMinutes: 1 };
  const network = { kind: 'network' as const, message: 'offline' };

  /** Startup plus the short greeting, well inside the first chatter interval. */
  async function settled(): Promise<void> {
    await untilShown();
    await vi.advanceTimersByTimeAsync(5_000);
  }

  it('never speaks a failed chatter request and backs off', async () => {
    const h = await startApp({ settings: chatter, send: async () => ({ ok: false, error: network }) });
    await settled();
    const greeted = h.debug().speechLog.length;
    expect(greeted).toBe(1);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(h.calls.sends.map((s) => s.source)).toEqual(['idle-chatter']);
    expect(h.debug().lastError?.kind).toBe('network');
    expect(h.state()).toBe('idle');
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    // Silent every time, and each failure doubles the wait (1, 2, 4, 8, then 16 min).
    expect(h.debug().speechLog.length).toBe(greeted);
    const at = h.calls.sends.map((s) => s.at);
    expect(at.length).toBe(4);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(2 * 60_000);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(4 * 60_000);
    expect(at[3]! - at[2]!).toBeGreaterThanOrEqual(8 * 60_000);
  });

  it('a streamed error during chatter is silent too', async () => {
    const h = await startApp({ settings: chatter });
    await settled();
    const greeted = h.debug().speechLog.length;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(h.calls.sends.length).toBe(1);
    expect(h.state()).toBe('thinking');
    h.emit({ type: 'error', requestId: 'r1', error: { kind: 'quota', message: 'no credits' } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.debug().speechLog.length).toBe(greeted);
    expect(h.debug().lastError?.kind).toBe('quota');
    expect(h.state()).toBe('idle');
  });

  it('a successful chatter reply resets the backoff', async () => {
    let fail = true;
    const h = await startApp({
      settings: chatter,
      send: async () => (fail ? { ok: false, error: network } : { ok: true, requestId: 'ok' }),
    });
    await settled();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(h.calls.sends.length).toBe(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 30_000);
    expect(h.calls.sends.length).toBe(2);
    h.emit({ type: 'delta', requestId: 'ok', text: 'Bananas are berries!' });
    h.emit({ type: 'done', requestId: 'ok', text: 'Bananas are berries!', finishReason: 'stop' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.debug().speechLog.at(-1)?.text).toBe('Bananas are berries!');
    // Back to the plain 1 minute interval.
    const last = h.calls.sends.at(-1)!.at;
    await vi.advanceTimersByTimeAsync(95_000);
    expect(h.calls.sends.length).toBe(3);
    expect(h.calls.sends[2]!.at - last).toBeLessThan(2 * 60_000);
  });

  it('a user request still announces its error', async () => {
    const h = await startApp({ send: async () => ({ ok: false, error: network }) });
    await settled();
    h.command({ type: 'quick-action', action: 'joke' });
    await drainSpeech();
    expect(h.debug().speechLog.at(-1)?.text).toMatch(/can't reach the server/);
  });

  it('waits while the user is away or the session is locked', async () => {
    let presence: SystemIdleState = 'locked';
    const h = await startApp({ settings: chatter, idleState: () => presence });
    await settled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.calls.idleQueries).toBeGreaterThan(0);
    expect(h.calls.sends).toEqual([]);
    presence = 'active';
    // Back: a full interval from the last away check, not at once.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls.sends).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls.sends.map((s) => s.source)).toEqual(['idle-chatter']);
  });

  it('pauses on lock and suspend power events', async () => {
    const h = await startApp({ settings: chatter });
    await settled();
    h.command({ type: 'power', state: 'lock' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.calls.sends).toEqual([]);
    h.command({ type: 'power', state: 'unlock' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls.sends).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls.sends.length).toBe(1);
  });

  it('restarts the chatter clock after the PC slept', async () => {
    const h = await startApp({ settings: { ...chatter, idleChatterMinutes: 5 } });
    await settled();
    await vi.advanceTimersByTimeAsync(60_000);
    // Sleep: the wall clock jumps 2 hours while the 30 s ticker does not run.
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls.sends).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.calls.sends.length).toBe(1);
  });
});

describe('AgentApp empty replies (F22)', () => {
  it('says why when a reply ends without words', async () => {
    const h = await startApp();
    await untilShown();
    await drainSpeech();
    h.command({ type: 'quick-action', action: 'fact' });
    await vi.advanceTimersByTimeAsync(10);
    h.emit({ type: 'done', requestId: 'r1', text: '', finishReason: 'length' });
    await drainSpeech();
    expect(h.debug().speechLog.at(-1)?.text).toMatch(/Max reply tokens/);
    expect(h.state()).toBe('idle');
  });

  it('counts a tags-only reply as empty', async () => {
    const h = await startApp();
    await untilShown();
    await drainSpeech();
    h.command({ type: 'quick-action', action: 'fact' });
    await vi.advanceTimersByTimeAsync(10);
    h.emit({ type: 'delta', requestId: 'r1', text: '[[Wave]] ' });
    h.emit({ type: 'done', requestId: 'r1', text: '[[Wave]] ', finishReason: 'content_filter' });
    await drainSpeech();
    expect(h.debug().speechLog.at(-1)?.text).toMatch(/can't answer that one/);
  });

  it('adds nothing to a normal reply', async () => {
    const h = await startApp();
    await untilShown();
    await drainSpeech();
    const before = h.debug().speechLog.length;
    h.command({ type: 'quick-action', action: 'fact' });
    await vi.advanceTimersByTimeAsync(10);
    h.emit({ type: 'delta', requestId: 'r1', text: '4. Easy peasy!' });
    h.emit({ type: 'done', requestId: 'r1', text: '4. Easy peasy!', finishReason: 'stop' });
    await drainSpeech();
    expect(h.debug().speechLog.slice(before).map((e) => e.text)).toEqual(['4. Easy peasy!']);
  });

  it('stays silent for an empty idle-chatter reply', async () => {
    const h = await startApp({ settings: { idleChatter: true, idleChatterMinutes: 1 } });
    await untilShown();
    await drainSpeech();
    const before = h.debug().speechLog.length;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(h.calls.sends.length).toBe(1);
    h.emit({ type: 'done', requestId: 'r1', text: '', finishReason: 'length' });
    await drainSpeech();
    expect(h.debug().speechLog.length).toBe(before);
  });
});

describe('AgentApp chat bar focus (F14)', () => {
  it('hands keyboard focus back when the chat bar closes with Esc', async () => {
    const h = await startApp();
    await untilShown();
    await drainSpeech();
    h.command({ type: 'open-chat' });
    expect(doc.windowFocused).toBe(true);
    doc.byId.get('chat-input')!.dispatch('keydown', { key: 'Escape', isComposing: false });
    expect(h.calls.releaseFocus).toBe(1);
    expect(doc.windowFocused).toBe(false);
  });

  it('hands focus back after the inactivity auto-close', async () => {
    const h = await startApp();
    await untilShown();
    await drainSpeech();
    h.command({ type: 'open-chat' });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(doc.byId.get('chat-bar')!.classList.contains('open')).toBe(false);
    expect(h.calls.releaseFocus).toBe(1);
  });

  it('leaves focus alone when the agent window is not focused', async () => {
    const h = await startApp();
    await untilShown();
    await drainSpeech();
    h.command({ type: 'open-chat' });
    // The user clicked into another app meanwhile.
    doc.windowFocused = false;
    doc.byId.get('chat-input')!.dispatch('keydown', { key: 'Escape', isComposing: false });
    expect(h.calls.releaseFocus).toBe(0);
  });
});

describe('AgentApp overlays at screen edges (F13)', () => {
  it('caps the balloon and chat bar to the visible span', async () => {
    // Bonzi flush with the left screen edge: the 460 px window hangs 130 px off screen.
    const h = await startApp();
    win.screenX = -130;
    await untilShown();
    h.command({ type: 'open-chat' });
    expect(doc.byId.get('balloon')!.style.maxWidth).toBe('322px');
    expect(doc.byId.get('chat-bar')!.style.maxWidth).toBe('322px');
    await drainSpeech();
  });

  it('leaves the full widths in the middle of the screen', async () => {
    const h = await startApp();
    await untilShown();
    h.command({ type: 'open-chat' });
    expect(doc.byId.get('balloon')!.style.maxWidth).toBe('340px');
    expect(doc.byId.get('chat-bar')!.style.maxWidth).toBe('460px');
    await drainSpeech();
  });
});
