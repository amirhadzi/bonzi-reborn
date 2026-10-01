// The chat input bar: open / close, Enter to send, Esc, history recall,
// mic button, and auto-close after a minute of inactivity when empty.

import { LIMITS } from '../../shared/settings.ts';
import type { ChatPlacement, Size } from './placement.ts';

export interface ChatBarCallbacks {
  onSubmit(text: string): void;
  onEscape(): void;
  onMic(): void;
  /** Opened, closed or resized: placement and hit testing need an update. */
  onChange(): void;
  /** Any typing or click inside the bar. */
  onActivity(): void;
  /**
   * The bar closed while the agent window had keyboard focus: hand focus back
   * to the app the user came from (a DOM blur alone keeps the native window active).
   */
  releaseFocus(): void;
}

export interface ChatBarElements {
  root: HTMLElement;
  input: HTMLInputElement;
  send: HTMLButtonElement;
  mic: HTMLButtonElement;
}

const INACTIVITY_MS = 60_000;
const HISTORY_MAX = 50;
const FADE_MS = 150;

export class ChatBar {
  private readonly els: ChatBarElements;
  private readonly cb: ChatBarCallbacks;
  private readonly focusWindow: () => void;
  private history: string[] = [];
  /** Index into history while recalling with the arrow keys; history.length = draft. */
  private recallIndex = 0;
  private draft = '';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private isOpenFlag = false;

  constructor(els: ChatBarElements, focusWindow: () => void, callbacks: ChatBarCallbacks) {
    this.els = els;
    this.cb = callbacks;
    this.focusWindow = focusWindow;
    const { input, send, mic, root } = els;
    input.maxLength = LIMITS.chatText;

    input.addEventListener('input', () => {
      this.updateSend();
      this.touch();
    });
    input.addEventListener('keydown', (e) => this.onKey(e));
    input.addEventListener('focus', () => this.touch());
    send.addEventListener('click', () => this.submit());
    mic.addEventListener('click', () => {
      this.touch();
      this.cb.onMic();
    });
    root.addEventListener('pointerdown', () => this.touch());
    this.updateSend();
  }

  get isOpen(): boolean {
    return this.isOpenFlag;
  }

  get element(): HTMLElement {
    return this.els.root;
  }

  get text(): string {
    return this.els.input.value;
  }

  /** The user is in the middle of typing something. */
  get isTyping(): boolean {
    return this.isOpenFlag && this.els.input.value.trim().length > 0;
  }

  setText(text: string): void {
    this.els.input.value = text.slice(0, LIMITS.chatText);
    this.updateSend();
  }

  open(): void {
    if (this.fadeTimer !== null) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
    const root = this.els.root;
    const wasOpen = this.isOpenFlag;
    this.isOpenFlag = true;
    root.hidden = false;
    this.cb.onChange();
    if (!wasOpen || !root.classList.contains('open')) {
      void root.offsetWidth;
      root.classList.add('open');
    }
    this.focus();
    this.touch();
  }

  focus(): void {
    this.focusWindow();
    this.els.input.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.isOpenFlag) return;
    this.isOpenFlag = false;
    // Whole-window focus, not just the input: after a click on Bonzi or the
    // balloon, BODY holds focus but the transparent window is still foreground.
    const hadWindowFocus = document.hasFocus();
    this.clearIdle();
    const root = this.els.root;
    root.classList.remove('open');
    if (document.activeElement === this.els.input) this.els.input.blur();
    this.recallIndex = this.history.length;
    if (this.fadeTimer !== null) clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout(() => {
      this.fadeTimer = null;
      if (this.isOpenFlag) return;
      root.hidden = true;
      this.cb.onChange();
    }, FADE_MS);
    this.cb.onChange();
    if (hadWindowFocus) this.cb.releaseFocus();
  }

  setMicVisible(visible: boolean): void {
    this.els.mic.hidden = !visible;
  }

  setMicRecording(recording: boolean, busy = false): void {
    const mic = this.els.mic;
    mic.classList.toggle('recording', recording);
    mic.setAttribute('aria-pressed', String(recording));
    mic.disabled = busy;
    const label = recording ? 'Stop listening' : 'Talk to Bonzi';
    mic.title = label;
    mic.setAttribute('aria-label', label);
  }

  /** Measured size for placement. */
  measure(): Size {
    return { width: this.els.root.offsetWidth, height: this.els.root.offsetHeight };
  }

  place(p: ChatPlacement): void {
    const s = this.els.root.style;
    s.left = `${p.x}px`;
    s.top = `${p.y}px`;
    this.els.root.classList.toggle('side-above', p.side === 'above');
    this.els.root.classList.toggle('side-below', p.side === 'below');
  }

  /** Sends whatever is in the input (also used by voice input). */
  submit(): void {
    const text = this.els.input.value.trim();
    if (!text) return;
    if (this.history[this.history.length - 1] !== text) {
      this.history.push(text);
      if (this.history.length > HISTORY_MAX) this.history.shift();
    }
    this.recallIndex = this.history.length;
    this.draft = '';
    this.els.input.value = '';
    this.updateSend();
    this.touch();
    this.cb.onSubmit(text);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    this.touch();
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        this.submit();
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this.cb.onEscape();
        break;
      case 'ArrowUp':
        if (this.history.length === 0) return;
        e.preventDefault();
        if (this.recallIndex === this.history.length) this.draft = this.els.input.value;
        this.recallIndex = Math.max(0, this.recallIndex - 1);
        this.recall();
        break;
      case 'ArrowDown':
        if (this.recallIndex >= this.history.length) return;
        e.preventDefault();
        this.recallIndex++;
        this.recall();
        break;
      default:
        break;
    }
  }

  private recall(): void {
    const value = this.recallIndex < this.history.length ? this.history[this.recallIndex]! : this.draft;
    const input = this.els.input;
    input.value = value;
    input.setSelectionRange(value.length, value.length);
    this.updateSend();
  }

  private updateSend(): void {
    this.els.send.disabled = this.els.input.value.trim().length === 0;
  }

  private touch(): void {
    this.cb.onActivity();
    if (!this.isOpenFlag) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.onIdle(), INACTIVITY_MS);
  }

  private onIdle(): void {
    this.idleTimer = null;
    if (!this.isOpenFlag) return;
    if (this.els.input.value.trim()) {
      this.idleTimer = setTimeout(() => this.onIdle(), INACTIVITY_MS);
      return;
    }
    this.close();
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
