// API key storage. The key is encrypted with an injected cipher (Electron
// safeStorage / DPAPI in production) at userData/credentials.bin. When
// encryption is unavailable the key lives in memory for the session only.
// Falls back to an environment variable when nothing is stored.
// The key is never logged and never leaves the main process except in the
// Authorization header sent by the AI service.

import fs from 'node:fs';
import { addRedaction, removeRedaction, type Logger } from './logger.ts';
import { removeFileQuiet, writeFileAtomic } from './fs-util.ts';

export type ApiKeySource = 'stored' | 'session' | 'env' | 'none';

/** Minimal async string cipher, implemented by safeStorage in main.ts and by fakes in tests. */
export interface StringCipher {
  isAvailable(): Promise<boolean>;
  encrypt(plain: string): Promise<Buffer>;
  decrypt(data: Buffer): Promise<{ text: string; shouldReEncrypt: boolean }>;
}

export const API_KEY_MIN = 8;
export const API_KEY_MAX = 512;

/**
 * Validates the shape of an API key: trimmed, 8..512 characters, no
 * whitespace or control characters. No 'sk-' prefix is required because
 * OpenAI-compatible providers use different formats. Returns the trimmed key
 * or null when invalid.
 */
export function validateApiKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (key.length < API_KEY_MIN || key.length > API_KEY_MAX) return null;
  // \s also covers U+2028/U+2029/U+FEFF; Cc = control, Cf = invisible format characters.
  if (/[\s\p{Cc}\p{Cf}]/u.test(key)) return null;
  return key;
}

/**
 * Looser check for OPENAI_API_KEY: the user set it explicitly, so any
 * non-empty token is passed on and the server decides (an invalid key then
 * gives a clear auth error instead of "no key").
 */
export function validateEnvApiKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (key.length < 1 || key.length > API_KEY_MAX) return null;
  if (/[\s\p{Cc}\p{Cf}]/u.test(key)) return null;
  return key;
}

/**
 * Reads OPENAI_API_KEY once and removes it from the environment, so Chromium child
 * processes (renderers, GPU, utility) and the sandboxed preloads' process.env copy never
 * receive it. Call it at the very top of main, before any child process starts.
 */
export function takeEnvApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.OPENAI_API_KEY;
  delete env.OPENAI_API_KEY;
  return value;
}

/** "sk-...abcd" for OpenAI-style keys, "...abcd" otherwise. Only the last 4 characters are revealed. */
export function apiKeyHint(key: string | null): string | null {
  if (!key) return null;
  const last4 = key.slice(-4);
  return key.startsWith('sk-') ? `sk-...${last4}` : `...${last4}`;
}

export interface SecretStoreOptions {
  filePath: string;
  cipher: StringCipher;
  /**
   * Returns the environment fallback key (OPENAI_API_KEY) captured by takeEnvApiKey() at
   * startup. Required: process.env no longer holds it by the time the store exists.
   */
  readEnvKey: () => string | undefined;
  log: Logger;
}

export class SecretStore {
  readonly #filePath: string;
  readonly #cipher: StringCipher;
  readonly #readEnvKey: () => string | undefined;
  readonly #log: Logger;
  #stored: string | null = null;
  #session: string | null = null;
  #encryptionAvailable = false;

  constructor(options: SecretStoreOptions) {
    this.#filePath = options.filePath;
    this.#cipher = options.cipher;
    this.#readEnvKey = options.readEnvKey;
    this.#log = options.log;
  }

  /** Must be called after app ready (safeStorage is unavailable before). */
  async load(): Promise<void> {
    try {
      this.#encryptionAvailable = await this.#cipher.isAvailable();
    } catch {
      this.#encryptionAvailable = false;
    }
    let blob: Buffer;
    try {
      blob = await fs.promises.readFile(this.#filePath);
    } catch {
      return;
    }
    if (!this.#encryptionAvailable) {
      this.#log.warn('Stored API key found but OS encryption is unavailable; it cannot be read this session.');
      return;
    }
    try {
      const { text, shouldReEncrypt } = await this.#cipher.decrypt(blob);
      const key = validateApiKey(text);
      if (!key) throw new Error('stored key has an invalid shape');
      this.#stored = key;
      addRedaction(key);
      if (shouldReEncrypt) await this.#persist(key);
    } catch {
      // Profile moved to another user or machine, or the file is corrupt: ask for the key again.
      this.#log.warn('Stored API key could not be decrypted; discarding it.');
      await removeFileQuiet(this.#filePath);
    }
  }

  get encryptionAvailable(): boolean {
    return this.#encryptionAvailable;
  }

  /** The active key, or null. */
  get(): string | null {
    return this.#stored ?? this.#session ?? this.#envKey();
  }

  source(): ApiKeySource {
    if (this.#stored) return 'stored';
    if (this.#session) return 'session';
    if (this.#envKey()) return 'env';
    return 'none';
  }

  /**
   * Stores a new key (already validated with validateApiKey) or clears it
   * with null. Throws only when writing the encrypted file fails.
   */
  async set(key: string | null): Promise<void> {
    const previous = this.#stored ?? this.#session;
    if (key === null) {
      this.#stored = null;
      this.#session = null;
      await removeFileQuiet(this.#filePath);
      removeRedaction(previous);
      this.#log.info('API key cleared.');
      return;
    }
    addRedaction(key);
    if (this.#encryptionAvailable) {
      await this.#persist(key);
      this.#stored = key;
      this.#session = null;
      this.#log.info('API key saved (encrypted).');
    } else {
      this.#session = key;
      this.#stored = null;
      await removeFileQuiet(this.#filePath);
      this.#log.warn('OS encryption unavailable; API key kept in memory for this session only.');
    }
    if (previous && previous !== key) removeRedaction(previous);
  }

  async #persist(key: string): Promise<void> {
    const blob = await this.#cipher.encrypt(key);
    await writeFileAtomic(this.#filePath, blob);
  }

  #envKey(): string | null {
    const key = validateEnvApiKey(this.#readEnvKey());
    if (key) addRedaction(key);
    return key;
  }
}
