import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts';
import { buildPublicSettings, changedKeys, SettingsStore } from '../src/main/settings-store.ts';
import type { SettingsChange } from '../src/main/settings-store.ts';
import { apiKeyHint, SecretStore, takeEnvApiKey, validateApiKey, validateEnvApiKey } from '../src/main/secrets.ts';
import type { StringCipher } from '../src/main/secrets.ts';
import { HistoryStore, sanitizeHistory } from '../src/main/history-store.ts';
import { redactSecrets, addRedaction, removeRedaction } from '../src/main/logger.ts';
import type { Logger } from '../src/main/logger.ts';

const quietLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonzi-main-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Reversible fake cipher so tests can check the file is not plain text. */
function fakeCipher(available = true): StringCipher & { failDecrypt: boolean } {
  const c = {
    failDecrypt: false,
    isAvailable: async () => available,
    encrypt: async (plain: string) => Buffer.from('ENC:' + Buffer.from(plain, 'utf8').toString('base64')),
    decrypt: async (data: Buffer) => {
      if (c.failDecrypt) throw new Error('cannot decrypt');
      const s = data.toString('utf8');
      if (!s.startsWith('ENC:')) throw new Error('bad blob');
      return { text: Buffer.from(s.slice(4), 'base64').toString('utf8'), shouldReEncrypt: false };
    },
  };
  return c;
}

describe('SettingsStore', () => {
  it('creates defaults when no file exists and saves them', () => {
    const file = path.join(dir, 'settings.json');
    const store = new SettingsStore({ filePath: file, log: quietLog });
    expect(store.load()).toEqual(DEFAULT_SETTINGS);
    store.flush();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(DEFAULT_SETTINGS);
  });

  it('migrates old or partial files: keeps valid values, fills defaults, drops junk', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(
      file,
      '\ufeff' +
        JSON.stringify({
          scale: 2,
          userName: 'Amir',
          volume: 9,
          voiceMode: 'shout',
          characterPath: 'C:\\chars\\Merlin.acs',
          unknownField: true,
          position: { x: 10.4, y: 'no' },
        }),
    );
    const store = new SettingsStore({ filePath: file, log: quietLog });
    const s = store.load();
    expect(s.scale).toBe(2);
    expect(s.userName).toBe('Amir');
    expect(s.volume).toBe(1);
    expect(s.voiceMode).toBe(DEFAULT_SETTINGS.voiceMode);
    expect(s.characterPath).toBe('C:\\chars\\Merlin.acs');
    expect(s.position).toBeNull();
    expect('unknownField' in s).toBe(false);
    store.flush();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(saved.unknownField).toBeUndefined();
    expect(saved.chatModel).toBe(DEFAULT_SETTINGS.chatModel);
  });

  it('survives a corrupt file and keeps a backup', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{ not json');
    const store = new SettingsStore({ filePath: file, log: quietLog });
    expect(store.load()).toEqual(DEFAULT_SETTINGS);
    expect(fs.readFileSync(`${file}.corrupt`, 'utf8')).toBe('{ not json');
  });

  it('applies untrusted patches safely and emits change events', () => {
    const store = new SettingsStore({ filePath: path.join(dir, 'settings.json'), log: quietLog });
    store.load();
    const events: SettingsChange[] = [];
    store.onChange((c) => events.push(c));
    store.update({ scale: 1.5, characterPath: 'C:\\evil.acs', alwaysOnTop: 'yes' });
    expect(store.get().scale).toBe(1.5);
    expect(store.get().characterPath).toBeNull();
    expect(store.get().alwaysOnTop).toBe(true);
    expect(events).toHaveLength(1);
    expect([...events[0]!.changed]).toEqual(['scale']);
    store.update({ scale: 1.5 });
    expect(events).toHaveLength(1);
  });

  it('lets the main process set characterPath through updateTrusted', () => {
    const store = new SettingsStore({ filePath: path.join(dir, 'settings.json'), log: quietLog });
    store.load();
    store.updateTrusted({ characterPath: 'D:\\Agents\\Genie.acs' });
    expect(store.get().characterPath).toBe('D:\\Agents\\Genie.acs');
    store.update({ characterPath: null });
    expect(store.get().characterPath).toBeNull();
  });

  it('debounces writes and writes atomically', async () => {
    vi.useFakeTimers();
    try {
      const file = path.join(dir, 'settings.json');
      const store = new SettingsStore({ filePath: file, log: quietLog, debounceMs: 100 });
      store.load();
      store.flush();
      store.update({ userName: 'A' });
      store.update({ userName: 'B' });
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).userName).toBe('');
      vi.advanceTimersByTime(150);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).userName).toBe('B');
      expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('compares positions by value', () => {
    const a = { ...DEFAULT_SETTINGS, position: { x: 1, y: 2 } };
    expect(changedKeys(a, { ...a, position: { x: 1, y: 2 } }).size).toBe(0);
    expect([...changedKeys(a, { ...a, position: { x: 1, y: 3 } })]).toEqual(['position']);
    expect([...changedKeys(a, { ...a, position: null })]).toEqual(['position']);
  });

  it('builds public settings without the key', () => {
    const pub = buildPublicSettings(DEFAULT_SETTINGS, {
      apiKeyHint: 'sk-...abcd',
      apiKeySource: 'stored',
      safeStorageAvailable: true,
      characterName: 'Bonzi',
      hotkeyError: null,
    });
    expect(pub.hasApiKey).toBe(true);
    expect(pub.apiKeyHint).toBe('sk-...abcd');
    expect(pub.characterName).toBe('Bonzi');
    const none = buildPublicSettings(DEFAULT_SETTINGS, {
      apiKeyHint: 'sk-...abcd',
      apiKeySource: 'none',
      safeStorageAvailable: false,
      characterName: 'Bonzi',
      hotkeyError: 'in use',
    });
    expect(none.hasApiKey).toBe(false);
    expect(none.apiKeyHint).toBeNull();
    expect(none.hotkeyError).toBe('in use');
  });
});

