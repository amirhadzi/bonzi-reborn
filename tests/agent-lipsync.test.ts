import { describe, expect, it } from 'vitest';
import { MOUTH } from '../src/shared/character-controller.ts';
import { LipSync, OPENNESS, rms, textVisemes, visemeAt } from '../src/renderer/agent/speech/lipsync.ts';

const openness = (shape: number): number => OPENNESS.indexOf(shape as (typeof OPENNESS)[number]);

describe('rms', () => {
  it('computes float and uint8 RMS', () => {
    expect(rms([])).toBe(0);
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5);
    expect(rms(new Uint8Array([128, 128]), true)).toBe(0);
    expect(rms(new Uint8Array([192, 64]), true)).toBeCloseTo(0.5);
  });
});

describe('LipSync', () => {
  it('stays closed in silence', () => {
    const ls = new LipSync();
    for (let t = 0; t < 1000; t += 66) expect(ls.update(0.002, t)).toBe(MOUTH.closed);
  });

  it('opens wider for louder audio', () => {
    const run = (levels: number[]): number => {
      const ls = new LipSync();
      let shape: number = MOUTH.closed;
      let t = 0;
      for (const l of levels) {
        shape = ls.update(l, t);
        t += 66;
      }
      return openness(shape);
    };
    // Establish a peak with loud speech, then measure soft vs loud.
    const loud = Array(20).fill(0.3);
    const soft = run([...loud, ...Array(4).fill(0.04)]);
    const louder = run([...loud, ...Array(4).fill(0.3)]);
    expect(soft).toBeGreaterThan(0);
    expect(soft).toBeLessThanOrEqual(openness(MOUTH.medium));
    expect(louder).toBe(openness(MOUTH.wide4));
  });

  it('closes again after speech ends', () => {
    const ls = new LipSync();
    let t = 0;
    for (let i = 0; i < 10; i++, t += 66) ls.update(0.25, t);
    let shape: number = MOUTH.wide4;
    for (let i = 0; i < 10; i++, t += 66) shape = ls.update(0, t);
    expect(shape).toBe(MOUTH.closed);
  });

  it('holds each shape for at least the minimum time', () => {
    const ls = new LipSync({ minHoldMs: 60 });
    let last: number = ls.update(0, 0);
    let lastChange = -Infinity;
    for (let t = 5; t < 3000; t += 5) {
      const level = (Math.sin(t / 7) + 1) * 0.2 * (t % 400 < 200 ? 1 : 0.1);
      const s = ls.update(level, t);
      if (s !== last) {
        expect(t - lastChange).toBeGreaterThanOrEqual(60);
        lastChange = t;
        last = s;
      }
    }
  });

  it('does not flicker around a threshold (hysteresis)', () => {
    const ls = new LipSync({ attackMs: 1, releaseMs: 1, minHoldMs: 0, peakDecayMs: 1e9 });
    let t = 0;
    for (let i = 0; i < 5; i++, t += 100) ls.update(0.3, t); // peak = 0.3
    // Normalised 0.45 boundary sits at about 0.1416; wobble just around it.
    ls.update(0.148, t);
    t += 100;
    const shapes = new Set<number>();
    for (let i = 0; i < 30; i++, t += 100) shapes.add(ls.update(i % 2 ? 0.135 : 0.148, t));
    expect(shapes.size).toBe(1);
    // A clear move still changes the shape.
    expect(ls.update(0.05, t)).not.toBe([...shapes][0]);
  });
});

describe('textVisemes', () => {
  it('maps letters to mouth shapes', () => {
    const tl = textVisemes('ma', 1000, 0);
    expect(tl).toEqual([
      { at: 0, shape: MOUTH.closed },
      { at: 500, shape: MOUTH.wide4 },
      { at: 1000, shape: MOUTH.closed },
    ]);
    expect(textVisemes('o', 100, 0)[0]!.shape).toBe(MOUTH.narrow);
    expect(textVisemes('e', 100, 0)[0]!.shape).toBe(MOUTH.wide2);
    expect(textVisemes('i', 100, 0)[0]!.shape).toBe(MOUTH.wide2);
    expect([MOUTH.medium, MOUTH.wide1]).toContain(textVisemes('t', 100, 0)[0]!.shape);
    expect(textVisemes(' ', 100, 0)[0]!.shape).toBe(MOUTH.closed);
  });

  it('is sorted, merges repeats, respects the minimum hold and ends closed', () => {
    const tl = textVisemes('Hello there, how are you doing today?', 2000, 60);
    for (let i = 1; i < tl.length; i++) {
      expect(tl[i]!.at).toBeGreaterThan(tl[i - 1]!.at);
      expect(tl[i]!.shape).not.toBe(tl[i - 1]!.shape);
      if (i < tl.length - 1) expect(tl[i]!.at - tl[i - 1]!.at).toBeGreaterThanOrEqual(60);
    }
    expect(tl[tl.length - 1]!.shape).toBe(MOUTH.closed);
    expect(tl[tl.length - 1]!.at).toBeLessThanOrEqual(2000);
    expect(textVisemes('Hello', 1000, 0).at(-1)).toEqual({ at: 1000, shape: MOUTH.closed });
    expect(tl.some((k) => k.shape !== MOUTH.closed)).toBe(true);
  });

  it('handles empty input', () => {
    expect(textVisemes('', 1000)).toEqual([{ at: 0, shape: MOUTH.closed }]);
  });

  it('visemeAt finds the active shape', () => {
    const tl = textVisemes('ma', 1000, 0);
    expect(visemeAt(tl, 0)).toBe(MOUTH.closed);
    expect(visemeAt(tl, 600)).toBe(MOUTH.wide4);
    expect(visemeAt(tl, 1200)).toBe(MOUTH.closed);
  });
});
