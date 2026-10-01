import { describe, expect, it } from 'vitest';
import type { AcsCharacter } from '../src/shared/acs/index.ts';
import { SoundPlayer } from '../src/renderer/agent/character/audio.ts';

// A minimal stand-in for the Web Audio objects SoundPlayer touches.
class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  connect(): void {}
  disconnect(): void {}
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeContext {
  state = 'running';
  destination = {};
  sources: FakeSource[] = [];
  failDecode = false;
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  decodeAudioData(): Promise<unknown> {
    return this.failDecode ? Promise.reject(new Error('bad wav')) : Promise.resolve({});
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const character = { audio: [{ data: new Uint8Array(8), checksum: 0 }] } as unknown as AcsCharacter;

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function track(p: Promise<void>): { done: boolean } {
  const box = { done: false };
  void p.then(() => {
    box.done = true;
  });
  return box;
}

function player(ctx: FakeContext, enabled = true): SoundPlayer {
  return new SoundPlayer(character, { audioContext: ctx as unknown as AudioContext, enabled });
}

describe('engine sound player', () => {
  it('play() settles when the sound ends', async () => {
    const ctx = new FakeContext();
    const p = track(player(ctx).play(0));
    await flush();
    expect(ctx.sources.length).toBe(1);
    expect(ctx.sources[0]!.started).toBe(true);
    expect(p.done).toBe(false);
    ctx.sources[0]!.onended?.();
    await flush();
    expect(p.done).toBe(true);
  });

  it('stopAll settles pending sounds even if ended never fires', async () => {
    const ctx = new FakeContext();
    const sp = player(ctx);
    const a = track(sp.play(0));
    const b = track(sp.play(0));
    await flush();
    expect(ctx.sources.length).toBe(2);
    sp.stopAll();
    await flush();
    expect(a.done && b.done).toBe(true);
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
  });

  it('dispose settles pending sounds', async () => {
    const ctx = new FakeContext();
    const sp = player(ctx);
    const a = track(sp.play(0));
    await flush();
    sp.dispose();
    await flush();
    expect(a.done).toBe(true);
  });

  it('settles at once when nothing is played', async () => {
    const ctx = new FakeContext();
    const off = track(player(ctx, false).play(0));
    const missing = track(player(ctx).play(5));
    const muted = player(ctx);
    muted.setVolume(0);
    const silent = track(muted.play(0));
    const bad = new FakeContext();
    bad.failDecode = true;
    const undecodable = track(player(bad).play(0));
    await flush();
    expect([off.done, missing.done, silent.done, undecodable.done]).toEqual([true, true, true, true]);
    expect(ctx.sources.length).toBe(0);
  });
});
