/**
 * Tests for the dependency-free OpenAI mock (scripts/mock-openai.mjs).
 * Run: npx vitest run tests/mock-openai.test.ts
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-ignore: plain .mjs script without a declaration file; it is typed locally below.
import * as mockModule from '../scripts/mock-openai.mjs';

// ---------------------------------------------------------------------------
// Local typings for the mock module
// ---------------------------------------------------------------------------

interface RecordedRequest {
  id: number;
  time: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  hasAuth: boolean;
  body: unknown;
  status: number | null;
  durationMs: number | null;
  completed: boolean | null;
}

interface MockServer {
  url: string;
  baseURL: string;
  port: number;
  requests: RecordedRequest[];
  reset(): number;
  close(): Promise<void>;
}

interface StartOptions {
  port?: number;
  log?: boolean | ((line: string) => void);
  chunkDelayMs?: [number, number];
  slowDelayMs?: number;
}

const startMockServer = (mockModule as { startMockServer: (o?: StartOptions) => Promise<MockServer> }).startMockServer;

interface ApiError {
  error: { message: string; type: string; param: string | null; code: string | null };
}

interface ChatCompletion {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface ChatChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{ index: number; delta: { role?: string; content?: string }; finish_reason: string | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

interface SseEvent {
  data: string;
  t: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEY = 'sk-test-local';
const SAMPLE_RATE = 24000;
const SAMPLES_PER_CHAR = (60 * SAMPLE_RATE) / 1000; // 1440
const SCRIPT_PATH = fileURLToPath(new URL('../scripts/mock-openai.mjs', import.meta.url));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(15);
  }
}

type ApiInit = RequestInit & { key?: string | null };

function api(server: MockServer, p: string, init: ApiInit = {}): Promise<Response> {
  const { key = KEY, headers, ...rest } = init;
  const h = new Headers(headers);
  if (key !== null) h.set('authorization', `Bearer ${key}`);
  return fetch(`${server.baseURL}${p}`, { ...rest, headers: h });
}

function postJson(server: MockServer, p: string, body: unknown, init: ApiInit = {}): Promise<Response> {
  return api(server, p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

const chat = (server: MockServer, body: Record<string, unknown>, init: ApiInit = {}) =>
  postJson(server, '/chat/completions', body, init);

const userMsgs = (content: string) => [
  { role: 'system', content: 'You are Bonzi, a friendly purple gorilla.' },
  { role: 'user', content },
];

function collectSse(res: Response) {
  const events: SseEvent[] = [];
  const body = res.body;
  if (!body) throw new Error('response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    let buf = '';
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = raw
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n');
        events.push({ data, t: performance.now() });
      }
    }
    expect(buf.trim()).toBe(''); // no partial event left over
  })();
  return { events, done };
}

async function readSse(res: Response): Promise<SseEvent[]> {
  const c = collectSse(res);
  await c.done;
  return c.events;
}

function parseChunks(events: SseEvent[]): ChatChunk[] {
  expect(events.length).toBeGreaterThan(2);
  expect(events.at(-1)?.data).toBe('[DONE]');
  return events.slice(0, -1).map((e) => JSON.parse(e.data) as ChatChunk);
}

function assembled(chunks: ChatChunk[]): string {
  return chunks.map((c) => c.choices[0]?.delta.content ?? '').join('');
}

/** Splits text into sentences on . ! ? followed by whitespace (tags stay attached). */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.replace(/\[\[[A-Za-z0-9_]+\]\]/g, '').trim().length > 0);
}

interface Wav {
  riff: string;
  riffSize: number;
  wave: string;
  fmt: string;
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataTag: string;
  dataSize: number;
  samples: Int16Array;
  totalBytes: number;
}

function parseWav(bytes: Uint8Array): Wav {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  const dataSize = dv.getUint32(40, true);
  const samples = new Int16Array(dataSize / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = dv.getInt16(44 + i * 2, true);
  return {
    riff: str(0),
    riffSize: dv.getUint32(4, true),
    wave: str(8),
    fmt: str(12),
    audioFormat: dv.getUint16(20, true),
    channels: dv.getUint16(22, true),
    sampleRate: dv.getUint32(24, true),
    byteRate: dv.getUint32(28, true),
    blockAlign: dv.getUint16(32, true),
    bitsPerSample: dv.getUint16(34, true),
    dataTag: str(36),
    dataSize,
    samples,
    totalBytes: bytes.byteLength,
  };
}

function pcmToSamples(bytes: Uint8Array): Int16Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}

function rms(samples: Int16Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / Math.max(1, end - start));
}

async function speech(server: MockServer, body: Record<string, unknown>) {
  const res = await postJson(server, '/audio/speech', body);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, bytes };
}

