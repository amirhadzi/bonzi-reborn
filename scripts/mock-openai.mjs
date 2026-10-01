#!/usr/bin/env node
/**
 * Mock OpenAI API server for local end-to-end testing of BonziBuddy Reborn.
 *
 * Dependency-free: only Node built-ins (node:http, node:crypto, node:fs,
 * node:path, node:url). Binds to 127.0.0.1 only.
 *
 * Usage as a CLI:
 *   node scripts/mock-openai.mjs [--port 8787] [--quiet] [--chunk-delay 20-40] [--slow-ms 3000]
 *   (port may also come from the MOCK_OPENAI_PORT environment variable)
 *
 * Usage from tests:
 *   import { startMockServer } from '../scripts/mock-openai.mjs';
 *   const mock = await startMockServer({ port: 0, log: false });
 *   // mock.baseURL === 'http://127.0.0.1:<port>/v1'
 *   await mock.close();
 *
 * Full documentation (endpoints, magic triggers, request inspection) lives in
 * docs/MOCK-OPENAI.md.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PORT = 8787;
export const HOST = '127.0.0.1';
/** The one API key the mock rejects with 401 (any other non-empty key is accepted). */
export const BAD_KEY = 'sk-bad';
export const SAMPLE_RATE = 24000;
export const SPEECH_MS_PER_CHAR = 60;
export const SPEECH_MAX_MS = 30_000;
export const SPEECH_MAX_INPUT_CHARS = 4096;
export const DEFAULT_CHUNK_DELAY_MS = Object.freeze([20, 40]);
export const DEFAULT_SLOW_DELAY_MS = 3000;

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const LOG_PREFIX = '[mock-openai]';
const SYSTEM_FINGERPRINT = 'fp_mock_bonzi';

/**
 * Models returned by GET /v1/models. `kind` is internal to the mock (it is
 * stripped from responses) and drives the "not a chat model" check.
 */
export const MODELS = Object.freeze([
  { id: 'gpt-5', created: 1754425777, owned_by: 'system', kind: 'chat' },
  { id: 'gpt-5-mini', created: 1754425867, owned_by: 'system', kind: 'chat' },
  { id: 'gpt-5-nano', created: 1754426384, owned_by: 'system', kind: 'chat' },
  { id: 'gpt-4.1', created: 1744316542, owned_by: 'system', kind: 'chat' },
  { id: 'gpt-4.1-mini', created: 1744318173, owned_by: 'system', kind: 'chat' },
  { id: 'gpt-4o', created: 1715367049, owned_by: 'system', kind: 'chat' },
  { id: 'gpt-4o-mini', created: 1721172741, owned_by: 'system', kind: 'chat' },
  { id: 'o4-mini', created: 1744225351, owned_by: 'system', kind: 'chat' },
  { id: 'gpt-4o-mini-tts', created: 1742403959, owned_by: 'system', kind: 'tts' },
  { id: 'tts-1', created: 1681940951, owned_by: 'openai-internal', kind: 'tts' },
  { id: 'tts-1-hd', created: 1699046015, owned_by: 'system', kind: 'tts' },
  { id: 'gpt-4o-transcribe', created: 1742068463, owned_by: 'system', kind: 'transcribe' },
  { id: 'gpt-4o-mini-transcribe', created: 1742068596, owned_by: 'system', kind: 'transcribe' },
  { id: 'whisper-1', created: 1677532384, owned_by: 'openai-internal', kind: 'transcribe' },
  { id: 'text-embedding-3-small', created: 1705948997, owned_by: 'system', kind: 'embedding' },
  { id: 'text-embedding-3-large', created: 1705953180, owned_by: 'system', kind: 'embedding' },
  { id: 'dall-e-3', created: 1698785189, owned_by: 'system', kind: 'image' },
  { id: 'gpt-image-1', created: 1745517030, owned_by: 'system', kind: 'image' },
  { id: 'omni-moderation-latest', created: 1731689265, owned_by: 'system', kind: 'moderation' },
]);

