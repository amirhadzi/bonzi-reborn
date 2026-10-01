// HTTP plumbing for the AI service: URL joining, auth header, timeouts composed
// with caller cancellation, and mapping of provider errors to AiError.
// Pure Node (global fetch); never imports electron.

import type { AiError, AiErrorKind } from '../../shared/ipc.ts';
import { normalizeBaseUrl } from '../../shared/settings.ts';

export type FetchLike = typeof fetch;

export interface AiTimeouts {
  /** Chat: time until the first response body bytes arrive (per attempt). */
  chatFirstByteMs: number;
  /** Chat: whole turn including retries. */
  chatTotalMs: number;
  ttsMs: number;
  sttMs: number;
  modelsMs: number;
}

export const DEFAULT_TIMEOUTS: AiTimeouts = {
  chatFirstByteMs: 30_000,
  chatTotalMs: 120_000,
  ttsMs: 30_000,
  sttMs: 60_000,
  modelsMs: 15_000,
};

/** Normalised provider error details (before mapping to an AiError kind). */
export interface ProviderError {
  status: number;
  message: string;
  type: string | null;
  code: string | null;
  param: string | null;
  retryAfterSec?: number;
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Abort scope: one AbortController fed by caller cancellation and timers, which
// remembers why it aborted so errors can be reported as 'timeout' or 'cancelled'.

export type AbortReason = 'timeout' | 'cancelled';

export interface AbortScope {
  readonly signal: AbortSignal;
  reason(): AbortReason | null;
  abort(reason: AbortReason): void;
  /** Starts a timer that aborts the scope with 'timeout'. Returns a function that clears it. */
  timer(ms: number): () => void;
  /** Clears timers and detaches from the parent signal. Does not abort. */
  dispose(): void;
}

export function createAbortScope(parent?: AbortSignal): AbortScope {
  const controller = new AbortController();
  let why: AbortReason | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const abort = (reason: AbortReason): void => {
    if (why) return;
    why = reason;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    controller.abort(reason);
  };
  const onParentAbort = (): void => abort('cancelled');
  if (parent) {
    if (parent.aborted) abort('cancelled');
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    reason: () => why,
    abort,
    timer(ms: number) {
      if (why) return () => {};
      const t = setTimeout(() => {
        timers.delete(t);
        abort('timeout');
      }, Math.max(0, ms));
      timers.add(t);
      return () => {
        clearTimeout(t);
        timers.delete(t);
      };
    },
    dispose() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/** setTimeout as a promise that rejects when the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// URLs

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function isOpenAiHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Messages (short, user-presentable, never containing the key)

const KEY_LIKE = /\b(?:sk|rk|pk|sess)-[A-Za-z0-9_\-*.]{6,}/g;

export function sanitizeMessage(message: string, apiKey?: string | null): string {
  let m = message;
  if (apiKey && apiKey.length >= 4) m = m.split(apiKey).join('[redacted]');
  m = m.replace(KEY_LIKE, '[redacted]');
  m = m.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  if (m.length > 200) m = `${m.slice(0, 197).trimEnd()}...`;
  return m;
}

export function aiError(kind: AiErrorKind, message: string, extra: Partial<AiError> = {}): AiError {
  return { kind, message, ...extra };
}

export const MESSAGES = {
  noKey: 'No API key is set. Add one in Settings.',
  auth: 'The API key was rejected. Check it in Settings.',
  forbidden: 'The AI provider refused access for this key.',
  quota: 'The account is out of credit or over its spend limit. Check billing with your provider.',
  network: 'Could not reach the AI server. Check your connection and the base URL.',
  timeout: 'The AI server took too long to answer.',
  server: 'The AI server had a problem. Please try again in a moment.',
  cancelled: 'Request cancelled.',
  badBaseUrl: 'The base URL is not valid. It must be https (or http on localhost).',
  redirect: 'The server tried to redirect the request. Check the base URL.',
  notFound: 'That endpoint was not found. Check the base URL.',
} as const;

// ---------------------------------------------------------------------------
// Error body normalisation

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Accepts OpenAI ({error:{...}}) and common non-OpenAI shapes ({error:"str"}, {detail}, {message}, plain text). */
export function normalizeErrorBody(raw: string): Pick<ProviderError, 'message' | 'type' | 'code' | 'param'> {
  const out = { message: '', type: null as string | null, code: null as string | null, param: null as string | null };
  const text = raw.trim();
  if (!text) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    out.message = text.slice(0, 500);
    return out;
  }
  return { ...out, ...normalizeErrorObject(parsed) };
}

export function normalizeErrorObject(parsed: unknown): Pick<ProviderError, 'message' | 'type' | 'code' | 'param'> {
  const out = { message: '', type: null as string | null, code: null as string | null, param: null as string | null };
  if (typeof parsed === 'string') {
    out.message = parsed;
    return out;
  }
  if (typeof parsed !== 'object' || parsed === null) return out;
  const o = parsed as Record<string, unknown>;
  let e: unknown = o.error ?? o;
  if (Array.isArray(e)) e = e[0];
  if (typeof e === 'string') {
    out.message = e;
    out.code = asString(o.code);
    out.type = asString(o.type);
    out.param = asString(o.param);
    return out;
  }
  if (typeof e === 'object' && e !== null) {
    const r = e as Record<string, unknown>;
    out.message = asString(r.message) ?? '';
    out.type = asString(r.type);
    out.code = asString(r.code);
    out.param = asString(r.param);
    if (!out.message && r.detail !== undefined) out.message = detailText(r.detail);
    if (!out.message && typeof r.error === 'string') out.message = r.error;
  }
  return out;
}

function detailText(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    // FastAPI/pydantic: [{loc:[...], msg, type}]
    return detail
      .map((d) => {
        if (typeof d !== 'object' || d === null) return String(d);
        const r = d as Record<string, unknown>;
        const loc = Array.isArray(r.loc) ? r.loc.join('.') : '';
        return [loc, asString(r.msg) ?? '', asString(r.type) ?? ''].filter(Boolean).join(': ');
      })
      .join('; ');
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return '';
  }
}

export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.max(0, Number(ms) / 1000);
  const ra = headers.get('retry-after');
  if (!ra) return undefined;
  const v = ra.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.max(0, Number(v));
  const date = Date.parse(v);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  return undefined;
}