describe('API key validation and hints', () => {
  it('validates shape without requiring sk-', () => {
    expect(validateApiKey('  sk-proj-abcdefgh1234  ')).toBe('sk-proj-abcdefgh1234');
    expect(validateApiKey('gsk_0123456789')).toBe('gsk_0123456789');
    expect(validateApiKey('short')).toBeNull();
    expect(validateApiKey('a'.repeat(513))).toBeNull();
    expect(validateApiKey('a'.repeat(512))).not.toBeNull();
    expect(validateApiKey('sk-abc def12345')).toBeNull();
    expect(validateApiKey('sk-abc\tdef12345')).toBeNull();
    expect(validateApiKey('sk-abc\u0000def12345')).toBeNull();
    expect(validateApiKey('sk-abc\u200bdef12345')).toBeNull();
    expect(validateApiKey('sk-abc\u2028def12345')).toBeNull();
    expect(validateApiKey(12345678)).toBeNull();
    expect(validateApiKey(null)).toBeNull();
  });

  it('reveals only the last 4 characters', () => {
    expect(apiKeyHint('sk-proj-0123456789abcd')).toBe('sk-...abcd');
    expect(apiKeyHint('gsk_0123456789wxyz')).toBe('...wxyz');
    expect(apiKeyHint(null)).toBeNull();
  });
});

