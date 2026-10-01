// Chat Completions streaming transport with a per-(baseUrl, model) parameter
// compatibility profile and the retry policy from docs/RESEARCH.md.

import type { Settings } from '../../shared/settings.ts';
import {
  abortableSleep,
  httpRequest,
  isContextLengthError,
  isOpenAiHost,
  isQuotaError,
  mapProviderError,
  mapThrown,
} from './http.ts';
import type { AbortScope, AiTimeouts, FetchLike, ProviderError } from './http.ts';
import { createSseParser, decodeChatData } from './sse.ts';
import type { AiError } from '../../shared/ipc.ts';

export interface WireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ---------------------------------------------------------------------------
// Compatibility profile

export interface CompatProfile {
  tokenParam: 'max_completion_tokens' | 'max_tokens' | 'omit';
  /** Requested reasoning effort -> effective value (null = omit). Absent = send as requested. */
  effort: Map<string, string | null>;
  sendStreamOptions: boolean;
  sendStore: boolean;
}

export function newProfile(): CompatProfile {
  return { tokenParam: 'max_completion_tokens', effort: new Map(), sendStreamOptions: true, sendStore: true };
}

export class CompatRegistry {
  #profiles = new Map<string, CompatProfile>();

  get(baseUrl: string, model: string): CompatProfile {
    const key = `${baseUrl}\u0000${model}`;
    let p = this.#profiles.get(key);
    if (!p) {
      p = newProfile();
      this.#profiles.set(key, p);
    }
    return p;
  }

  clear(): void {
    this.#profiles.clear();
  }
}

export interface ChatBodyInput {
  settings: Pick<Settings, 'baseUrl' | 'chatModel' | 'reasoningEffort' | 'maxReplyTokens'>;
  messages: WireMessage[];
  profile: CompatProfile;
}

export function effectiveEffort(requested: string, profile: CompatProfile): string | null {
  if (requested === 'auto') return null;
  return profile.effort.has(requested) ? (profile.effort.get(requested) ?? null) : requested;
}

export function buildChatBody(input: ChatBodyInput): Record<string, unknown> {
  const { settings, profile } = input;
  const body: Record<string, unknown> = {
    model: settings.chatModel,
    messages: input.messages,
    stream: true,
  };
  if (profile.sendStore) body.store = false;
  const effort = effectiveEffort(settings.reasoningEffort, profile);
  if (effort) body.reasoning_effort = effort;
  if (settings.maxReplyTokens > 0 && profile.tokenParam !== 'omit') body[profile.tokenParam] = Math.floor(settings.maxReplyTokens);
  if (isOpenAiHost(settings.baseUrl) && profile.sendStreamOptions) body.stream_options = { include_usage: true };
  return body;
}

const KNOWN_PARAMS = ['max_completion_tokens', 'reasoning_effort', 'stream_options', 'max_tokens', 'store'] as const;
type KnownParam = (typeof KNOWN_PARAMS)[number];

const UNSUPPORTED_PHRASE =
  /unsupported (parameter|value)|unrecognized (request )?argument|unknown (field|parameter|argument|name)|extra_forbidden|extra (inputs|fields) (are )?not permitted|not supported|not allowed|is not permitted|invalid (parameter|value)|does not support/i;

