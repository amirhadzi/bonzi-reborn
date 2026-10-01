import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { exitPath, getAnimation, parseAcs, pickNextFrame, type AcsCharacter } from '../src/shared/acs/index.ts';
import { ManualClock } from '../src/renderer/agent/character/manual-clock.ts';
import {
  AnimationScheduler,
  type EngineTiming,
  type SchedulerEvent,
} from '../src/renderer/agent/character/scheduler.ts';

const ACS_PATH = fileURLToPath(new URL('../assets/characters/Bonzi.acs', import.meta.url));
let ch: AcsCharacter;
beforeAll(() => {
  ch = parseAcs(readFileSync(ACS_PATH));
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Shown {
  anim: string;
  frame: number;
  mouth: number | null;
}

function setup(
  opts: {
    idle?: boolean;
    timing?: Partial<EngineTiming>;
    seed?: number;
    random?: () => number;
    onSound?: (index: number, clock: ManualClock) => unknown;
  } = {},
) {
  const clock = new ManualClock();
  const events: SchedulerEvent[] = [];
  const frames: Array<Shown | null> = [];
  const sounds: Array<{ index: number; at: number }> = [];
  const s = new AnimationScheduler({
    character: ch,
    clock,
    random: opts.random ?? mulberry32(opts.seed ?? 1),
    idleEnabled: opts.idle ?? false,
    timing: opts.timing,
    onDisplay: (d) => frames.push(d ? { anim: d.animation.name, frame: d.frame, mouth: d.mouth } : null),
    onSound: (index) => {
      sounds.push({ index, at: clock.now() });
      return opts.onSound?.(index, clock);
    },
    onEvent: (e) => events.push(e),
  });
  const anims = () =>
    events.flatMap((e) => (e.type === 'animation' ? [`${e.name}${e.mode === 'exit' ? ':exit' : ''}`] : []));
  const last = () => frames[frames.length - 1] ?? null;
  return { s, clock, events, frames, sounds, anims, last, advance: (ms: number) => clock.advance(ms) };
}

function track<T>(p: Promise<T>): { value: T | undefined; done: boolean } {
  const box: { value: T | undefined; done: boolean } = { value: undefined, done: false };
  void p.then((v) => {
    box.value = v;
    box.done = true;
  });
  return box;
}

describe('engine scheduler: lookup', () => {
  it('resolves unknown names to missing without queueing', async () => {
    const t = setup();
    expect(await t.s.play('NoSuchAnimation')).toBe('missing');
    expect(await t.s.playNow('')).toBe('missing');
    expect(t.anims()).toEqual([]);
  });

  it('accepts mixed-case names', async () => {
    const t = setup();
    const a = track(t.s.play('wAvE'));
    const b = track(t.s.play('Idle1_4 (2)'));
    await t.advance(30_000);
    expect(a.value).toBe('completed');
    expect(b.value).toBe('completed');
    expect(t.anims()).toContain('WAVE');
    expect(t.anims()).toContain('IDLE1_4 (2)');
  });

  it('flags rest-pose placeholders and never treats real animations as placeholders', () => {
    const t = setup();
    for (const n of ['THINKING', 'PROCESSING', 'HEARING1', 'SUGGEST', 'LOOKUPLEFT', 'DOMAGIC1']) {
      expect(t.s.isPlaceholder(getAnimation(ch, n)!), n).toBe(true);
    }
    for (const n of ['RESTPOSE', 'THINK', 'WAVE', 'LOOKLEFT', 'ALERT', 'BLINK']) {
      expect(t.s.isPlaceholder(getAnimation(ch, n)!), n).toBe(false);
    }
  });
});

describe('engine scheduler: frame playback', () => {
  it('shows each frame for duration * 10 ms and fires sounds on frame entry', async () => {
    const t = setup();
    void t.s.play('Show');
    await t.advance(0);
    expect(t.last()).toEqual({ anim: 'SHOW', frame: 0, mouth: null });
    await t.advance(99);
    expect(t.last()?.frame).toBe(0);
    await t.advance(1);
    expect(t.last()?.frame).toBe(1);
    await t.advance(1800); // frame 19 starts at 1900 ms and carries sound 18
    expect(t.last()?.frame).toBe(19);
    expect(t.sounds).toEqual([{ index: 18, at: 1900 }]);
  });

  it('holds the last visible frame after a natural end (end markers are not drawn)', async () => {
    const t = setup();
    const p = track(t.s.play('Explain'));
    await t.advance(700);
    expect(p.value).toBe('completed');
    expect(t.last()).toEqual({ anim: 'EXPLAIN', frame: 6, mouth: null });
    const n = t.frames.length;
    await t.advance(20_000);
    expect(t.frames.length).toBe(n);
    expect(t.s.debugState().held).toBe('EXPLAIN');
    expect(t.frames.every((f) => f && f.frame !== 7)).toBe(true);
  });

  it('corrects timer drift instead of accumulating lateness', async () => {
    const t = setup();
    t.clock.lateness = 30;
    const p = track(t.s.play('Show')); // 27 frames x 100 ms
    await t.advance(2_640);
    expect(p.done).toBe(false);
    await t.advance(150);
    expect(p.value).toBe('completed');
  });

  it('branches with the documented probabilities', () => {
    const anim = getAnimation(ch, 'SEARCHING')!;
    const rnd = mulberry32(42);
    let to9 = 0;
    let to31 = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const next = pickNextFrame(anim, 8, rnd);
      if (next === 9) to9++;
      else if (next === 31) to31++;
    }
    expect(to9 + to31).toBe(n);
    expect(to9 / n).toBeGreaterThan(0.88);
    expect(to9 / n).toBeLessThan(0.92);
  });

  it('follows branches during scheduled playback (LOOKLEFT picks 6/7/8 about equally)', async () => {
    const t = setup({ seed: 7 });
    void t.s.play('LookLeft');
    await t.advance(1_200_000);
    const seq = t.frames.filter((f): f is Shown => !!f && f.anim === 'LOOKLEFT').map((f) => f.frame);
    const counts = { 6: 0, 7: 0, 8: 0 };
    for (let i = 0; i + 1 < seq.length; i++) {
      if (seq[i] !== 5) continue;
      const nx = seq[i + 1] as 6 | 7 | 8;
      expect([6, 7, 8]).toContain(nx);
      counts[nx]++;
    }
    const total = counts[6] + counts[7] + counts[8];
    expect(total).toBeGreaterThan(150);
    for (const k of [6, 7, 8] as const) {
      expect(counts[k] / total).toBeGreaterThan(0.22);
      expect(counts[k] / total).toBeLessThan(0.45);
    }
  });
});

describe('engine scheduler: wind-back', () => {
  it('rewinds an exit-branch animation (DECLINE) before the next request', async () => {
    const t = setup();
    const a = track(t.s.play('Decline'));
    await t.advance(3_000);
    expect(a.value).toBe('completed');
    expect(t.last()).toEqual({ anim: 'DECLINE', frame: 18, mouth: null });
    const before = t.frames.length;
    const b = track(t.s.play('Acknowledge'));
    await t.advance(5_000);
    expect(b.value).toBe('completed');
    expect(t.anims()).toEqual(['DECLINE', 'DECLINE:exit', 'ACKNOWLEDGE']);
    const decline = getAnimation(ch, 'DECLINE')!;
    const expected = exitPath(decline, 18).filter((i) => (decline.frames[i]?.images.length ?? 0) > 0);
    const rewound = t.frames
      .slice(before)
      .filter((f): f is Shown => !!f && f.anim === 'DECLINE')
      .map((f) => f.frame);
    expect(rewound).toEqual(expected);
    expect(expected).toEqual([5, 4, 3, 2, 1, 0]);
  });

  it('plays the return animation of a transition type 0 animation (READING -> READRETURN)', async () => {
    const t = setup();
    const a = track(t.s.play('Reading'));
    await t.advance(30_000);
    expect(a.done).toBe(false); // endless: keeps reading
    expect(t.last()?.anim).toBe('READING');
    const b = track(t.s.play('Wave'));
    await t.advance(200);
    expect(a.value).toBe('completed'); // resolves when it starts exiting
    await t.advance(10_000);
    expect(b.value).toBe('completed');
    expect(t.anims()).toEqual(['READING', 'READRETURN', 'WAVE']);
  });

  it('exits an endless animation gracefully when the next request arrives', async () => {
    const t = setup();
    const a = track(t.s.play('LookLeft'));
    await t.advance(20_000);
    expect(a.done).toBe(false);
    const b = track(t.s.play('Acknowledge'));
    await t.advance(160);
    expect(a.value).toBe('completed');
    expect(t.last()?.anim).toBe('LOOKLEFTRETURN');
    await t.advance(5_000);
    expect(b.value).toBe('completed');
    expect(t.anims()).toEqual(['LOOKLEFT', 'LOOKLEFTRETURN', 'ACKNOWLEDGE']);
  });

  it('queues natural animations and plays them in order', async () => {
    const t = setup();
    const a = track(t.s.play('Greet'));
    const b = track(t.s.play('Wave'));
    await t.advance(500);
    expect(t.last()?.anim).toBe('GREET');
    expect(b.done).toBe(false);
    await t.advance(10_000);
    expect(a.value).toBe('completed');
    expect(b.value).toBe('completed');
    expect(t.anims()).toEqual(['GREET', 'GREET:exit', 'WAVE']);
  });
});

describe('engine scheduler: interruption', () => {
  it('playNow clears the queue and exits the current animation gracefully', async () => {
    const t = setup();
    const banana = track(t.s.play('Banana'));
    const wave = track(t.s.play('Wave'));
    await t.advance(1_000);
    const greet = track(t.s.playNow('Greet'));
    await t.advance(10);
    expect(wave.value).toBe('interrupted');
    await t.advance(200);
    expect(banana.value).toBe('interrupted');
    await t.advance(10_000);
    expect(greet.value).toBe('completed');
    expect(t.anims()).toEqual(['BANANA', 'BANANA:exit', 'GREET']);
  });

  it('stopAll interrupts immediately and draws the rest pose', async () => {
    const t = setup();
    const wave = track(t.s.play('Wave'));
    const greet = track(t.s.play('Greet'));
    await t.advance(1_000);
    t.s.stopAll();
    await t.advance(0);
    expect(wave.value).toBe('interrupted');
    expect(greet.value).toBe('interrupted');
    expect(t.last()).toEqual({ anim: 'RESTPOSE', frame: 0, mouth: null });
    const n = t.frames.length;
    await t.advance(10_000);
    expect(t.frames.length).toBe(n);
    expect(t.s.debugState().job).toBe(null);
  });
});

describe('engine scheduler: show and hide', () => {
  it('starts blank, shows with SHOW, hides with HIDE and ends blank', async () => {
    const t = setup();
    expect(t.s.getDisplay()).toBe(null);
    const shown = track(t.s.show());
    await t.advance(3_000);
    expect(shown.done).toBe(true);
    expect(t.last()).toEqual({ anim: 'SHOW', frame: 26, mouth: null });
    const wave = track(t.s.play('Wave'));
    const hidden = track(t.s.hide());
    await t.advance(10);
    expect(wave.value).toBe('interrupted');
    await t.advance(3_000);
    expect(hidden.done).toBe(true);
    expect(t.last()).toBe(null);
    expect(t.s.isHidden()).toBe(true);
    expect(t.anims()).toEqual(['SHOW', 'HIDE']);
    // show again starts from blank
    void t.s.show();
    await t.advance(0);
    expect(t.last()).toEqual({ anim: 'SHOW', frame: 0, mouth: null });
  });
});

describe('engine scheduler: work queued behind a starting job', () => {
  // random 0.1 always takes the loop branch, so SEARCH / READING never end on their own.
  const loopForever = () => 0.1;

  for (const gesture of ['SEARCH', 'READING']) {
    it(`a looping ${gesture} started with speech queued behind it yields at once`, async () => {
      const t = setup({ idle: true, random: loopForever });
      void t.s.show();
      await t.advance(3_000);
      expect(t.s.debugState().job).toBe('idle');
      const play = track(t.s.play(gesture));
      const speak = track(t.s.beginSpeaking());
      const start = t.clock.now();
      let waited = 0;
      while (!speak.done && waited < 30_000) {
        await t.advance(50);
        waited += 50;
      }
      expect(speak.done, `${gesture}: speech still waiting after ${waited} ms`).toBe(true);
      expect(t.clock.now() - start).toBeLessThan(2_000);
      expect(play.value).toBe('completed');
      expect(t.anims()).toContain(gesture);
    });
  }

  it('SEARCH and beginSpeaking right after the thinking activity is stopped', async () => {
    const t = setup({ idle: true, random: loopForever });
    void t.s.show();
    await t.advance(3_000);
    t.s.startActivity('thinking');
    await t.advance(4_000);
    void t.s.stopActivity();
    const play = track(t.s.play('SEARCH'));
    const speak = track(t.s.beginSpeaking());
    const start = t.clock.now();
    while (!speak.done && t.clock.now() - start < 30_000) await t.advance(50);
    expect(t.clock.now() - start).toBeLessThan(2_000);
    expect(play.value).toBe('completed');
  });

  it('still lets a lone endless gesture keep looping', async () => {
    const t = setup({ idle: true, random: loopForever });
    void t.s.show();
    await t.advance(3_000);
    const play = track(t.s.play('SEARCH'));
    await t.advance(20_000);
    expect(play.done).toBe(false);
    expect(t.last()?.anim).toBe('SEARCH');
  });
});

/** Duration in ms of a RIFF/WAVE clip (data chunk size / byte rate). */
function wavMs(b: Uint8Array): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= b.length) {
    const id = String.fromCharCode(...b.subarray(off, off + 4));
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') byteRate = dv.getUint32(off + 16, true);
    if (id === 'data') return Math.round((size / byteRate) * 1000);
    off += 8 + size + (size & 1);
  }
  return 0;
}

