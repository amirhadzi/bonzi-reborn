import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MicRecorder, type RecordingResult } from '../src/renderer/agent/mic.ts';

// Fakes for getUserMedia, MediaRecorder and the level meter. The recorder
// produces data even for pure silence, like Chromium's does for a muted mic.

let level = 0;

class FakeRecorder {
  static isTypeSupported(): boolean {
    return true;
  }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array(4000)]) });
    setTimeout(() => this.onstop?.(), 0);
  }
}

function fakeContext(withAnalyser: boolean): AudioContext {
  const node = { connect: () => {}, disconnect: () => {} };
  return {
    state: 'running',
    resume: async () => {},
    createMediaStreamSource: () => node,
    createAnalyser: () => {
      if (!withAnalyser) throw new Error('no analyser');
      return {
        ...node,
        fftSize: 1024,
        getFloatTimeDomainData: (out: Float32Array) => {
          for (let i = 0; i < out.length; i++) out[i] = i % 2 ? level : -level;
        },
      };
    },
  } as unknown as AudioContext;
}

function settle(p: Promise<RecordingResult>): { result: RecordingResult | null } {
  const box: { result: RecordingResult | null } = { result: null };
  void p.then((r) => (box.result = r));
  return box;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  level = 0;
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MicRecorder', () => {
  it('gives up after 8 s without speech and uploads nothing', async () => {
    const mic = new MicRecorder(() => fakeContext(true));
    const box = settle(mic.record());
    await vi.advanceTimersByTimeAsync(7_500);
    expect(box.result).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(box.result).toEqual({ ok: false, reason: 'empty' });
    expect(mic.recording).toBe(false);
  });

  it('a manual stop before any speech returns empty, not audio', async () => {
    const mic = new MicRecorder(() => fakeContext(true));
    const box = settle(mic.record());
    await vi.advanceTimersByTimeAsync(2_000);
    mic.stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(box.result).toEqual({ ok: false, reason: 'empty' });
  });

  it('returns the audio once speech was heard, stopping after the silence that follows', async () => {
    const mic = new MicRecorder(() => fakeContext(true));
    const box = settle(mic.record());
    await vi.advanceTimersByTimeAsync(1_000);
    level = 0.2;
    await vi.advanceTimersByTimeAsync(1_000);
    level = 0;
    await vi.advanceTimersByTimeAsync(1_300);
    expect(box.result).toBeNull();
    await vi.advanceTimersByTimeAsync(400);
    expect(box.result?.ok).toBe(true);
  });

  it('keeps speaking past 8 s once speech started', async () => {
    const mic = new MicRecorder(() => fakeContext(true));
    const box = settle(mic.record());
    level = 0.2;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(box.result).toBeNull();
    mic.stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(box.result?.ok).toBe(true);
  });

  it('without a level meter it still uploads what was recorded', async () => {
    const mic = new MicRecorder(() => fakeContext(false));
    const box = settle(mic.record());
    await vi.advanceTimersByTimeAsync(9_000);
    expect(box.result).toBeNull();
    mic.stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(box.result?.ok).toBe(true);
  });
});