export const VOICES = Object.freeze([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
]);
export const SPEECH_FORMATS = Object.freeze(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']);
const TRANSCRIPTION_FORMATS = Object.freeze(['json', 'text', 'verbose_json', 'srt', 'vtt']);
const VALID_ROLES = Object.freeze(['system', 'developer', 'user', 'assistant', 'tool', 'function']);

/** Magic phrases recognised in the last user message (case-insensitive). */
export const TRIGGERS = Object.freeze(['429', 'quota', '500', 'slow', 'long', 'badparam', 'hang']);

const JSON_PARSE_ERROR =
  "We could not parse the JSON body of your request. (HINT: This likely means you aren't using your HTTP library " +
  'correctly. The OpenAI API expects a JSON payload, but what was sent was not valid JSON.)';
const MISSING_KEY_ERROR =
  "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth " +
  '(i.e. Authorization: Bearer YOUR_KEY). You can obtain an API key from https://platform.openai.com/account/api-keys.';

// ---------------------------------------------------------------------------
// Bonzi reply text
// ---------------------------------------------------------------------------
// Every default reply has [[Wave]] in its first sentence and [[Pleased]] in its
// last sentence. All tag names are real animations from Bonzi.acs.

const OPENERS = [
  '[[Wave]] Well hello there, friend!',
  '[[Wave]] Hiya, pal!',
  '[[Wave]] Hey there, buddy!',
  '[[Wave]] Howdy, my friend!',
];

const ECHO_TEMPLATES = [
  (e) => `You said "${e}", and I think that is just swell.`,
  (e) => `Ooh, "${e}" sounds like a fun thing to talk about!`,
  (e) => `I heard you say "${e}" and my gorilla brain is already buzzing.`,
  (e) => `Thanks for telling me "${e}", pal.`,
];

const NO_ECHO = "You didn't say much, but I'm all ears!";

const MIDDLES = [
  '[[Think]] Let me scratch my head on that one for a second.',
  'Gorillas like me happen to be excellent listeners, you know.',
  '[[Explain]] I have been helping folks on their computers for a very long time.',
];

const CLOSERS = [
  "[[Pleased]] I'm always happy to help you out!",
  '[[Pleased]] Is there anything else you would like to chat about?',
  '[[Pleased]] You can always count on your old pal Bonzi!',
];

const FILLERS = [
  '[[Explain]] Back in my day, I lived on desktops all over the world and helped folks surf the World Wide Web.',
  'These days I run on a shiny new engine, but I still love a good chat.',
  '[[Think]] Hmm, let me think about that a little more carefully.',
  'Did you know that a group of gorillas is called a troop?',
  '[[Surprised]] Wow, I almost forgot to mention the best part!',
  'Every question you ask helps me learn what you like to talk about.',
  'If you ever get bored, just ask me for a joke and I will do my best.',
  '[[Giggle]] I once heard that bananas only visit the doctor when they are not peeling well.',
  'I keep my purple fur extra fluffy for days like this one.',
  '[[Explain]] The trick with any big problem is to break it into small, friendly pieces.',
  'You can type to me or talk to me, whichever feels easier.',
  'I promise to keep your secrets safe in my big gorilla heart.',
  '[[Suggest]] Why not take a quick stretch break while we chat?',
  'Remember to drink some water and rest your eyes now and then.',
];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const estimateTokens = (text) => Math.max(1, Math.ceil(text.length / 4));

function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function newRequestId() {
  return `req_${randomUUID().replace(/-/g, '')}`;
}

function newCompletionId() {
  return `chatcmpl-mock${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function errorBody(message, type, code = null, param = null) {
  return { error: { message, type, param, code } };
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function sendError(res, status, message, type, code = null, param = null, headers = {}) {
  sendJson(res, status, errorBody(message, type, code, param), headers);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve({ body: Buffer.concat(chunks), size, tooLarge }));
    req.on('error', reject);
  });
}

function parseJson(buf) {
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false, value: undefined };
  }
}

const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'api-key', 'x-api-key', 'cookie']);

function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Multipart parsing (just enough for /v1/audio/transcriptions)
// ---------------------------------------------------------------------------

function getBoundary(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return m ? (m[1] ?? m[2]) : null;
}

/**
 * Parses a multipart/form-data body. Returns an array of
 * { name, filename, contentType, data: Buffer } or null when malformed.
 */
export function parseMultipart(buf, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const nextDelim = Buffer.from(`\r\n--${boundary}`);
  const parts = [];
  let pos = buf.indexOf(delim);
  if (pos < 0) return null;
  for (;;) {
    pos += delim.length;
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // closing "--"
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;
    const headerEnd = buf.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) return parts.length ? parts : null;
    const headerText = buf.subarray(pos, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const end = buf.indexOf(nextDelim, bodyStart);
    if (end < 0) return parts.length ? parts : null;
    const headers = {};
    for (const line of headerText.split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const disposition = headers['content-disposition'] ?? '';
    const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1] ?? null;
    const filename = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
    parts.push({ name, filename, contentType: headers['content-type'] ?? null, data: buf.subarray(bodyStart, end) });
    pos = end + 2; // skip CRLF, land on the next delimiter
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Chat helpers
// ---------------------------------------------------------------------------

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (isPlainObject(p) && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isPlainObject(m) && m.role === 'user') return messageText(m.content);
  }
  return '';
}

/** Returns a Set like {'slow', 'long', '429', '429:once'}. */
export function detectTriggers(text) {
  const found = new Set();
  const re = /\btrigger\s+(429|quota|500|slow|long|badparam|hang)\b(\s+once\b)?/gi;
  for (const m of text.matchAll(re)) {
    const name = m[1].toLowerCase();
    found.add(name);
    if (m[2]) found.add(`${name}:once`);
  }
  return found;
}

function makeEcho(text) {
  let s = text
    .replace(/\[\[|\]\]/g, ' ')
    .replace(/[.!?;:"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  if (s.length > 48) {
    const cut = s.slice(0, 48);
    const sp = cut.lastIndexOf(' ');
    s = `${(sp > 20 ? cut.slice(0, sp) : cut).trimEnd()}…`;
  }
  return s;
}

/** Deterministic Bonzi-style reply for a given user message. */
export function buildBonziReply(userText, { long = false, seed = 0 } = {}) {
  const rng = mulberry32(hashString(`${seed}\u0000${userText}`));
  const echo = makeEcho(userText);
  const sentences = [pick(rng, OPENERS), echo ? pick(rng, ECHO_TEMPLATES)(echo) : NO_ECHO];
  if (long) sentences.push(...shuffle(rng, FILLERS.slice()).slice(0, 9));
  else if (rng() < 0.5) sentences.push(pick(rng, MIDDLES));
  sentences.push(pick(rng, CLOSERS));
  return sentences.join(' ');
}

/**
 * Splits text into 2-6 character pieces. The first [[Tag]] is always split
 * across two pieces so clients must buffer partial tags.
 */
function splitIntoChunks(text, rng) {
  const bounds = new Set();
  let i = 0;
  for (;;) {
    i += randInt(rng, 2, 6);
    if (i >= text.length) break;
    bounds.add(i);
  }
  const tagStart = text.indexOf('[[');
  if (tagStart >= 0) {
    const tagEnd = text.indexOf(']]', tagStart) + 2;
    if (tagEnd > tagStart + 3 && ![...bounds].some((b) => b > tagStart && b < tagEnd)) bounds.add(tagStart + 3);
  }
  const sorted = [...bounds]
    .map((b) => (/[\uDC00-\uDFFF]/.test(text[b] ?? '') ? b + 1 : b)) // never split a surrogate pair
    .sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const b of sorted) {
    if (b > prev && b < text.length) {
      out.push(text.slice(prev, b));
      prev = b;
    }
  }
  out.push(text.slice(prev));
  return out.filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Speech synthesis (synthetic "voice-like" buzz for lip-sync testing)
// ---------------------------------------------------------------------------

function isVoicedChar(ch) {
  return /[\p{L}\p{N}'’-]/u.test(ch);
}

/** Duration in ms the mock produces for a given input and speed. */
export function speechDurationMs(text, speed = 1) {
  return Math.min((text.length * SPEECH_MS_PER_CHAR) / speed, SPEECH_MAX_MS);
}

/**
 * Synthesises a voice-like signal: a low-passed 120-180 Hz sawtooth buzz with
 * a ~4-6 Hz syllable amplitude envelope inside words, and silence for spaces
 * and punctuation. Each character occupies 60 ms / speed. Returns PCM16 mono
 * samples at 24 kHz.
 */
export function synthesizeSpeech(text, { voice = 'alloy', speed = 1 } = {}) {
  const msPerChar = SPEECH_MS_PER_CHAR / speed;
  const total = Math.round((speechDurationMs(text, speed) * SAMPLE_RATE) / 1000);
  const samplesPerChar = (msPerChar * SAMPLE_RATE) / 1000;
  const out = new Int16Array(total);
  if (total === 0 || text.length === 0) return out;

  const rng = mulberry32(hashString(`${voice}\u0000${text}`));
  const baseF0 = 130 + (hashString(voice) % 41); // 130..170 Hz, stable per voice
  const lpA = 1 - Math.exp((-2 * Math.PI * 1800) / SAMPLE_RATE); // ~1.8 kHz one-pole low-pass
  const envK = 1 - Math.exp(-1 / (SAMPLE_RATE * 0.006)); // 6 ms attack/release smoothing

  let phase = 0;
  let lp = 0;
  let env = 0;
  let curChar = -1;
  let voiced = false;
  let wordStart = 0;
  let wordF0 = baseF0;
  let sylHz = 5;

  for (let n = 0; n < total; n++) {
    const ci = Math.min(text.length - 1, Math.floor(n / samplesPerChar));
    if (ci !== curChar) {
      const wasVoiced = voiced;
      curChar = ci;
      voiced = isVoicedChar(text[ci] ?? ' ');
      if (voiced && !wasVoiced) {
        wordStart = n;
        wordF0 = baseF0 * (0.92 + rng() * 0.16);
        sylHz = (4 + rng() * 2) * speed;
      }
    }
    const t = n / SAMPLE_RATE;
    const tw = (n - wordStart) / SAMPLE_RATE;
    const syllable = 0.5 - 0.5 * Math.cos(2 * Math.PI * sylHz * tw);
    const target = voiced ? 0.15 + 0.85 * syllable : 0;
    env += (target - env) * envK;

    const f0 = clamp(wordF0 * (1 + 0.05 * Math.sin(2 * Math.PI * 0.8 * t)), 120, 180);
    phase += f0 / SAMPLE_RATE;
    if (phase >= 1) phase -= 1;
    lp += (2 * phase - 1 - lp) * lpA;

    out[n] = Math.round(clamp(lp * env * 0.8, -1, 1) * 32767);
  }
  return out;
}

export function pcm16ToBuffer(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}

/** Wraps PCM16 mono samples in a 44-byte RIFF/WAVE header. */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const data = pcm16ToBuffer(samples);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function estimateAudioSeconds(data) {
  if (data.length >= 44 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') {
    const byteRate = data.readUInt32LE(28);
    if (byteRate > 0) return Math.max(0, (data.length - 44) / byteRate);
  }
  return data.length / 16000; // rough guess for compressed audio
}

function fmtTimestamp(seconds, sep) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function publicModel(m) {
  return { id: m.id, object: 'model', created: m.created, owned_by: m.owned_by };
}

function checkAuth(req) {
  const header = req.headers.authorization;
  const m = typeof header === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(header.trim()) : null;
  if (!m) return { message: MISSING_KEY_ERROR, reason: 'missing' };
  if (m[1] === BAD_KEY) {
    return {
      message: `Incorrect API key provided: ${BAD_KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`,
      reason: 'rejected',
    };
  }
  return null;
}

function checkChatModel(model) {
  const known = MODELS.find((m) => m.id === model);
  if (known && known.kind !== 'chat') {
    return {
      status: 404,
      message:
        'This is not a chat model and thus not supported in the v1/chat/completions endpoint. Did you mean to use v1/completions?',
      code: null,
    };
  }
  if (!known && /^nonexistent/i.test(model)) {
    return {
      status: 404,
      message: `The model \`${model}\` does not exist or you do not have access to it.`,
      code: 'model_not_found',
    };
  }
  return null;
}

