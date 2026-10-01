/**
 * AI service chat tests against scripts/mock-openai.mjs, plus compatibility
 * profile tests with an injected fetch.
 * Run: npx vitest run tests/ai-chat.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// @ts-ignore: plain .mjs script without a declaration file; it is typed locally below.
import * as mockModule from '../scripts/mock-openai.mjs';
import { createAiService } from '../src/main/ai/index.ts';
import type { AiServiceTuning } from '../src/main/ai/index.ts';
import type { ChatMessage } from '../src/main/ai/contract.ts';
import type { ChatEvent, ChatSendRequest } from '../src/shared/ipc.ts';
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts';
import type { Settings } from '../src/shared/settings.ts';

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  status: number | null;
  completed: boolean | null;
}
interface MockServer {
  url: string;
  baseURL: string;
  requests: RecordedRequest[];
  reset(): number;
  close(): Promise<void>;
}
interface StartOptions {
  port?: number;
  log?: boolean;
  chunkDelayMs?: [number, number];
  slowDelayMs?: number;
}
const startMockServer = (mockModule as { startMockServer: (o?: StartOptions) => Promise<MockServer> }).startMockServer;

const KEY = 'sk-test-local';
let mock: MockServer;

beforeAll(async () => {
  mock = await startMockServer({ port: 0, log: false, chunkDelayMs: [0, 2], slowDelayMs: 1500 });
});
afterAll(async () => {
  await mock?.close();
});
beforeEach(() => {
  mock.reset();
});

// ---------------------------------------------------------------------------
// Helpers

interface Harness {
  service: ReturnType<typeof createAiService>;
  settings: Settings;
  key: { value: string | null };
  historyEvents: ChatMessage[][];
}

function harness(over: Partial<Settings> = {}, extra: { fetch?: typeof fetch; tuning?: AiServiceTuning } = {}): Harness {
  const settings: Settings = { ...DEFAULT_SETTINGS, baseUrl: mock.baseURL, chatModel: 'gpt-5-mini', ...over };
  const key = { value: KEY as string | null };
  const historyEvents: ChatMessage[][] = [];
  const service = createAiService({
    getConfig: () => ({ settings, apiKey: key.value }),
    now: () => new Date('2026-10-01T12:00:00Z'),
    onHistoryChanged: (h) => historyEvents.push(h),
    ...(extra.fetch ? { fetch: extra.fetch } : {}),
    tuning: { serverRetryDelayMs: 10, timeZone: 'Europe/London', ...extra.tuning },
  });
  return { service, settings, key, historyEvents };
}

interface Turn {
  requestId: string;
  events: ChatEvent[];
  end: Promise<ChatEvent>;
}

function send(h: Harness, text: string, source: ChatSendRequest['source'] = 'typed'): Turn {
  const events: ChatEvent[] = [];
  let resolve!: (ev: ChatEvent) => void;
  const end = new Promise<ChatEvent>((r) => (resolve = r));
  const res = h.service.sendChat({ text, source }, (ev) => {
    events.push(ev);
    if (ev.type === 'done' || ev.type === 'error') resolve(ev);
  });
  if (!res.ok) throw new Error(`sendChat failed: ${res.error.kind}`);
  return { requestId: res.requestId, events, end };
}

function expectWellFormed(t: Turn): void {
  expect(t.events.length).toBeGreaterThanOrEqual(2);
  expect(t.events[0]).toEqual({ type: 'start', requestId: t.requestId });
  const terminal = t.events.filter((e) => e.type === 'done' || e.type === 'error');
  expect(terminal).toHaveLength(1);
  expect(t.events.at(-1)).toBe(terminal[0]);
  expect(t.events.filter((e) => e.type === 'start')).toHaveLength(1);
  for (const e of t.events) expect(e.requestId).toBe(t.requestId);
}

const deltas = (t: Turn) => t.events.flatMap((e) => (e.type === 'delta' ? [e.text] : []));
const chatRequests = () => mock.requests.filter((r) => r.path === '/v1/chat/completions');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

describe('chat streaming against the mock', () => {
  it('streams deltas that assemble into the final text, with tags split across chunks', async () => {
    const h = harness();
    const t = send(h, 'Tell me about purple bananas');
    const end = await t.end;
    expectWellFormed(t);
    expect(end.type).toBe('done');
    if (end.type !== 'done') return;
    const parts = deltas(t);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.join('')).toBe(end.text);
    expect(end.text).toContain('[[Wave]]');
    expect(end.text).toContain('purple bananas');
    expect(parts.some((p) => p.includes('[[Wave]]'))).toBe(false);
    expect(end.finishReason).toBe('stop');
  });

  it('sends the documented request shape to a custom host', async () => {
    const h = harness();
    await send(h, 'shape check').end;
    const body = chatRequests()[0]!.body as Record<string, unknown>;
    expect(body.model).toBe('gpt-5-mini');
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.reasoning_effort).toBe('none'); // explicitly chosen in settings
    expect(body).not.toHaveProperty('stream_options'); // only for api.openai.com
    expect(body).not.toHaveProperty('max_completion_tokens'); // maxReplyTokens 0
    expect(body).not.toHaveProperty('temperature');
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('Thursday, 1 October 2026');
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'shape check' });
  });

  it('omits reasoning_effort for "auto" and sends max_completion_tokens when set', async () => {
    const h = harness({ reasoningEffort: 'auto', maxReplyTokens: 5 });
    const t = send(h, 'limit me');
    const end = await t.end;
    const body = chatRequests()[0]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body.max_completion_tokens).toBe(5);
    expect(end.type === 'done' && end.finishReason).toBe('length');
  });

  it('records the user message at send and the raw assistant reply on done', async () => {
    const h = harness();
    const t = send(h, 'remember this');
    expect(h.service.getHistory()).toEqual([{ role: 'user', content: 'remember this', at: '2026-10-01T12:00:00.000Z' }]);
    const end = await t.end;
    const hist = h.service.getHistory();
    expect(hist).toHaveLength(2);
    expect(hist[1]).toMatchObject({ role: 'assistant', content: end.type === 'done' ? end.text : '' });
    expect(hist[1]!.content).toContain('[[');
    expect(h.historyEvents.at(-1)).toEqual(hist);
  });

  it('returns no-key synchronously without emitting anything', () => {
    const h = harness();
    h.key.value = null;
    const events: ChatEvent[] = [];
    const res = h.service.sendChat({ text: 'hi', source: 'typed' }, (e) => events.push(e));
    expect(res).toEqual({ ok: false, error: { kind: 'no-key', message: expect.any(String) } });
    expect(events).toEqual([]);
    expect(h.service.getHistory()).toEqual([]);
  });

  it('rejects an empty message', () => {
    const res = harness().service.sendChat({ text: '   ', source: 'typed' }, () => {});
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.kind).toBe('bad-request');
  });
});

describe('cancellation and timeouts', () => {
  it('a new sendChat cancels the active one, which ends with exactly one cancelled error', async () => {
    const h = harness();
    const a = send(h, 'trigger slow first');
    const b = send(h, 'second message');
    const [ea, eb] = await Promise.all([a.end, b.end]);
    expectWellFormed(a);
    expectWellFormed(b);
    expect(ea).toMatchObject({ type: 'error', error: { kind: 'cancelled' } });
    expect(eb.type).toBe('done');
    // The cancelled turn produced no text, so its user message was dropped.
    const hist = h.service.getHistory();
    expect(hist.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(hist[0]!.content).toBe('second message');
    await sleep(50);
    expect(a.events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  it('cancelChat during "trigger slow" ends the turn promptly', async () => {
    const h = harness();
    const t = send(h, 'trigger slow please');
    await sleep(100);
    const t0 = performance.now();
    h.service.cancelChat(t.requestId);
    const end = await t.end;
    expect(performance.now() - t0).toBeLessThan(100);
    expect(end).toMatchObject({ type: 'error', error: { kind: 'cancelled' } });
    expectWellFormed(t);
    expect(h.service.getHistory()).toEqual([]);
  });

  it('cancelChat with another id does nothing; without an id cancels the active turn', async () => {
    const h = harness();
    const t = send(h, `trigger hang ${Date.now()}`);
    h.service.cancelChat('not-the-id');
    await sleep(150);
    expect(t.events.some((e) => e.type === 'error')).toBe(false);
    h.service.cancelChat();
    expect(await t.end).toMatchObject({ type: 'error', error: { kind: 'cancelled' } });
    expectWellFormed(t);
    // The aborted request is seen by the server as an incomplete response.
    await sleep(100);
    expect(chatRequests()[0]!.completed).toBe(false);
  });

  it('cancelling immediately after send still emits start before the error', async () => {
    const h = harness();
    const t = send(h, 'hello');
    h.service.cancelChat();
    await t.end;
    expectWellFormed(t);
    expect(t.events.map((e) => e.type)).toEqual(['start', 'error']);
  });

  it('"trigger hang" hits the total timeout after partial deltas', async () => {
    const h = harness({}, { tuning: { timeouts: { chatTotalMs: 400 } } });
    const t = send(h, `trigger hang ${Date.now()}`);
    const end = await t.end;
    expectWellFormed(t);
    expect(end).toMatchObject({ type: 'error', error: { kind: 'timeout' } });
    expect(deltas(t).length).toBe(2);
    // Under 20 characters of partial text: the whole turn is dropped from history.
    expect(h.service.getHistory()).toEqual([]);
  });

  it('"trigger slow" hits the first-byte timeout', async () => {
    const h = harness({}, { tuning: { timeouts: { chatFirstByteMs: 200 } } });
    const t0 = performance.now();
    const t = send(h, 'trigger slow');
    const end = await t.end;
    expect(end).toMatchObject({ type: 'error', error: { kind: 'timeout' } });
    expect(performance.now() - t0).toBeLessThan(1200);
    expect(deltas(t)).toEqual([]);
  });

  it('dispose() aborts the active turn and refuses new work', async () => {
    const h = harness();
    const t = send(h, `trigger hang ${Date.now()}`);
    h.service.dispose();
    expect(await t.end).toMatchObject({ type: 'error', error: { kind: 'cancelled' } });
    const res = h.service.sendChat({ text: 'hi', source: 'typed' }, () => {});
    expect(res.ok).toBe(false);
  });
});

describe('error mapping and retries', () => {
  it('"trigger 429 once" is retried transparently', async () => {
    const h = harness();
    const t = send(h, `trigger 429 once ${Date.now()}`);
    const end = await t.end;
    expect(end.type).toBe('done');
    expect(chatRequests().map((r) => r.status)).toEqual([429, 200]);
    expectWellFormed(t);
  });

  it('"trigger 429" retries once, then surfaces rate-limit with retryAfterSec', async () => {
    const h = harness();
    const end = await send(h, 'trigger 429').end;
    expect(end).toMatchObject({ type: 'error', error: { kind: 'rate-limit', retryAfterSec: 1, status: 429 } });
    expect(end.type === 'error' && end.error.requestId).toMatch(/^req_/);
    expect(chatRequests()).toHaveLength(2);
  });

  it('"trigger quota" maps to quota and is never retried', async () => {
    const h = harness();
    const end = await send(h, 'trigger quota').end;
    expect(end).toMatchObject({ type: 'error', error: { kind: 'quota', status: 429 } });
    expect(end.type === 'error' && end.error.retryAfterSec).toBeUndefined();
    expect(chatRequests()).toHaveLength(1);
  });

  it('"trigger 500 once" is retried once', async () => {
    const h = harness();
    const end = await send(h, `trigger 500 once ${Date.now()}`).end;
    expect(end.type).toBe('done');
    expect(chatRequests().map((r) => r.status)).toEqual([500, 200]);
  });

  it('"trigger 500" surfaces a server error after one retry', async () => {
    const h = harness();
    const end = await send(h, 'trigger 500').end;
    expect(end).toMatchObject({ type: 'error', error: { kind: 'server', status: 500 } });
    expect(chatRequests()).toHaveLength(2);
  });

  it('an invalid key maps to auth without echoing the key', async () => {
    const h = harness();
    h.key.value = 'sk-bad';
    const end = await send(h, 'hello').end;
    expect(end).toMatchObject({ type: 'error', error: { kind: 'auth', status: 401 } });
    expect(JSON.stringify(end)).not.toContain('sk-bad');
    expect(chatRequests()).toHaveLength(1);
  });

  it('an unknown model maps to model', async () => {
    const h = harness({ chatModel: 'nonexistent-model' });
    const end = await send(h, 'hello').end;
    expect(end).toMatchObject({ type: 'error', error: { kind: 'model', status: 404 } });
    expect(end.type === 'error' && end.error.message).toContain('nonexistent-model');
  });

  it('a refused connection maps to network', async () => {
    const h = harness({ baseUrl: 'http://127.0.0.1:9/v1' });
    const end = await send(h, 'hello').end;
    expect(end).toMatchObject({ type: 'error', error: { kind: 'network' } });
  });
});

// ---------------------------------------------------------------------------
// Injected fetch: compatibility profile and other server behaviours

interface FakeCall {
  url: string;
  body: Record<string, unknown>;
  auth: string | null;
}

function sseText(contents: string[], opts: { finish?: string | null; done?: boolean; error?: unknown } = {}): string {
  const lines = contents.map((c) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: c }, finish_reason: null }] })}\n\n`);
  if (opts.error) lines.push(`data: ${JSON.stringify({ error: opts.error })}\n\n`);
  if (opts.finish !== null && !opts.error) lines.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: opts.finish ?? 'stop' }] })}\n\n`);
  if (opts.done !== false && !opts.error) lines.push('data: [DONE]\n\n');
  return lines.join('');
}

const sseResponse = (text: string) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_fake' } });
const jsonError = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeFetch(handler: (call: FakeCall, n: number) => Response | Promise<Response>) {
  const calls: FakeCall[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const headers = new Headers(init?.headers);
    const call = { url, body, auth: headers.get('authorization') };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { fn, calls };
}

const unsupported = (param: string | null, code: string, message: string) => ({
  error: { message, type: 'invalid_request_error', param, code },
});

describe('parameter compatibility profile (injected fetch)', () => {
  it('steps reasoning_effort none -> low and falls back to max_tokens, then remembers it', async () => {
    const f = fakeFetch(({ body }) => {
      if (body.reasoning_effort === 'none') {
        return jsonError(400, unsupported('reasoning_effort', 'unsupported_value', "Unsupported value: 'reasoning_effort' does not support 'none' with this model."));
      }
      if ('max_completion_tokens' in body) {
        return jsonError(400, unsupported('max_completion_tokens', 'unsupported_parameter', "Unsupported parameter: 'max_completion_tokens'."));
      }
      return sseResponse(sseText(['Hi', ' there!']));
    });
    const h = harness({ baseUrl: 'http://127.0.0.1:1/v1', maxReplyTokens: 300 }, { fetch: f.fn });
    const end = await send(h, 'hello').end;
    expect(end).toMatchObject({ type: 'done', text: 'Hi there!' });
    expect(f.calls.map((c) => [c.body.reasoning_effort, c.body.max_completion_tokens, c.body.max_tokens])).toEqual([
      ['none', 300, undefined],
      ['low', 300, undefined],
      ['low', undefined, 300],
    ]);
    expect(f.calls[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(f.calls[0]!.url).toBe('http://127.0.0.1:1/v1/chat/completions');

    // Remembered for this (baseUrl, model): the next turn needs one request.
    await send(h, 'again').end;
    expect(f.calls).toHaveLength(4);
    expect(f.calls[3]!.body).toMatchObject({ reasoning_effort: 'low', max_tokens: 300 });
    expect(f.calls[3]!.body).not.toHaveProperty('max_completion_tokens');
  });

  it('drops reasoning_effort entirely when the parameter itself is unsupported', async () => {
    const f = fakeFetch(({ body }) =>
      'reasoning_effort' in body
        ? jsonError(400, unsupported('reasoning_effort', 'unsupported_parameter', "Unsupported parameter: 'reasoning_effort'."))
        : sseResponse(sseText(['ok'])),
    );
    const h = harness({ baseUrl: 'http://127.0.0.1:1/v1' }, { fetch: f.fn });
    expect((await send(h, 'x').end).type).toBe('done');
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.body).not.toHaveProperty('reasoning_effort');
  });

  it('matches the parameter from the message when param is null or the error is a plain string', async () => {
    const f = fakeFetch(({ body }) => {
      if ('max_completion_tokens' in body) return jsonError(400, { error: 'Unrecognized request argument supplied: max_completion_tokens' });
      if (body.store === false) return jsonError(422, { detail: [{ loc: ['body', 'store'], msg: 'Extra inputs are not permitted', type: 'extra_forbidden' }] });
      return sseResponse(sseText(['fine']));
    });
    const h = harness({ baseUrl: 'http://127.0.0.1:1/v1', maxReplyTokens: 50, reasoningEffort: 'auto' }, { fetch: f.fn });
    expect((await send(h, 'x').end).type).toBe('done');
    expect(f.calls.map((c) => Object.keys(c.body).filter((k) => ['max_completion_tokens', 'max_tokens', 'store'].includes(k)).sort())).toEqual([
      ['max_completion_tokens', 'store'],
      ['max_tokens', 'store'],
      ['max_tokens'],
    ]);
  });

  it('on api.openai.com sends stream_options and omits (never renames) a rejected max_completion_tokens', async () => {
    const f = fakeFetch(({ body }) =>
      'max_completion_tokens' in body
        ? jsonError(400, unsupported('max_completion_tokens', 'unsupported_parameter', 'nope'))
        : sseResponse(sseText(['ok'])),
    );
    const h = harness({ baseUrl: 'https://api.openai.com/v1', maxReplyTokens: 100 }, { fetch: f.fn });
    expect((await send(h, 'x').end).type).toBe('done');
    expect(f.calls[0]!.body.stream_options).toEqual({ include_usage: true });
    expect(f.calls[1]!.body).not.toHaveProperty('max_completion_tokens');
    expect(f.calls[1]!.body).not.toHaveProperty('max_tokens');
  });

  it('gives up after 3 adjustments and does not retry parameters it never sent', async () => {
    const f = fakeFetch(() => jsonError(400, unsupported('temperature', 'unsupported_parameter', "Unsupported parameter: 'temperature'.")));
    const h = harness({ baseUrl: 'http://127.0.0.1:1/v1' }, { fetch: f.fn });
    const end = await send(h, 'x').end;
    expect(end).toMatchObject({ type: 'error', error: { kind: 'bad-request', status: 400 } });
    expect(f.calls).toHaveLength(1);

    let n = 0;
    const g = fakeFetch(() => {
      n++;
      const params = ['reasoning_effort', 'store', 'max_completion_tokens', 'max_tokens'];
      return jsonError(400, unsupported(params[n - 1] ?? 'max_tokens', 'unsupported_parameter', 'Unsupported parameter.'));
    });
    const h2 = harness({ baseUrl: 'http://127.0.0.1:1/v1', maxReplyTokens: 10 }, { fetch: g.fn });
    const end2 = await send(h2, 'x').end;
    expect(end2).toMatchObject({ type: 'error', error: { kind: 'bad-request' } });
    expect(g.calls).toHaveLength(4); // first try + 3 adjusted retries
  });

  it('halves the history once on context_length_exceeded', async () => {
    let first = true;
    const f = fakeFetch(() => {
      if (first) {
        first = false;
        return jsonError(400, { error: { message: 'maximum context length exceeded', type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' } });
      }
      return sseResponse(sseText(['short']));
    });
    const h = harness({ baseUrl: 'http://127.0.0.1:1/v1', historyMessages: 20 }, { fetch: f.fn });
    const past: ChatMessage[] = [];
    for (let i = 0; i < 8; i++) past.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}`, at: '2026-10-01T00:00:00.000Z' });
    h.service.setHistory(past);
    expect((await send(h, 'now').end).type).toBe('done');
    const counts = f.calls.map((c) => (c.body.messages as unknown[]).length);
    expect(counts).toEqual([1 + 8 + 1, 1 + 4 + 1]);
  });

  it('treats an error object inside the stream as an error event and keeps a long partial reply', async () => {
    const f = fakeFetch(() =>
      sseResponse(sseText(['This is a fairly long ', 'partial answer'], { error: { message: 'overloaded', type: 'server_error', code: 'server_is_overloaded' } })),
    );
    const h = harness({ baseUrl: 'http://127.0.0.1:1/v1' }, { fetch: f.fn });
    const t = send(h, 'question');
    const end = await t.end;
    expect(end).toMatchObject({ type: 'error', error: { kind: 'server', requestId: 'req_fake' } });
    expect(f.calls).toHaveLength(1); // deltas were emitted, so no retry
    expect(h.service.getHistory().map((m) => [m.role, m.content])).toEqual([
      ['user', 'question'],
      ['assistant', 'This is a fairly long partial answer ...'],
    ]);
  });

  it('treats EOF without [DONE] as success only when a finish_reason was seen', async () => {
    const ok = fakeFetch(() => sseResponse(sseText(['a', 'b'], { done: false })));
    const h1 = harness({ baseUrl: 'http://127.0.0.1:1/v1' }, { fetch: ok.fn });
    expect(await send(h1, 'x').end).toMatchObject({ type: 'done', text: 'ab', finishReason: 'stop' });

    const cut = fakeFetch(() => sseResponse(sseText(['a', 'b'], { done: false, finish: null })));
    const h2 = harness({ baseUrl: 'http://127.0.0.1:1/v1' }, { fetch: cut.fn });
    expect(await send(h2, 'x').end).toMatchObject({ type: 'error', error: { kind: 'network' } });
  });

  it('accepts a non-streaming JSON completion from servers that ignore stream:true', async () => {
    const f = fakeFetch(
      () =>
        new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '[[Wave]] Hello!' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const h = harness({ baseUrl: 'http://127.0.0.1:1/v1' }, { fetch: f.fn });
    const t = send(h, 'x');
    expect(await t.end).toMatchObject({ type: 'done', text: '[[Wave]] Hello!' });
    expect(deltas(t)).toEqual(['[[Wave]] Hello!']);
  });

  it('does not follow redirects', async () => {
    const f = fakeFetch(() => new Response(null, { status: 307, headers: { location: 'https://evil.example/v1/chat/completions' } }));
    const h = harness({ baseUrl: 'http://127.0.0.1:1/v1' }, { fetch: f.fn });
    const end = await send(h, 'x').end;
    expect(end).toMatchObject({ type: 'error', error: { kind: 'bad-request', status: 307 } });
    expect(f.calls).toHaveLength(1);
  });
});
