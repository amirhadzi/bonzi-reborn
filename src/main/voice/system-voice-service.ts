// Windows voice service for the IPC layer: voice listing (cached), voice
// validation against the installed list, tempo compensation for the pitch
// shift, and mapping SAPI failures to TtsResult errors.

import type { SystemVoice, SystemVoiceListResult, TtsResult } from '../../shared/ipc.ts';
import { pickDefaultSystemVoice, resolveSystemVoice, sapiRateFor } from '../../shared/voice-tuning.ts';
import { SapiError } from './sapi-host.ts';
import type { SapiHostLike, SapiLog } from './sapi-host.ts';

export interface SystemSpeechRequest {
  text: string;
  /** Requested voice name (settings or preview override). Empty = Bonzi's default voice. */
  voiceName: string;
  /** settings.systemVoiceRate: perceived speed after the pitch shift. */
  rate: number;
  /** settings.systemVoicePitch: the renderer plays the WAV at this playbackRate. */
  pitch: number;
}

export interface SystemVoiceServiceOptions {
  host: SapiHostLike;
  log?: SapiLog;
  /** How long a voice list stays cached. Default 60 s. */
  voicesTtlMs?: number;
  now?: () => number;
}

const MESSAGE_UNAVAILABLE = 'Windows voices are not available on this PC.';

/** Plain text for SAPI: control characters become spaces, whitespace is collapsed. */
export function cleanSystemSpeechText(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 32 || (c >= 127 && c < 160) ? ' ' : ch;
  }
  // \s also matches the Unicode line and paragraph separators.
  return out.replace(/\s+/g, ' ').trim();
}

export class SystemVoiceService {
  readonly #host: SapiHostLike;
  readonly #log: SapiLog;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #voices: { at: number; list: SystemVoice[] } | null = null;
  #voicesInFlight: Promise<SystemVoice[]> | null = null;
  #warnedMissing = '';

  constructor(options: SystemVoiceServiceOptions) {
    this.#host = options.host;
    this.#log = options.log ?? (() => undefined);
    this.#ttlMs = options.voicesTtlMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  async #installed(): Promise<SystemVoice[]> {
    const cached = this.#voices;
    if (cached && this.#now() - cached.at < this.#ttlMs) return cached.list;
    if (!this.#voicesInFlight) {
      this.#voicesInFlight = this.#host
        .listVoices()
        .then((list) => {
          this.#voices = { at: this.#now(), list };
          return list;
        })
        .finally(() => {
          this.#voicesInFlight = null;
        });
    }
    return this.#voicesInFlight;
  }

  async listVoices(): Promise<SystemVoiceListResult> {
    try {
      const voices = await this.#installed();
      return { ok: true, voices: voices.map((v) => ({ ...v })), defaultVoice: pickDefaultSystemVoice(voices) };
    } catch (err) {
      return { ok: false, error: toAiError(err) };
    }
  }

  async synthesize(req: SystemSpeechRequest): Promise<TtsResult> {
    const text = cleanSystemSpeechText(req.text);
    if (!text) return { ok: false, error: { kind: 'bad-request', message: 'There is no text to speak.' } };
    try {
      const voices = await this.#installed();
      const { name, matched } = resolveSystemVoice(req.voiceName, voices);
      if (!matched && this.#warnedMissing !== req.voiceName) {
        this.#warnedMissing = req.voiceName;
        this.#log('warn', 'The chosen Windows voice is not installed; using the default voice.');
      }
      const wav = await this.#host.speak({ text, voice: name, rate: sapiRateFor(req.rate, req.pitch), volume: 100 });
      const audio = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
      return { ok: true, audio, mime: 'audio/wav' };
    } catch (err) {
      // A failed request may mean the voice list changed (voice removed): refresh it next time.
      this.#voices = null;
      return { ok: false, error: toAiError(err) };
    }
  }

  dispose(): void {
    this.#host.dispose();
  }
}

function toAiError(err: unknown): { kind: 'timeout' | 'cancelled' | 'unknown'; message: string } {
  if (err instanceof SapiError) {
    if (err.code === 'timeout') return { kind: 'timeout', message: 'The Windows voice took too long to answer.' };
    if (err.code === 'disposed') return { kind: 'cancelled', message: 'The Windows voice was shut down.' };
    if (err.code === 'unavailable') return { kind: 'unknown', message: MESSAGE_UNAVAILABLE };
    return { kind: 'unknown', message: err.message };
  }
  return { kind: 'unknown', message: 'The Windows voice failed.' };
}
