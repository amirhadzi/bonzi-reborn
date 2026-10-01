// State machine behind the "Chat shortcut" capture box. DOM-free so it can be
// unit tested; sections/app.ts wires the input's events to it.
//
// While recording, main must not hold the global shortcut: on Windows,
// RegisterHotKey consumes the final key before the focused input sees it, and
// the hotkey callback focuses Bonzi, which blurs the box. So every start
// pauses the global shortcut (setCapture(true)) and every stop resumes it
// (setCapture(false)), exactly once per recording session.

import { acceleratorFromKeyEvent, formatAccelerator } from './accelerator.ts';
import type { KeyLike } from './accelerator.ts';

export interface HotkeyRecorderHost {
  /** Tells main to pause (true) or resume (false) the global shortcut. */
  setCapture(on: boolean): void;
  /** Persists a captured accelerator. */
  save(accelerator: string): void;
  /** The currently saved accelerator ('' when none). */
  current(): string;
  /** Maximum accepted accelerator length. */
  readonly maxLength: number;
}

export type RecorderKeyResult =
  /** Not handled: let the browser do its default (not recording, or plain Tab). */
  | { kind: 'ignore' }
  /** Plain Escape: the caller should blur the box, which ends recording. */
  | { kind: 'cancel' }
  /** Modifiers only so far; show `text` in the box. */
  | { kind: 'preview'; text: string }
  /** Rejected combination; `clear` empties the box. */
  | { kind: 'error'; message: string; clear: boolean }
  /** A complete combination was saved; show `text` in the box. */
  | { kind: 'captured'; accelerator: string; text: string };

export const RECORDING_PLACEHOLDER = 'Press a shortcut, or Esc to cancel';
export const CAPTURED_HINT = 'Saved. Press another combination to change it, or Tab to move on.';
export const TOO_LONG_MESSAGE = 'That shortcut is too long.';

export class HotkeyRecorder {
  #host: HotkeyRecorderHost;
  #recording = false;
  #captured = false;

  constructor(host: HotkeyRecorderHost) {
    this.#host = host;
  }

  get recording(): boolean {
    return this.#recording;
  }

  /** The box gained focus. Pauses the global shortcut. Idempotent. */
  start(): void {
    if (this.#recording) return;
    this.#host.setCapture(true);
    this.#recording = true;
    this.#captured = false;
  }

  /**
   * The box lost focus (Escape, Tab, a click elsewhere, the window losing
   * focus or closing). Resumes the global shortcut only when a capture was
   * active, so stray blurs never send a spurious resume. Idempotent.
   */
  stop(): void {
    if (!this.#recording) return;
    this.#recording = false;
    this.#captured = false;
    this.#host.setCapture(false);
  }

  keydown(e: KeyLike): RecorderKeyResult {
    if (!this.#recording) return { kind: 'ignore' };
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
    if (plain && e.key === 'Tab') return { kind: 'ignore' }; // keep keyboard navigation working
    if (plain && e.key === 'Escape') return { kind: 'cancel' };
    const r = acceleratorFromKeyEvent(e);
    if (r.kind === 'partial') return { kind: 'preview', text: r.preview };
    if (r.kind === 'invalid') return { kind: 'error', message: r.message, clear: true };
    if (r.accelerator.length > this.#host.maxLength) return { kind: 'error', message: TOO_LONG_MESSAGE, clear: false };
    // Stay in recording mode so another combination simply replaces this one.
    this.#captured = true;
    this.#host.save(r.accelerator);
    return { kind: 'captured', accelerator: r.accelerator, text: formatAccelerator(r.accelerator) };
  }

  /**
   * Text to restore after a key release, or null to leave the box alone.
   * Releasing modifiers without a key restores the prompt (or the combination
   * captured in this session).
   */
  keyup(currentText: string): string | null {
    if (!this.#recording || !currentText.endsWith('...')) return null;
    return this.#captured ? formatAccelerator(this.#host.current()) : '';
  }
}