// ---------------------------------------------------------------------------
// Mapping to AiError

const QUOTA_RE = /insufficient_quota|credit_balance_exhausted|spend_limit|usage_limit|billing_hard_limit|billing_not_active|quota_exceeded/i;

export function isQuotaError(p: Pick<ProviderError, 'code' | 'type'>): boolean {
  return QUOTA_RE.test(p.code ?? '') || QUOTA_RE.test(p.type ?? '');
}

export function isContextLengthError(p: ProviderError): boolean {
  return p.code === 'context_length_exceeded' || /context[_ ]length|maximum context|too many tokens/i.test(p.message);
}

export interface MapContext {
  /** The request targeted a specific model (chat, TTS, STT), so a 404 most likely means the model. */
  model?: string;
  apiKey?: string | null;
}

export function mapProviderError(p: ProviderError, ctx: MapContext = {}): AiError {
  const extra: Partial<AiError> = {};
  if (p.status > 0) extra.status = p.status;
  if (p.requestId) extra.requestId = p.requestId;
  const provider = sanitizeMessage(p.message, ctx.apiKey);
  const code = p.code ?? '';
  const type = p.type ?? '';

  if (isQuotaError(p)) return aiError('quota', MESSAGES.quota, extra);
  if (code === 'invalid_api_key' || p.status === 401) return aiError('auth', MESSAGES.auth, extra);
  if (p.status === 403) {
    return aiError('auth', provider && !/api key/i.test(provider) ? `${MESSAGES.forbidden} (${provider})` : MESSAGES.forbidden, extra);
  }
  if (p.status === 429 || /rate_limit|slow_down/.test(code) || /rate_limit/.test(type)) {
    if (p.retryAfterSec !== undefined) extra.retryAfterSec = p.retryAfterSec;
    const wait = p.retryAfterSec !== undefined ? ` Try again in ${Math.max(1, Math.ceil(p.retryAfterSec))} seconds.` : ' Try again shortly.';
    return aiError('rate-limit', `Too many requests right now.${wait}`, extra);
  }
  if (code === 'model_not_found' || (p.status === 404 && ctx.model && !/invalid url/i.test(p.message))) {
    const name = ctx.model ? `"${ctx.model}"` : 'The model';
    return aiError('model', `${ctx.model ? `Model ${name}` : name} is not available for this key or server.`, extra);
  }
  if (p.status === 404) return aiError('bad-request', MESSAGES.notFound, extra);
  if (p.status >= 300 && p.status < 400) return aiError('bad-request', MESSAGES.redirect, extra);
  if (p.status >= 500 || code === 'server_is_overloaded' || code === 'server_error' || type === 'server_error') {
    return aiError('server', MESSAGES.server, extra);
  }
  if (p.status === 408) return aiError('timeout', MESSAGES.timeout, extra);
  if (p.status === 400 || p.status === 413 || p.status === 422) {
    return aiError('bad-request', provider || 'The AI server rejected the request.', extra);
  }
  if (p.status === 0) {
    // Error object inside a stream with no HTTP status.
    return aiError('server', provider || MESSAGES.server, extra);
  }
  return aiError('unknown', provider ? `Unexpected error (HTTP ${p.status}): ${provider}` : `Unexpected error (HTTP ${p.status}).`, extra);
}

