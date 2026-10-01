// AgentWindow with a fake BrowserWindow: the hide/show handshake, ready state,
// click-through recovery after a crash or hang, the drag idle timeout and focus release.

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppCommand } from '../src/shared/ipc.ts';
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts';
import type { Settings } from '../src/shared/settings.ts';

class FakeWebContents extends EventEmitter {
  readonly id = 7;
  readonly sent: { channel: string; payload: unknown }[] = [];
  isDestroyed(): boolean {
    return false;
  }
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
  focus(): void {}
  openDevTools(): void {}
  commands(): AppCommand[] {
    return this.sent.filter((s) => s.channel === 'app:command').map((s) => s.payload as AppCommand);
  }
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  visible = false;
  focused = false;
  bounds = { x: 100, y: 100, width: 400, height: 400 };
  /** Every setIgnoreMouseEvents call, as the ignore flag. */
  readonly ignoreCalls: boolean[] = [];
  readonly onTopCalls: boolean[] = [];
  blurCalls = 0;
  isDestroyed(): boolean {
    return false;
  }
  isVisible(): boolean {
    return this.visible;
  }
  isFocused(): boolean {
    return this.focused;
  }
  showInactive(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
    this.focused = false;
  }
  focus(): void {
    this.focused = true;
  }
  blur(): void {
    this.blurCalls++;
    this.focused = false;
  }
  setAlwaysOnTop(flag: boolean): void {
    this.onTopCalls.push(flag);
  }
  setMenu(): void {}
  /** Options passed with each setIgnoreMouseEvents call (forwarding must never be used). */
  readonly ignoreOptions: unknown[] = [];
  setIgnoreMouseEvents(ignore: boolean, options?: unknown): void {
    this.ignoreCalls.push(ignore);
    this.ignoreOptions.push(options);
  }
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { ...this.bounds };
  }
  setBounds(b: { x: number; y: number; width: number; height: number }): void {
    this.bounds = { ...b };
  }
  loadURL(): Promise<void> {
    return Promise.resolve();
  }
  get lastIgnore(): boolean | undefined {
    return this.ignoreCalls.at(-1);
  }
}

const h = vi.hoisted(() => ({
  win: null as unknown,
  cursor: { x: 0, y: 0 },
}));

vi.mock('electron', () => ({
  BrowserWindow: function FakeBrowserWindow() {
    return h.win;
  },
  screen: {
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getCursorScreenPoint: () => ({ ...h.cursor }),
    on: () => undefined,
    off: () => undefined,
  },
}));
vi.mock('../src/main/paths.ts', () => ({ AGENT_URL: 'app://bonzi/agent/index.html' }));
vi.mock('../src/main/logger.ts', () => ({
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  errorMessage: (e: unknown) => String(e),
}));

const { AgentWindow, DRAG_IDLE_MS, POINTER_POLL_MS, pointerSampleFor } = await import('../src/main/windows/agent-window.ts');

function setup(settings: Partial<Settings> = {}) {
  const win = new FakeWindow();
  h.win = win;
  h.cursor = { x: 0, y: 0 };
  const visibility: boolean[] = [];
  const s: Settings = { ...DEFAULT_SETTINGS, ...settings };
  const aw = new AgentWindow({
    preloadPath: 'preload.cjs',
    iconPath: undefined,
    isPackaged: true,
    getSettings: () => s,
    savePosition: () => undefined,
    getCharacterSize: () => ({ width: 200, height: 160 }),
    isQuitting: () => false,
    onVisibilityChanged: (shown) => visibility.push(shown),
  });
  aw.create();
  return { aw, win, wc: win.webContents, visibility };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentWindow hide/show handshake', () => {
  it('ignores a stale win:hidden that arrives after the user showed Bonzi again', () => {
    const { aw, win, wc } = setup();
    aw.markReady();
    expect(win.visible).toBe(true);
    aw.requestHide(); // tray click 1: asks the renderer to play Hide
    aw.show(); // tray click 2 or the hotkey, before Hide finished
    expect(wc.commands()).toEqual([{ type: 'hide' }, { type: 'show' }]);
    aw.confirmHidden(); // the renderer's win:hidden from the first request
    expect(aw.isShown()).toBe(true);
    expect(win.visible).toBe(true);
  });

  it('hides the window when win:hidden answers a pending hide request', () => {
    const { aw, win, visibility } = setup();
    aw.markReady();
    aw.requestHide();
    expect(win.visible).toBe(true); // waits for the Hide animation
    aw.confirmHidden();
    expect(win.visible).toBe(false);
    expect(aw.isShown()).toBe(false);
    expect(visibility).toEqual([true, false]);
  });
});