describe('engine scheduler: sound effects', () => {
  /** onSound that settles when the clip would have finished playing. */
  const realLength = (index: number, clock: ManualClock) =>
    new Promise<void>((resolve) => clock.setTimeout(resolve, wavMs(ch.audio[index]!.data)));

  it('play() completes only after the sound it started has ended (CONFUSED)', async () => {
    const confused = getAnimation(ch, 'CONFUSED')!;
    const animMs = confused.frames.reduce((sum, f) => sum + f.duration * 10, 0);
    const t = setup({ onSound: realLength });
    const play = track(t.s.play('Confused'));
    const speak = track(t.s.beginSpeaking());
    await t.advance(animMs + 50);
    expect(t.sounds.length).toBe(1);
    const soundEnd = t.sounds[0]!.at + wavMs(ch.audio[t.sounds[0]!.index]!.data);
    expect(soundEnd).toBeGreaterThan(animMs + 500); // the effect outlasts the animation
    expect(play.done).toBe(false);
    expect(speak.done).toBe(false);
    await t.advance(soundEnd - t.clock.now() - 10);
    expect(speak.done).toBe(false);
    await t.advance(20);
    expect(play.value).toBe('completed');
    expect(speak.done).toBe(true);
    expect(t.last()?.anim).toBe('CONFUSED');
  });

  it('playNow during the sound tail starts promptly', async () => {
    const t = setup({ onSound: realLength });
    const play = track(t.s.play('Confused'));
    await t.advance(1_900); // animation over, sound still playing
    expect(play.done).toBe(false);
    const wave = track(t.s.playNow('Wave'));
    await t.advance(10);
    expect(play.value).toBe('completed');
    await t.advance(10_000);
    expect(wave.value).toBe('completed');
    const i = t.anims().indexOf('WAVE');
    expect(i).toBeGreaterThan(0);
  });

  it('caps the wait for a sound that never ends', async () => {
    const confused = getAnimation(ch, 'CONFUSED')!;
    const animMs = confused.frames.reduce((sum, f) => sum + f.duration * 10, 0);
    const t = setup({ onSound: () => new Promise<void>(() => {}), timing: { soundTailMaxMs: 3_000 } });
    const play = track(t.s.play('Confused'));
    await t.advance(animMs + 3_000 - 20);
    expect(play.done).toBe(false);
    await t.advance(40);
    expect(play.value).toBe('completed');
  });

  it('stopAll during the sound tail interrupts the play', async () => {
    const t = setup({ onSound: () => new Promise<void>(() => {}) });
    const play = track(t.s.play('Confused'));
    await t.advance(2_000);
    t.s.stopAll();
    await t.advance(0);
    expect(play.value).toBe('interrupted');
  });

  it('does not wait when onSound returns nothing', async () => {
    const t = setup();
    const p = track(t.s.play('Confused'));
    const confused = getAnimation(ch, 'CONFUSED')!;
    await t.advance(confused.frames.reduce((sum, f) => sum + f.duration * 10, 0) + 10);
    expect(p.value).toBe('completed');
  });
});
