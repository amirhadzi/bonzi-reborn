// Text-to-speech: POST {baseUrl}/audio/speech, whole WAV body per sentence.

import type { TtsRequest, TtsResult } from '../../shared/ipc.ts';
import type { Settings } from '../../shared/settings.ts';
import { LIMITS } from '../../shared/settings.ts';
import { aiError, baseMime, httpRequest, mapProviderError, mapThrown } from './http.ts';
import type { AbortScope, FetchLike } from './http.ts';

export function ttsSupportsInstructions(model: string): boolean {
  return !/^tts-1(?:-hd)?(?:$|-)/i.test(model.trim());
}

export function buildTtsBody(settings: Settings, req: TtsRequest): Record<string, unknown> | null {
  const input = (typeof req.text === 'string' ? req.text : '').trim().slice(0, LIMITS.ttsText).trim();
  if (!input) return null;
  const model = (req.model?.trim() || settings.ttsModel).slice(0, LIMITS.modelName);
  const voice = (req.voice?.trim() || settings.ttsVoice).slice(0, LIMITS.ttsVoice);
  const speed = Math.min(LIMITS.ttsSpeed.max, Math.max(LIMITS.ttsSpeed.min, Number.isFinite(settings.ttsSpeed) ? settings.ttsSpeed : 1));
  const body: Record<string, unknown> = { model, input, voice, response_format: 'wav', speed };
  const instructions = (req.instructions ?? settings.ttsInstructions).trim().slice(0, LIMITS.ttsInstructions);
  if (instructions && ttsSupportsInstructions(model)) body.instructions = instructions;
  return body;
}

export interface TtsRunOptions {
  fetch: FetchLike;
  apiKey: string;
  settings: Settings;
  req: TtsRequest;
  scope: AbortScope;
  timeoutMs: number;
}

export async function synthesizeSpeech(o: TtsRunOptions): Promise<TtsResult> {
  const body = buildTtsBody(o.settings, o.req);
  if (!body) return { ok: false, error: aiError('bad-request', 'There is no text to speak.') };
  const model = String(body.model);
  o.scope.timer(o.timeoutMs);
  const res = await httpRequest({ fetch: o.fetch, baseUrl: o.settings.baseUrl, apiKey: o.apiKey, path: 'audio/speech', json: body, signal: o.scope.signal });
  if (!res.ok) {
    return { ok: false, error: 'provider' in res ? mapProviderError(res.provider, { model, apiKey: o.apiKey }) : mapThrown(res.thrown, o.scope) };
  }
  let audio: ArrayBuffer;
  try {
    audio = await res.response.arrayBuffer();
  } catch (err) {
    return { ok: false, error: mapThrown(err, o.scope) };
  }
  if (audio.byteLength === 0) {
    return { ok: false, error: aiError('server', 'The voice server returned no audio.', res.requestId ? { requestId: res.requestId } : {}) };
  }
  const ctype = baseMime(res.response.headers.get('content-type'));
  const mime = ctype && ctype !== 'application/octet-stream' ? ctype : 'audio/wav';
  return { ok: true, audio, mime };
}
