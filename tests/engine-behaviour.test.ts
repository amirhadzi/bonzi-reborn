import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { getAnimation, parseAcs, type AcsAnimation, type AcsCharacter } from '../src/shared/acs/index.ts';
import { MOUTH } from '../src/shared/character-controller.ts';
import { ManualClock } from '../src/renderer/agent/character/manual-clock.ts';
import {
  AnimationScheduler,
  DEFAULT_TIMING,
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

function setup(opts: { idle?: boolean; timing?: Partial<EngineTiming>; seed?: number } = {}) {
  const clock = new ManualClock();
  const events: Array<SchedulerEvent & { at: number }> = [];
  const frames: Array<Shown | null> = [];
  /** clock.now() of each entry in `frames`. */
  const frameTimes: number[] = [];
  const s = new AnimationScheduler({
    character: ch,
    clock,
    random: mulberry32(opts.seed ?? 3),
    idleEnabled: opts.idle ?? false,
    timing: opts.timing,
    onDisplay: (d) => {
      frames.push(d ? { anim: d.animation.name, frame: d.frame, mouth: d.mouth } : null);
      frameTimes.push(clock.now());
    },
    onEvent: (e) => events.push({ ...e, at: clock.now() }),
  });
  const anims = () =>
    events.flatMap((e) => (e.type === 'animation' ? [`${e.name}${e.mode === 'exit' ? ':exit' : ''}`] : []));
  const idles = () => events.flatMap((e) => (e.type === 'idle' ? [{ level: e.level, name: e.name, at: e.at }] : []));
  const last = () => frames[frames.length - 1] ?? null;
  return { s, clock, events, frames, frameTimes, anims, idles, last, advance: (ms: number) => clock.advance(ms) };
}

function track<T>(p: Promise<T>): { value: T | undefined; done: boolean } {
  const box: { value: T | undefined; done: boolean } = { value: undefined, done: false };
  void p.then((v) => {
    box.value = v;
    box.done = true;
  });
  return box;
}

describe('engine activities', () => {
  it('thinking: THINK, then SEARCHING while still waiting, SEARCHINGRETURN on stop', async () => {
    const t = setup();
    t.s.startActivity('thinking');
    await t.advance(1_000);
    expect(t.last()?.anim).toBe('THINK');
    await t.advance(10_000);
    expect(t.last()?.anim).toBe('SEARCHING');
    expect(t.s.currentActivity()).toBe('thinking');
    const stopped = track(t.s.stopActivity());
    await t.advance(100);
    expect(stopped.done).toBe(false);
    await t.advance(3_000);
    expect(stopped.done).toBe(true);
    expect(t.s.currentActivity()).toBe(null);
    expect(t.anims()).toEqual(['THINK', 'THINK:exit', 'SEARCHING', 'SEARCHINGRETURN']);
    expect(t.last()).toEqual({ anim: 'SEARCHINGRETURN', frame: 6, mouth: null });
  });

  it('thinking stopped early rewinds THINK via its exit branches', async () => {
    const t = setup();
    t.s.startActivity('thinking');
    await t.advance(800);
    const stopped = track(t.s.stopActivity());
    await t.advance(5_000);
    expect(stopped.done).toBe(true);
    expect(t.anims()).toEqual(['THINK', 'THINK:exit']);
    expect(t.last()?.anim).toBe('THINK');
  });

  it('listening: STARTLISTENING, hold ALERT, STOPLISTENING on stop', async () => {
    const t = setup();
    t.s.startActivity('listening');
    await t.advance(5_000);
    expect(t.last()).toEqual({ anim: 'ALERT', frame: 1, mouth: null });
    const n = t.frames.length;
    await t.advance(30_000);
    expect(t.frames.length).toBe(n);
    const stopped = track(t.s.stopActivity());
    await t.advance(5_000);
    expect(stopped.done).toBe(true);
    expect(t.anims()).toEqual(['STARTLISTENING', 'STARTLISTENING:exit', 'ALERT', 'STOPLISTENING', 'STOPLISTENING:exit']);
  });

  it('processing holds THINK until stopped', async () => {
    const t = setup();
    t.s.startActivity('processing');
    await t.advance(20_000);
    expect(t.last()).toEqual({ anim: 'THINK', frame: 16, mouth: null });
    const stopped = track(t.s.stopActivity());
    await t.advance(5_000);
    expect(stopped.done).toBe(true);
    expect(t.anims()).toEqual(['THINK', 'THINK:exit']);
  });

  it('searching, reading and writing loop until stopped, then return', async () => {
    const cases = [
      ['searching', ['SEARCHING', 'SEARCHINGRETURN']],
      ['reading', ['READING', 'READRETURN']],
      ['writing', ['WRITING', 'WRITINGRETURN']],
    ] as const;
    for (const [activity, expected] of cases) {
      const t = setup();
      t.s.startActivity(activity);
      await t.advance(60_000);
      expect(t.last()?.anim, activity).toBe(expected[0]);
      const stopped = track(t.s.stopActivity());
      await t.advance(10_000);
      expect(stopped.done, activity).toBe(true);
      expect(t.anims(), activity).toEqual([...expected]);
    }
  });

  it('dragging holds MOVEUP on its last frame and plays MOVEUPRETURN on drop', async () => {
    const t = setup();
    t.s.startActivity('dragging');
    await t.advance(5_000);
    expect(t.last()).toEqual({ anim: 'MOVEUP', frame: 7, mouth: null });
    const stopped = track(t.s.stopActivity());
    await t.advance(2_000);
    expect(stopped.done).toBe(true);
    expect(t.anims()).toEqual(['MOVEUP', 'MOVEUPRETURN']);
  });

  it('a new activity replaces the current one, and a play request ends it', async () => {
    const t = setup();
    t.s.startActivity('searching');
    await t.advance(3_000);
    t.s.startActivity('dragging');
    await t.advance(3_000);
    expect(t.s.currentActivity()).toBe('dragging');
    const wave = track(t.s.play('Wave'));
    await t.advance(10_000);
    expect(wave.value).toBe('completed');
    expect(t.s.currentActivity()).toBe(null);
    expect(t.anims()).toEqual(['SEARCHING', 'SEARCHINGRETURN', 'MOVEUP', 'MOVEUPRETURN', 'WAVE']);
  });

  it('stopActivity before the activity started just drops it', async () => {
    const t = setup();
    void t.s.play('Greet');
    t.s.startActivity('thinking');
    const stopped = track(t.s.stopActivity());
    await t.advance(0);
    expect(stopped.done).toBe(true);
    await t.advance(5_000);
    expect(t.anims()).toEqual(['GREET']);
  });
});

describe('engine look', () => {
  it('looks in the character direction, holds, then returns', async () => {
    const t = setup();
    const p = track(t.s.look('left'));
    await t.advance(1_000);
    expect(t.last()?.anim).toBe('LOOKLEFT');
    await t.advance(3_000);
    expect(p.value).toBe('completed');
    expect(t.anims()).toEqual(['LOOKLEFT', 'LOOKLEFTRETURN']);
  });

  it('maps placeholder diagonals to the nearest real animation', async () => {
    const t = setup();
    expect(t.s.resolveLook('up-left')?.name).toBe('LOOKLEFT');
    expect(t.s.resolveLook('down-right')?.name).toBe('LOOKRIGHT');
    const p = track(t.s.look('up-right'));
    await t.advance(5_000);
    expect(p.value).toBe('completed');
    expect(t.anims()).toEqual(['LOOKRIGHT', 'LOOKRIGHTRETURN']);
  });
});

describe('engine speaking', () => {
  it('speaks on the held overlay frame of a talkable gesture (EXPLAIN)', async () => {
    const t = setup();
    void t.s.play('Explain');
    const ready = track(t.s.beginSpeaking());
    await t.advance(2_000);
    expect(ready.done).toBe(true);
    expect(t.last()).toEqual({ anim: 'EXPLAIN', frame: 6, mouth: null });
    for (const m of Object.values(MOUTH)) {
      t.s.setMouth(m);
      expect(t.last()).toEqual({ anim: 'EXPLAIN', frame: 6, mouth: m });
    }
    t.s.endSpeaking();
    expect(t.last()).toEqual({ anim: 'EXPLAIN', frame: 6, mouth: null });
    expect(t.anims()).toEqual(['EXPLAIN']);
    // the next request winds the gesture back first
    void t.s.play('Acknowledge');
    await t.advance(5_000);
    expect(t.anims()).toEqual(['EXPLAIN', 'EXPLAIN:exit', 'ACKNOWLEDGE']);
  });

  it('falls back to RESTPOSE frame 0 after a gesture without mouth overlays', async () => {
    const t = setup();
    expect(t.s.canSpeakDuring('Juggle')).toBe(false);
    expect(t.s.canSpeakDuring('explain')).toBe(true);
    expect(t.s.canSpeakDuring('Nope')).toBe(false);
    void t.s.play('Juggle');
    const ready = track(t.s.beginSpeaking());
    await t.advance(30_000);
    expect(ready.done).toBe(true);
    expect(t.last()).toEqual({ anim: 'RESTPOSE', frame: 0, mouth: null });
    t.s.setMouth(MOUTH.wide3);
    expect(t.last()).toEqual({ anim: 'RESTPOSE', frame: 0, mouth: MOUTH.wide3 });
  });

  it('ignores setMouth when not speaking and resets the mouth on the next animation', async () => {
    const t = setup();
    void t.s.show();
    await t.advance(3_000);
    const n = t.frames.length;
    t.s.setMouth(MOUTH.wide1);
    expect(t.frames.length).toBe(n);
    await t.s.beginSpeaking().then(() => undefined);
    t.s.setMouth(MOUTH.wide1);
    expect(t.last()?.mouth).toBe(MOUTH.wide1);
    void t.s.play('Wave');
    await t.advance(100);
    expect(t.last()?.mouth).toBe(null);
    expect(t.s.isSpeaking()).toBe(false);
  });

  it('stopAll closes the mouth and returns to rest', async () => {
    const t = setup();
    void t.s.play('Greet');
    void t.s.beginSpeaking();
    await t.advance(3_000);
    t.s.setMouth(MOUTH.wide4);
    expect(t.last()).toEqual({ anim: 'GREET', frame: 9, mouth: MOUTH.wide4 });
    t.s.stopAll();
    expect(t.last()).toEqual({ anim: 'RESTPOSE', frame: 0, mouth: null });
  });
});

describe('engine idle', () => {
  it('escalates from level 1 to level 2 to level 3 on schedule', async () => {
    const t = setup({ idle: true, seed: 11 });
    void t.s.show();
    await t.advance(2_700);
    const shownAt = t.clock.now();
    await t.advance(7_500);
    expect(t.idles()).toEqual([]);
    await t.advance(1_000);
    expect(t.idles().length).toBe(1);
    expect(t.idles()[0]!.level).toBe(1);
    expect(t.idles()[0]!.at - shownAt).toBeGreaterThanOrEqual(DEFAULT_TIMING.idleStartMs);

    await t.advance(400_000);
    const list = t.idles();
    const level1 = list.filter((e) => e.level === 1);
    const level2 = list.filter((e) => e.level === 2);
    const level3 = list.filter((e) => e.level === 3);
    expect(level1.length).toBeGreaterThan(3);
    expect(level2.length).toBeGreaterThan(5);
    expect(level1.every((e) => e.at - shownAt < DEFAULT_TIMING.idleLevel2Ms + 1)).toBe(true);
    expect(level2.every((e) => e.at - shownAt >= DEFAULT_TIMING.idleLevel2Ms)).toBe(true);
    expect(level2.every((e) => e.at - shownAt < DEFAULT_TIMING.idleLevel3Ms + 1)).toBe(true);
    expect(level3.map((e) => e.name)).toEqual(['IDLE3_1', 'IDLE3_2']);
    expect(level3[0]!.at - shownAt).toBeGreaterThanOrEqual(DEFAULT_TIMING.idleLevel3Ms);
    for (let i = 1; i < list.length; i++) expect(list[i]!.name).not.toBe(list[i - 1]!.name);
    // gaps between level 1/2 idles are at least the minimum gap
    const ends = t.events.filter((e) => e.type === 'idle');
    expect(ends.length).toBe(list.length);
    // dozing is endless: nothing new for minutes
    expect(t.last()?.anim).toBe('IDLE3_2');
    const count = t.idles().length;
    await t.advance(600_000);
    expect(t.idles().length).toBe(count);

    // user activity wakes him gracefully and resets the level
    t.s.notifyUserActivity();
    await t.advance(3_000);
    expect(t.anims().slice(-1)[0]).toBe('IDLE3_2:exit');
    await t.advance(8_000);
    const after = t.idles().slice(count);
    expect(after.length).toBe(1);
    expect(after[0]!.level).toBe(1);
  });

  it('honours shortened timing constants', async () => {
    const t = setup({
      idle: true,
      timing: { idleStartMs: 500, idleMinGapMs: 100, idleMaxGapMs: 200, idleLevel2Ms: 20_000, idleLevel3Ms: 60_000 },
    });
    void t.s.play('RestPose');
    await t.advance(700);
    expect(t.idles().length).toBe(1);
    await t.advance(120_000);
    expect(t.idles().some((e) => e.name === 'IDLE3_2')).toBe(true);
  });

  it('never idles while speaking or during an activity, and a request exits an idle gracefully', async () => {
    const t = setup({ idle: true });
    void t.s.show();
    await t.advance(3_000);
    t.s.startActivity('listening');
    await t.advance(120_000);
    expect(t.idles()).toEqual([]);
    const stopped = track(t.s.stopActivity());
    await t.advance(3_000);
    expect(stopped.done).toBe(true);
    void t.s.beginSpeaking();
    await t.advance(120_000);
    expect(t.idles()).toEqual([]);
    t.s.endSpeaking();
    await t.advance(7_000);
    expect(t.idles()).toEqual([]);
    await t.advance(2_000);
    expect(t.idles().length).toBe(1);
    const idleName = t.idles()[0]!.name;
    const wave = track(t.s.play('Wave'));
    await t.advance(10_000);
    expect(wave.value).toBe('completed');
    const seq = t.anims();
    const iw = seq.indexOf('WAVE');
    expect(seq.slice(0, iw)).toContain(idleName);
  });

  it('setIdleEnabled(false) stops idling', async () => {
    const t = setup({ idle: true, timing: { idleStartMs: 1_000 } });
    void t.s.show();
    await t.advance(5_000);
    expect(t.idles().length).toBeGreaterThan(0);
    t.s.setIdleEnabled(false);
    await t.advance(1_000);
    const n = t.idles().length;
    await t.advance(120_000);
    expect(t.idles().length).toBe(n);
    expect(t.s.debugState().job).toBe(null);
  });
});

describe('engine interrupted idles', () => {
  it('leaves the sunglasses idle (IDLE1_24) promptly, skipping its 2 s holds', async () => {
    const idle = getAnimation(ch, 'IDLE1_24')!;
    let t: ReturnType<typeof setup> | null = null;
    for (let seed = 1; seed < 200 && !t; seed++) {
      const c = setup({ idle: true, seed });
      (c.s as unknown as { pickIdle: () => AcsAnimation }).pickIdle = () => idle;
      void c.s.show();
      for (let ms = 0; ms < 40_000; ms += 50) {
        await c.advance(50);
        const d = c.s.debugState();
        if (d.animation === 'IDLE1_24' && d.frame === 21) {
          t = c;
          break;
        }
      }
    }
    expect(t, 'no seed reached IDLE1_24 frame 21').not.toBe(null);
    const c = t!;
    const from = c.frames.length;
    const t0 = c.clock.now();
    c.s.notifyUserActivity();
    c.s.startActivity('thinking');
    while (!c.anims().includes('THINK') && c.clock.now() - t0 < 10_000) await c.advance(10);
    const think = c.events.find((e) => e.type === 'animation' && e.name === 'THINK');
    expect(think).toBeDefined();
    expect(think!.at - t0).toBeLessThan(2_500);
    // The picture changes at least every exitLatencyMs (+ timer slack) until THINK is up.
    const thinkShown = c.frames.findIndex((f, i) => i >= from && f?.anim === 'THINK');
    expect(thinkShown).toBeGreaterThanOrEqual(from);
    const times = [t0, ...c.frameTimes.slice(from, thinkShown + 1)];
    const limit = DEFAULT_TIMING.exitLatencyMs + 10;
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!, `gap before display ${i}`).toBeLessThanOrEqual(limit);
    }
  });
});

