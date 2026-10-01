/**
 * TTS, STT, model listing and connection tests (mock server + injected fetch).
 * Run: npx vitest run tests/ai-voice-models.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// @ts-ignore: plain .mjs script without a declaration file; it is typed locally below.
import * as mockModule from '../scripts/mock-openai.mjs';
import { createAiService } from '../src/main/ai/index.ts';
import { classifyModels, parseModelList } from '../src/main/ai/models.ts';
import { uploadFileFor } from '../src/main/ai/stt.ts';
import { ttsSupportsInstructions } from '../src/main/ai/tts.ts';
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts';
import type { Settings } from '../src/shared/settings.ts';

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  status: number | null;
}
interface MockServer {
  baseURL: string;
  requests: RecordedRequest[];
  reset(): number;
  close(): Promise<void>;
}
const startMockServer = (mockModule as { startMockServer: (o?: { port?: number; log?: boolean }) => Promise<MockServer> }).startMockServer;

const KEY = 'sk-test-local';
let mock: MockServer;

beforeAll(async () => {
  mock = await startMockServer({ port: 0, log: false });
});
afterAll(async () => {
  await mock?.close();
});
beforeEach(() => {
  mock.reset();
});

function service(over: Partial<Settings> = {}, opts: { key?: string | null; fetch?: typeof fetch; modelsMs?: number } = {}) {
  const settings: Settings = { ...DEFAULT_SETTINGS, baseUrl: mock.baseURL, chatModel: 'gpt-5-mini', ...over };
  return createAiService({
    getConfig: () => ({ settings, apiKey: opts.key === undefined ? KEY : opts.key }),
    now: () => new Date('2026-10-01T12:00:00Z'),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    tuning: { timeouts: { modelsMs: opts.modelsMs ?? 15_000 } },
  });
}

const ascii = (buf: ArrayBuffer, from: number, to: number) => String.fromCharCode(...new Uint8Array(buf).subarray(from, to));

describe('TTS', () => {
  it('returns WAV bytes and sends instructions for gpt-4o-mini-tts', async () => {
    const s = service();
    const res = await s.synthesize({ text: '  Hello there, friend!  ' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mime).toBe('audio/wav');
    expect(ascii(res.audio, 0, 4)).toBe('RIFF');
    expect(ascii(res.audio, 8, 12)).toBe('WAVE');
    const body = mock.requests[0]!.body as Record<string, unknown>;
    expect(body).toEqual({
      model: 'gpt-4o-mini-tts',
      input: 'Hello there, friend!',
      voice: 'cedar',
      response_format: 'wav',
      speed: 1,
      instructions: DEFAULT_SETTINGS.ttsInstructions,
    });
  });

  it('never sends instructions to tts-1 / tts-1-hd and honours request overrides', async () => {
    const s = service();
    const res = await s.synthesize({ text: 'Hi', model: 'tts-1', voice: 'onyx', instructions: 'Whisper' });
    expect(res.ok).toBe(true);
    const body = mock.requests[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'tts-1', voice: 'onyx', response_format: 'wav' });
    expect(body).not.toHaveProperty('instructions');
    expect(ttsSupportsInstructions('tts-1-hd')).toBe(false);
    expect(ttsSupportsInstructions('tts-1-hd-1106')).toBe(false);
    expect(ttsSupportsInstructions('gpt-4o-mini-tts-2025-12-15')).toBe(true);
  });

  it('omits empty instructions and truncates input to 4096 characters', async () => {
    const s = service({ ttsInstructions: '' });
    const res = await s.synthesize({ text: 'word '.repeat(1000) });
    expect(res.ok).toBe(true);
    const body = mock.requests[0]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('instructions');
    expect((body.input as string).length).toBeLessThanOrEqual(4096);
  });

  it('rejects empty input locally, and maps provider and key errors', async () => {
    const empty = await service().synthesize({ text: '   ' });
    expect(empty).toMatchObject({ ok: false, error: { kind: 'bad-request' } });
    expect(mock.requests).toHaveLength(0);

    const badVoice = await service().synthesize({ text: 'hi', voice: 'bonzi' });
    expect(badVoice).toMatchObject({ ok: false, error: { kind: 'bad-request', status: 400 } });

    expect(await service({}, { key: null }).synthesize({ text: 'hi' })).toMatchObject({ ok: false, error: { kind: 'no-key' } });
    const bad = await service({}, { key: 'sk-bad' }).synthesize({ text: 'hi' });
    expect(bad).toMatchObject({ ok: false, error: { kind: 'auth' } });
    expect(JSON.stringify(bad)).not.toContain('sk-bad');
  });
});

describe('STT', () => {
  async function wav(): Promise<ArrayBuffer> {
    const res = await service().synthesize({ text: 'Hello Bonzi' });
    if (!res.ok) throw new Error('tts failed');
    mock.reset();
    return res.audio;
  }

  it('uploads speech.webm as multipart and returns the trimmed text', async () => {
    const audio = await wav();
    const res = await service().transcribe({ audio, mime: 'audio/webm;codecs=opus' });
    expect(res).toEqual({ ok: true, text: `Hello Bonzi, this is a mock transcription (${audio.byteLength} bytes).` });
    const rec = mock.requests[0]!;
    expect(rec.path).toBe('/v1/audio/transcriptions');
    expect(rec.body).toEqual({
      fields: { model: 'gpt-transcribe', response_format: 'json' },
      files: [{ field: 'file', filename: 'speech.webm', contentType: 'audio/webm', size: audio.byteLength }],
    });
  });

  it('names the file by mime type', () => {
    expect(uploadFileFor('audio/wav')).toEqual({ fileName: 'speech.wav', contentType: 'audio/wav' });
    expect(uploadFileFor('audio/mp4;codecs=mp4a.40.2')).toEqual({ fileName: 'speech.mp4', contentType: 'audio/mp4' });
    expect(uploadFileFor('audio/ogg;codecs=opus')).toEqual({ fileName: 'speech.ogg', contentType: 'audio/ogg' });
    expect(uploadFileFor('')).toEqual({ fileName: 'speech.webm', contentType: 'audio/webm' });
  });

  it('rejects empty audio locally', async () => {
    const res = await service().transcribe({ audio: new ArrayBuffer(0), mime: 'audio/webm' });
    expect(res).toMatchObject({ ok: false, error: { kind: 'bad-request' } });
    expect(mock.requests).toHaveLength(0);
  });

  it('sends keywords[] for gpt-transcribe on api.openai.com and retries without them if rejected', async () => {
    const forms: FormData[] = [];
    const fake: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://api.openai.com/v1/audio/transcriptions');
      const form = init?.body as FormData;
      forms.push(form);
      if (form.getAll('keywords[]').length > 0) {
        return new Response(JSON.stringify({ error: { message: "Unknown parameter: 'keywords'.", type: 'invalid_request_error', param: 'keywords', code: 'unknown_parameter' } }), { status: 400 });
      }
      return new Response(JSON.stringify({ text: '  hi bonzi  ' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const s = service({ baseUrl: 'https://api.openai.com/v1' }, { fetch: fake });
    const res = await s.transcribe({ audio: new Uint8Array([1, 2, 3]).buffer, mime: 'audio/webm;codecs=opus' });
    expect(res).toEqual({ ok: true, text: 'hi bonzi' });
    expect(forms).toHaveLength(2);
    expect(forms[0]!.getAll('keywords[]')).toEqual(['Bonzi', 'BonziBuddy']);
    expect(forms[1]!.getAll('keywords[]')).toEqual([]);
    const file = forms[0]!.get('file') as File;
    expect(file.name).toBe('speech.webm');
    expect(file.type).toBe('audio/webm');
  });

  it('does not send keywords to other hosts or other models; empty text is ok', async () => {
    const forms: FormData[] = [];
    const fake: typeof fetch = async (_input, init) => {
      forms.push(init?.body as FormData);
      return new Response(JSON.stringify({ text: '' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const custom = await service({ baseUrl: 'http://127.0.0.1:1/v1' }, { fetch: fake }).transcribe({ audio: new ArrayBuffer(4), mime: 'audio/webm' });
    const whisper = await service({ baseUrl: 'https://api.openai.com/v1', sttModel: 'whisper-1' }, { fetch: fake }).transcribe({ audio: new ArrayBuffer(4), mime: 'audio/webm' });
    expect(custom).toEqual({ ok: true, text: '' });
    expect(whisper).toEqual({ ok: true, text: '' });
    for (const f of forms) expect(f.getAll('keywords[]')).toEqual([]);
  });
});

describe('models', () => {
  it('lists the mock models; a custom host puts everything in chat', async () => {
    const res = await service().listModels();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const m = res.models;
    expect(m.all).toHaveLength(19);
    expect(m.chat).toEqual(m.all);
    expect(m.tts).toEqual(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']);
    expect(m.stt).toEqual(expect.arrayContaining(['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe']));
    expect(m.stt).toHaveLength(3);
    expect(m.stt[0]).toBe('whisper-1');
  });

  it('classifies api.openai.com models, pins defaults and drops shut-down models', () => {
    const entries = parseModelList({
      object: 'list',
      data: [
        'gpt-5', 'gpt-5-mini', 'gpt-6-sol', 'gpt-6-luna', 'gpt-4.1', 'o4-mini', 'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd',
        'gpt-transcribe', 'gpt-4o-transcribe', 'gpt-4o-transcribe-diarize', 'whisper-1', 'text-embedding-3-small', 'dall-e-3',
        'gpt-image-1', 'omni-moderation-latest', 'gpt-realtime-2.1', 'gpt-live-transcribe', 'ft:gpt-4.1-mini:acme::abc',
        'gpt-4o-search-preview', 'codex-mini-latest', 'chatgpt-4o-latest',
      ]
        .map((id) => ({ id, object: 'model', created: 1, owned_by: 'openai' }))
        .concat([
          { id: 'gpt-5-2025-08-07', object: 'model', created: 1, owned_by: 'openai', shutdown_date: '2026-09-01' } as never,
          { id: 'gpt-5.4-mini', object: 'model', created: 1, owned_by: 'openai', shutdown_date: '2027-02-26' } as never,
        ]),
    });
    const m = classifyModels(entries, 'https://api.openai.com/v1', new Date('2026-10-01T00:00:00Z'));
    expect(m.chat.slice(0, 2)).toEqual(['gpt-6-luna', 'gpt-6-sol']);
    expect(m.chat).toEqual(
      expect.arrayContaining(['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'o4-mini', 'ft:gpt-4.1-mini:acme::abc', 'chatgpt-4o-latest', 'gpt-5.4-mini']),
    );
    for (const id of ['gpt-4o-mini-tts', 'whisper-1', 'gpt-image-1', 'gpt-realtime-2.1', 'gpt-4o-search-preview', 'codex-mini-latest', 'text-embedding-3-small', 'dall-e-3']) {
      expect(m.chat).not.toContain(id);
    }
    expect(m.all).not.toContain('gpt-5-2025-08-07');
    expect(m.tts).toEqual(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']);
    expect(m.stt).toEqual(['gpt-transcribe', 'whisper-1', 'gpt-4o-transcribe']);
  });

  it('testConnection reports latency, model count and chat model availability', async () => {
    const ok = await service().testConnection();
    expect(ok).toMatchObject({ ok: true, modelCount: 19, chatModelAvailable: true });
    expect(ok.ok && ok.latencyMs).toBeGreaterThanOrEqual(0);
    expect(await service({ chatModel: 'gpt-6-luna' }).testConnection()).toMatchObject({ ok: true, chatModelAvailable: false });
    expect(await service({}, { key: 'sk-bad' }).testConnection()).toMatchObject({ ok: false, error: { kind: 'auth', status: 401 } });
    expect(await service({}, { key: null }).testConnection()).toMatchObject({ ok: false, error: { kind: 'no-key' } });
    expect(await service({ baseUrl: 'http://127.0.0.1:9/v1' }).testConnection()).toMatchObject({ ok: false, error: { kind: 'network' } });
  });

  it('times out a hanging /models call', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const res = await service({}, { fetch: hang, modelsMs: 100 }).listModels();
    expect(res).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });
});