function shouldFire(state, triggers, name, text) {
  if (!triggers.has(name)) return false;
  if (!triggers.has(`${name}:once`)) return true;
  const key = `${name}\u0000${text}`;
  if (state.onceFired.has(key)) return false;
  state.onceFired.add(key);
  return true;
}

async function handleChat(req, res, state, raw, info) {
  const parsed = parseJson(raw);
  if (!parsed.ok) return sendError(res, 400, JSON_PARSE_ERROR, 'invalid_request_error');
  const body = parsed.value;
  if (!isPlainObject(body)) {
    return sendError(res, 400, 'Invalid request body: expected a JSON object.', 'invalid_request_error');
  }
  const { model, messages } = body;
  if (typeof model !== 'string' || model.trim() === '') {
    return sendError(res, 400, 'you must provide a model parameter', 'invalid_request_error');
  }
  info.model = model;
  info.stream = body.stream === true;

  if (messages === undefined) {
    return sendError(res, 400, "Missing required parameter: 'messages'.", 'invalid_request_error', 'missing_required_parameter', 'messages');
  }
  if (!Array.isArray(messages)) {
    return sendError(res, 400, "Invalid type for 'messages': expected an array of objects.", 'invalid_request_error', 'invalid_type', 'messages');
  }
  if (messages.length === 0) {
    return sendError(
      res, 400,
      "Invalid 'messages': empty array. Expected an array with minimum length 1, but got an empty array instead.",
      'invalid_request_error', 'empty_array', 'messages',
    );
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!isPlainObject(m) || !VALID_ROLES.includes(m.role)) {
      const got = isPlainObject(m) ? String(m.role) : typeof m;
      return sendError(
        res, 400,
        `Invalid value for 'messages[${i}].role': '${got}'. Supported values are: ${VALID_ROLES.map((r) => `'${r}'`).join(', ')}.`,
        'invalid_request_error', 'invalid_value', `messages[${i}].role`,
      );
    }
  }
  if (body.stream_options !== undefined && body.stream_options !== null && body.stream !== true) {
    return sendError(res, 400, "The 'stream_options' parameter is only allowed when 'stream' is enabled.", 'invalid_request_error', null, 'stream_options');
  }
  const modelErr = checkChatModel(model);
  if (modelErr) return sendError(res, modelErr.status, modelErr.message, 'invalid_request_error', modelErr.code, 'model');

  const userText = lastUserText(messages);
  const triggers = detectTriggers(userText);
  const fire = (name) => {
    const fired = shouldFire(state, triggers, name, userText);
    if (fired) info.triggers.push(name);
    return fired;
  };

  if (fire('429')) {
    return sendError(
      res, 429,
      `Rate limit reached for ${model} in organization org-mock on requests per min (RPM): Limit 3, Used 3, Requested 1. ` +
        'Please try again in 1s. Visit https://platform.openai.com/account/rate-limits to learn more.',
      'requests', 'rate_limit_exceeded', null,
      {
        'retry-after': '1',
        'retry-after-ms': '1000',
        'x-ratelimit-limit-requests': '3',
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-reset-requests': '1s',
      },
    );
  }
  if (fire('quota')) {
    return sendError(
      res, 429,
      'You exceeded your current quota, please check your plan and billing details. For more information on this error, ' +
        'read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.',
      'insufficient_quota', 'insufficient_quota',
    );
  }
  if (fire('500')) {
    return sendError(
      res, 500,
      'The server had an error while processing your request. Sorry about that! (mock: trigger 500)',
      'server_error',
    );
  }
  if (Object.hasOwn(body, 'temperature') && fire('badparam')) {
    return sendError(
      res, 400,
      "Unsupported parameter: 'temperature' is not supported with this model.",
      'invalid_request_error', 'unsupported_parameter', 'temperature',
    );
  }
  const hang = fire('hang');
  const slow = fire('slow');
  const long = fire('long');

  let content = buildBonziReply(userText, { long, seed: hashString(model) });
  let finishReason = 'stop';
  const promptTokens = estimateTokens(messages.map((m) => messageText(m.content)).join('\n'));
  let completionTokens = estimateTokens(content);
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (typeof maxTokens === 'number' && maxTokens > 0 && completionTokens > maxTokens) {
    content = content.slice(0, Math.floor(maxTokens) * 4);
    completionTokens = Math.floor(maxTokens);
    finishReason = 'length';
  }
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
  };
  const id = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const timingRng = mulberry32(hashString(`timing\u0000${userText}`));

  if (!info.stream) {
    if (hang) return; // never respond
    if (slow) await state.sleep(state.slowDelayMs);
    if (state.isDead(res)) return;
    return sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content, refusal: null, annotations: [] },
          logprobs: null,
          finish_reason: finishReason,
        },
      ],
      usage,
      service_tier: 'default',
      system_fingerprint: SYSTEM_FINGERPRINT,
    });
  }

  // Streaming (SSE)
  const includeUsage = isPlainObject(body.stream_options) && body.stream_options.include_usage === true;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.flushHeaders();
  const base = { id, object: 'chat.completion.chunk', created, model, service_tier: 'default', system_fingerprint: SYSTEM_FINGERPRINT };
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const chunk = (delta, finish) => ({
    ...base,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    ...(includeUsage ? { usage: null } : {}),
  });
  const [minDelay, maxDelay] = state.chunkDelayMs;
  const pause = () => state.sleep(randInt(timingRng, minDelay, maxDelay));

  if (slow) await state.sleep(state.slowDelayMs);
  if (state.isDead(res)) return;
  send(chunk({ role: 'assistant', content: '', refusal: null }, null));

  const pieces = splitIntoChunks(content, mulberry32(hashString(`chunks\u0000${content}`)));
  const toSend = hang ? pieces.slice(0, 2) : pieces;
  for (const piece of toSend) {
    await pause();
    if (state.isDead(res)) return;
    send(chunk({ content: piece }, null));
  }
  if (hang) return; // stall forever; the client must time out / abort

  await pause();
  if (state.isDead(res)) return;
  send(chunk({}, finishReason));
  if (includeUsage) send({ ...base, choices: [], usage });
  res.write('data: [DONE]\n\n');
  res.end();
}

