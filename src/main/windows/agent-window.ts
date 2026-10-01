// The transparent, frameless, always-on-top character window.
// Owns geometry (layout, clamping, drag), click-through state, the
// hide/show handshake with the renderer and crash recovery.

import { BrowserWindow, screen } from 'electron';
import type { Display, WebContents } from 'electron';
import {
  characterPositionForWindow,
  clampCharacterToWorkAreas,
  computeAgentLayout,
  defaultCharacterPosition,
  windowPositionForCharacter,
} from '../../shared/layout.ts';
import type { AgentLayout, Point, Rect } from '../../shared/layout.ts';
import { IPC } from '../../shared/ipc.ts';
import type { AgentReadyResult, AppCommand, PointerSample } from '../../shared/ipc.ts';
import type { SavedPosition, Settings } from '../../shared/settings.ts';
import { log } from '../logger.ts';
import { AGENT_URL } from '../paths.ts';

const DRAG_TICK_MS = 16;
/** Cursor sampling rate for hover detection (about 30 Hz). */
export const POINTER_POLL_MS = 33;
/** A drag ends by itself after this long without cursor movement (a lost mouseup). */
export const DRAG_IDLE_MS = 10_000;
const HIDE_FALLBACK_MS = 4_000;
const CRASH_BACKOFF_MS = [500, 2_000, 5_000, 15_000, 30_000];
const CRASH_RESET_MS = 60_000;

export interface AgentWindowOptions {
  preloadPath: string;
  iconPath: string | undefined;
  isPackaged: boolean;
  getSettings: () => Settings;
  savePosition: (pos: SavedPosition) => void;
  getCharacterSize: () => { width: number; height: number };
  isQuitting: () => boolean;
  /** Called on every win:ready from the renderer (initial load and after reloads). */
  onReady?: () => void;
  onVisibilityChanged?: (shown: boolean) => void;
  /** Windows is logging off or shutting down: the app must let windows close. */
  onSessionEnd?: () => void;
}

interface DragState {
  offset: Point;
  last: Point;
  timer: ReturnType<typeof setInterval>;
  safety: ReturnType<typeof setTimeout>;
}

/** Cursor position relative to the window, or null when the cursor is outside it. */
export function pointerSampleFor(cursor: Point, bounds: Rect): PointerSample {
  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;
  if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return null;
  return { x, y };
}

function workAreas(): Rect[] {
  return screen.getAllDisplays().map((d: Display) => ({ ...d.workArea }));
}