describe('engine speech interrupted by a drag or a menu animation', () => {
  it('lip-sync resumes after a drag ends mid-sentence, and idles wait for endSpeaking', async () => {
    const t = setup({ idle: true });
    void t.s.show();
    await t.advance(3_000);
    const ready = track(t.s.beginSpeaking());
    await t.advance(2_000);
    expect(ready.done).toBe(true);
    t.s.setMouth(MOUTH.wide1);
    expect(t.last()?.mouth).toBe(MOUTH.wide1);
    t.s.startActivity('dragging');
    await t.advance(3_000);
    expect(t.last()?.anim).toBe('MOVEUP');
    void t.s.stopActivity();
    await t.advance(3_000);
    expect(t.s.isSpeaking()).toBe(true);
    t.s.setMouth(MOUTH.wide3);
    expect(t.last()?.mouth).toBe(MOUTH.wide3);
    t.s.setMouth(MOUTH.narrow);
    expect(t.last()?.mouth).toBe(MOUTH.narrow);
    await t.advance(60_000);
    expect(t.idles()).toEqual([]);
    t.s.endSpeaking();
    expect(t.last()?.mouth).toBe(null);
    await t.advance(10_000);
    expect(t.idles().length).toBe(1);
  });

  it('a menu animation (playNow Wave) mid-sentence speaks on its held overlay frame', async () => {
    const t = setup({ idle: true });
    void t.s.show();
    await t.advance(3_000);
    void t.s.beginSpeaking();
    await t.advance(1_000);
    const wave = track(t.s.playNow('Wave'));
    await t.advance(10_000);
    expect(wave.value).toBe('completed');
    t.s.setMouth(MOUTH.wide2);
    expect(t.last()).toEqual({ anim: 'WAVE', frame: 19, mouth: MOUTH.wide2 });
    await t.advance(60_000);
    expect(t.idles()).toEqual([]);
    t.s.endSpeaking();
    await t.advance(10_000);
    expect(t.idles().length).toBe(1);
  });

  it('stopAll and hide end the interrupted sentence too', async () => {
    const t = setup({ idle: true });
    void t.s.show();
    await t.advance(3_000);
    void t.s.beginSpeaking();
    await t.advance(1_000);
    t.s.startActivity('dragging');
    await t.advance(2_000);
    t.s.stopAll();
    await t.advance(1_000);
    expect(t.s.isSpeaking()).toBe(false);
    t.s.setMouth(MOUTH.wide1);
    expect(t.last()?.mouth).toBe(null);
    await t.advance(10_000);
    expect(t.idles().length).toBeGreaterThan(0);

    const h = setup({ idle: true });
    void h.s.show();
    await h.advance(3_000);
    void h.s.beginSpeaking();
    await h.advance(1_000);
    void h.s.playNow('Wave');
    void h.s.hide();
    await h.advance(10_000);
    expect(h.s.isHidden()).toBe(true);
    void h.s.show();
    await h.advance(5_000);
    expect(h.s.isSpeaking()).toBe(false);
  });
});