/** Which parameter a 400 complains about, if it is one we send. */
export function unsupportedParam(err: ProviderError, body: Record<string, unknown>): KnownParam | null {
  if (err.status !== 400 && err.status !== 422) return null;
  const codeMatch = err.code === 'unsupported_parameter' || err.code === 'unsupported_value';
  if (!codeMatch && !UNSUPPORTED_PHRASE.test(err.message)) return null;
  const sent = (p: KnownParam) => Object.hasOwn(body, p);
  if (err.param) {
    const head = err.param.split(/[.[]/)[0] ?? '';
    const known = KNOWN_PARAMS.find((p) => p === head);
    if (known && sent(known)) return known;
    if (codeMatch) return null; // a parameter we do not control
  }
  for (const p of KNOWN_PARAMS) {
    if (sent(p) && new RegExp(`\\b${p}\\b`).test(err.message)) return p;
  }
  return null;
}

/** Adjusts the profile for one rejected parameter. Returns false when nothing could change. */
export function adjustProfile(
  profile: CompatProfile,
  param: KnownParam,
  err: ProviderError,
  body: Record<string, unknown>,
  openAiHost: boolean,
  requestedEffort: string,
): boolean {
  switch (param) {
    case 'reasoning_effort': {
      const sentValue = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : null;
      if (!sentValue || requestedEffort === 'auto') return false;
      const requested = requestedEffort;
      const valueProblem = err.code === 'unsupported_value' || /does not support|unsupported value|invalid value/i.test(err.message);
      const next = valueProblem && (sentValue === 'none' || sentValue === 'minimal') ? 'low' : null;
      profile.effort.set(requested, next);
      return true;
    }
    case 'max_completion_tokens':
      profile.tokenParam = openAiHost ? 'omit' : 'max_tokens';
      return true;
    case 'max_tokens':
      profile.tokenParam = 'omit';
      return true;
    case 'stream_options':
      profile.sendStreamOptions = false;
      return true;
    case 'store':
      profile.sendStore = false;
      return true;
  }
}

// ---------------------------------------------------------------------------
// Turn runner

export interface ChatRunOptions {
  fetch: FetchLike;
  apiKey: string;
  settings: Settings;
  profile: CompatProfile;
  /** Builds the messages; `historyLimit` lets the runner shrink the context. */
  buildMessages: (historyLimit: number) => WireMessage[];
  historyLimit: number;
  /** Turn scope (caller cancellation + total timeout already wired). */
  scope: AbortScope;
  timeouts: AiTimeouts;
  serverRetryDelayMs: number;
  /** Rate limits with a retry-after up to this many seconds are retried once. */
  maxRateLimitWaitSec: number;
  onDelta: (text: string) => void;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export type ChatRunResult =
  | { ok: true; text: string; finishReason: string | null; requestId?: string }
  | { ok: false; error: AiError; text: string };

const MAX_COMPAT_ADJUSTMENTS = 3;

interface AttemptFailure {
  provider?: ProviderError;
  error?: AiError;
}

export async function runChat(o: ChatRunOptions): Promise<ChatRunResult> {
  const openAiHost = isOpenAiHost(o.settings.baseUrl);
  const model = o.settings.chatModel;
  let compatAdjustments = 0;
  let rateLimitRetried = false;
  let serverRetried = false;
  let contextTrimmed = false;
  let historyLimit = o.historyLimit;
  let text = '';
  let emitted = false;

  const fail = (error: AiError): ChatRunResult => ({ ok: false, error, text });

  for (;;) {
    if (o.scope.reason()) return fail(mapThrown(null, o.scope));
    const messages = o.buildMessages(historyLimit);
    const body = buildChatBody({ settings: o.settings, messages, profile: o.profile });

    const attempt = await attemptStream(o, body, (delta) => {
      text += delta;
      emitted = true;
      o.onDelta(delta);
    });
    if (attempt.ok) return { ok: true, text, finishReason: attempt.finishReason, ...(attempt.requestId ? { requestId: attempt.requestId } : {}) };

    const f = attempt.failure;
    const p = f.provider;
    const error = f.error ?? (p ? mapProviderError(p, { model, apiKey: o.apiKey }) : mapThrown(null, o.scope));
    if (emitted || !p) return fail(error);

    if (compatAdjustments < MAX_COMPAT_ADJUSTMENTS) {
      const param = unsupportedParam(p, body);
      if (param && adjustProfile(o.profile, param, p, body, openAiHost, o.settings.reasoningEffort)) {
        compatAdjustments++;
        o.log?.('info', `chat: provider rejected ${param} for model ${model}; retrying without it`);
        continue;
      }
    }
    if (error.kind === 'rate-limit' && !isQuotaError(p) && !rateLimitRetried && p.retryAfterSec !== undefined && p.retryAfterSec <= o.maxRateLimitWaitSec) {
      rateLimitRetried = true;
      o.log?.('info', `chat: rate limited, retrying in ${p.retryAfterSec}s`);
      try {
        await abortableSleep(p.retryAfterSec * 1000, o.scope.signal);
      } catch {
        return fail(mapThrown(null, o.scope));
      }
      continue;
    }
    if (error.kind === 'server' && !serverRetried) {
      serverRetried = true;
      o.log?.('info', 'chat: server error, retrying once');
      try {
        await abortableSleep(o.serverRetryDelayMs, o.scope.signal);
      } catch {
        return fail(mapThrown(null, o.scope));
      }
      continue;
    }
    if (p.status === 400 && isContextLengthError(p) && !contextTrimmed) {
      contextTrimmed = true;
      const prior = Math.max(0, messages.filter((m) => m.role !== 'system').length - 1);
      historyLimit = Math.floor(Math.min(historyLimit, prior) / 2);
      o.log?.('info', `chat: context too long, retrying with ${historyLimit} history messages`);
      continue;
    }
    return fail(error);
  }
}

type AttemptResult =
  | { ok: true; finishReason: string | null; requestId?: string }
  | { ok: false; failure: AttemptFailure };

async function attemptStream(o: ChatRunOptions, body: Record<string, unknown>, onDelta: (t: string) => void): Promise<AttemptResult> {
  const clearFirstByte = o.scope.timer(o.timeouts.chatFirstByteMs);
  try {
    const res = await httpRequest({
      fetch: o.fetch,
      baseUrl: o.settings.baseUrl,
      apiKey: o.apiKey,
      path: 'chat/completions',
      json: body,
      signal: o.scope.signal,
    });
    if (!res.ok) {
      if ('provider' in res) return { ok: false, failure: { provider: res.provider } };
      return { ok: false, failure: { error: mapThrown(res.thrown, o.scope) } };
    }
    const response = res.response;
    const requestId = res.requestId;
    const ctype = (response.headers.get('content-type') ?? '').toLowerCase();

    if (!ctype.includes('text/event-stream') && ctype.includes('application/json')) {
      // Some servers ignore stream:true and answer with a full completion.
      clearFirstByte();
      return await readNonStream(response, onDelta, requestId);
    }
    if (!response.body) return { ok: false, failure: { error: { kind: 'server', message: 'The AI server sent an empty response.' } } };

    let finishReason: string | null = null;
    let sawDone = false;
    let streamError: ProviderError | null = null;
    const parser = createSseParser((msg) => {
      if (sawDone || streamError) return;
      const item = decodeChatData(msg.data);
      if (item.kind === 'done') sawDone = true;
      else if (item.kind === 'error') streamError = { status: 0, ...item.error, ...(requestId ? { requestId } : {}) };
      else if (item.kind === 'chunk') {
        if (item.content) onDelta(item.content);
        if (item.finishReason) finishReason = item.finishReason;
      }
    });

    const reader = response.body.getReader();
    let first = true;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (first) {
          first = false;
          clearFirstByte();
        }
        if (value) parser.push(value);
        if (sawDone || streamError) break;
      }
      if (!sawDone && !streamError) parser.end();
    } catch (err) {
      return { ok: false, failure: { error: withRequestId(mapThrown(err, o.scope), requestId) } };
    } finally {
      if (sawDone || streamError) reader.cancel().catch(() => {});
      else reader.releaseLock();
    }

    if (streamError) return { ok: false, failure: { provider: streamError } };
    if (sawDone || finishReason !== null) return { ok: true, finishReason, ...(requestId ? { requestId } : {}) };
    if (o.scope.reason()) return { ok: false, failure: { error: withRequestId(mapThrown(null, o.scope), requestId) } };
    return {
      ok: false,
      failure: { error: withRequestId({ kind: 'network', message: 'The connection closed before the reply finished.' }, requestId) },
    };
  } finally {
    clearFirstByte();
  }
}

async function readNonStream(response: Response, onDelta: (t: string) => void, requestId: string | undefined): Promise<AttemptResult> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, failure: { error: withRequestId({ kind: 'server', message: 'The AI server sent an unreadable response.' }, requestId) } };
  }
  const o = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (o.error) {
    const item = decodeChatData(JSON.stringify(o));
    if (item.kind === 'error') return { ok: false, failure: { provider: { status: 0, ...item.error, ...(requestId ? { requestId } : {}) } } };
  }
  const choice = Array.isArray(o.choices) ? (o.choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = choice && typeof choice.message === 'object' && choice.message !== null ? (choice.message as Record<string, unknown>) : {};
  const content = typeof message.content === 'string' ? message.content : typeof message.refusal === 'string' ? message.refusal : '';
  if (content) onDelta(content);
  const finishReason = choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  return { ok: true, finishReason, ...(requestId ? { requestId } : {}) };
}

function withRequestId(e: AiError, requestId: string | undefined): AiError {
  return requestId ? { ...e, requestId } : e;
}
