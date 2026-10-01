// Sound effects from the ACS audio list, decoded lazily with Web Audio and
// played through a GainNode. Never throws: audio problems are swallowed.

import type { AcsCharacter } from '../../../shared/acs/types.ts';

export interface SoundOptions {
  audioContext?: AudioContext;
  enabled?: boolean;
  volume?: number;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

export class SoundPlayer {
  private readonly ch: AcsCharacter;
  private ctx: AudioContext | null;
  private readonly ownsContext: boolean;
  private gain: GainNode | null = null;
  private enabled: boolean;
  private volume: number;
  private readonly buffers = new Map<number, Promise<AudioBuffer | null>>();
  /** Playing sources, each with the callback that settles its play() promise. */
  private readonly active = new Map<AudioBufferSourceNode, () => void>();
  private disposed = false;
  private contextFailed = false;

  constructor(ch: AcsCharacter, options: SoundOptions = {}) {
    this.ch = ch;
    this.ctx = options.audioContext ?? null;
    this.ownsContext = !options.audioContext;
    this.enabled = options.enabled ?? true;
    this.volume = clamp01(options.volume ?? 1);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stopAll();
  }

  setVolume(volume: number): void {
    this.volume = clamp01(volume);
    if (this.gain) {
      try {
        this.gain.gain.value = this.volume;
      } catch {
        // ignore
      }
    }
  }

  /**
   * Starts sound `index`. The promise settles when the sound has ended (or was
   * stopped), and at once when nothing is played. It never rejects.
   */
  play(index: number): Promise<void> {
    if (this.disposed || !this.enabled || this.volume <= 0) return Promise.resolve();
    if (!this.ch.audio[index]) return Promise.resolve();
    try {
      const ctx = this.context();
      if (!ctx) return Promise.resolve();
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      return this.buffer(ctx, index)
        .then(
          (buf) =>
            new Promise<void>((resolve) => {
              if (!buf || this.disposed || !this.enabled || !this.gain) return resolve();
              const src = ctx.createBufferSource();
              src.buffer = buf;
              src.connect(this.gain);
              const done = (): void => {
                this.active.delete(src);
                try {
                  src.disconnect();
                } catch {
                  // ignore
                }
                resolve();
              };
              src.onended = done;
              this.active.set(src, done);
              try {
                src.start();
              } catch {
                done();
              }
            }),
        )
        .catch(() => {});
    } catch {
      // never throw from audio
      return Promise.resolve();
    }
  }

  stopAll(): void {
    const list = [...this.active];
    this.active.clear();
    for (const [src, done] of list) {
      try {
        src.stop();
      } catch {
        // ignore
      }
      // Settle waiters even if 'ended' never fires (e.g. a closed context).
      done();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopAll();
    this.disposed = true;
    try {
      this.gain?.disconnect();
    } catch {
      // ignore
    }
    this.gain = null;
    this.buffers.clear();
    if (this.ownsContext && this.ctx) void this.ctx.close().catch(() => {});
    this.ctx = null;
  }

  private context(): AudioContext | null {
    if (this.contextFailed) return null;
    try {
      if (!this.ctx) this.ctx = new AudioContext();
      if (!this.gain) {
        this.gain = this.ctx.createGain();
        this.gain.gain.value = this.volume;
        this.gain.connect(this.ctx.destination);
      }
      return this.ctx;
    } catch {
      this.contextFailed = true;
      return null;
    }
  }

  private buffer(ctx: AudioContext, index: number): Promise<AudioBuffer | null> {
    let p = this.buffers.get(index);
    if (!p) {
      const clip = this.ch.audio[index];
      if (!clip) return Promise.resolve(null);
      // decodeAudioData detaches its input, so hand it a copy.
      const copy = clip.data.slice().buffer;
      p = ctx.decodeAudioData(copy).catch(() => null);
      this.buffers.set(index, p);
    }
    return p;
  }
}