describe('SecretStore', () => {
  it('stores the key encrypted and reads it back', async () => {
    const file = path.join(dir, 'credentials.bin');
    const cipher = fakeCipher();
    const s1 = new SecretStore({ filePath: file, cipher, readEnvKey: () => undefined, log: quietLog });
    await s1.load();
    expect(s1.source()).toBe('none');
    await s1.set('sk-test-0123456789');
    expect(s1.source()).toBe('stored');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('sk-test-0123456789');

    const s2 = new SecretStore({ filePath: file, cipher, readEnvKey: () => undefined, log: quietLog });
    await s2.load();
    expect(s2.get()).toBe('sk-test-0123456789');
    expect(s2.source()).toBe('stored');

    await s2.set(null);
    expect(fs.existsSync(file)).toBe(false);
    expect(s2.get()).toBeNull();
  });

  it('keeps the key in memory only when encryption is unavailable', async () => {
    const file = path.join(dir, 'credentials.bin');
    const s = new SecretStore({ filePath: file, cipher: fakeCipher(false), readEnvKey: () => undefined, log: quietLog });
    await s.load();
    expect(s.encryptionAvailable).toBe(false);
    await s.set('sk-session-12345678');
    expect(s.source()).toBe('session');
    expect(s.get()).toBe('sk-session-12345678');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('falls back to the environment key and prefers a stored key', async () => {
    const file = path.join(dir, 'credentials.bin');
    const s = new SecretStore({ filePath: file, cipher: fakeCipher(), readEnvKey: () => ' sk-env-12345678 ', log: quietLog });
    await s.load();
    expect(s.source()).toBe('env');
    expect(s.get()).toBe('sk-env-12345678');
    await s.set('sk-stored-12345678');
    expect(s.get()).toBe('sk-stored-12345678');
    const bad = new SecretStore({ filePath: path.join(dir, 'x.bin'), cipher: fakeCipher(), readEnvKey: () => 'bad key', log: quietLog });
    await bad.load();
    expect(bad.source()).toBe('none');
    const short = new SecretStore({ filePath: path.join(dir, 'y.bin'), cipher: fakeCipher(), readEnvKey: () => 'sk-bad', log: quietLog });
    await short.load();
    expect(short.source()).toBe('env');
  });

  it('accepts any non-empty token without whitespace as the environment key', () => {
    expect(validateEnvApiKey(' sk-bad ')).toBe('sk-bad');
    expect(validateEnvApiKey('')).toBeNull();
    expect(validateEnvApiKey('a b')).toBeNull();
    expect(validateEnvApiKey(undefined)).toBeNull();
    expect(validateApiKey('sk-bad')).toBeNull();
  });

  it('discards an undecryptable blob', async () => {
    const file = path.join(dir, 'credentials.bin');
    fs.writeFileSync(file, 'garbage');
    const s = new SecretStore({ filePath: file, cipher: fakeCipher(), readEnvKey: () => undefined, log: quietLog });
    await s.load();
    expect(s.get()).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('HistoryStore', () => {
  const msgs = [
    { role: 'user' as const, content: 'hi', at: '2026-10-01T10:00:00.000Z' },
    { role: 'assistant' as const, content: 'Hello [[Wave]]', at: '2026-10-01T10:00:01.000Z' },
  ];

  it('persists encrypted history and loads it back', async () => {
    const file = path.join(dir, 'history.bin');
    const h = new HistoryStore({ filePath: file, cipher: fakeCipher(), log: quietLog, debounceMs: 10 });
    h.schedule(msgs);
    await h.flush();
    expect(fs.readFileSync(file, 'utf8')).not.toContain('Hello');
    const h2 = new HistoryStore({ filePath: file, cipher: fakeCipher(), log: quietLog });
    expect(await h2.load()).toEqual(msgs);
  });

  it('clear() deletes the file and cancels pending writes', async () => {
    const file = path.join(dir, 'history.bin');
    const h = new HistoryStore({ filePath: file, cipher: fakeCipher(), log: quietLog, debounceMs: 10 });
    h.schedule(msgs);
    await h.flush();
    h.schedule(msgs);
    await h.clear();
    await new Promise((r) => setTimeout(r, 30));
    expect(fs.existsSync(file)).toBe(false);
  });

  it('does not persist without encryption', async () => {
    const file = path.join(dir, 'history.bin');
    const h = new HistoryStore({ filePath: file, cipher: fakeCipher(false), log: quietLog });
    h.schedule(msgs);
    await h.flush();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('sanitizes untrusted history', () => {
    expect(sanitizeHistory('nope')).toEqual([]);
    const out = sanitizeHistory([
      { role: 'system', content: 'evil', at: 'x' },
      { role: 'user', content: '', at: 'x' },
      { role: 'user', content: 'ok', at: 'not a date' },
      null,
      { role: 'assistant', content: 'fine', at: '2026-10-01T10:00:00.000Z' },
    ]);
    expect(out.map((m) => m.content)).toEqual(['ok', 'fine']);
    expect(out[0]!.at).toBe(new Date(0).toISOString());
    expect(sanitizeHistory(Array.from({ length: 500 }, () => ({ role: 'user', content: 'x', at: '' })))).toHaveLength(200);
  });
});

describe('log redaction', () => {
  it('redacts registered secrets and key-shaped strings', () => {
    addRedaction('custom-secret-value');
    expect(redactSecrets('key=custom-secret-value end')).toBe('key=[redacted] end');
    removeRedaction('custom-secret-value');
    expect(redactSecrets('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [redacted]');
    expect(redactSecrets('using sk-proj-AbCdEfGhIjKlMnOpQrSt')).not.toContain('IjKlMnOpQrSt');
  });
});

describe('takeEnvApiKey', () => {
  it('returns OPENAI_API_KEY once and removes it so child processes never inherit it', () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-test-local', PATH: 'x' };
    expect(takeEnvApiKey(env)).toBe('sk-test-local');
    expect('OPENAI_API_KEY' in env).toBe(false);
    expect(env.PATH).toBe('x');
    expect(takeEnvApiKey(env)).toBeUndefined();
  });

  it('feeds SecretStore through readEnvKey after the variable is gone', async () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-test-local' };
    const captured = takeEnvApiKey(env);
    const s = new SecretStore({
      filePath: path.join(os.tmpdir(), `bonzi-none-${process.pid}.bin`),
      cipher: { isAvailable: async () => false, encrypt: async () => Buffer.alloc(0), decrypt: async () => ({ text: '', shouldReEncrypt: false }) },
      readEnvKey: () => captured,
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    await s.load();
    expect(s.get()).toBe('sk-test-local');
    expect(s.source()).toBe('env');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
