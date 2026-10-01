// Pure formatting and validation helpers for the settings window.

import type { AiError } from '../../../shared/ipc.ts';
import type { PublicSettings } from '../../../shared/settings.ts';
import { normalizeBaseUrl } from '../../../shared/settings.ts';

export const OPENAI_HOST = 'api.openai.com';

/** Host name of a base URL ("api.openai.com"), or null when it cannot be parsed. */
export function hostOf(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl.trim()).host;
    return host || null;
  } catch {
    return null;
  }
}

export function isOpenAiHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase() === OPENAI_HOST;
  } catch {
    return false;
  }
}

export type BaseUrlCheck =
  | { ok: true; normalized: string; host: string; isOpenAi: boolean; hint: string | null }
  | { ok: false; message: string };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Validates what the user typed in the base URL field and explains any problem. */
export function checkBaseUrl(input: string): BaseUrlCheck {
  const text = input.trim();
  if (!text) return { ok: false, message: 'Enter a URL such as https://api.openai.com/v1.' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: 'That is not a valid URL. It should start with https://.' };
  }
  if (url.username || url.password) return { ok: false, message: 'Remove the user name and password from the URL.' };
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    return { ok: false, message: 'Use https://. Plain http is only allowed for localhost.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, message: 'Only https:// URLs are supported.' };
  }
  const normalized = normalizeBaseUrl(text);
  if (!normalized) return { ok: false, message: 'That URL cannot be used.' };
  const isOpenAi = url.hostname.toLowerCase() === OPENAI_HOST;
  const hint = /\/v\d+$/.test(url.pathname.replace(/\/+$/, ''))
    ? null
    : 'Most OpenAI-compatible servers expect the URL to end in /v1.';
  return { ok: true, normalized, host: url.host, isOpenAi, hint };
}

/** Lenient shape check so custom providers with other key formats still work. Returns an error or null. */
export function checkApiKeyShape(input: string): string | null {
  const key = input.trim();
  if (!key) return 'Paste your API key first.';
  if (/\s/.test(key)) return 'An API key cannot contain spaces or line breaks.';
  if (key.length < 8) return 'That key looks too short.';
  if (key.length > 1024) return 'That key looks too long.';
  return null;
}

export function apiKeySourceNote(s: Pick<PublicSettings, 'apiKeySource' | 'safeStorageAvailable'>): string {
  switch (s.apiKeySource) {
    case 'stored':
      return 'Stored encrypted on this PC with Windows DPAPI.';
    case 'session':
      return 'Kept in memory for this session only, because Windows encryption is unavailable. You will need to enter it again next time.';
    case 'env':
      return 'Read from the OPENAI_API_KEY environment variable. A key saved here takes priority.';
    case 'none':
      return s.safeStorageAvailable
        ? 'Not set. Your key will be stored encrypted on this PC with Windows DPAPI.'
        : 'Not set. Windows encryption is unavailable, so a key will only be kept for this session.';
  }
}

export function apiKeyPlaceholder(s: Pick<PublicSettings, 'apiKeyHint' | 'apiKeySource'>): string {
  if (!s.apiKeyHint) return 'Not set';
  return s.apiKeySource === 'env' ? `From environment: ${s.apiKeyHint}` : `Saved: ${s.apiKeyHint}`;
}

function group(n: number): string {
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.abs(Math.trunc(n)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatInt(n: number): string {
  return group(Math.round(n));
}

export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatInt(n)} ${n === 1 ? one : many}`;
}

/** 1 -> "1x", 1.25 -> "1.25x", 0.5 -> "0.5x". */
export function formatMultiplier(v: number): string {
  return `${Number(v.toFixed(2))}x`;
}

export function formatPercent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function formatCounter(length: number, max: number): string {
  return `${formatInt(length)} / ${formatInt(max)}`;
}

/**
 * Parses an integer field. Empty or non-numeric input returns null; numbers are
 * rounded and clamped into range.
 */
export function parseIntInRange(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Math.round(Number(t));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/** Snaps a slider value to its step to avoid floating point noise such as 1.1500000000000001. */
export function snapToStep(v: number, step: number, min: number, max: number): number {
  const snapped = Math.round((v - min) / step) * step + min;
  return Math.min(max, Math.max(min, Number(snapped.toFixed(4))));
}

/** User-facing explanation for an AiError. */
export function friendlyAiError(err: AiError, host?: string | null): string {
  const where = host || 'the server';
  switch (err.kind) {
    case 'no-key':
      return 'Add your API key first.';
    case 'auth':
      return 'The key was rejected. Check that it is correct and still active.';
    case 'quota':
      return 'Your account is out of credit or has reached its spend limit. Check your billing settings.';
    case 'rate-limit':
      return err.retryAfterSec !== undefined && err.retryAfterSec > 0
        ? `Too many requests right now. Try again in ${Math.ceil(err.retryAfterSec)} s.`
        : 'Too many requests right now. Try again in a moment.';
    case 'model':
      return 'That model is not available for this key. Pick another one from the list.';
    case 'network':
      return `Could not reach ${where}. Check your internet connection and the base URL.`;
    case 'timeout':
      return `${where === 'the server' ? 'The server' : where} took too long to answer. Try again.`;
    case 'server':
      return `${where === 'the server' ? 'The server' : where} is having trouble${err.status ? ` (error ${err.status})` : ''}. Try again shortly.`;
    case 'cancelled':
      return 'Cancelled.';
    case 'bad-request':
    case 'unknown':
      return err.message ? err.message : 'Something went wrong. Try again.';
  }
}

/** Message for a rejected promise from the preload API (main validation errors, IPC failures). */
export function errorText(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) {
    // Electron prefixes rejected invoke errors with "Error invoking remote method 'x': Error: ".
    const m = /Error invoking remote method '[^']*': (?:\w*Error: )?(.*)$/s.exec(e.message);
    return (m?.[1] ?? e.message).trim() || fallback;
  }
  return fallback;
}
