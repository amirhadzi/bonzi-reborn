// Speech-to-text: multipart POST {baseUrl}/audio/transcriptions.

import type { SttRequest, SttResult } from '../../shared/ipc.ts';
import type { Settings } from '../../shared/settings.ts';
import { LIMITS } from '../../shared/settings.ts';
import { aiError, baseMime, httpRequest, isOpenAiHost, mapProviderError, mapThrown } from './http.ts';
import type { AbortScope, FetchLike, ProviderError } from './http.ts';

const EXT_BY_MIME: Record<string, string> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/mp4': 'mp4',
  'video/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

/** File name and content type for an upload, from the recorder's mime type. */
export function uploadFileFor(mime: string): { fileName: string; contentType: string } {
  const base = baseMime(mime);
  const ext = EXT_BY_MIME[base];
  if (!ext) return { fileName: 'speech.webm', contentType: 'audio/webm' };
  return { fileName: `speech.${ext}`, contentType: base };
}

export function wantsKeywords(model: string, baseUrl: string): boolean {
  return /^gpt-transcribe/i.test(model.trim()) && isOpenAiHost(baseUrl);
}

export const STT_KEYWORDS = ['Bonzi', 'BonziBuddy'] as const;

function keywordsRejected(p: ProviderError): boolean {
  if (p.status !== 400 && p.status !== 422) return false;
  return /keyword/i.test(p.param ?? '') || /keyword/i.test(p.message) || p.code === 'unsupported_parameter';
}

export interface SttRunOptions {
  fetch: FetchLike;
  apiKey: string;
  settings: Settings;
  req: SttRequest;
  scope: AbortScope;
  timeoutMs: number;
}

export async function transcribeAudio(o: SttRunOptions): Promise<SttResult> {
  const audio = toBytes(o.req.audio);
  if (!audio || audio.byteLength === 0) {
    return { ok: false, error: aiError('bad-request', 'No audio was recorded.') };
  }
  if (audio.byteLength > LIMITS.sttBytes) return { ok: false, error: aiError('bad-request', 'The recording is too long.') };
  const model = o.settings.sttModel;
  const file = uploadFileFor(typeof o.req.mime === 'string' ? o.req.mime : '');
  let withKeywords = wantsKeywords(model, o.settings.baseUrl);
  o.scope.timer(o.timeoutMs);

  for (;;) {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: file.contentType }), file.fileName);
    form.append('model', model);
    form.append('response_format', 'json');
    if (withKeywords) for (const k of STT_KEYWORDS) form.append('keywords[]', k);

    const res = await httpRequest({ fetch: o.fetch, baseUrl: o.settings.baseUrl, apiKey: o.apiKey, path: 'audio/transcriptions', form, signal: o.scope.signal });
    if (!res.ok) {
      if ('provider' in res) {
        if (withKeywords && keywordsRejected(res.provider)) {
          withKeywords = false;
          continue;
        }
        return { ok: false, error: mapProviderError(res.provider, { model, apiKey: o.apiKey }) };
      }
      return { ok: false, error: mapThrown(res.thrown, o.scope) };
    }
    let raw: string;
    try {
      raw = await res.response.text();
    } catch (err) {
      return { ok: false, error: mapThrown(err, o.scope) };
    }
    return { ok: true, text: extractText(raw, res.response.headers.get('content-type')) };
  }
}

/** Accepts an ArrayBuffer or any view of one (IPC may deliver a Uint8Array or Buffer). */
function toBytes(v: unknown): Uint8Array<ArrayBuffer> | null {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer);
  return null;
}

function extractText(raw: string, contentType: string | null): string {
  const t = raw.trim();
  if (!t) return '';
  if (baseMime(contentType) === 'application/json' || t.startsWith('{')) {
    try {
      const parsed = JSON.parse(t) as unknown;
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { text?: unknown }).text === 'string') {
        return (parsed as { text: string }).text.trim();
      }
      return '';
    } catch {
      // fall through to plain text
    }
  }
  return t;
}