export class AgentWindow {
  readonly #opts: AgentWindowOptions;
  #win: BrowserWindow | null = null;
  #layout: AgentLayout;
  #ignoreRequested = true;
  /** The renderer is unresponsive: it cannot report the cursor leaving Bonzi, so stay click-through. */
  #hung = false;
  #drag: DragState | null = null;
  #pointerTimer: ReturnType<typeof setInterval> | null = null;
  /** Last sample sent to the renderer; undefined = none sent since polling (re)started. */
  #lastPointer: PointerSample | undefined = undefined;
  #ready = false;
  #hiddenByUser = false;
  #hideFallback: ReturnType<typeof setTimeout> | null = null;
  #crashCount = 0;
  #lastCrashAt = 0;
  #reloadTimer: ReturnType<typeof setTimeout> | null = null;
  #sessionEnding = false;
  #displayListener = (): void => this.#onDisplaysChanged();
  #metricsListener = (): void => {
    this.#onDisplaysChanged();
    this.#applyIgnore();
  };

  constructor(options: AgentWindowOptions) {
    this.#opts = options;
    const size = options.getCharacterSize();
    this.#layout = computeAgentLayout(size.width, size.height, options.getSettings().scale);
  }

  get window(): BrowserWindow | null {
    return this.#win && !this.#win.isDestroyed() ? this.#win : null;
  }

  get webContents(): WebContents | null {
    const w = this.window;
    return w && !w.webContents.isDestroyed() ? w.webContents : null;
  }

  get layout(): AgentLayout {
    return this.#layout;
  }

  isReady(): boolean {
    return this.#ready;
  }

  /** True unless the user hid Bonzi (the window may still be loading). */
  isShown(): boolean {
    return !this.#hiddenByUser;
  }

  create(): BrowserWindow {
    const existing = this.window;
    if (existing) return existing;
    const settings = this.#opts.getSettings();
    const size = this.#opts.getCharacterSize();
    this.#layout = computeAgentLayout(size.width, size.height, settings.scale);
    const charPos = this.#initialCharacterPosition(settings);
    const winPos = windowPositionForCharacter(this.#layout, charPos);

    const win = new BrowserWindow({
      x: winPos.x,
      y: winPos.y,
      width: this.#layout.width,
      height: this.#layout.height,
      transparent: true,
      frame: false,
      backgroundColor: '#00000000',
      hasShadow: false,
      roundedCorners: false,
      thickFrame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      focusable: true,
      alwaysOnTop: settings.alwaysOnTop,
      title: 'BonziBuddy Reborn',
      ...(this.#opts.iconPath ? { icon: this.#opts.iconPath } : {}),
      webPreferences: {
        preload: this.#opts.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        spellcheck: false,
        devTools: !this.#opts.isPackaged,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    this.#win = win;
    win.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
    win.setMenu(null);
    this.#applyIgnore();

    const onSessionEnd = (): void => {
      if (this.#sessionEnding) return;
      this.#sessionEnding = true;
      this.#opts.onSessionEnd?.();
    };
    win.on('query-session-end', onSessionEnd);
    win.on('session-end', onSessionEnd);
    win.on('close', (event) => {
      if (!this.#opts.isQuitting() && !this.#sessionEnding) {
        // Alt+F4 on the character hides it; only Exit quits the app.
        event.preventDefault();
        this.requestHide();
      }
    });
    win.on('closed', () => {
      this.#stopDrag();
      this.#stopPointerPolling(false);
      this.#clearTimers();
      screen.off('display-added', this.#displayListener);
      screen.off('display-removed', this.#displayListener);
      screen.off('display-metrics-changed', this.#metricsListener);
      this.#win = null;
      this.#ready = false;
      // A page-initiated window.close() bypasses the 'close' guard; bring Bonzi back.
      if (!this.#opts.isQuitting() && !this.#sessionEnding) {
        log.warn('Agent window closed unexpectedly; recreating it.');
        this.#reloadTimer = setTimeout(() => {
          this.#reloadTimer = null;
          if (!this.#opts.isQuitting() && !this.#sessionEnding) this.create();
        }, 1_000);
      }
    });

    const wc = win.webContents;
    // A fresh document starts click-through, matching PointerController's initial
    // state; the new renderer re-sends the real state once it is ready. Without this
    // a stale "cursor over Bonzi" from the previous document keeps swallowing clicks.
    // did-navigate repeats the reset once the new document has committed, so a late
    // message from the outgoing document cannot leave main out of step.
    const resetForNewDocument = (): void => {
      this.dragEnd();
      this.#hung = false;
      this.#ignoreRequested = true;
      this.#applyIgnore();
    };
    wc.on('did-start-loading', resetForNewDocument);
    wc.on('did-navigate', resetForNewDocument);
    wc.on('did-finish-load', () => this.#applyIgnore());
    wc.on('render-process-gone', (_e, details) => {
      this.#ready = false;
      this.#stopDrag();
      this.#stopPointerPolling(false);
      // A dead renderer cannot report the cursor leaving Bonzi, so stop swallowing clicks.
      this.#hung = false;
      this.#ignoreRequested = true;
      this.#applyIgnore();
      if (this.#opts.isQuitting()) return;
      log.error(`Agent renderer gone (${details.reason}, exit code ${details.exitCode})`);
      this.#scheduleReload();
    });
    wc.on('unresponsive', () => {
      log.warn('Agent renderer unresponsive; making the window click-through.');
      this.#hung = true;
      // Ends a drag (no-op without one) so #applyIgnore is not skipped.
      this.dragEnd();
      this.#applyIgnore();
    });
    wc.on('responsive', () => {
      if (!this.#hung) return;
      log.info('Agent renderer responsive again.');
      this.#hung = false;
      this.#applyIgnore();
    });
    wc.on('preload-error', (_e, preloadPath, error) => {
      log.error(`Agent preload failed (${preloadPath}): ${error.message}`);
    });

    screen.on('display-added', this.#displayListener);
    screen.on('display-removed', this.#displayListener);
    screen.on('display-metrics-changed', this.#metricsListener);

    if (!this.#opts.isPackaged && process.env.BONZI_DEVTOOLS === '1') {
      wc.openDevTools({ mode: 'detach', activate: false });
    }
    void win.loadURL(AGENT_URL).catch((err: unknown) => {
      log.error(`Agent window failed to load: ${err instanceof Error ? err.message : String(err)}`);
    });
    return win;
  }

  send(cmd: AppCommand): boolean {
    return this.sendChannel(IPC.appCommand, cmd);
  }

  sendChannel(channel: string, payload: unknown): boolean {
    const wc = this.webContents;
    if (!wc) return false;
    try {
      wc.send(channel, payload);
      return true;
    } catch (err) {
      log.warn(`Could not send ${channel} to agent: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Click-through

  setIgnoreMouse(ignore: boolean): void {
    this.#ignoreRequested = ignore;
    if (!this.#drag) this.#applyIgnore();
  }

  #applyIgnore(): void {
    const win = this.window;
    if (!win || this.#drag) return;
    // Deliberately no { forward: true }. On Windows, Electron implements forwarding
    // with a system-wide low-level mouse hook serviced by this (main) thread, so every
    // mouse move on the PC waits for us, and in practice the forwarded moves often never
    // reach the page. Hover is detected by polling the cursor instead (#pointerTick).
    win.setIgnoreMouseEvents(this.#ignoreRequested || this.#hung);
  }

  // ---------------------------------------------------------------------------
  // Hover detection: sample the cursor and tell the renderer where it is over the
  // window, so it can hit-test Bonzi's pixels and toggle click-through. Cheap: two
  // native calls per tick and an IPC message only when the sample changes.

  #startPointerPolling(): void {
    if (this.#pointerTimer) return;
    this.#lastPointer = undefined;
    this.#pointerTimer = setInterval(() => this.#pointerTick(), POINTER_POLL_MS);
  }

  /** notify: tell the renderer the cursor is gone (it may still think it is over Bonzi). */
  #stopPointerPolling(notify: boolean): void {
    if (!this.#pointerTimer) return;
    clearInterval(this.#pointerTimer);
    this.#pointerTimer = null;
    if (notify && this.#lastPointer) this.sendChannel(IPC.winPointer, null);
    this.#lastPointer = undefined;
  }

  #pointerTick(): void {
    const win = this.window;
    // During a drag the renderer has pointer capture; a hung renderer cannot consume samples.
    if (!win || !this.#ready || this.#drag || this.#hung || !win.isVisible()) return;
    const sample = pointerSampleFor(screen.getCursorScreenPoint(), win.getBounds());
    const last = this.#lastPointer;
    const same = sample === null ? last === null : last != null && last.x === sample.x && last.y === sample.y;
    if (same) return;
    this.#lastPointer = sample;
    this.sendChannel(IPC.winPointer, sample);
  }

  // ---------------------------------------------------------------------------
  // Drag

  /** grab: the press point in window px from the renderer; else measured from the cursor now. */
  dragStart(grab?: Point): void {
    const win = this.window;
    if (!win || this.#drag || this.#hung) return;
    const b = win.getBounds();
    let offset: Point;
    if (grab && grab.x < b.width && grab.y < b.height) offset = { x: grab.x, y: grab.y };
    else {
      const cursor = screen.getCursorScreenPoint();
      offset = { x: cursor.x - b.x, y: cursor.y - b.y };
    }
    const timer = setInterval(() => this.#dragTick(), DRAG_TICK_MS);
    this.#drag = { offset, last: { x: b.x, y: b.y }, timer, safety: this.#armDragSafety() };
  }

  /**
   * Safety net for a lost mouseup: ends the drag after DRAG_IDLE_MS without cursor
   * movement (re-armed on every move, so a slow drag is never cut off) and tells the
   * renderer, which otherwise keeps its drag state until a pointerup.
   */
  #armDragSafety(): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (!this.#drag) return;
      log.warn('Drag idle timeout reached; ending drag.');
      this.dragEnd();
      this.send({ type: 'drag-cancelled' });
    }, DRAG_IDLE_MS);
  }

  #dragTick(): void {
    const win = this.window;
    const drag = this.#drag;
    if (!win || !drag) return;
    const c = screen.getCursorScreenPoint();
    const x = c.x - drag.offset.x;
    const y = c.y - drag.offset.y;
    if (x === drag.last.x && y === drag.last.y) return;
    drag.last = { x, y };
    clearTimeout(drag.safety);
    drag.safety = this.#armDragSafety();
    // setBounds with an explicit size avoids DPI-change resizes when crossing monitors.
    win.setBounds({ x, y, width: this.#layout.width, height: this.#layout.height });
  }

  dragEnd(): void {
    if (!this.#drag) return;
    this.#dragTick();
    this.#stopDrag();
    this.#clampAndPersist(true);
    this.#applyIgnore();
  }

  #stopDrag(): void {
    if (!this.#drag) return;
    clearInterval(this.#drag.timer);
    clearTimeout(this.#drag.safety);
    this.#drag = null;
  }

  // ---------------------------------------------------------------------------
  // Geometry

  #initialCharacterPosition(settings: Settings): Point {
    const areas = workAreas();
    const pos = settings.position ?? defaultCharacterPosition(this.#layout, screen.getPrimaryDisplay().workArea);
    return clampCharacterToWorkAreas(this.#layout, pos, areas);
  }

  #currentCharacterPosition(): Point | null {
    const win = this.window;
    if (!win) return null;
    const b = win.getBounds();
    return characterPositionForWindow(this.#layout, { x: b.x, y: b.y });
  }

  /** Moves the window so the character box is at charPos (clamped), optionally persisting it. */
  #placeCharacter(charPos: Point, persist: boolean): void {
    const win = this.window;
    if (!win) return;
    const clamped = clampCharacterToWorkAreas(this.#layout, charPos, workAreas());
    const wp = windowPositionForCharacter(this.#layout, clamped);
    const b = win.getBounds();
    if (b.x !== wp.x || b.y !== wp.y || b.width !== this.#layout.width || b.height !== this.#layout.height) {
      win.setBounds({ x: wp.x, y: wp.y, width: this.#layout.width, height: this.#layout.height });
    }
    if (persist) this.#opts.savePosition({ x: clamped.x, y: clamped.y });
  }

  #clampAndPersist(persist: boolean): void {
    const pos = this.#currentCharacterPosition();
    if (pos) this.#placeCharacter(pos, persist);
  }

  /** Recomputes the layout (scale or character changed), keeping the character box in place. */
  relayout(): void {
    const before = this.#currentCharacterPosition();
    const size = this.#opts.getCharacterSize();
    this.#layout = computeAgentLayout(size.width, size.height, this.#opts.getSettings().scale);
    if (!before) return;
    this.#placeCharacter(before, false);
    const after = this.#currentCharacterPosition();
    if (after && (after.x !== before.x || after.y !== before.y)) this.#opts.savePosition(after);
  }

  #onDisplaysChanged(): void {
    if (this.#drag) return;
    const before = this.#currentCharacterPosition();
    if (!before) return;
    this.#placeCharacter(before, false);
    const after = this.#currentCharacterPosition();
    if (after && (after.x !== before.x || after.y !== before.y)) this.#opts.savePosition(after);
  }

  setAlwaysOnTop(flag: boolean): void {
    this.window?.setAlwaysOnTop(flag, 'floating');
  }

  focus(): void {
    const win = this.window;
    if (!win || !win.isVisible()) return;
    win.focus();
    win.webContents.focus();
  }

  /** Gives the keyboard back to the window under Bonzi (the app that was active before). */
  releaseFocus(): void {
    const win = this.window;
    // Chromium's Deactivate() foregrounds the next visible window in z-order even when
    // this window is not active, so act only while Bonzi actually holds focus.
    if (!win || !win.isVisible() || !win.isFocused()) return;
    const onTop = this.#opts.getSettings().alwaysOnTop;
    // Leave the topmost band first so the walk skips overlays and other always-on-top
    // windows and lands on the top normal window. Both calls use SWP_NOACTIVATE.
    if (onTop) win.setAlwaysOnTop(false);
    win.blur();
    if (onTop) win.setAlwaysOnTop(true, 'floating');
  }

  // ---------------------------------------------------------------------------
  // Ready / show / hide handshake

  /**
   * win:ready from the renderer (first load and every reload). The result tells the
   * fresh renderer whether the user has Bonzi hidden, in which case it must stay hidden
   * until main sends {type:'show'}.
   */
  markReady(): AgentReadyResult {
    const win = this.window;
    if (!win) return { shown: !this.#hiddenByUser };
    this.#ready = true;
    if (!this.#hiddenByUser && !win.isVisible()) {
      win.showInactive();
      win.setAlwaysOnTop(this.#opts.getSettings().alwaysOnTop, 'floating');
      this.#applyIgnore();
      this.#opts.onVisibilityChanged?.(true);
    }
    if (!this.#hiddenByUser) {
      // A fresh document knows nothing yet: re-send the current sample on the next tick.
      this.#lastPointer = undefined;
      this.#startPointerPolling();
    }
    this.#opts.onReady?.();
    return { shown: !this.#hiddenByUser };
  }

  /** Shows Bonzi (no focus steal) and lets the renderer play its Show animation. */
  show(): void {
    const win = this.window;
    const wasHidden = this.#hiddenByUser;
    const wasHiding = this.#hideFallback !== null;
    this.#hiddenByUser = false;
    if (this.#hideFallback) {
      clearTimeout(this.#hideFallback);
      this.#hideFallback = null;
    }
    if (!win || !this.#ready) {
      if (wasHidden) this.#opts.onVisibilityChanged?.(true);
      return;
    }
    const visible = win.isVisible();
    if (!visible) {
      this.#clampAndPersist(false);
      win.showInactive();
      log.debug('Agent window shown.');
      win.setAlwaysOnTop(this.#opts.getSettings().alwaysOnTop, 'floating');
      this.#applyIgnore();
    }
    this.#startPointerPolling();
    if (!visible || wasHiding) this.send({ type: 'show' });
    if (wasHidden) this.#opts.onVisibilityChanged?.(true);
  }

  /** Asks the renderer to play Hide; the window hides on win:hidden or after a fallback timeout. */
  requestHide(): void {
    if (this.#hiddenByUser) return;
    this.#hiddenByUser = true;
    this.#opts.onVisibilityChanged?.(false);
    const win = this.window;
    if (!win) return;
    if (!this.#ready || !win.isVisible() || !this.send({ type: 'hide' })) {
      this.#hideNow();
      return;
    }
    this.#hideFallback = setTimeout(() => {
      this.#hideFallback = null;
      this.#hideNow();
    }, HIDE_FALLBACK_MS);
  }

  /**
   * win:hidden from the renderer: its Hide animation has finished. Only main asks the
   * renderer to hide, so a win:hidden that arrives while Bonzi is not hidden by the user
   * is stale (a show() superseded the hide request) and must not hide the window again.
   */
  confirmHidden(): void {
    if (!this.#hiddenByUser) {
      log.debug('Ignoring a stale win:hidden (shown again since the hide request).');
      return;
    }
    this.#hideNow();
  }

  #hideNow(): void {
    if (this.#hideFallback) {
      clearTimeout(this.#hideFallback);
      this.#hideFallback = null;
    }
    this.#stopDrag();
    this.#stopPointerPolling(true);
    const win = this.window;
    if (win && win.isVisible()) {
      win.hide();
      log.debug('Agent window hidden.');
    }
  }

  // ---------------------------------------------------------------------------
  // Crash recovery

  #scheduleReload(): void {
    if (this.#reloadTimer) return;
    const now = Date.now();
    if (now - this.#lastCrashAt > CRASH_RESET_MS) this.#crashCount = 0;
    this.#lastCrashAt = now;
    const delay = CRASH_BACKOFF_MS[Math.min(this.#crashCount, CRASH_BACKOFF_MS.length - 1)] ?? 30_000;
    this.#crashCount++;
    log.info(`Reloading agent renderer in ${delay} ms`);
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = null;
      const win = this.window;
      if (!win || this.#opts.isQuitting()) return;
      void win.loadURL(AGENT_URL).catch((err: unknown) => {
        log.error(`Agent reload failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, delay);
  }

  /** Reloads the renderer (e.g. when the character file changed and a soft reload is not enough). */
  reload(): void {
    const win = this.window;
    if (!win) return;
    this.#ready = false;
    void win.loadURL(AGENT_URL).catch(() => undefined);
  }

  async capture(): Promise<Buffer | null> {
    const win = this.window;
    if (!win) return null;
    const img = await win.webContents.capturePage();
    return img.toPNG();
  }

  #clearTimers(): void {
    if (this.#hideFallback) clearTimeout(this.#hideFallback);
    if (this.#reloadTimer) clearTimeout(this.#reloadTimer);
    this.#hideFallback = null;
    this.#reloadTimer = null;
  }
}