function handleSpeech(req, res, raw, info) {
  const parsed = parseJson(raw);
  if (!parsed.ok) return sendError(res, 400, JSON_PARSE_ERROR, 'invalid_request_error');
  const body = parsed.value;
  if (!isPlainObject(body)) {
    return sendError(res, 400, 'Invalid request body: expected a JSON object.', 'invalid_request_error');
  }
  const { model, input, voice } = body;
  if (typeof model !== 'string' || model.trim() === '') {
    return sendError(res, 400, 'you must provide a model parameter', 'invalid_request_error');
  }
  info.model = model;
  if (input === undefined || input === null) {
    return sendError(res, 400, "Missing required parameter: 'input'.", 'invalid_request_error', 'missing_required_parameter', 'input');
  }
  if (typeof input !== 'string') {
    return sendError(res, 400, "Invalid type for 'input': expected a string.", 'invalid_request_error', 'invalid_type', 'input');
  }
  if (input.trim().length === 0) {
    return sendError(
      res, 400,
      "Invalid 'input': empty string. Expected a string with minimum length 1, but got an empty string instead.",
      'invalid_request_error', 'empty_string', 'input',
    );
  }
  if (input.length > SPEECH_MAX_INPUT_CHARS) {
    return sendError(
      res, 400,
      `Invalid 'input': string too long. Expected a string with maximum length ${SPEECH_MAX_INPUT_CHARS}, ` +
        `but got a string with length ${input.length} instead.`,
      'invalid_request_error', 'string_above_max_length', 'input',
    );
  }
  if (voice === undefined || voice === null || voice === '') {
    return sendError(res, 400, "Missing required parameter: 'voice'.", 'invalid_request_error', 'missing_required_parameter', 'voice');
  }
  if (typeof voice !== 'string' || !VOICES.includes(voice)) {
    return sendError(
      res, 400,
      `Invalid value: '${String(voice)}'. Supported values are: ${VOICES.map((v) => `'${v}'`).join(', ')}.`,
      'invalid_request_error', 'invalid_value', 'voice',
    );
  }
  const format = body.response_format ?? 'mp3';
  if (typeof format !== 'string' || !SPEECH_FORMATS.includes(format)) {
    return sendError(
      res, 400,
      `Invalid value: '${String(format)}'. Supported values are: ${SPEECH_FORMATS.map((f) => `'${f}'`).join(', ')}.`,
      'invalid_request_error', 'invalid_value', 'response_format',
    );
  }
  const speed = body.speed ?? 1;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.25 || speed > 4) {
    return sendError(
      res, 400,
      `Invalid 'speed': expected a number between 0.25 and 4.0, but got ${JSON.stringify(speed)} instead.`,
      'invalid_request_error', 'invalid_value', 'speed',
    );
  }

  const samples = synthesizeSpeech(input, { voice, speed });
  const durationMs = Math.round((samples.length / SAMPLE_RATE) * 1000);
  const headers = {
    'x-mock-duration-ms': String(durationMs),
    'x-mock-sample-rate': String(SAMPLE_RATE),
  };
  let payload;
  if (format === 'pcm') {
    payload = pcm16ToBuffer(samples);
    headers['content-type'] = 'audio/pcm';
  } else {
    payload = encodeWav(samples);
    headers['content-type'] = 'audio/wav';
    if (format !== 'wav') {
      headers['x-mock-note'] = `mock cannot encode ${format}; returned WAV (PCM16 mono 24kHz) instead`;
      info.note = `format=${format}->wav`;
    }
  }
  headers['content-length'] = String(payload.length);
  res.writeHead(200, headers);
  res.end(payload);
}

