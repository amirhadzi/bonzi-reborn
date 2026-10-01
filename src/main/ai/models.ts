// GET {baseUrl}/models, classification into chat / TTS / STT lists, and the
// settings window's connection test.

import type { ConnectionTestResult, ModelLists, ModelListResult } from '../../shared/ipc.ts';
import type { Settings } from '../../shared/settings.ts';
import { httpRequest, isOpenAiHost, mapProviderError, mapThrown } from './http.ts';
import type { AbortScope, FetchLike } from './http.ts';

export interface ModelEntry {
  id: string;
  shutdownDate: string | null;
}

const PINNED_CHAT = ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra'];
const PINNED_TTS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'];
const PINNED_STT = ['gpt-transcribe', 'whisper-1'];

const CHAT_INCLUDE = /^(?:gpt-|o\d|chatgpt-|ft:gpt-)/i;
const CHAT_EXCLUDE =
  /audio|realtime|live|transcribe|tts|whisper|image|dall-e|embedding|moderation|search|codex|computer-use|diarize|sora|cyber|deep-research|instruct|babbage|davinci|rosalind/i;

export function parseModelList(raw: unknown): ModelEntry[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const data = (raw as { data?: unknown }).data;
  const list = Array.isArray(data) ? data : Array.isArray(raw) ? (raw as unknown[]) : [];
  const out: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const m of list) {
    if (typeof m !== 'object' || m === null) continue;
    const r = m as Record<string, unknown>;
    if (typeof r.id !== 'string') continue;
    const id = r.id.trim();
    if (!id || id.length > 256 || seen.has(id)) continue;
    seen.add(id);
    const sd = r.shutdown_date;
    let shutdownDate: string | null = null;
    if (typeof sd === 'string' && sd) shutdownDate = sd;
    else if (typeof sd === 'number' && Number.isFinite(sd)) shutdownDate = new Date(sd < 1e12 ? sd * 1000 : sd).toISOString();
    out.push({ id, shutdownDate });
  }
  return out;
}

export function isShutDown(entry: ModelEntry, now: Date): boolean {
  if (!entry.shutdownDate) return false;
  const t = Date.parse(entry.shutdownDate);
  return Number.isFinite(t) && t <= now.getTime();
}

function naturalSort(ids: string[], pinned: readonly string[]): string[] {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const pin = (id: string) => {
    const i = pinned.indexOf(id);
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  return [...ids].sort((a, b) => {
    const pa = pin(a);
    const pb = pin(b);
    if (pa !== pb) return pa - pb;
    return collator.compare(a, b);
  });
}

export function classifyModels(entries: readonly ModelEntry[], baseUrl: string, now: Date): ModelLists {
  const ids = entries.filter((e) => !isShutDown(e, now)).map((e) => e.id);
  if (isOpenAiHost(baseUrl)) {
    const chat = ids.filter((id) => CHAT_INCLUDE.test(id) && !CHAT_EXCLUDE.test(id));
    const tts = ids.filter((id) => /tts/i.test(id) && !/realtime|live/i.test(id));
    const stt = ids.filter((id) => /transcribe|whisper/i.test(id) && !/realtime|live|diarize/i.test(id));
    return {
      chat: naturalSort(chat, PINNED_CHAT),
      tts: naturalSort(tts, PINNED_TTS),
      stt: naturalSort(stt, PINNED_STT),
      all: naturalSort(ids, []),
    };
  }
  return {
    chat: naturalSort(ids, PINNED_CHAT),
    tts: naturalSort(ids.filter((id) => /tts|speech/i.test(id)), PINNED_TTS),
    stt: naturalSort(ids.filter((id) => /whisper|transcri/i.test(id)), PINNED_STT),
    all: naturalSort(ids, []),
  };
}

export interface ModelsRunOptions {
  fetch: FetchLike;
  apiKey: string;
  settings: Settings;
  scope: AbortScope;
  timeoutMs: number;
}

type FetchModelsResult = { ok: true; entries: ModelEntry[] } | Extract<ModelListResult, { ok: false }>;

export async function fetchModels(o: ModelsRunOptions): Promise<FetchModelsResult> {
  o.scope.timer(o.timeoutMs);
  const res = await httpRequest({ fetch: o.fetch, baseUrl: o.settings.baseUrl, apiKey: o.apiKey, path: 'models', signal: o.scope.signal });
  if (!res.ok) {
    return { ok: false, error: 'provider' in res ? mapProviderError(res.provider, { apiKey: o.apiKey }) : mapThrown(res.thrown, o.scope) };
  }
  let parsed: unknown;
  try {
    parsed = await res.response.json();
  } catch (err) {
    if (o.scope.reason()) return { ok: false, error: mapThrown(err, o.scope) };
    return { ok: false, error: { kind: 'bad-request', message: 'The server did not return a model list. Check the base URL.' } };
  }
  return { ok: true, entries: parseModelList(parsed) };
}

export async function listModels(o: ModelsRunOptions, now: Date): Promise<ModelListResult> {
  const r = await fetchModels(o);
  if (!r.ok) return r;
  return { ok: true, models: classifyModels(r.entries, o.settings.baseUrl, now) };
}

export async function testConnection(o: ModelsRunOptions, clock: () => number = () => performance.now()): Promise<ConnectionTestResult> {
  const t0 = clock();
  const r = await fetchModels(o);
  const latencyMs = Math.max(0, Math.round(clock() - t0));
  if (!r.ok) return r;
  const model = o.settings.chatModel.trim();
  return {
    ok: true,
    latencyMs,
    modelCount: r.entries.length,
    chatModelAvailable: r.entries.some((e) => e.id === model),
  };
}
