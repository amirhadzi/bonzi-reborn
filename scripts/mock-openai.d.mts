/**
 * Type declarations for scripts/mock-openai.mjs (dependency-free mock of the OpenAI API).
 * See docs/MOCK-OPENAI.md for behaviour.
 */

export declare const DEFAULT_PORT: 8787;
export declare const HOST: '127.0.0.1';
/** The one API key the mock rejects with 401 (any other non-empty key is accepted). */
export declare const BAD_KEY: 'sk-bad';
export declare const SAMPLE_RATE: 24000;
export declare const SPEECH_MS_PER_CHAR: 60;
export declare const SPEECH_MAX_MS: 30000;
export declare const SPEECH_MAX_INPUT_CHARS: 4096;
export declare const DEFAULT_CHUNK_DELAY_MS: readonly [number, number];
export declare const DEFAULT_SLOW_DELAY_MS: 3000;

export type MockModelKind = 'chat' | 'tts' | 'transcribe' | 'embedding' | 'image' | 'moderation';

export interface MockModel {
  readonly id: string;
  readonly created: number;
  readonly owned_by: string;
  /** Internal to the mock; stripped from API responses. */
  readonly kind: MockModelKind;
}

export declare const MODELS: readonly MockModel[];
export declare const VOICES: readonly string[];
export declare const SPEECH_FORMATS: readonly ('mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm')[];
export type MockTrigger = '429' | 'quota' | '500' | 'slow' | 'long' | 'badparam' | 'hang';
export declare const TRIGGERS: readonly MockTrigger[];

export interface MultipartPart {
  name: string | null;
  filename: string | null;
  contentType: string | null;
  data: Buffer;
}

/** Parses a multipart/form-data body; null when malformed. */
export declare function parseMultipart(buf: Buffer, boundary: string): MultipartPart[] | null;

/** Returns trigger names found in the text, plus '<name>:once' entries for "trigger <name> once". */
export declare function detectTriggers(text: string): Set<string>;

/** Deterministic Bonzi-style reply for a given user message. */
export declare function buildBonziReply(userText: string, options?: { long?: boolean; seed?: number }): string;

/** Duration in ms the mock produces for a given input and speed. */
export declare function speechDurationMs(text: string, speed?: number): number;

/** Synthetic voice-like PCM16 mono samples at 24 kHz. */
export declare function synthesizeSpeech(text: string, options?: { voice?: string; speed?: number }): Int16Array;

export declare function pcm16ToBuffer(samples: Int16Array): Buffer;

/** Wraps PCM16 mono samples in a 44-byte RIFF/WAVE header. */
export declare function encodeWav(samples: Int16Array, sampleRate?: number): Buffer;

export interface MultipartSummary {
  fields: Record<string, string>;
  files: Array<{ field: string | null; filename: string; contentType: string | null; size: number }>;
}

export interface RecordedRequest {
  id: number;
  /** ISO timestamp. */
  time: string;
  method: string;
  path: string;
  query: Record<string, string>;
  /** Request headers without authorization, cookie, api-key or x-api-key. */
  headers: Record<string, string | string[] | undefined>;
  hasAuth: boolean;
  /** Parsed JSON, a multipart summary, or null. */
  body: unknown;
  status: number | null;
  durationMs: number | null;
  /** false when the client went away before the response finished. */
  completed: boolean | null;
}

export interface MockServerOptions {
  /** Port to listen on; 0 (default) picks a free port. */
  port?: number;
  /** true logs one line per request to stdout, false is silent, or pass a sink. Default true. */
  log?: boolean | ((line: string) => void);
  /** Min/max delay between streamed chat chunks in ms. Default [20, 40]. */
  chunkDelayMs?: readonly [number, number] | [number, number];
  /** Delay before the first token for "trigger slow". Default 3000. */
  slowDelayMs?: number;
}

export interface MockServer {
  /** Origin, e.g. http://127.0.0.1:54321 (for the /__mock/* routes). */
  url: string;
  /** API base URL to give the app, e.g. http://127.0.0.1:54321/v1. */
  baseURL: string;
  port: number;
  /** Live array of recorded requests. */
  requests: RecordedRequest[];
  /** Clears the recording and re-arms "once" triggers; returns how many entries were removed. */
  reset(): number;
  /** Stops the server and tears down hung streams. */
  close(): Promise<void>;
}

/** Starts the mock server on 127.0.0.1. */
export declare function startMockServer(options?: MockServerOptions): Promise<MockServer>;
