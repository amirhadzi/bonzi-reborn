// Encrypted conversation history at userData/history.bin, used only while
// settings.rememberConversation is true. Writes are debounced.

import fs from 'node:fs';
import type { ChatMessage } from './ai/contract.ts';
import type { StringCipher } from './secrets.ts';
import type { Logger } from './logger.ts';
import { removeFileQuiet, writeFileAtomic } from './fs-util.ts';

export const MAX_HISTORY_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 20000;

/** Validates persisted history (untrusted input) and keeps the most recent messages. */
export function sanitizeHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const m = item as Record<string, unknown>;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (typeof m.content !== 'string' || m.content.length === 0) continue;
    const at = typeof m.at === 'string' && !Number.isNaN(Date.parse(m.at)) ? m.at : new Date(0).toISOString();
    out.push({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS), at });
  }
  return out.slice(-MAX_HISTORY_MESSAGES);
}

export interface HistoryStoreOptions {
  filePath: string;
  cipher: StringCipher;
  log: Logger;
  debounceMs?: number;
}

export class HistoryStore {
  readonly #filePath: string;
  readonly #cipher: StringCipher;
  readonly #log: Logger;
  readonly #debounceMs: number;
  #pending: ChatMessage[] | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writing: Promise<void> = Promise.resolve();
  /** Incremented on clear() so in-flight writes from before the clear are discarded. */
  #generation = 0;

  constructor(options: HistoryStoreOptions) {
    this.#filePath = options.filePath;
    this.#cipher = options.cipher;
    this.#log = options.log;
    this.#debounceMs = options.debounceMs ?? 1000;
  }

  async load(): Promise<ChatMessage[]> {
    let blob: Buffer;
    try {
      blob = await fs.promises.readFile(this.#filePath);
    } catch {
      return [];
    }
    try {
      if (!(await this.#cipher.isAvailable())) return [];
      const { text } = await this.#cipher.decrypt(blob);
      return sanitizeHistory(JSON.parse(text) as unknown);
    } catch {
      this.#log.warn('Saved conversation could not be read; starting fresh.');
      await removeFileQuiet(this.#filePath);
      return [];
    }
  }

  /** Schedules a debounced encrypted write of the given history. */
  schedule(history: readonly ChatMessage[]): void {
    this.#pending = history.slice(-MAX_HISTORY_MESSAGES);
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.#debounceMs);
  }

  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const history = this.#pending;
    this.#pending = null;
    if (history) {
      const generation = this.#generation;
      this.#writing = this.#writing.then(() => this.#write(history, generation));
    }
    await this.#writing;
  }

  /** Cancels pending writes and deletes the file. */
  async clear(): Promise<void> {
    this.#generation++;
    this.#pending = null;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#writing;
    await removeFileQuiet(this.#filePath);
  }

  async #write(history: ChatMessage[], generation: number): Promise<void> {
    try {
      if (!(await this.#cipher.isAvailable())) return;
      if (history.length === 0) {
        if (generation === this.#generation) await removeFileQuiet(this.#filePath);
        return;
      }
      const blob = await this.#cipher.encrypt(JSON.stringify(history));
      if (generation !== this.#generation) return;
      await writeFileAtomic(this.#filePath, blob);
    } catch (err) {
      this.#log.warn(`Could not save conversation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
