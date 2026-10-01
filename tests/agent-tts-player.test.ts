import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MouthShape } from '../src/shared/character-controller.ts';
import { TtsPlayer } from '../src/renderer/agent/speech/tts-player.ts';

// A tiny Web Audio graph: each node knows what feeds it, and the analyser
// "hears" a sine whose amplitude is the source amplitude times every gain on
// the path. That is enough to tell whether lip-sync depends on the volume.

const AMPLITUDE = 0.3;

class FakeNode {
  inputs: FakeNode[] = [];
  connect(dest: FakeNode | object): void {
    if (dest instanceof FakeNode) dest.inputs.push(this);
  }
  disconnect(): void {}
  /** Amplitude arriving at this node's output. */
  level(): number {
    return this.inputs.reduce((sum, n) => sum + n.level(), 0);
  }
}

class FakeSource extends FakeNode {
  buffer: { duration: number } | null = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  start(): void {}
  stop(): void {}
  override level(): number {
    return AMPLITUDE;
  }
}

class FakeGain extends FakeNode {
  gain = { value: 1 };
  override level(): number {
    return super.level() * this.gain.value;
  }
}

class FakeAnalyser extends FakeNode {
  fftSize = 1024;
  smoothingTimeConstant = 0.8;
  getFloatTimeDomainData(out: Float32Array): void {
    const a = this.level();
    for (let i = 0; i < out.length; i++) out[i] = a * Math.sin((2 * Math.PI * i) / 32);
  }
}

class FakeContext {
  state = 'running';
  destination = {};
  get currentTime(): number {
    return performance.now() / 1000;
  }
  async resume(): Promise<void> {}
  async decodeAudioData(): Promise<{ duration: number }> {
    return { duration: 1 };
  }
  createBufferSource(): FakeSource {
    return new FakeSource();
  }
  createGain(): FakeGain {
    return new FakeGain();
  }
  createAnalyser(): FakeAnalyser {
    return new FakeAnalyser();
  }
}

async function mouthShapesAt(volume: number): Promise<{ shapes: MouthShape[]; peak: number }> {
  const ctx = new FakeContext();
  const player = new TtsPlayer(() => ctx as unknown as AudioContext);
  const shapes: MouthShape[] = [];
  const done = player.play(new ArrayBuffer(8), volume, { onProgress: () => {}, onMouth: (s) => shapes.push(s) });
  await vi.advanceTimersByTimeAsync(600);
  player.stop();
  await done;
  return { shapes, peak: player.lastStats?.peakRms ?? 0 };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TtsPlayer lip-sync', () => {
  it('opens the mouth at normal volume', async () => {
    const { shapes, peak } = await mouthShapesAt(0.8);
    expect(shapes.some((s) => s !== 0)).toBe(true);
    expect(peak).toBeGreaterThan(0.15);
  });

  it('still moves the mouth at volume 0', async () => {
    const { shapes } = await mouthShapesAt(0);
    expect(shapes.some((s) => s !== 0)).toBe(true);
  });

  it('does not depend on the volume level', async () => {
    const loud = await mouthShapesAt(1);
    const quiet = await mouthShapesAt(0.02);
    expect(quiet.shapes).toEqual(loud.shapes);
    expect(quiet.peak).toBeCloseTo(loud.peak, 6);
  });
});
