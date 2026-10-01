// Plays synthesized speech through Web Audio with loudness-driven lip-sync.
// Graph: AudioBufferSourceNode -> GainNode (volume) -> destination, with an
// AnalyserNode tapped off the source so lip-sync does not depend on the volume.

import type { MouthShape } from '../../../shared/character-controller.ts';
import { LipSync, rms } from './lipsync.ts';

export type SpeakOutcome = 'ended' | 'stopped' | 'failed';

export interface PlayOptions {
  /**
   * AudioBufferSourceNode.playbackRate (1 = as recorded). The Windows voice uses it
   * to raise the pitch; main has already slowed SAPI down to keep the tempo.
   */
  playbackRate?: number;
}

/** What the last play() did, for the dev-only audio log. */
export interface PlayStats {
  outcome: SpeakOutcome;
  /** Length of the audio as heard (after playbackRate). */
  durationMs: number;
  /** Highest RMS the analyser saw (before the volume gain), 0 when nothing played. */
  peakRms: number;
}

export interface SpeakHooks {
  /** 0..1 of the utterance played so far. */
  onProgress(fraction: number): void;
  onMouth(shape: MouthShape): void;
}

const TICK_MS = 66; // ~15 Hz mouth updates

export class TtsPlayer {
  private readonly getContext: () => AudioContext;
  private current: { stop: () => void } | null = null;
  /** Stats of the most recent play() call. */
  lastStats: PlayStats | null = null;

  constructor(getContext: () => AudioContext) {
    this.getContext = getContext;
  }

  get playing(): boolean {
    return this.current !== null;
  }

  stop(): void {
    this.current?.stop();
  }

  async play(audio: ArrayBuffer, volume: number, hooks: SpeakHooks, options: PlayOptions = {}): Promise<SpeakOutcome> {
    this.stop();
    this.lastStats = null;
    const rate = Math.min(4, Math.max(0.25, Number.isFinite(options.playbackRate) ? (options.playbackRate as number) : 1));
    const ctx = this.getContext();
    try {
      if (ctx.state === 'suspended') await ctx.resume();
    } catch {
      // resume() can reject when the context is closing; decode will fail below.
    }

    let buffer: AudioBuffer;
    let stopped = false;
    const pendingStop = { stop: () => (stopped = true) };
    this.current = pendingStop;
    try {
      // decodeAudioData detaches its input, so hand it a copy.
      buffer = await ctx.decodeAudioData(audio.slice(0));
    } catch {
      if (this.current === pendingStop) this.current = null;
      const outcome: SpeakOutcome = stopped ? 'stopped' : 'failed';
      this.lastStats = { outcome, durationMs: 0, peakRms: 0 };
      return outcome;
    }
    if (stopped) {
      if (this.current === pendingStop) this.current = null;
      this.lastStats = { outcome: 'stopped', durationMs: 0, peakRms: 0 };
      return 'stopped';
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = Math.min(1, Math.max(0, volume));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    // Lip-sync tap before the volume gain: at volume 0 the mouth still moves.
    // Chromium pulls an AnalyserNode even when its output is not connected.
    source.connect(analyser);
    source.connect(gain);
    gain.connect(ctx.destination);

    const samples = new Float32Array(analyser.fftSize);
    const lip = new LipSync();
    const duration = Math.max(0.001, buffer.duration / rate);
    let peakRms = 0;

    return new Promise<SpeakOutcome>((resolve) => {
      let done = false;
      let lastShape: MouthShape | null = null;
      const startAt = ctx.currentTime + 0.02;

      const finish = (outcome: SpeakOutcome): void => {
        if (done) return;
        done = true;
        clearInterval(timer);
        source.onended = null;
        try {
          source.stop();
        } catch {
          // already stopped
        }
        source.disconnect();
        gain.disconnect();
        analyser.disconnect();
        if (this.current === handle) this.current = null;
        if (outcome === 'ended') hooks.onProgress(1);
        this.lastStats = { outcome, durationMs: Math.round(duration * 1000), peakRms };
        resolve(outcome);
      };

      const tick = (): void => {
        const t = ctx.currentTime - startAt;
        hooks.onProgress(Math.min(1, Math.max(0, t / duration)));
        analyser.getFloatTimeDomainData(samples);
        const raw = rms(samples);
        if (raw > peakRms) peakRms = raw;
        const shape = lip.update(raw, performance.now());
        if (shape !== lastShape) {
          lastShape = shape;
          hooks.onMouth(shape);
        }
      };

      const timer = setInterval(tick, TICK_MS);
      const handle = { stop: () => finish('stopped') };
      this.current = handle;
      source.onended = () => finish('ended');
      source.start(startAt);
      // Safety net in case onended never fires.
      setTimeout(() => finish('ended'), (duration + 2) * 1000);
    });
  }
}
