// Pure helpers for the Windows (SAPI) voice: pitch, tempo compensation and
// voice selection. Shared by the main process (which asks SAPI for a rate) and
// the renderers (which apply the pitch as an AudioBufferSourceNode playbackRate).
//
// Pitch is applied by playing the WAV faster (playbackRate = pitch), which also
// speeds it up by the same factor. To keep the perceived speed at
// settings.systemVoiceRate, SAPI is asked to speak correspondingly slower:
//   perceived = sapiSpeed(rate) * pitch,  sapiSpeed(rate) ~= 3 ^ (rate / 10)
// (measured on Microsoft David: rate -5 = 0.58x, +5 = 1.79x, +10 = 3.06x).

import { LIMITS } from './settings.ts';

/** SAPI rate r speaks about SAPI_SPEED_BASE ^ (r / 10) times faster than rate 0. */
export const SAPI_SPEED_BASE = 3;
export const SAPI_RATE_MIN = -10;
export const SAPI_RATE_MAX = 10;

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** playbackRate for the Windows voice WAV (1 = natural pitch). */
export function playbackRateForPitch(pitch: number): number {
  return Math.min(LIMITS.systemVoicePitch.max, Math.max(LIMITS.systemVoicePitch.min, finiteOr(pitch, 1)));
}

/** Speed multiplier SAPI produces for an integer rate. */
export function sapiSpeedForRate(rate: number): number {
  return SAPI_SPEED_BASE ** (finiteOr(rate, 0) / 10);
}

/**
 * Integer SAPI rate (-10..10) so that, after playback at playbackRateForPitch(pitch),
 * the voice is heard at about `perceivedRate` times its normal speed.
 */
export function sapiRateFor(perceivedRate: number, pitch: number): number {
  const target = Math.min(LIMITS.systemVoiceRate.max, Math.max(LIMITS.systemVoiceRate.min, finiteOr(perceivedRate, 1)));
  const sapiSpeed = target / playbackRateForPitch(pitch);
  const rate = Math.round((10 * Math.log(sapiSpeed)) / Math.log(SAPI_SPEED_BASE));
  return Math.min(SAPI_RATE_MAX, Math.max(SAPI_RATE_MIN, rate));
}

/** The speed actually heard (SAPI rates are integers, so this is close to, not exactly, the setting). */
export function effectiveSpeed(perceivedRate: number, pitch: number): number {
  return sapiSpeedForRate(sapiRateFor(perceivedRate, pitch)) * playbackRateForPitch(pitch);
}

export interface VoiceLike {
  name: string;
  culture: string;
  gender: string;
}

/** Bonzi is a "he": Microsoft David, else the first en-US male voice, else the first en-US voice, else null (Windows default). */
export function pickDefaultSystemVoice(voices: readonly VoiceLike[]): string | null {
  const enUs = voices.filter((v) => v.culture.toLowerCase() === 'en-us');
  const pick =
    voices.find((v) => /^Microsoft David\b/i.test(v.name)) ??
    enUs.find((v) => v.gender.toLowerCase() === 'male') ??
    enUs[0] ??
    null;
  return pick ? pick.name : null;
}

/**
 * The installed voice to use for a requested name: an exact (or case-insensitive)
 * match of an installed voice, otherwise the default pick. Never returns a name
 * that is not in `voices`, so arbitrary renderer strings never reach SAPI.
 */
export function resolveSystemVoice(requested: string, voices: readonly VoiceLike[]): { name: string | null; matched: boolean } {
  const want = requested.trim();
  if (want) {
    const exact = voices.find((v) => v.name === want) ?? voices.find((v) => v.name.toLowerCase() === want.toLowerCase());
    if (exact) return { name: exact.name, matched: true };
  }
  return { name: pickDefaultSystemVoice(voices), matched: want.length === 0 };
}