async function speechWav(server: MockServer, input: string, extra: Record<string, unknown> = {}) {
  const { res, bytes } = await speech(server, {
    model: 'gpt-4o-mini-tts',
    input,
    voice: 'alloy',
    response_format: 'wav',
    ...extra,
  });
  expect(res.status).toBe(200);
  return { res, wav: parseWav(bytes) };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let mock: MockServer;
let fast: MockServer;

beforeAll(async () => {
  mock = await startMockServer({ port: 0, log: false });
  fast = await startMockServer({ port: 0, log: false, chunkDelayMs: [0, 1], slowDelayMs: 200 });
});

afterAll(async () => {
  await mock?.close();
  await fast?.close();
});

describe('server basics', () => {
  it('binds to 127.0.0.1 on an ephemeral port and exposes url/baseURL', () => {
    expect(mock.port).toBeGreaterThan(0);
    expect(mock.url).toBe(`http://127.0.0.1:${mock.port}`);
    expect(mock.baseURL).toBe(`${mock.url}/v1`);
    expect(Array.isArray(mock.requests)).toBe(true);
  });

  it('serves a health endpoint without auth', async () => {
    const res = await fetch(`${mock.url}/__mock/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns an OpenAI-shaped 404 for unknown /v1 routes', async () => {
    const res = await api(mock, '/does-not-exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiError;
    expect(body.error.message).toBe('Invalid URL (GET /v1/does-not-exist)');
    expect(body.error.type).toBe('invalid_request_error');
  });
});

describe('authentication', () => {
  it('rejects a missing Authorization header with 401 invalid_api_key', async () => {
    const res = await api(mock, '/models', { key: null });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiError;
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('invalid_api_key');
    expect(body.error.message).toMatch(/didn't provide an API key/);
  });

  it('rejects the sk-bad key with 401', async () => {
    const res = await api(mock, '/models', { key: 'sk-bad' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiError;
    expect(body.error).toMatchObject({ type: 'invalid_request_error', code: 'invalid_api_key' });
    expect(body.error.message).toMatch(/Incorrect API key/);
  });

  it('rejects non-Bearer schemes and empty bearer tokens', async () => {
    const basic = await fetch(`${mock.baseURL}/models`, { headers: { authorization: 'Basic abc' } });
    expect(basic.status).toBe(401);
    const empty = await fetch(`${mock.baseURL}/models`, { headers: { authorization: 'Bearer ' } });
    expect(empty.status).toBe(401);
  });

  it('requires auth on every /v1 endpoint', async () => {
    const r1 = await chat(mock, { model: 'gpt-5-mini', messages: userMsgs('hi') }, { key: null });
    const r2 = await postJson(mock, '/audio/speech', { model: 'tts-1', input: 'hi', voice: 'alloy' }, { key: 'sk-bad' });
    const r3 = await api(mock, '/audio/transcriptions', { method: 'POST', key: null, body: new FormData() });
    expect([r1.status, r2.status, r3.status]).toEqual([401, 401, 401]);
  });
});

describe('GET /v1/models', () => {
  it('lists several models in OpenAI list format', async () => {
    const res = await api(mock, '/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<Record<string, unknown>> };
    expect(body.object).toBe('list');
    const ids = body.data.map((m) => m.id);
    for (const id of [
      'gpt-5-mini', 'gpt-5', 'gpt-4.1-mini', 'gpt-4o-mini-tts', 'gpt-4o-mini-transcribe',
      'whisper-1', 'text-embedding-3-small', 'dall-e-3',
    ]) {
      expect(ids).toContain(id);
    }
    for (const m of body.data) {
      expect(Object.keys(m).sort()).toEqual(['created', 'id', 'object', 'owned_by']);
      expect(m.object).toBe('model');
      expect(typeof m.created).toBe('number');
      expect(typeof m.owned_by).toBe('string');
    }
  });

  it('retrieves a single model and 404s on unknown ids', async () => {
    const ok = await api(mock, '/models/gpt-5-mini');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: 'gpt-5-mini', object: 'model' });
    const missing = await api(mock, '/models/nope-model');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiError).error.code).toBe('model_not_found');
  });
});

describe('POST /v1/chat/completions (non-stream)', () => {
  it('returns a chat.completion with a Bonzi-style reply, echo and animation tags', async () => {
    const res = await chat(mock, { model: 'gpt-5-mini', messages: userMsgs('Can you tell me about purple bananas today') });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('x-request-id')).toMatch(/^req_/);
    const body = (await res.json()) as ChatCompletion;
    expect(body.object).toBe('chat.completion');
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.model).toBe('gpt-5-mini');
    expect(body.choices).toHaveLength(1);
    const choice = body.choices[0]!;
    expect(choice.finish_reason).toBe('stop');
    expect(choice.message.role).toBe('assistant');

    const content = choice.message.content;
    expect(content).toContain('purple bananas');
    const s = sentences(content);
    expect(s.length).toBeGreaterThanOrEqual(2);
    expect(s.length).toBeLessThanOrEqual(4);
    const waveIdx = s.findIndex((x) => x.includes('[[Wave]]'));
    const pleasedIdx = s.findIndex((x) => x.includes('[[Pleased]]'));
    expect(waveIdx).toBeGreaterThanOrEqual(0);
    expect(pleasedIdx).toBeGreaterThanOrEqual(0);
    expect(waveIdx).not.toBe(pleasedIdx);

    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage.completion_tokens).toBeGreaterThan(0);
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
  });

  it('is deterministic for the same model and message', async () => {
    const a = (await (await chat(mock, { model: 'gpt-5-mini', messages: userMsgs('same input') })).json()) as ChatCompletion;
    const b = (await (await chat(mock, { model: 'gpt-5-mini', messages: userMsgs('same input') })).json()) as ChatCompletion;
    expect(a.choices[0]!.message.content).toBe(b.choices[0]!.message.content);
  });

  it('echoes only the LAST user message and supports content-part arrays', async () => {
    const res = await chat(mock, {
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'user', content: 'first message about apples' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [{ type: 'text', text: 'second message about giraffes' }] },
      ],
    });
    const content = ((await res.json()) as ChatCompletion).choices[0]!.message.content;
    expect(content).toContain('giraffes');
    expect(content).not.toContain('apples');
  });

  it('strips [[tags]] and sentence punctuation from the echo', async () => {
    const res = await chat(mock, { model: 'gpt-5-mini', messages: userMsgs('[[Wave]] hi. Are you there?') });
    const content = ((await res.json()) as ChatCompletion).choices[0]!.message.content;
    expect(content.match(/\[\[Wave\]\]/g)).toHaveLength(1);
  });

  it('truncates with finish_reason "length" when max_completion_tokens is small', async () => {
    const res = await chat(mock, { model: 'gpt-5-mini', messages: userMsgs('hello'), max_completion_tokens: 5 });
    const body = (await res.json()) as ChatCompletion;
    expect(body.choices[0]!.finish_reason).toBe('length');
    expect(body.choices[0]!.message.content.length).toBeLessThanOrEqual(20);
    expect(body.usage.completion_tokens).toBe(5);
  });

  it('validates the request body', async () => {
    const badJson = await api(mock, '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as ApiError).error.message).toMatch(/could not parse the JSON body/);

    const noModel = await chat(mock, { messages: userMsgs('hi') });
    expect(noModel.status).toBe(400);
    expect(((await noModel.json()) as ApiError).error.message).toMatch(/model parameter/);

    const noMessages = await chat(mock, { model: 'gpt-5-mini' });
    expect(noMessages.status).toBe(400);
    expect(((await noMessages.json()) as ApiError).error).toMatchObject({ param: 'messages', code: 'missing_required_parameter' });

    const emptyMessages = await chat(mock, { model: 'gpt-5-mini', messages: [] });
    expect(((await emptyMessages.json()) as ApiError).error.code).toBe('empty_array');

    const badRole = await chat(mock, { model: 'gpt-5-mini', messages: [{ role: 'robot', content: 'x' }] });
    expect(badRole.status).toBe(400);
    expect(((await badRole.json()) as ApiError).error.param).toBe('messages[0].role');

    const streamOptsWithoutStream = await chat(mock, {
      model: 'gpt-5-mini',
      messages: userMsgs('hi'),
      stream_options: { include_usage: true },
    });
    expect(streamOptsWithoutStream.status).toBe(400);
    expect(((await streamOptsWithoutStream.json()) as ApiError).error.param).toBe('stream_options');
  });

  it('404s for non-chat models and for "nonexistent*" model ids', async () => {
    const notChat = await chat(mock, { model: 'whisper-1', messages: userMsgs('hi') });
    expect(notChat.status).toBe(404);
    expect(((await notChat.json()) as ApiError).error.message).toMatch(/not a chat model/);

    const missing = await chat(mock, { model: 'nonexistent-model', messages: userMsgs('hi') });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiError).error.code).toBe('model_not_found');

    const lenient = await chat(mock, { model: 'gpt-some-future-model', messages: userMsgs('hi') });
    expect(lenient.status).toBe(200);
  });
});

describe('POST /v1/chat/completions (stream)', () => {
  it('streams chat.completion.chunk SSE events that reassemble into the non-stream reply', async () => {
    const message = 'Please stream me a reply about my keyboard';
    const t0 = performance.now();
    const res = await chat(mock, { model: 'gpt-5-mini', stream: true, messages: userMsgs(message) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const events = await readSse(res);
    const chunks = parseChunks(events);

    // Common envelope
    const id = chunks[0]!.id;
    for (const c of chunks) {
      expect(c.object).toBe('chat.completion.chunk');
      expect(c.id).toBe(id);
      expect(c.model).toBe('gpt-5-mini');
      expect(c).not.toHaveProperty('usage'); // include_usage not requested
    }

    // First chunk: role only
    expect(chunks[0]!.choices[0]!.delta).toMatchObject({ role: 'assistant', content: '' });
    expect(chunks[0]!.choices[0]!.finish_reason).toBeNull();

    // Last chunk: empty delta + finish_reason stop
    const last = chunks.at(-1)!;
    expect(last.choices[0]!.delta).toEqual({});
    expect(last.choices[0]!.finish_reason).toBe('stop');

    // Content chunks are small
    const contentPieces = chunks.slice(1, -1).map((c) => c.choices[0]!.delta.content ?? '');
    expect(contentPieces.length).toBeGreaterThan(10);
    for (const p of contentPieces) {
      expect(p.length).toBeGreaterThanOrEqual(1);
      expect(p.length).toBeLessThanOrEqual(7);
    }
    // The first tag is deliberately split across chunks.
    expect(contentPieces.some((p) => p.includes('[[Wave]]'))).toBe(false);

    // Reassembles into the same text as the non-stream reply
    const text = assembled(chunks);
    const nonStream = (await (await chat(mock, { model: 'gpt-5-mini', messages: userMsgs(message) })).json()) as ChatCompletion;
    expect(text).toBe(nonStream.choices[0]!.message.content);
    expect(text).toContain('[[Wave]]');
    expect(text).toContain('[[Pleased]]');

    // Pacing: roughly 20-40 ms between chunks on average
    const contentEvents = events.slice(1, -2);
    const first = contentEvents[0]!.t;
    const lastT = contentEvents.at(-1)!.t;
    const meanGap = (lastT - first) / (contentEvents.length - 1);
    expect(meanGap).toBeGreaterThan(12);
    expect(meanGap).toBeLessThan(80);
    expect(lastT - t0).toBeGreaterThan(contentEvents.length * 12);
  }, 15_000);

  it('emits a usage chunk before [DONE] when stream_options.include_usage is set', async () => {
    const res = await chat(fast, {
      model: 'gpt-5-mini',
      stream: true,
      stream_options: { include_usage: true },
      messages: userMsgs('count my tokens'),
    });
    const chunks = parseChunks(await readSse(res));
    const usageChunk = chunks.at(-1)!;
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toBeTruthy();
    expect(usageChunk.usage!.total_tokens).toBe(usageChunk.usage!.prompt_tokens + usageChunk.usage!.completion_tokens);
    for (const c of chunks.slice(0, -1)) expect(c.usage).toBeNull();
    expect(chunks.at(-2)!.choices[0]!.finish_reason).toBe('stop');
  });
});

describe('magic triggers', () => {
  it('trigger 429 returns rate_limit_exceeded with retry-after (also for stream requests)', async () => {
    for (const stream of [false, true]) {
      const res = await chat(mock, { model: 'gpt-5-mini', stream, messages: userMsgs('please trigger 429 now') });
      expect(res.status).toBe(429);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(res.headers.get('retry-after-ms')).toBe('1000');
      const body = (await res.json()) as ApiError;
      expect(body.error.code).toBe('rate_limit_exceeded');
      expect(body.error.message).toMatch(/Rate limit reached/);
    }
  });

  it('"trigger 429 once" fails only the first time for the same message', async () => {
    const msg = `trigger 429 once ${Date.now()}`;
    const first = await chat(mock, { model: 'gpt-5-mini', messages: userMsgs(msg) });
    expect(first.status).toBe(429);
    const second = await chat(mock, { model: 'gpt-5-mini', messages: userMsgs(msg) });
    expect(second.status).toBe(200);
  });

  it('trigger quota returns 429 insufficient_quota without retry-after', async () => {
    const res = await chat(mock, { model: 'gpt-5-mini', messages: userMsgs('TRIGGER QUOTA') });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeNull();
    const body = (await res.json()) as ApiError;
    expect(body.error).toMatchObject({ type: 'insufficient_quota', code: 'insufficient_quota' });
  });

  it('trigger 500 returns a server_error', async () => {
    const res = await chat(mock, { model: 'gpt-5-mini', messages: userMsgs('trigger 500') });
    expect(res.status).toBe(500);
    expect(((await res.json()) as ApiError).error.type).toBe('server_error');
  });

  it('trigger badparam returns 400 unsupported_parameter only when temperature is present', async () => {
    const withTemp = await chat(mock, { model: 'gpt-5-mini', temperature: 0.7, messages: userMsgs('trigger badparam') });
    expect(withTemp.status).toBe(400);
    const err = ((await withTemp.json()) as ApiError).error;
    expect(err).toEqual({
      message: expect.stringMatching(/^Unsupported parameter: 'temperature'/),
      type: 'invalid_request_error',
      param: 'temperature',
      code: 'unsupported_parameter',
    });

    // The client's auto-retry without temperature succeeds.
    const retry = await chat(mock, { model: 'gpt-5-mini', messages: userMsgs('trigger badparam') });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as ChatCompletion).choices[0]!.message.content).toContain('[[Wave]]');
  });

  it('trigger slow delays the first token by ~3 s (stream and non-stream)', async () => {
    const t0 = performance.now();
    const streamTask = (async () => {
      const res = await chat(mock, { model: 'gpt-5-mini', stream: true, messages: userMsgs('trigger slow please') });
      const headersAt = performance.now() - t0;
      const events = await readSse(res);
      return { headersAt, firstEventAt: events[0]!.t - t0, chunks: parseChunks(events) };
    })();
    const plainTask = (async () => {
      const res = await chat(mock, { model: 'gpt-5-mini', messages: userMsgs('trigger slow please') });
      await res.json();
      return performance.now() - t0;
    })();
    const [s, plainMs] = await Promise.all([streamTask, plainTask]);
    expect(s.headersAt).toBeLessThan(1500); // headers are flushed immediately
    expect(s.firstEventAt).toBeGreaterThanOrEqual(2900);
    expect(assembled(s.chunks)).toContain('[[Wave]]');
    expect(plainMs).toBeGreaterThanOrEqual(2900);
  }, 15_000);

  it('trigger long produces a ~12 sentence reply (non-stream and stream agree)', async () => {
    const res = await chat(fast, { model: 'gpt-5-mini', messages: userMsgs('trigger long story please') });
    const content = ((await res.json()) as ChatCompletion).choices[0]!.message.content;
    const s = sentences(content);
    expect(s.length).toBeGreaterThanOrEqual(10);
    expect(s.length).toBeLessThanOrEqual(14);
    const tags = new Set(content.match(/\[\[[A-Za-z0-9_]+\]\]/g));
    expect(tags.size).toBeGreaterThanOrEqual(3);

    const streamRes = await chat(fast, { model: 'gpt-5-mini', stream: true, messages: userMsgs('trigger long story please') });
    expect(assembled(parseChunks(await readSse(streamRes)))).toBe(content);
  });

  it('trigger hang (stream) sends a couple of chunks and then stalls until the client aborts', async () => {
    const msg = `trigger hang stream ${Date.now()}`;
    const controller = new AbortController();
    const res = await chat(mock, { model: 'gpt-5-mini', stream: true, messages: userMsgs(msg) }, { signal: controller.signal });
    expect(res.status).toBe(200);
    const c = collectSse(res);
    c.done.catch(() => {}); // rejects with AbortError below
    await waitFor(() => c.events.length >= 3, 3000, 'first chunks');
    const seen = c.events.length;
    await sleep(600);
    expect(c.events.length).toBe(seen); // stalled
    expect(seen).toBe(3); // role chunk + 2 content chunks
    const first = JSON.parse(c.events[0]!.data) as ChatChunk;
    expect(first.choices[0]!.delta.role).toBe('assistant');
    expect(c.events.some((e) => e.data === '[DONE]')).toBe(false);

    controller.abort();
    await expect(c.done).rejects.toThrow();
    const entry = () =>
      mock.requests.find((r) => JSON.stringify(r.body).includes(msg));
    await waitFor(() => entry()?.completed === false, 2000, 'server to notice abort');
    expect(entry()!.status).toBe(200);
  });

  it('trigger hang (non-stream) never responds', async () => {
    const t0 = performance.now();
    await expect(
      chat(mock, { model: 'gpt-5-mini', messages: userMsgs('trigger hang') }, { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
    expect(performance.now() - t0).toBeGreaterThanOrEqual(450);
  });
});

describe('POST /v1/audio/speech', () => {
  it('returns a valid RIFF PCM16 mono 24 kHz WAV whose length is 60 ms per character', async () => {
    const input = 'Hello there, my friend!';
    const { res, wav } = await speechWav(mock, input);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('x-mock-note')).toBeNull();
    expect(wav).toMatchObject({
      riff: 'RIFF',
      wave: 'WAVE',
      fmt: 'fmt ',
      audioFormat: 1,
      channels: 1,
      sampleRate: SAMPLE_RATE,
      byteRate: SAMPLE_RATE * 2,
      blockAlign: 2,
      bitsPerSample: 16,
      dataTag: 'data',
    });
    expect(wav.riffSize).toBe(wav.totalBytes - 8);
    expect(wav.dataSize).toBe(wav.totalBytes - 44);
    expect(wav.samples.length).toBe(input.length * SAMPLES_PER_CHAR);
    expect(Number(res.headers.get('x-mock-duration-ms'))).toBe(input.length * 60);
    expect(Number(res.headers.get('content-length'))).toBe(wav.totalBytes);
  });

  it('scales duration with input length and speed, capped at 30 s', async () => {
    const short = await speechWav(mock, 'a'.repeat(10));
    const longer = await speechWav(mock, 'a'.repeat(40));
    expect(longer.wav.samples.length).toBe(short.wav.samples.length * 4);

    const fast2x = await speechWav(mock, 'a'.repeat(40), { speed: 2 });
    expect(fast2x.wav.samples.length).toBe(longer.wav.samples.length / 2);

    const capped = await speechWav(mock, 'word '.repeat(819) + 'x'); // 4096 chars
    expect(capped.wav.samples.length).toBe(30 * SAMPLE_RATE);
  });

  it('returns raw 24 kHz PCM16 for response_format "pcm" (same samples as the WAV)', async () => {
    const input = 'Lip sync me';
    const { res, bytes } = await speech(mock, { model: 'gpt-4o-mini-tts', input, voice: 'alloy', response_format: 'pcm' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/pcm');
    expect(bytes.byteLength).toBe(input.length * SAMPLES_PER_CHAR * 2);
    const { wav } = await speechWav(mock, input);
    expect(Array.from(pcmToSamples(bytes))).toEqual(Array.from(wav.samples));
  });

  it('returns WAV with an x-mock-note header for compressed formats (mp3 default, opus, aac, flac)', async () => {
    for (const fmt of [undefined, 'mp3', 'opus', 'aac', 'flac']) {
      const body: Record<string, unknown> = { model: 'tts-1', input: 'Hi pal', voice: 'onyx' };
      if (fmt) body.response_format = fmt;
      const { res, bytes } = await speech(mock, body);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('audio/wav');
      expect(res.headers.get('x-mock-note')).toContain(`cannot encode ${fmt ?? 'mp3'}`);
      expect(parseWav(bytes).riff).toBe('RIFF');
    }
  });

  it('produces a voice-like signal: buzz in words, silence at spaces, syllable-rate envelope', async () => {
    // Silence at spaces, energy inside words
    const { wav } = await speechWav(mock, 'Hi there friend');
    const s = wav.samples;
    const spaceSlot = 2 * SAMPLES_PER_CHAR; // the space after "Hi"
    const silent = rms(s, spaceSlot + 500, spaceSlot + SAMPLES_PER_CHAR - 40);
    const voiced = rms(s, 3 * SAMPLES_PER_CHAR + 600, 8 * SAMPLES_PER_CHAR - 200); // "there"
    expect(silent).toBeLessThan(200);
    expect(voiced).toBeGreaterThan(2000);
    let peak = 0;
    for (const v of s) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(8000);
    expect(peak).toBeLessThanOrEqual(32767);

    // Fundamental frequency between 120 and 180 Hz (autocorrelation on a voiced window)
    const start = 3 * SAMPLES_PER_CHAR + 1500;
    const win = 2048;
    let bestLag = 0;
    let best = -Infinity;
    for (let lag = 110; lag <= 240; lag++) {
      let acc = 0;
      for (let i = 0; i < win; i++) acc += (s[start + i] ?? 0) * (s[start + i + lag] ?? 0);
      if (acc > best) {
        best = acc;
        bestLag = lag;
      }
    }
    const f0 = SAMPLE_RATE / bestLag;
    expect(f0).toBeGreaterThan(115);
    expect(f0).toBeLessThan(185);

    // Syllable-like amplitude modulation inside one long word
    const word = 'supercalifragilisticexpialidocious';
    const longWord = (await speechWav(mock, word)).wav.samples;
    const frame = SAMPLE_RATE / 50; // 20 ms frames
    const levels: number[] = [];
    for (let i = Math.round(0.1 * SAMPLE_RATE); i + frame < longWord.length - 0.1 * SAMPLE_RATE; i += frame) {
      levels.push(rms(longWord, i, i + frame));
    }
    const max = Math.max(...levels);
    const min = Math.min(...levels);
    expect(max / Math.max(1, min)).toBeGreaterThan(3);
    const mid = (max + min) / 2;
    let rises = 0;
    for (let i = 1; i < levels.length; i++) if (levels[i - 1]! < mid && levels[i]! >= mid) rises++;
    // ~2 s of audio at 4-6 syllables per second
    expect(rises).toBeGreaterThanOrEqual(5);
    expect(rises).toBeLessThanOrEqual(14);
  });

  it('validates input, voice, response_format and speed', async () => {
    const base = { model: 'gpt-4o-mini-tts', input: 'hello', voice: 'alloy' };
    const cases: Array<[Record<string, unknown>, string, string | null]> = [
      [{ ...base, input: '' }, 'input', 'empty_string'],
      [{ ...base, input: '   ' }, 'input', 'empty_string'],
      [{ ...base, input: undefined }, 'input', 'missing_required_parameter'],
      [{ ...base, input: 'x'.repeat(4097) }, 'input', 'string_above_max_length'],
      [{ ...base, voice: undefined }, 'voice', 'missing_required_parameter'],
      [{ ...base, voice: 'bonzi' }, 'voice', 'invalid_value'],
      [{ ...base, response_format: 'ogg' }, 'response_format', 'invalid_value'],
      [{ ...base, speed: 10 }, 'speed', 'invalid_value'],
    ];
    for (const [body, param, code] of cases) {
      const { res, bytes } = await speech(mock, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      const err = (JSON.parse(new TextDecoder().decode(bytes)) as ApiError).error;
      expect(err.param).toBe(param);
      expect(err.code).toBe(code);
    }
    const max = await speech(mock, { ...base, input: 'x'.repeat(4096) });
    expect(max.res.status).toBe(200);
  });
});

describe('POST /v1/audio/transcriptions', () => {
  async function wavBlob(): Promise<{ blob: Blob; size: number }> {
    const res = await postJson(mock, '/audio/speech', { model: 'tts-1', input: 'Hello Bonzi', voice: 'alloy', response_format: 'wav' });
    const buf = await res.arrayBuffer();
    return { blob: new Blob([buf], { type: 'audio/wav' }), size: buf.byteLength };
  }

  it('parses multipart form data and returns a mock transcription with the byte count', async () => {
    const { blob, size } = await wavBlob();
    mock.reset();
    const form = new FormData();
    form.append('file', blob, 'recording.wav');
    form.append('model', 'gpt-4o-mini-transcribe');
    form.append('language', 'en');
    const res = await api(mock, '/audio/transcriptions', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: `Hello Bonzi, this is a mock transcription (${size} bytes).` });

    const entry = mock.requests.find((r) => r.path === '/v1/audio/transcriptions')!;
    expect(entry.body).toEqual({
      fields: { model: 'gpt-4o-mini-transcribe', language: 'en' },
      files: [{ field: 'file', filename: 'recording.wav', contentType: 'audio/wav', size }],
    });
  });

  it('supports text and verbose_json response formats', async () => {
    const { blob, size } = await wavBlob();
    const mk = (fmt: string) => {
      const f = new FormData();
      f.append('model', 'whisper-1');
      f.append('response_format', fmt);
      f.append('file', blob, 'a.wav');
      return api(mock, '/audio/transcriptions', { method: 'POST', body: f });
    };
    const text = await mk('text');
    expect(text.headers.get('content-type')).toMatch(/^text\/plain/);
    expect((await text.text()).trim()).toBe(`Hello Bonzi, this is a mock transcription (${size} bytes).`);

    const verbose = (await (await mk('verbose_json')).json()) as { duration: number; text: string; segments: unknown[] };
    expect(verbose.duration).toBeCloseTo(('Hello Bonzi'.length * 60) / 1000, 2);
    expect(verbose.segments).toHaveLength(1);
  });

  it('rejects missing file, missing model, empty file and non-multipart bodies', async () => {
    const noFile = new FormData();
    noFile.append('model', 'whisper-1');
    const r1 = await api(mock, '/audio/transcriptions', { method: 'POST', body: noFile });
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as ApiError).error).toMatchObject({ param: 'file', code: 'missing_required_parameter' });

    const { blob } = await wavBlob();
    const noModel = new FormData();
    noModel.append('file', blob, 'a.wav');
    const r2 = await api(mock, '/audio/transcriptions', { method: 'POST', body: noModel });
    expect(r2.status).toBe(400);
    expect(((await r2.json()) as ApiError).error.message).toMatch(/model parameter/);

    const empty = new FormData();
    empty.append('model', 'whisper-1');
    empty.append('file', new Blob([]), 'empty.wav');
    const r3 = await api(mock, '/audio/transcriptions', { method: 'POST', body: empty });
    expect(r3.status).toBe(400);
    expect(((await r3.json()) as ApiError).error.code).toBe('audio_too_short');

    const r4 = await postJson(mock, '/audio/transcriptions', { model: 'whisper-1' });
    expect(r4.status).toBe(400);
    expect(((await r4.json()) as ApiError).error.message).toMatch(/multipart\/form-data/);
  });
});

describe('request inspection (/__mock/*)', () => {
  it('records requests without the Authorization header and can be reset', async () => {
    const secret = 'sk-test-local-very-secret-9876';
    const reset0 = await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
    expect(reset0.status).toBe(200);
    expect(mock.requests).toHaveLength(0);

    await api(mock, '/models', { key: secret });
    await chat(mock, { model: 'gpt-5-mini', messages: userMsgs('record me') }, { key: secret });
    await chat(mock, { model: 'gpt-5-mini', messages: userMsgs('no key') }, { key: null });

    const res = await fetch(`${mock.url}/__mock/requests`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(secret);
    const recorded = JSON.parse(raw) as RecordedRequest[];
    expect(recorded).toHaveLength(3); // control requests are not recorded
    expect(recorded.map((r) => [r.method, r.path, r.status, r.hasAuth])).toEqual([
      ['GET', '/v1/models', 200, true],
      ['POST', '/v1/chat/completions', 200, true],
      ['POST', '/v1/chat/completions', 401, false],
    ]);
    for (const r of recorded) {
      expect(Object.keys(r.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
      expect(r.completed).toBe(true);
    }
    expect(recorded[1]!.body).toMatchObject({ model: 'gpt-5-mini', messages: userMsgs('record me') });
    expect(recorded[1]!.headers['content-type']).toBe('application/json');

    // The handle exposes the same live array
    expect(mock.requests.map((r) => r.id)).toEqual(recorded.map((r) => r.id));

    const reset = (await (await fetch(`${mock.url}/__mock/reset`, { method: 'POST' })).json()) as { ok: boolean; cleared: number };
    expect(reset).toEqual({ ok: true, cleared: 3 });
    expect(mock.requests).toHaveLength(0);
    expect(await (await fetch(`${mock.url}/__mock/requests`)).json()).toEqual([]);
  });

  it('logs one line per request and never logs the key', async () => {
    const lines: string[] = [];
    const logged = await startMockServer({ port: 0, log: (l) => lines.push(l), chunkDelayMs: [0, 1] });
    try {
      const secret = 'sk-live-looking-secret-123';
      await api(logged, '/models', { key: secret });
      await chat(logged, { model: 'gpt-5-mini', messages: userMsgs('trigger quota') }, { key: secret });
      await readSse(await chat(logged, { model: 'gpt-5-mini', stream: true, messages: userMsgs('hi') }, { key: secret }));
      await api(logged, '/models', { key: 'sk-bad' });
      await waitFor(() => lines.length >= 4, 2000, 'log lines');
      expect(lines).toHaveLength(4);
      for (const l of lines) {
        expect(l).not.toContain(secret);
        expect(l).not.toContain('Bearer');
        expect(l.startsWith('[mock-openai]')).toBe(true);
      }
      expect(lines[0]).toMatch(/GET \/v1\/models 200/);
      expect(lines[1]).toMatch(/POST \/v1\/chat\/completions 429 .*trigger=quota/);
      expect(lines[2]).toMatch(/POST \/v1\/chat\/completions 200 .*stream/);
      expect(lines[3]).toMatch(/GET \/v1\/models 401 .*auth=rejected/);
    } finally {
      await logged.close();
    }
  });
});

describe('CLI', () => {
  it('starts from the command line, prints a READY line and serves requests', async () => {
    const child = spawn(process.execPath, [SCRIPT_PATH, '--port', '0', '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => (out += d));
      await waitFor(() => /MOCK_OPENAI_READY (\S+)/.test(out), 5000, 'READY line');
      const baseURL = /MOCK_OPENAI_READY (\S+)/.exec(out)![1]!;
      expect(baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      const res = await fetch(`${baseURL}/models`, { headers: { authorization: `Bearer ${KEY}` } });
      expect(res.status).toBe(200);
    } finally {
      child.kill();
    }
  }, 10_000);

  it('prints help and exits 0 with --help', async () => {
    const child = spawn(process.execPath, [SCRIPT_PATH, '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(0);
    expect(out).toContain('Usage: node scripts/mock-openai.mjs');
  }, 10_000);
});