describe('AgentWindow ready state', () => {
  it('tells a freshly loaded renderer that Bonzi is shown', () => {
    const { aw, win } = setup();
    expect(aw.markReady()).toEqual({ shown: true });
    expect(win.visible).toBe(true);
  });

  it('tells the renderer to stay hidden when the user hid Bonzi while it loaded', () => {
    const { aw, win, wc } = setup();
    aw.requestHide(); // tray click before win:ready
    expect(aw.markReady()).toEqual({ shown: false });
    expect(win.visible).toBe(false);
    expect(wc.commands()).toEqual([]);
    aw.show();
    expect(win.visible).toBe(true);
    expect(wc.commands()).toEqual([{ type: 'show' }]);
  });

  it('keeps Bonzi hidden across a crash reload', () => {
    const { aw, win, wc } = setup();
    aw.markReady();
    aw.requestHide();
    aw.confirmHidden();
    vi.useFakeTimers();
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(aw.isReady()).toBe(false);
    expect(aw.markReady()).toEqual({ shown: false });
    expect(win.visible).toBe(false);
  });
});

describe('AgentWindow click-through recovery', () => {
  it('makes the window click-through when the renderer dies with the cursor over Bonzi', () => {
    const { aw, win, wc } = setup();
    vi.useFakeTimers();
    aw.markReady();
    aw.setIgnoreMouse(false); // cursor over Bonzi
    expect(win.lastIgnore).toBe(false);
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(win.lastIgnore).toBe(true);
    // Reload: the stale state must not come back with the new document.
    wc.emit('did-finish-load');
    expect(win.lastIgnore).toBe(true);
  });

  it('starts every new document click-through (reload, character-load failure path)', () => {
    const { aw, win, wc } = setup();
    aw.markReady();
    aw.setIgnoreMouse(false);
    aw.reload();
    wc.emit('did-start-loading');
    expect(win.lastIgnore).toBe(true);
    wc.emit('did-finish-load');
    expect(win.lastIgnore).toBe(true);
    // The new renderer reports the real state again.
    aw.setIgnoreMouse(false);
    expect(win.lastIgnore).toBe(false);
  });

  it('stays click-through while the renderer is unresponsive and restores the state after', () => {
    const { aw, win, wc } = setup();
    aw.markReady();
    aw.setIgnoreMouse(false);
    wc.emit('unresponsive');
    expect(win.lastIgnore).toBe(true);
    aw.setIgnoreMouse(false); // a late message still queued from before the hang
    expect(win.lastIgnore).toBe(true);
    wc.emit('responsive');
    expect(win.lastIgnore).toBe(false);
  });

  it('ends a drag when the renderer hangs so the window does not stay hit-testable', () => {
    const { aw, win, wc } = setup();
    vi.useFakeTimers();
    aw.markReady();
    aw.setIgnoreMouse(false);
    aw.dragStart();
    wc.emit('unresponsive');
    expect(win.lastIgnore).toBe(true);
    // No longer following the cursor.
    h.cursor = { x: 500, y: 500 };
    const before = win.getBounds();
    vi.advanceTimersByTime(100);
    expect(win.getBounds()).toEqual(before);
  });
});

