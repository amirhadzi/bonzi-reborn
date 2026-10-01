// Pure validators for untrusted IPC payloads from renderers.
// Each returns the sanitised value or null when the payload is invalid.

import { EXTERNAL_LINKS } from '../shared/ipc.ts';
import type { ChatSendRequest, ChatSource, ExternalLinkId, SttRequest, TtsEngine, TtsRequest } from '../shared/ipc.ts';
import { LIMITS } from '../shared/settings.ts';

const CHAT_SOURCES: readonly ChatSource[] = ['typed', 'voice', 'quick-action', 'idle-chatter', 'greeting'];
const MAX_REQUEST_ID = 128;
const MAX_MIME = 100;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function isArrayBuffer(v: unknown): v is ArrayBuffer {
  return v instanceof ArrayBuffer || Object.prototype.toString.call(v) === '[object ArrayBuffer]';
}

/** Optional short string; undefined when absent, null when invalid. */
function optionalString(v: unknown, maxLen: number): string | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > maxLen) return null;
  return v;
}

export function validateChatSend(raw: unknown): ChatSendRequest | null {
  if (!isPlainObject(raw)) return null;
  const { text, source } = raw;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || text.length > LIMITS.chatText) return null;
  if (typeof source !== 'string' || !(CHAT_SOURCES as readonly string[]).includes(source)) return null;
  return { text: trimmed, source: source as ChatSource };
}

export function validateTtsRequest(raw: unknown): TtsRequest | null {
  if (!isPlainObject(raw)) return null;
  const { text } = raw;
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > LIMITS.ttsText) return null;
  let engine: TtsEngine | undefined;
  if (raw.engine !== undefined && raw.engine !== null) {
    if (raw.engine !== 'openai' && raw.engine !== 'system') return null;
    engine = raw.engine;
  }
  // Windows voice names ("Microsoft David Desktop") can be longer than OpenAI voice ids.
  const voice = optionalString(raw.voice, engine === 'system' ? LIMITS.systemVoiceName : LIMITS.ttsVoice);
  const model = optionalString(raw.model, LIMITS.modelName);
  const instructions = optionalString(raw.instructions, LIMITS.ttsInstructions);
  if (voice === null || model === null || instructions === null) return null;
  const req: TtsRequest = { text };
  if (engine) req.engine = engine;
  if (voice !== undefined && voice.trim()) req.voice = voice.trim();
  if (model !== undefined && model.trim()) req.model = model.trim();
  if (instructions !== undefined) req.instructions = instructions;
  return req;
}

export function validateSttRequest(raw: unknown): SttRequest | null {
  if (!isPlainObject(raw)) return null;
  const { audio, mime } = raw;
  if (!isArrayBuffer(audio)) return null;
  if (audio.byteLength === 0 || audio.byteLength > LIMITS.sttBytes) return null;
  if (typeof mime !== 'string' || mime.length > MAX_MIME) return null;
  const m = mime.trim().toLowerCase();
  if (!/^audio\/[a-z0-9.+-]+(\s*;\s*[a-z0-9.+=",-]+)*$/.test(m)) return null;
  return { audio, mime: m };
}

/** For chat:cancel: undefined means "the active request"; null means invalid. */
export function validateOptionalRequestId(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_REQUEST_ID) return null;
  return raw;
}

/** Bounds for app:idle-state thresholds: idle chatter runs every 1..240 minutes. */
export const IDLE_THRESHOLD_SEC = { min: 60, max: 14_400 } as const;

/** For app:idle-state: a finite number of seconds, rounded and clamped; null when not a number. */
export function validateIdleThreshold(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.min(IDLE_THRESHOLD_SEC.max, Math.max(IDLE_THRESHOLD_SEC.min, Math.round(raw)));
}

/** For win:drag-start: an optional grab point in window px (finite, within 0..10000). */
export function validateGrabPoint(raw: unknown): { x: number; y: number } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { x, y } = raw as Record<string, unknown>;
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10_000;
  return ok(x) && ok(y) ? { x, y } : undefined;
}

export function validateBoolean(raw: unknown): boolean | null {
  return typeof raw === 'boolean' ? raw : null;
}

export function validateExternalLinkId(raw: unknown): ExternalLinkId | null {
  if (typeof raw !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(EXTERNAL_LINKS, raw) ? (raw as ExternalLinkId) : null;
}