/** Maps a thrown fetch / body-read error, using the scope's abort reason when it aborted. */
export function mapThrown(err: unknown, scope: AbortScope | null): AiError {
  const reason = scope?.reason();
  if (reason === 'timeout') return aiError('timeout', MESSAGES.timeout);
  if (reason === 'cancelled') return aiError('cancelled', MESSAGES.cancelled);
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return err.name === 'TimeoutError' ? aiError('timeout', MESSAGES.timeout) : aiError('cancelled', MESSAGES.cancelled);
  }
  return aiError('network', MESSAGES.network);
}

// ---------------------------------------------------------------------------
// Request helper

export interface HttpRequest {
  fetch: FetchLike;
  baseUrl: string;
  apiKey: string;
  path: string;
  method?: 'GET' | 'POST';
  /** JSON-serialisable body, or FormData for multipart. */
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  signal: AbortSignal;
}

export type HttpResponse =
  | { ok: true; response: Response; requestId?: string }
  | { ok: false; provider: ProviderError }
  | { ok: false; thrown: unknown };

/**
 * Sends one request. Never throws: network failures come back as `thrown`,
 * HTTP errors as a normalised `provider` error (body already consumed).
 * Redirects are not followed so nothing is ever sent to another host.
 */
export async function httpRequest(req: HttpRequest): Promise<HttpResponse> {
  const base = normalizeBaseUrl(req.baseUrl);
  if (!base) return { ok: false, provider: { status: 400, message: MESSAGES.badBaseUrl, type: 'client', code: 'invalid_base_url', param: null } };
  const headers: Record<string, string> = {
    authorization: `Bearer ${req.apiKey}`,
    accept: 'application/json, text/event-stream, audio/*',
    ...req.headers,
  };
  let body: string | FormData | undefined;
  if (req.form) body = req.form;
  else if (req.json !== undefined) {
    body = JSON.stringify(req.json);
    headers['content-type'] = 'application/json';
  }
  let response: Response;
  try {
    response = await req.fetch(joinUrl(base, req.path), {
      method: req.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      signal: req.signal,
      redirect: 'manual',
    });
  } catch (err) {
    return { ok: false, thrown: err };
  }
  const requestId = response.headers.get('x-request-id') ?? undefined;
  if (response.status >= 200 && response.status < 300) return { ok: true, response, ...(requestId ? { requestId } : {}) };

  let raw = '';
  try {
    raw = await response.text();
  } catch (err) {
    if (req.signal.aborted) return { ok: false, thrown: err };
  }
  const norm = normalizeErrorBody(raw.slice(0, 64 * 1024));
  const provider: ProviderError = { status: response.status, ...norm };
  const retryAfterSec = parseRetryAfter(response.headers);
  if (retryAfterSec !== undefined) provider.retryAfterSec = retryAfterSec;
  if (requestId) provider.requestId = requestId;
  return { ok: false, provider };
}

/** Base content type without parameters, lower case: "audio/webm;codecs=opus" -> "audio/webm". */
export function baseMime(mime: string | null | undefined): string {
  return (mime ?? '').split(';')[0]!.trim().toLowerCase();
}