describe('AgentWindow drag idle timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('never cuts off a drag that keeps moving', () => {
    const { aw, win, wc } = setup();
    aw.markReady();
    aw.dragStart();
    for (let i = 1; i <= 30; i++) {
      h.cursor = { x: i * 5, y: i * 3 };
      vi.advanceTimersByTime(1_000); // 30 s of slow movement
    }
    expect(wc.commands()).not.toContainEqual({ type: 'drag-cancelled' });
    h.cursor = { x: 400, y: 300 };
    vi.advanceTimersByTime(50);
    const b = win.getBounds();
    expect(b.x).toBe(400 + 100); // still following with the grab offset (cursor 0,0 vs window 100,100)
    aw.dragEnd();
  });

  it('ends a drag with no cursor movement for the idle timeout and tells the renderer', () => {
    const { aw, win, wc } = setup();
    aw.markReady();
    aw.setIgnoreMouse(false);
    aw.dragStart();
    h.cursor = { x: 10, y: 10 };
    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(DRAG_IDLE_MS - 100);
    expect(wc.commands()).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(wc.commands()).toEqual([{ type: 'drag-cancelled' }]);
    // The drag is over: the window no longer follows the cursor.
    const before = win.getBounds();
    h.cursor = { x: 600, y: 600 };
    vi.advanceTimersByTime(100);
    expect(win.getBounds()).toEqual(before);
    // A late dragEnd from the renderer is a no-op.
    aw.dragEnd();
    expect(wc.commands()).toEqual([{ type: 'drag-cancelled' }]);
  });
});

describe('AgentWindow focus release', () => {
  it('blurs an active window, leaving the topmost band during the blur', () => {
    const { aw, win } = setup({ alwaysOnTop: true });
    aw.markReady();
    aw.focus();
    win.onTopCalls.length = 0;
    aw.releaseFocus();
    expect(win.blurCalls).toBe(1);
    expect(win.onTopCalls).toEqual([false, true]);
    expect(win.isFocused()).toBe(false);
  });

  it('does nothing when Bonzi does not hold focus (Deactivate would foreground another window)', () => {
    const { aw, win } = setup({ alwaysOnTop: false });
    aw.markReady();
    aw.releaseFocus();
    expect(win.blurCalls).toBe(0);
    aw.focus();
    aw.releaseFocus();
    expect(win.blurCalls).toBe(1);
    expect(win.onTopCalls.filter((f) => !f).length).toBe(win.onTopCalls.length); // never raised to topmost
  });
});

