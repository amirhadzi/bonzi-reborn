import { describe, expect, it } from 'vitest';
import {
  apiKeyPlaceholder,
  apiKeySourceNote,
  checkApiKeyShape,
  checkBaseUrl,
  errorText,
  formatCounter,
  formatInt,
  formatLatency,
  formatMultiplier,
  formatPercent,
  friendlyAiError,
  hostOf,
  isOpenAiHost,
  parseIntInRange,
  plural,
  snapToStep,
} from '../src/renderer/settings/lib/format.ts';

describe('hosts', () => {
  it('extracts the host', () => {
    expect(hostOf('https://api.openai.com/v1')).toBe('api.openai.com');
    expect(hostOf('http://localhost:8787/v1')).toBe('localhost:8787');
    expect(hostOf('not a url')).toBeNull();
  });

  it('detects the OpenAI host', () => {
    expect(isOpenAiHost('https://api.openai.com/v1')).toBe(true);
    expect(isOpenAiHost('https://API.OpenAI.com/v1')).toBe(true);
    expect(isOpenAiHost('https://api.openai.com.evil.example/v1')).toBe(false);
    expect(isOpenAiHost('garbage')).toBe(false);
  });
});

describe('checkBaseUrl', () => {
  it('accepts https and normalises', () => {
    const r = checkBaseUrl(' https://api.openai.com/v1/ ');
    expect(r).toEqual({ ok: true, normalized: 'https://api.openai.com/v1', host: 'api.openai.com', isOpenAi: true, hint: null });
  });

  it('accepts http only for loopback', () => {
    expect(checkBaseUrl('http://localhost:8787/v1').ok).toBe(true);
    expect(checkBaseUrl('http://127.0.0.1:1234/v1').ok).toBe(true);
    const bad = checkBaseUrl('http://example.com/v1');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/https/);
  });

  it('rejects junk, credentials and other schemes', () => {
    expect(checkBaseUrl('').ok).toBe(false);
    expect(checkBaseUrl('api.openai.com').ok).toBe(false);
    expect(checkBaseUrl('https://user:pw@example.com/v1').ok).toBe(false);
    expect(checkBaseUrl('ftp://example.com/v1').ok).toBe(false);
  });

  it('flags other hosts and hints about /v1', () => {
    const r = checkBaseUrl('https://openrouter.ai/api');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.isOpenAi).toBe(false);
      expect(r.host).toBe('openrouter.ai');
      expect(r.hint).toMatch(/\/v1/);
    }
  });
});

describe('API key helpers', () => {
  it('checks the key shape leniently', () => {
    expect(checkApiKeyShape('')).not.toBeNull();
    expect(checkApiKeyShape('sk-abc def')).not.toBeNull();
    expect(checkApiKeyShape('short')).not.toBeNull();
    expect(checkApiKeyShape('  sk-proj-1234567890abcdef  ')).toBeNull();
    expect(checkApiKeyShape('x'.repeat(2000))).not.toBeNull();
  });

  it('describes the key source', () => {
    expect(apiKeySourceNote({ apiKeySource: 'stored', safeStorageAvailable: true })).toMatch(/DPAPI/);
    expect(apiKeySourceNote({ apiKeySource: 'session', safeStorageAvailable: false })).toMatch(/session/);
    expect(apiKeySourceNote({ apiKeySource: 'env', safeStorageAvailable: true })).toMatch(/OPENAI_API_KEY/);
    expect(apiKeySourceNote({ apiKeySource: 'none', safeStorageAvailable: false })).toMatch(/session/);
  });

  it('builds the placeholder from the hint only', () => {
    expect(apiKeyPlaceholder({ apiKeyHint: null, apiKeySource: 'none' })).toBe('Not set');
    expect(apiKeyPlaceholder({ apiKeyHint: 'sk-...abcd', apiKeySource: 'stored' })).toBe('Saved: sk-...abcd');
    expect(apiKeyPlaceholder({ apiKeyHint: 'sk-...abcd', apiKeySource: 'env' })).toBe('From environment: sk-...abcd');
  });
});

describe('number formatting', () => {
  it('formats integers, latency and counts', () => {
    expect(formatInt(1234567)).toBe('1,234,567');
    expect(formatInt(-4000)).toBe('-4,000');
    expect(formatLatency(312.4)).toBe('312 ms');
    expect(formatLatency(1530)).toBe('1.5 s');
    expect(formatLatency(12500)).toBe('13 s');
    expect(formatLatency(Number.NaN)).toBe('-');
    expect(plural(1, 'model')).toBe('1 model');
    expect(plural(87, 'model')).toBe('87 models');
    expect(formatCounter(123, 4000)).toBe('123 / 4,000');
  });

  it('formats multipliers and percentages', () => {
    expect(formatMultiplier(1)).toBe('1x');
    expect(formatMultiplier(1.25)).toBe('1.25x');
    expect(formatMultiplier(0.5)).toBe('0.5x');
    expect(formatMultiplier(1.1500000000000001)).toBe('1.15x');
    expect(formatPercent(0.8)).toBe('80%');
    expect(formatPercent(0.005)).toBe('1%');
  });

  it('parses integers in range', () => {
    expect(parseIntInRange('20', 0, 100)).toBe(20);
    expect(parseIntInRange(' 250 ', 0, 100)).toBe(100);
    expect(parseIntInRange('-3', 0, 100)).toBe(0);
    expect(parseIntInRange('12.6', 0, 100)).toBe(13);
    expect(parseIntInRange('', 0, 100)).toBeNull();
    expect(parseIntInRange('abc', 0, 100)).toBeNull();
    expect(parseIntInRange('1e3', 0, 100)).toBeNull();
  });

  it('snaps slider values to the step', () => {
    expect(snapToStep(1.1500000000000001, 0.05, 0.25, 4)).toBe(1.15);
    expect(snapToStep(0.27, 0.05, 0.25, 4)).toBe(0.25);
    expect(snapToStep(9, 0.05, 0.25, 4)).toBe(4);
    expect(snapToStep(0.333, 0.01, 0, 1)).toBe(0.33);
  });
});

describe('errors', () => {
  it('explains AI errors in plain words', () => {
    expect(friendlyAiError({ kind: 'auth', message: 'Incorrect API key' })).toMatch(/rejected/);
    expect(friendlyAiError({ kind: 'quota', message: 'x' })).toMatch(/credit/);
    expect(friendlyAiError({ kind: 'rate-limit', message: 'x', retryAfterSec: 12.2 })).toMatch(/13 s/);
    expect(friendlyAiError({ kind: 'network', message: 'x' }, 'localhost:8787')).toMatch(/localhost:8787/);
    expect(friendlyAiError({ kind: 'server', message: 'x', status: 503 })).toMatch(/503/);
    expect(friendlyAiError({ kind: 'bad-request', message: 'Input too long' })).toBe('Input too long');
    expect(friendlyAiError({ kind: 'unknown', message: '' })).toMatch(/went wrong/);
  });

  it('strips the Electron invoke prefix from rejected promises', () => {
    expect(errorText(new Error("Error invoking remote method 'settings:set-api-key': Error: Invalid key"), 'x')).toBe('Invalid key');
    expect(errorText(new Error('Plain'), 'x')).toBe('Plain');
    expect(errorText('nope', 'fallback')).toBe('fallback');
  });
});
