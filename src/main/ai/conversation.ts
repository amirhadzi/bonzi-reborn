// Conversation history kept in the main process.
//
// Turn lifecycle:
// - Normal sources (typed, voice, quick-action): the user message is stored when the
//   turn starts. Synthetic sources (idle-chatter, greeting) store nothing up front;
//   their prompt is sent as an extra system message for that turn only.
// - Done: the assistant's raw text (including [[tags]]) is stored. An empty reply is
//   treated like a failed turn.
// - Cancel / error: when at least 20 characters were received, the partial text is
//   stored with " ..." appended, so the model knows it was cut off. Otherwise the
//   turn's user message is removed as well, which keeps user/assistant alternation
//   and avoids replaying an unanswered question.
// - After every finished turn the history is trimmed to `limit` most recent messages.

import type { ChatMessage } from './contract.ts';

export const PARTIAL_MIN_CHARS = 20;
/** Hard cap on stored messages regardless of settings. */
export const MAX_STORED_MESSAGES = 200;
const MAX_CONTENT = 16_000;

export interface Turn {
  readonly userMessage: ChatMessage | null;
  /** Set when the conversation was reset while the turn was running. */
  discarded: boolean;
}

export class Conversation {
  #messages: ChatMessage[] = [];
  readonly #onChanged: ((history: ChatMessage[]) => void) | undefined;
  readonly #now: () => Date;

  constructor(onChanged: ((history: ChatMessage[]) => void) | undefined, now: () => Date) {
    this.#onChanged = onChanged;
    this.#now = now;
  }

  get(): ChatMessage[] {
    return this.#messages.map((m) => ({ ...m }));
  }

  /** Replaces the history with validated messages (no change notification: the caller is the source). */
  set(history: unknown): void {
    this.#messages = sanitizeHistory(history);
  }

  reset(): void {
    this.#messages = [];
    this.#notify();
  }

  /** Starts a turn. For normal sources the user message is appended immediately. */
  begin(userText: string | null): Turn {
    let userMessage: ChatMessage | null = null;
    if (userText !== null) {
      userMessage = { role: 'user', content: userText, at: this.#now().toISOString() };
      this.#messages.push(userMessage);
      this.#notify();
    }
    return { userMessage, discarded: false };
  }

  /**
   * Messages to send as context: the `limit` most recent messages before the
   * turn's user message, followed by that message. limit 0 sends only the current message.
   */
  context(turn: Turn, limit: number): ChatMessage[] {
    const idx = turn.userMessage ? this.#messages.indexOf(turn.userMessage) : -1;
    const prior = idx >= 0 ? this.#messages.slice(0, idx) : this.#messages.slice();
    const n = Math.max(0, Math.floor(limit));
    const recent = n === 0 ? [] : prior.slice(-n);
    // Do not start the context with an orphaned assistant message.
    while (recent.length > 0 && recent[0]!.role === 'assistant' && turn.userMessage) recent.shift();
    return turn.userMessage && idx >= 0 ? [...recent, turn.userMessage] : recent;
  }

  complete(turn: Turn, text: string, limit: number): void {
    if (turn.discarded) return;
    if (text.trim().length === 0) {
      this.#removeUser(turn);
      this.#trim(limit);
      this.#notify();
      return;
    }
    this.#messages.push({ role: 'assistant', content: text.slice(0, MAX_CONTENT), at: this.#now().toISOString() });
    this.#trim(limit);
    this.#notify();
  }

  fail(turn: Turn, partialText: string, limit: number): void {
    if (turn.discarded) return;
    const partial = partialText.trimEnd();
    if (partial.trim().length >= PARTIAL_MIN_CHARS) {
      this.#messages.push({ role: 'assistant', content: `${partial.slice(0, MAX_CONTENT)} ...`, at: this.#now().toISOString() });
    } else {
      this.#removeUser(turn);
    }
    this.#trim(limit);
    this.#notify();
  }

  #removeUser(turn: Turn): void {
    if (!turn.userMessage) return;
    const idx = this.#messages.indexOf(turn.userMessage);
    if (idx >= 0) this.#messages.splice(idx, 1);
  }

  #trim(limit: number): void {
    const n = Math.min(MAX_STORED_MESSAGES, Math.max(0, Math.floor(limit)));
    if (this.#messages.length > n) this.#messages = n === 0 ? [] : this.#messages.slice(-n);
  }

  #notify(): void {
    try {
      this.#onChanged?.(this.get());
    } catch {
      // A failing persistence callback must not break the chat.
    }
  }
}

export function sanitizeHistory(history: unknown): ChatMessage[] {
  if (!Array.isArray(history)) return [];
  const out: ChatMessage[] = [];
  for (const m of history) {
    if (typeof m !== 'object' || m === null) continue;
    const r = m as Record<string, unknown>;
    if ((r.role !== 'user' && r.role !== 'assistant') || typeof r.content !== 'string') continue;
    const at = typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)) ? r.at : new Date(0).toISOString();
    out.push({ role: r.role, content: r.content.slice(0, MAX_CONTENT), at });
  }
  return out.slice(-MAX_STORED_MESSAGES);
}