function handleTranscription(req, res, parts, info) {
  const contentType = String(req.headers['content-type'] ?? '');
  if (!/^multipart\/form-data/i.test(contentType)) {
    return sendError(
      res, 400,
      `Invalid Content-Type header (${contentType || 'none'}), expected multipart/form-data.`,
      'invalid_request_error',
    );
  }
  if (!parts) {
    return sendError(res, 400, 'Could not parse multipart form data.', 'invalid_request_error');
  }
  const field = (name) => {
    const p = parts.find((x) => x.name === name && x.filename === null);
    return p ? p.data.toString('utf8') : undefined;
  };
  const model = field('model');
  if (!model) return sendError(res, 400, 'you must provide a model parameter', 'invalid_request_error');
  info.model = model;
  const file = parts.find((x) => x.name === 'file');
  if (!file) {
    return sendError(res, 400, "Missing required parameter: 'file'.", 'invalid_request_error', 'missing_required_parameter', 'file');
  }
  if (file.data.length === 0) {
    return sendError(res, 400, 'Audio file is too short. Minimum audio length is 0.1 seconds.', 'invalid_request_error', 'audio_too_short', 'file');
  }
  const format = field('response_format') ?? 'json';
  if (!TRANSCRIPTION_FORMATS.includes(format)) {
    return sendError(
      res, 400,
      `Invalid value: '${format}'. Supported values are: ${TRANSCRIPTION_FORMATS.map((f) => `'${f}'`).join(', ')}.`,
      'invalid_request_error', 'invalid_value', 'response_format',
    );
  }
  const text = `Hello Bonzi, this is a mock transcription (${file.data.length} bytes).`;
  const duration = Math.round(estimateAudioSeconds(file.data) * 1000) / 1000;
  switch (format) {
    case 'text':
      return sendText(res, 200, `${text}\n`);
    case 'srt':
      return sendText(res, 200, `1\n${fmtTimestamp(0, ',')} --> ${fmtTimestamp(duration, ',')}\n${text}\n\n`);
    case 'vtt':
      return sendText(res, 200, `WEBVTT\n\n${fmtTimestamp(0, '.')} --> ${fmtTimestamp(duration, '.')}\n${text}\n\n`, 'text/vtt; charset=utf-8');
    case 'verbose_json':
      return sendJson(res, 200, {
        task: 'transcribe',
        language: field('language') ?? 'english',
        duration,
        text,
        segments: [
          { id: 0, seek: 0, start: 0, end: duration, text, tokens: [], temperature: 0, avg_logprob: -0.2, compression_ratio: 1, no_speech_prob: 0.01 },
        ],
      });
    default:
      return sendJson(res, 200, { text });
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function formatLogLine({ method, path: p, status, ms, info, aborted }) {
  const ts = new Date().toISOString().slice(11, 23);
  const parts = [LOG_PREFIX, ts, method, p, status === null ? '---' : String(status), `${ms}ms`];
  if (info.model) parts.push(`model=${info.model}`);
  if (info.stream) parts.push('stream');
  if (info.triggers.length) parts.push(`trigger=${info.triggers.join(',')}`);
  if (info.auth) parts.push(`auth=${info.auth}`);
  if (info.note) parts.push(info.note);
  if (aborted) parts.push('ABORTED');
  return parts.join(' ');
}

async function handleRequest(req, res, state) {
  const started = Date.now();
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const isControl = pathname.startsWith('/__mock/');
  const info = { model: undefined, stream: false, triggers: [], auth: undefined, note: undefined };

  let entry = null;
  if (!isControl) {
    entry = {
      id: state.nextId++,
      time: new Date().toISOString(),
      method,
      path: pathname,
      query: Object.fromEntries(url.searchParams),
      headers: sanitizeHeaders(req.headers),
      hasAuth: typeof req.headers.authorization === 'string' && req.headers.authorization.length > 0,
      body: null,
      status: null,
      durationMs: null,
      completed: null,
    };
    state.requests.push(entry);
  }

  res.setHeader('x-request-id', newRequestId());
  res.setHeader('openai-version', '2020-10-01');
  res.setHeader('openai-processing-ms', '1');
  res.setHeader('x-mock-server', 'bonzi-mock-openai');

  res.on('close', () => {
    const status = res.headersSent ? res.statusCode : null;
    const completed = res.writableFinished;
    if (entry) {
      entry.status = status;
      entry.durationMs = Date.now() - started;
      entry.completed = completed;
    }
    state.log(formatLogLine({ method, path: pathname, status, ms: Date.now() - started, info, aborted: !completed }));
  });

  // Read the body for every non-GET request so it can be recorded.
  let raw = Buffer.alloc(0);
  let parts = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const r = await readBody(req, MAX_BODY_BYTES);
    if (r.tooLarge) {
      if (entry) entry.body = { bytes: r.size, note: 'body too large, not recorded' };
      return sendError(res, 413, `Request body too large (max ${MAX_BODY_BYTES} bytes).`, 'invalid_request_error');
    }
    raw = r.body;
    if (entry && raw.length > 0) {
      const ct = String(req.headers['content-type'] ?? '');
      if (/^multipart\/form-data/i.test(ct)) {
        const boundary = getBoundary(ct);
        parts = boundary ? parseMultipart(raw, boundary) : null;
        entry.body = parts
          ? {
              fields: Object.fromEntries(parts.filter((p) => p.filename === null && p.name).map((p) => [p.name, p.data.toString('utf8')])),
              files: parts
                .filter((p) => p.filename !== null)
                .map((p) => ({ field: p.name, filename: p.filename, contentType: p.contentType, size: p.data.length })),
            }
          : { bytes: raw.length, note: 'unparseable multipart body' };
      } else {
        const parsed = parseJson(raw);
        entry.body = parsed.ok ? parsed.value : { bytes: raw.length, text: raw.toString('utf8').slice(0, 2000) };
      }
    }
  }

  // Mock control endpoints (no auth, not recorded)
  if (isControl) {
    if (pathname === '/__mock/requests' && method === 'GET') return sendJson(res, 200, state.requests);
    if (pathname === '/__mock/reset' && method === 'POST') return sendJson(res, 200, { ok: true, cleared: state.reset() });
    if (pathname === '/__mock/health' && method === 'GET') return sendJson(res, 200, { ok: true });
    return sendError(res, 404, `Invalid URL (${method} ${pathname})`, 'invalid_request_error');
  }
  if (pathname === '/' && method === 'GET') {
    return sendJson(res, 200, { ok: true, name: 'bonzi-mock-openai', baseURL: `${state.url}/v1` });
  }

  if (pathname === '/v1' || pathname.startsWith('/v1/')) {
    const authErr = checkAuth(req);
    if (authErr) {
      info.auth = authErr.reason;
      return sendError(res, 401, authErr.message, 'invalid_request_error', 'invalid_api_key');
    }
    if (pathname === '/v1/models' && method === 'GET') {
      return sendJson(res, 200, { object: 'list', data: MODELS.map(publicModel) });
    }
    if (pathname.startsWith('/v1/models/') && method === 'GET') {
      const id = decodeURIComponent(pathname.slice('/v1/models/'.length));
      const m = MODELS.find((x) => x.id === id);
      if (m) return sendJson(res, 200, publicModel(m));
      return sendError(res, 404, `The model '${id}' does not exist`, 'invalid_request_error', 'model_not_found', 'model');
    }
    if (pathname === '/v1/chat/completions' && method === 'POST') return handleChat(req, res, state, raw, info);
    if (pathname === '/v1/audio/speech' && method === 'POST') return handleSpeech(req, res, raw, info);
    if (pathname === '/v1/audio/transcriptions' && method === 'POST') {
      if (!parts) {
        const ct = String(req.headers['content-type'] ?? '');
        const boundary = getBoundary(ct);
        parts = boundary && raw.length ? parseMultipart(raw, boundary) : null;
      }
      return handleTranscription(req, res, parts, info);
    }
  }
  return sendError(res, 404, `Invalid URL (${method} ${pathname})`, 'invalid_request_error');
}

/**
 * Starts the mock server on 127.0.0.1.
 *
 * @param {object} [options]
 * @param {number} [options.port=0] Port to listen on (0 = ephemeral).
 * @param {boolean | ((line: string) => void)} [options.log=true] Log one line per request to stdout,
 *   or pass a function to receive the lines. The API key is never logged.
 * @param {[number, number]} [options.chunkDelayMs=[20, 40]] Min/max delay between streamed chunks.
 * @param {number} [options.slowDelayMs=3000] Delay before the first token for "trigger slow".
 * @returns {Promise<{ url: string, baseURL: string, port: number, requests: object[], reset: () => number, close: () => Promise<void> }>}
 */
export async function startMockServer(options = {}) {
  const {
    port = 0,
    log = true,
    chunkDelayMs = DEFAULT_CHUNK_DELAY_MS,
    slowDelayMs = DEFAULT_SLOW_DELAY_MS,
  } = options;

  const timers = new Set();
  let closed = false;

  const state = {
    url: '',
    nextId: 1,
    requests: [],
    onceFired: new Set(),
    chunkDelayMs: [Math.max(0, chunkDelayMs[0] ?? 20), Math.max(0, chunkDelayMs[1] ?? chunkDelayMs[0] ?? 40)],
    slowDelayMs: Math.max(0, slowDelayMs),
    log: typeof log === 'function' ? log : log ? (line) => console.log(line) : () => {},
    sleep: (ms) =>
      new Promise((resolve) => {
        if (closed) return; // never resolves; server is shutting down
        const t = setTimeout(() => {
          timers.delete(t);
          resolve();
        }, ms);
        timers.add(t);
      }),
    isDead: (res) => closed || res.destroyed || res.writableEnded,
    reset: () => {
      const n = state.requests.length;
      state.requests.length = 0; // keep the same array so callers holding `requests` see the change
      state.onceFired.clear();
      return n;
    },
  };

  const server = http.createServer((req, res) => {
    handleRequest(req, res, state).catch((err) => {
      if (!res.headersSent) {
        sendError(res, 500, `Mock server internal error: ${err instanceof Error ? err.message : String(err)}`, 'server_error');
      } else {
        res.destroy();
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  state.url = `http://${HOST}:${actualPort}`;

  let closePromise = null;
  const close = () => {
    if (!closePromise) {
      closed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      closePromise = new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections(); // also tears down hung streams
      });
    }
    return closePromise;
  };

  return {
    url: state.url,
    baseURL: `${state.url}/v1`,
    port: actualPort,
    requests: state.requests,
    reset: state.reset,
    close,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `Mock OpenAI API for BonziBuddy Reborn (binds 127.0.0.1 only)

Usage: node scripts/mock-openai.mjs [options]

Options:
  -p, --port <n>          Port to listen on (default: $MOCK_OPENAI_PORT or ${DEFAULT_PORT}; 0 = ephemeral)
  -q, --quiet             Do not log one line per request
      --chunk-delay <a-b> Delay range between streamed chunks in ms (default: ${DEFAULT_CHUNK_DELAY_MS.join('-')})
      --slow-ms <n>       Delay before the first token for "trigger slow" (default: ${DEFAULT_SLOW_DELAY_MS})
  -h, --help              Show this help

See docs/MOCK-OPENAI.md for endpoints and magic triggers.`;

function parsePort(value, source) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Invalid port from ${source}: ${value}`);
  return n;
}

function parseCliArgs(argv) {
  const opts = { port: undefined, log: true, chunkDelayMs: undefined, slowDelayMs: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${flag}`);
      return v;
    };
    switch (flag) {
      case '-p':
      case '--port':
        opts.port = parsePort(value(), flag);
        break;
      case '-q':
      case '--quiet':
        opts.log = false;
        break;
      case '--chunk-delay': {
        const m = /^(\d+)(?:-(\d+))?$/.exec(value());
        if (!m) throw new Error('--chunk-delay expects <min>-<max>, e.g. 20-40');
        opts.chunkDelayMs = [Number(m[1]), Number(m[2] ?? m[1])];
        break;
      }
      case '--slow-ms': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 0) throw new Error('--slow-ms expects a non-negative integer');
        opts.slowDelayMs = n;
        break;
      }
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${LOG_PREFIX} ${err instanceof Error ? err.message : String(err)}\n\n${HELP}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }
  let port = DEFAULT_PORT;
  try {
    if (opts.port !== undefined) port = opts.port;
    else if (process.env.MOCK_OPENAI_PORT) port = parsePort(process.env.MOCK_OPENAI_PORT, 'MOCK_OPENAI_PORT');
  } catch (err) {
    console.error(`${LOG_PREFIX} ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  let mock;
  try {
    mock = await startMockServer({
      port,
      log: opts.log,
      ...(opts.chunkDelayMs ? { chunkDelayMs: opts.chunkDelayMs } : {}),
      ...(opts.slowDelayMs !== undefined ? { slowDelayMs: opts.slowDelayMs } : {}),
    });
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
    const msg = code === 'EADDRINUSE' ? `Port ${port} is already in use (try --port <n>).` : String(err);
    console.error(`${LOG_PREFIX} Failed to start: ${msg}`);
    process.exit(1);
  }

  console.log(`${LOG_PREFIX} Mock OpenAI API listening on ${mock.url}`);
  console.log(`${LOG_PREFIX}   Base URL : ${mock.baseURL}`);
  console.log(`${LOG_PREFIX}   API key  : any non-empty key, e.g. sk-test-local ('${BAD_KEY}' is rejected with 401)`);
  console.log(`${LOG_PREFIX}   Inspect  : GET ${mock.url}/__mock/requests, POST ${mock.url}/__mock/reset`);
  console.log(`${LOG_PREFIX}   Triggers : ${TRIGGERS.map((t) => `"trigger ${t}"`).join(', ')}`);
  console.log(`MOCK_OPENAI_READY ${mock.baseURL}`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log(`${LOG_PREFIX} Shutting down`);
    mock.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const invoked = realpathSync(path.resolve(process.argv[1]));
    return process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main();
}
