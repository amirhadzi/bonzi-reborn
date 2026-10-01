// Mouse handling for the transparent window: click-through outside Bonzi and
// the UI, click / double click / right click / drag on Bonzi.
//
// Hover is decided from the cursor POSITION only: cursor samples from the main
// process (onPointerSample) while the window is click-through, plus native
// mousemove once it is clickable. Enter/leave events are not trusted: Windows
// fires a spurious mouseleave whenever click-through is toggled, and acting on
// it made the window flip back to click-through under the cursor.

import type { PointerSample } from '../../shared/ipc.ts';

export interface PointerTarget {
  /** True when (x, y) in window CSS px is over an opaque pixel of the character. */
  hitCharacter(x: number, y: number): boolean;
  /** Visible interactive DOM elements (balloon, chat bar). */
  interactiveElements(): HTMLElement[];
}

export interface PointerCallbacks {
  setIgnoreMouseEvents(ignore: boolean): void;
  onClick(): void;
  onDoubleClick(): void;
  onContextMenu(): void;
  /** grab: where the button went down, in window CSS px. */
  onDragStart(grab: { x: number; y: number }): void;
  onDragEnd(): void;
  /** Any pointer interaction with Bonzi or the UI. */
  onActivity(): void;
}

const DRAG_THRESHOLD = 4;
const DOUBLE_CLICK_MS = 260;

export class PointerController {
  private readonly target: PointerTarget;
  private readonly cb: PointerCallbacks;
  private readonly stage: HTMLElement;
  /** Main starts the window ignoring mouse events (with forwarding). */
  private ignoring = true;
  private press: { id: number; x: number; y: number } | null = null;
  private dragging = false;
  private clickTimer: ReturnType<typeof setTimeout> | null = null;
  private lastX = -1;
  private lastY = -1;
  private readonly disposers: Array<() => void> = [];

  constructor(stage: HTMLElement, target: PointerTarget, callbacks: PointerCallbacks) {
    this.stage = stage;
    this.target = target;
    this.cb = callbacks;

    this.listen(window, 'mousemove', (e) => this.onMove(e as MouseEvent));
    this.listen(window, 'blur', () => {
      if (this.dragging) this.endDrag();
    });
    this.listen(stage, 'pointerdown', (e) => this.onDown(e as PointerEvent));
    this.listen(window, 'pointermove', (e) => this.onPointerMove(e as PointerEvent));
    this.listen(window, 'pointerup', (e) => this.onUp(e as PointerEvent));
    this.listen(window, 'pointercancel', () => {
      if (this.dragging) this.endDrag();
      this.press = null;
    });
    this.listen(stage, 'contextmenu', (e) => {
      e.preventDefault();
      const me = e as MouseEvent;
      if (!this.target.hitCharacter(me.clientX, me.clientY)) return;
      this.cb.onActivity();
      this.cb.onContextMenu();
    });
    // No browser context menu anywhere else either (inputs keep theirs off too).
    this.listen(window, 'contextmenu', (e) => e.preventDefault());
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /** Re-evaluates click-through after the UI changed under a still cursor. */
  refresh(): void {
    if (this.lastX >= 0) this.update(this.lastX, this.lastY);
  }

  /** Forces the current state to be re-sent (e.g. after a reload). */
  resync(): void {
    this.cb.setIgnoreMouseEvents(this.ignoring);
  }

  /**
   * A cursor sample from the main process (window CSS px), or null when the cursor
   * left the window. Drives click-through while the window cannot see the mouse.
   */
  onPointerSample(p: PointerSample): void {
    if (this.press || this.dragging) return;
    if (p === null) {
      this.lastX = this.lastY = -1;
      this.stage.classList.remove('over');
      this.setIgnore(true);
      return;
    }
    this.lastX = p.x;
    this.lastY = p.y;
    this.update(p.x, p.y);
  }

  /** Main ended the drag on its own (lost mouseup): drop the drag state as if the button was released. */
  cancelDrag(): void {
    if (this.dragging) this.endDrag();
    this.press = null;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    if (this.clickTimer !== null) clearTimeout(this.clickTimer);
  }

  private listen(t: EventTarget, type: string, fn: (e: Event) => void): void {
    t.addEventListener(type, fn);
    this.disposers.push(() => t.removeEventListener(type, fn));
  }

  private isInteractiveAt(x: number, y: number): { over: boolean; character: boolean } {
    if (this.target.hitCharacter(x, y)) return { over: true, character: true };
    for (const el of this.target.interactiveElements()) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return { over: true, character: false };
    }
    return { over: false, character: false };
  }

  private update(x: number, y: number): void {
    const hit = this.isInteractiveAt(x, y);
    this.stage.classList.toggle('over', hit.character);
    this.setIgnore(!hit.over);
  }

  private setIgnore(ignore: boolean): void {
    // Never toggle while a press or drag is in progress.
    if (this.press || this.dragging) return;
    if (ignore === this.ignoring) return;
    this.ignoring = ignore;
    this.cb.setIgnoreMouseEvents(ignore);
  }

  private onMove(e: MouseEvent): void {
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (!this.press && !this.dragging) this.update(e.clientX, e.clientY);
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (!this.target.hitCharacter(e.clientX, e.clientY)) return;
    e.preventDefault();
    this.press = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      // capture is best effort
    }
    this.cb.onActivity();
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.press;
    if (!p || this.dragging || e.pointerId !== p.id) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_THRESHOLD) {
      this.dragging = true;
      this.cancelClick();
      document.body.classList.add('dragging');
      this.cb.onDragStart({ x: p.x, y: p.y });
    }
  }

  private onUp(e: PointerEvent): void {
    const p = this.press;
    if (!p || e.pointerId !== p.id) return;
    if (this.dragging) {
      this.endDrag();
      return;
    }
    this.press = null;
    if (this.clickTimer !== null) {
      this.cancelClick();
      this.cb.onDoubleClick();
    } else {
      this.clickTimer = setTimeout(() => {
        this.clickTimer = null;
        this.cb.onClick();
      }, DOUBLE_CLICK_MS);
    }
    this.update(e.clientX, e.clientY);
  }

  private endDrag(): void {
    this.dragging = false;
    this.press = null;
    document.body.classList.remove('dragging');
    this.cb.onDragEnd();
    if (this.lastX >= 0) this.update(this.lastX, this.lastY);
  }

  private cancelClick(): void {
    if (this.clickTimer !== null) clearTimeout(this.clickTimer);
    this.clickTimer = null;
  }
}
