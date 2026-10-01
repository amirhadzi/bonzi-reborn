// Lip-sync: loudness (RMS) to MS Agent mouth overlays, and a letter-based
// viseme timeline for voices without audio analysis.

import { MOUTH, type MouthShape } from '../../../shared/character-controller.ts';

/** Mouth shapes from closed to widest open. */
export const OPENNESS: readonly MouthShape[] = [
  MOUTH.closed,
  MOUTH.narrow,
  MOUTH.medium,
  MOUTH.wide1,
  MOUTH.wide2,
  MOUTH.wide3,
  MOUTH.wide4,
];

/** Upper bounds of normalised loudness for each OPENNESS step (last is open-ended). */
const STEP_LIMITS = [0.1, 0.2, 0.32, 0.45, 0.6, 0.78];

export interface LipSyncOptions {
  /** RMS below this counts as silence. */
  noiseFloor?: number;
  /** Envelope time constants. */
  attackMs?: number;
  releaseMs?: number;
  /** Minimum time a shape is held before it may change. */
  minHoldMs?: number;
  /** Normalised loudness margin needed to move one step (hysteresis). */
  hysteresis?: number;
  /** Time constant of the peak tracker used to normalise loudness. */
  peakDecayMs?: number;
}

/** Root mean square of time-domain samples (Float32 -1..1, or Uint8 centred on 128). */
export function rms(samples: ArrayLike<number>, unsigned8 = false): number {
  const n = samples.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = unsigned8 ? ((samples[i] ?? 128) - 128) / 128 : (samples[i] ?? 0);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

export class LipSync {
  private readonly floor: number;
  private readonly attackMs: number;
  private readonly releaseMs: number;
  private readonly minHoldMs: number;
  private readonly hysteresis: number;
  private readonly peakDecayMs: number;
  private env = 0;
  private peak = 0;
  private step = 0;
  private lastT: number | null = null;
  private changedAt = -Infinity;

  constructor(options: LipSyncOptions = {}) {
    this.floor = options.noiseFloor ?? 0.012;
    this.attackMs = options.attackMs ?? 25;
    this.releaseMs = options.releaseMs ?? 90;
    this.minHoldMs = options.minHoldMs ?? 60;
    this.hysteresis = options.hysteresis ?? 0.04;
    this.peakDecayMs = options.peakDecayMs ?? 2500;
  }

  reset(): void {
    this.env = 0;
    this.peak = 0;
    this.step = 0;
    this.lastT = null;
    this.changedAt = -Infinity;
  }

  get shape(): MouthShape {
    return OPENNESS[this.step] ?? MOUTH.closed;
  }

  /** Feeds one loudness reading; returns the mouth shape to show. */
  update(level: number, nowMs: number): MouthShape {
    const dt = this.lastT === null ? 66 : Math.max(1, nowMs - this.lastT);
    this.lastT = nowMs;
    const tau = level > this.env ? this.attackMs : this.releaseMs;
    this.env += (level - this.env) * (1 - Math.exp(-dt / tau));
    // Slowly decaying peak so quiet and loud voices both use the full range.
    this.peak = Math.max(this.env, this.peak * Math.exp(-dt / this.peakDecayMs));
    const ref = Math.max(0.08, this.peak);

    let target: number;
    if (this.env < this.floor) target = 0;
    else {
      const norm = Math.min(1, (this.env - this.floor) / (ref - this.floor));
      target = STEP_LIMITS.findIndex((lim) => norm < lim);
      if (target < 0) target = OPENNESS.length - 1;
      if (target === 0) target = 1; // audible sound never shows a fully closed mouth
      if (Math.abs(target - this.step) === 1 && this.step > 0) {
        const edge = STEP_LIMITS[Math.min(target, this.step)] ?? 1;
        if (Math.abs(norm - edge) < this.hysteresis) target = this.step;
      }
    }

    if (target !== this.step && nowMs - this.changedAt >= this.minHoldMs) {
      this.step = target;
      this.changedAt = nowMs;
    }
    return this.shape;
  }
}

export interface VisemeKey {
  /** Milliseconds from the start of the utterance. */
  at: number;
  shape: MouthShape;
}

function letterShape(ch: string, index: number): MouthShape {
  const c = ch.toLowerCase();
  if (c === 'm' || c === 'b' || c === 'p') return MOUTH.closed;
  if (c === 'o' || c === 'u' || c === 'w') return MOUTH.narrow;
  if (c === 'a') return MOUTH.wide4;
  if (c === 'e' || c === 'i' || c === 'y') return MOUTH.wide2;
  if (/\p{L}|\p{N}/u.test(c)) return index % 2 === 0 ? MOUTH.medium : MOUTH.wide1;
  return MOUTH.closed;
}

/**
 * Mouth timeline from letters, spread evenly over durationMs. Consecutive equal
 * shapes are merged and no shape lasts less than minHoldMs (except the last).
 * Always ends with a closed mouth at durationMs.
 */
export function textVisemes(text: string, durationMs: number, minHoldMs = 60): VisemeKey[] {
  const chars = [...text];
  const out: VisemeKey[] = [];
  if (chars.length === 0 || durationMs <= 0) return [{ at: 0, shape: MOUTH.closed }];
  const per = durationMs / chars.length;
  for (let i = 0; i < chars.length; i++) {
    const shape = letterShape(chars[i]!, i);
    const at = Math.round(i * per);
    const prev = out[out.length - 1];
    if (prev && prev.shape === shape) continue;
    // Too short to see: the previous shape simply runs a little longer.
    if (prev && at - prev.at < minHoldMs) continue;
    out.push({ at, shape });
  }
  const last = out[out.length - 1];
  if (!last || last.shape !== MOUTH.closed) out.push({ at: Math.round(durationMs), shape: MOUTH.closed });
  return out;
}

/** The shape active at time t (ms) in a timeline from textVisemes. */
export function visemeAt(timeline: readonly VisemeKey[], t: number): MouthShape {
  let shape: MouthShape = MOUTH.closed;
  for (const k of timeline) {
    if (k.at > t) break;
    shape = k.shape;
  }
  return shape;
}