describe('AgentWindow hover detection by cursor polling', () => {
  function pointerSamples(wc: FakeWebContents): unknown[] {
    return wc.sent.filter((m) => m.channel === 'win:pointer').map((m) => m.payload);
  }

  it('never asks Electron to forward mouse events (no system-wide mouse hook)', () => {
    vi.useFakeTimers();
    const { aw, win, wc } = setup();
    aw.markReady();
    aw.setIgnoreMouse(false);
    aw.setIgnoreMouse(true);
    wc.emit('did-finish-load');
    wc.emit('unresponsive');
    wc.emit('responsive');
    expect(win.ignoreCalls.length).toBeGreaterThan(3);
    for (const o of win.ignoreOptions) expect((o as { forward?: boolean } | undefined)?.forward).not.toBe(true);
  });

  it('sends window-relative samples while the cursor is over the window, deduplicated', () => {
    vi.useFakeTimers();
    const { aw, win, wc } = setup();
    aw.markReady();
    const b = win.getBounds();
    h.cursor = { x: b.x + 230, y: b.y + 300 };
    vi.advanceTimersByTime(POINTER_POLL_MS * 3);
    expect(pointerSamples(wc)).toEqual([{ x: 230, y: 300 }]);
    h.cursor = { x: b.x + 231, y: b.y + 300 };
    vi.advanceTimersByTime(POINTER_POLL_MS);
    expect(pointerSamples(wc)).toEqual([{ x: 230, y: 300 }, { x: 231, y: 300 }]);
  });

  it('sends a single null when the cursor leaves the window', () => {
    vi.useFakeTimers();
    const { aw, win, wc } = setup();
    aw.markReady();
    const b = win.getBounds();
    h.cursor = { x: b.x + 10, y: b.y + 10 };
    vi.advanceTimersByTime(POINTER_POLL_MS);
    h.cursor = { x: b.x - 50, y: b.y - 50 };
    vi.advanceTimersByTime(POINTER_POLL_MS * 5);
    expect(pointerSamples(wc)).toEqual([{ x: 10, y: 10 }, null]);
  });

  it('pauses sampling during a drag and while hidden, and resumes on show', () => {
    vi.useFakeTimers();
    const { aw, win, wc } = setup();
    aw.markReady();
    const b = win.getBounds();
    h.cursor = { x: b.x + 50, y: b.y + 50 };
    vi.advanceTimersByTime(POINTER_POLL_MS);
    aw.dragStart();
    h.cursor = { x: b.x + 90, y: b.y + 90 };
    vi.advanceTimersByTime(POINTER_POLL_MS * 2);
    expect(pointerSamples(wc)).toEqual([{ x: 50, y: 50 }]);
    aw.dragEnd();
    aw.requestHide();
    aw.confirmHidden();
    // Hiding tells the renderer the cursor is gone, then sampling stops.
    expect(pointerSamples(wc).at(-1)).toBeNull();
    const whileHidden = pointerSamples(wc).length;
    h.cursor = { x: win.getBounds().x + 5, y: win.getBounds().y + 5 };
    vi.advanceTimersByTime(POINTER_POLL_MS * 5);
    expect(pointerSamples(wc).length).toBe(whileHidden);
    aw.show();
    vi.advanceTimersByTime(POINTER_POLL_MS);
    expect(pointerSamples(wc).length).toBe(whileHidden + 1);
  });

  it('re-sends the current sample to a reloaded renderer', () => {
    vi.useFakeTimers();
    const { aw, win, wc } = setup();
    aw.markReady();
    const b = win.getBounds();
    h.cursor = { x: b.x + 20, y: b.y + 30 };
    vi.advanceTimersByTime(POINTER_POLL_MS);
    aw.markReady(); // a new document after a reload
    vi.advanceTimersByTime(POINTER_POLL_MS);
    expect(pointerSamples(wc)).toEqual([{ x: 20, y: 30 }, { x: 20, y: 30 }]);
  });

  it('pointerSampleFor maps the cursor into window coordinates', () => {
    const bounds = { x: 100, y: 200, width: 460, height: 760 };
    expect(pointerSampleFor({ x: 100, y: 200 }, bounds)).toEqual({ x: 0, y: 0 });
    expect(pointerSampleFor({ x: 559, y: 959 }, bounds)).toEqual({ x: 459, y: 759 });
    expect(pointerSampleFor({ x: 560, y: 300 }, bounds)).toBeNull();
    expect(pointerSampleFor({ x: 99, y: 300 }, bounds)).toBeNull();
  });
});

describe('AgentWindow drag grab point', () => {
  it('uses the renderer press point as the grab offset', () => {
    vi.useFakeTimers();
    const { aw, win } = setup();
    aw.markReady();
    const b0 = win.getBounds();
    // The drag threshold was crossed 12 px right of the press point.
    h.cursor = { x: b0.x + 212, y: b0.y + 300 };
    aw.dragStart({ x: 200, y: 300 });
    h.cursor = { x: b0.x + 212 - 100, y: b0.y + 300 - 50 };
    vi.advanceTimersByTime(50);
    aw.dragEnd();
    const b1 = win.getBounds();
    // The press point stays under the cursor: window moved by cursor - grab.
    expect(b1.x).toBe(b0.x + 212 - 100 - 200);
    expect(b1.y).toBe(b0.y + 300 - 50 - 300);
  });
});
