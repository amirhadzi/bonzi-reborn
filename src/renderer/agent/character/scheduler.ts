// Pure MS Agent playback scheduler: request queue, frame stepping, wind-back,
// activities, idle escalation and speaking frame selection. No DOM access:
// time, timers and randomness are injected so tests can drive it with a fake
// clock against the real Bonzi.acs.

import type { AcsAnimation, AcsCharacter, AcsFrame, MouthType } from '../../../shared/acs/types.ts';
import {
  animationsForState,
  canEndNaturally,
  exitNextFrame,
  getReturnAnimation,
  hasLoop,
  pickNextFrame,
} from '../../../shared/acs/playback.ts';
import type { Activity, LookDirection, PlayOutcome } from '../../../shared/character-controller.ts';

export interface SchedulerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface EngineTiming {
  /** Quiet time (empty queue, no user activity) before the first idle animation. */
  idleStartMs: number;
  /** Random gap between level 1/2 idle animations. */
  idleMinGapMs: number;
  idleMaxGapMs: number;
  /** Inactivity after which idle picks come from IdlingLevel2. */
  idleLevel2Ms: number;
  /** Inactivity after which IdlingLevel3 (yawn, then doze) plays. */
  idleLevel3Ms: number;
  /** Safety cap for an idle animation that never ends on its own. */
  idleMaxAnimMs: number;
  /** How long look() holds the gaze before returning. */
  lookHoldMs: number;
  /**
   * Upper bound on how long the current frame keeps showing once an exit is
   * requested. It also bounds each frame of an interrupted idle's exit.
   */
  exitLatencyMs: number;
  /** When a timer fires this late, restart the frame clock instead of catching up. */
  lagResyncMs: number;
  /**
   * Safety cap on how long a finished play() keeps waiting for the sound
   * effects it started (e.g. an audio context that never resumes).
   */
  soundTailMaxMs: number;
}

export const DEFAULT_TIMING: Readonly<EngineTiming> = Object.freeze({
  idleStartMs: 8_000,
  idleMinGapMs: 6_000,
  idleMaxGapMs: 12_000,
  idleLevel2Ms: 90_000,
  idleLevel3Ms: 300_000,
  idleMaxAnimMs: 30_000,
  lookHoldMs: 1_500,
  exitLatencyMs: 150,
  lagResyncMs: 250,
  soundTailMaxMs: 3_000,
});

export interface FrameRef {
  animation: AcsAnimation;
  frame: number;
}

export interface DisplayState extends FrameRef {
  mouth: MouthType | null;
}

export type SchedulerEvent =
  | { type: 'animation'; name: string; mode: 'play' | 'exit' }
  | { type: 'idle'; level: 1 | 2 | 3; name: string }
  | { type: 'activity'; activity: Activity; phase: 'start' | 'stop' };

export interface SchedulerOptions {
  character: AcsCharacter;
  clock: SchedulerClock;
  random?: () => number;
  timing?: Partial<EngineTiming>;
  idleEnabled?: boolean;
  /** Called whenever the displayed frame or mouth changes. null = draw nothing. */
  onDisplay?: (state: DisplayState | null) => void;
  /**
   * Called when a frame with a sound is entered. May return a promise that
   * settles when the sound ends; play() jobs wait for it (capped).
   */
  onSound?: (audioIndex: number) => unknown;
  onEvent?: (event: SchedulerEvent) => void;
}

export interface SchedulerDebugState {
  job: JobKind | null;
  animation: string | null;
  frame: number;
  queue: number;
  held: string | null;
  hidden: boolean;
  speaking: boolean;
  activity: Activity | null;
  idleLevel: 0 | 1 | 2 | 3;
}

// Preemption levels, from weakest to strongest.
const NONE = 0;
/** User activity: only idle animations yield. */
const USER = 1;
/** A new request is waiting: endless / looping animations and activities yield. */
const SOFT = 2;
/** playNow / hide: everything exits gracefully. */
const HARD = 3;
type Level = 0 | 1 | 2 | 3;

type JobKind = 'play' | 'show' | 'hide' | 'speak' | 'activity' | 'look' | 'idle';
type StepResult = 'ended' | 'stopped' | 'aborted';
type SleepResult = 'done' | 'woken' | 'aborted';

interface Job {
  kind: JobKind;
  aborted: boolean;
  level: Level;
  run: (job: Job) => Promise<void>;
  /** Settles the job's caller-facing promise when it is dropped or aborted. */
  cancel: () => void;
  cleanup: Array<() => void>;
  activity?: Activity;
  stopWaiters?: Array<() => void>;
}

interface Held extends FrameRef {
  /** Used to get back to rest when the animation itself has no return path. */
  returnOverride: AcsAnimation | null;
}

interface Stepper {
  job: Job;
  anim: AcsAnimation;
  mode: 'play' | 'exit';
  yieldAt: Level;
  index: number;
  shown: number;
  due: number;
  timer: unknown;
  hasTimer: boolean;
  visited: Set<number>;
  returnOverride: AcsAnimation | null;
  /** Collects end-of-sound promises for the sounds this stepper started (play jobs only). */
  sounds: Promise<unknown>[] | null;
  resolve: (r: StepResult) => void;
}

interface Sleeper {
  job: Job;
  yieldAt: Level;
  timer: unknown;
  hasTimer: boolean;
  resolve: (r: SleepResult) => void;
}

interface ActivityStepSpec {
  /** Candidate animation names, first usable one wins. */
  names: string[];
  /** Fallback state whose first usable animation is used when no name matches. */
  state?: string;
  /** Keep looping (endless animations loop by themselves; others are replayed). */
  loop?: boolean;
  /** Played to get back to rest when the animation has no return of its own. */
  returnNames?: string[];
}

interface ActivityPlanSpec {
  steps: ActivityStepSpec[];
  /** Played after the steps are wound back when the activity is stopped. */
  outro?: string[];
}

// READING and WRITING already contain the sit-down / notebook intro of READ and
// WRITE (frames 0..21 of READING match READ), so playing READ first would make
// Bonzi sit down twice. They are used on their own; READ / WRITE are fallbacks.
const ACTIVITY_PLANS: Record<Activity, ActivityPlanSpec> = {
  thinking: {
    steps: [{ names: ['THINK'] }, { names: ['SEARCHING', 'THINKING', 'PROCESSING'], loop: true }],
  },
  listening: {
    steps: [{ names: ['STARTLISTENING'] }, { names: ['ALERT'], state: 'LISTENING' }],
    outro: ['STOPLISTENING'],
  },
  processing: { steps: [{ names: ['THINK', 'PROCESSING', 'THINKING'] }] },
  searching: { steps: [{ names: ['SEARCHING', 'SEARCH'], loop: true }] },
  reading: { steps: [{ names: ['READING', 'READCONTINUED', 'READ'], loop: true, returnNames: ['READRETURN'] }] },
  writing: {
    steps: [
      { names: ['WRITING', 'WRITECONTINUED', 'WRITE'], loop: true, returnNames: ['WRITINGRETURN', 'WRITERETURN'] },
    ],
  },
  dragging: { steps: [{ names: ['MOVEUP'], state: 'MOVINGUP' }] },
};

interface ResolvedStep {
  anim: AcsAnimation;
  loop: boolean;
  ret: AcsAnimation | null;
}

/**
 * look() takes the CHARACTER's own direction, like the ACS names: 'left' plays
 * LOOKLEFT, which for Bonzi faces the RIGHT edge of the screen. Diagonals fall
 * back to the horizontal, then the vertical animation when the diagonal is a
 * rest-pose placeholder (all of Bonzi's are).
 */
const LOOK_NAMES: Record<LookDirection, string[]> = {
  left: ['LOOKLEFT'],
  right: ['LOOKRIGHT'],
  up: ['LOOKUP'],
  down: ['LOOKDOWN'],
  'up-left': ['LOOKUPLEFT', 'LOOKLEFT', 'LOOKUP'],
  'up-right': ['LOOKUPRIGHT', 'LOOKRIGHT', 'LOOKUP'],
  'down-left': ['LOOKDOWNLEFT', 'LOOKLEFT', 'LOOKDOWN'],
  'down-right': ['LOOKDOWNRIGHT', 'LOOKRIGHT', 'LOOKDOWN'],
};

function frameKey(f: AcsFrame): string {
  return f.images.map((i) => `${i.imageIndex}@${i.x},${i.y}`).join('|');
}

function lastVisibleFrame(anim: AcsAnimation): number {
  for (let i = anim.frames.length - 1; i >= 0; i--) if ((anim.frames[i]?.images.length ?? 0) > 0) return i;
  return -1;
}

export class AnimationScheduler {
  readonly character: AcsCharacter;
  private readonly clock: SchedulerClock;
  private readonly random: () => number;
  private timing: EngineTiming;
  private readonly onDisplay: (state: DisplayState | null) => void;
  private readonly onSound: (audioIndex: number) => unknown;
  private readonly onEvent: (event: SchedulerEvent) => void;

  private queue: Job[] = [];
  private current: Job | null = null;
  private stepper: Stepper | null = null;
  private sleeper: Sleeper | null = null;
  private held: Held | null = null;
  private displayed: FrameRef | null = null;
  private mouth: MouthType | null = null;
  private hidden = true;
  private speaking = false;
  /** True from the moment a speak job runs until endSpeaking (survives drags and menu animations). */
  private speechActive = false;
  private idleEnabled: boolean;
  private lastActivity: number;
  private idleBase: number;
  private idleResumeAt = 0;
  private idleLevelNow: 0 | 1 | 2 | 3 = 0;
  private lastIdlePick: AcsAnimation | null = null;
  private activityJob: Job | null = null;
  private disposed = false;

  private readonly restKey: string | null;
  private readonly placeholders = new Map<AcsAnimation, boolean>();
  private readonly endless = new Map<AcsAnimation, boolean>();
  readonly restFrame: FrameRef | null;
  readonly speakingFrame: FrameRef | null;

  constructor(options: SchedulerOptions) {
    this.character = options.character;
    this.clock = options.clock;
    this.random = options.random ?? Math.random;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.onDisplay = options.onDisplay ?? (() => {});
    this.onSound = options.onSound ?? (() => {});
    this.onEvent = options.onEvent ?? (() => {});
    this.idleEnabled = options.idleEnabled ?? true;
    this.lastActivity = this.clock.now();
    this.idleBase = this.lastActivity;

    const rest = this.find('RESTPOSE');
    const restFrame0 = rest?.frames[0];
    this.restKey = restFrame0 && restFrame0.images.length ? frameKey(restFrame0) : null;
    this.speakingFrame = this.computeSpeakingFrame();
    this.restFrame = restFrame0 && restFrame0.images.length && rest ? { animation: rest, frame: 0 } : this.speakingFrame;
  }

  // ------------------------------------------------------------------ lookup

  /** Case-insensitive animation lookup. */
  find(name: string): AcsAnimation | undefined {
    return this.character.animationsByName.get(name.trim().toLowerCase());
  }

  /** True for animations that only show the rest pose (e.g. Bonzi's THINKING, SUGGEST, diagonal looks). */
  isPlaceholder(anim: AcsAnimation): boolean {
    let v = this.placeholders.get(anim);
    if (v === undefined) {
      const visible = anim.frames.filter((f) => f.images.length > 0);
      if (visible.length === 0) v = true;
      else if (this.restKey === null || anim === this.restFrame?.animation) v = false;
      else v = visible.every((f) => frameKey(f) === this.restKey);
      this.placeholders.set(anim, v);
    }
    return v;
  }

  /** Endless (never ends) or looping animations yield to the next request. */
  isEndless(anim: AcsAnimation): boolean {
    let v = this.endless.get(anim);
    if (v === undefined) {
      v = !canEndNaturally(anim) || hasLoop(anim);
      this.endless.set(anim, v);
    }
    return v;
  }

  private findReal(name: string): AcsAnimation | undefined {
    const a = this.find(name);
    return a && !this.isPlaceholder(a) ? a : undefined;
  }

  private stateAnim(state: string): AcsAnimation | undefined {
    return animationsForState(this.character, state).find((a) => !this.isPlaceholder(a));
  }

  private firstReal(names: readonly string[] | undefined, state?: string): AcsAnimation | null {
    for (const n of names ?? []) {
      const a = this.findReal(n);
      if (a) return a;
    }
    return (state && this.stateAnim(state)) || null;
  }

  resolveLook(direction: LookDirection): AcsAnimation | null {
    return this.firstReal(LOOK_NAMES[direction]);
  }

  /** True when the animation's last visible frame has mouth overlays. */
  canSpeakDuring(name: string): boolean {
    const anim = this.find(name);
    if (!anim) return false;
    const i = lastVisibleFrame(anim);
    return i >= 0 && (anim.frames[i]?.overlays.length ?? 0) > 0;
  }

  private computeSpeakingFrame(): FrameRef | null {
    const pick = (a: AcsAnimation | undefined): FrameRef | null => {
      if (!a) return null;
      const f0 = a.frames[0];
      if (f0 && f0.images.length && f0.overlays.length) return { animation: a, frame: 0 };
      const i = a.frames.findIndex((f) => f.images.length > 0 && f.overlays.length > 0);
      return i >= 0 ? { animation: a, frame: i } : null;
    };
    for (const a of animationsForState(this.character, 'SPEAKING')) {
      const r = pick(a);
      if (r) return r;
    }
    const r = pick(this.find('RESTPOSE'));
    if (r) return r;
    for (const a of this.character.animations) {
      const x = pick(a);
      if (x) return x;
    }
    return null;
  }

  // ------------------------------------------------------------------ public API

  play(name: string): Promise<PlayOutcome> {
    return this.request(name, false);
  }

  playNow(name: string): Promise<PlayOutcome> {
    return this.request(name, true);
  }

  private request(name: string, now: boolean): Promise<PlayOutcome> {
    const anim = this.find(name);
    if (!anim || this.disposed) return Promise.resolve('missing');
    if (now) this.cancelQueued();
    return new Promise<PlayOutcome>((resolve) => {
      const settle = once(resolve);
      const job = this.makeJob('play', (j) => this.runPlay(j, anim, settle), () => settle('interrupted'));
      this.enqueue(job, now ? HARD : SOFT);
    });
  }

  show(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = once(resolve);
      const job = this.makeJob('show', (j) => this.runShow(j, done), done);
      this.enqueue(job, SOFT);
    });
  }

  hide(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.cancelQueued();
    return new Promise<void>((resolve) => {
      const done = once(resolve);
      const job = this.makeJob('hide', (j) => this.runHide(j, done), done);
      this.enqueue(job, HARD);
    });
  }

  look(direction: LookDirection): Promise<PlayOutcome> {
    const anim = this.resolveLook(direction);
    if (!anim || this.disposed) return Promise.resolve('missing');
    return new Promise<PlayOutcome>((resolve) => {
      const settle = once(resolve);
      const job = this.makeJob('look', (j) => this.runLook(j, anim, settle), () => settle('interrupted'));
      this.enqueue(job, SOFT);
    });
  }

  startActivity(activity: Activity): void {
    if (this.disposed) return;
    const cur = this.activityJob;
    if (cur && cur.activity === activity && cur.level < SOFT && !cur.aborted) return;
    if (cur) this.requestActivityStop(cur, SOFT);
    const waiters: Array<() => void> = [];
    const job = this.makeJob(
      'activity',
      (j) => this.runActivity(j, activity),
      () => flush(waiters),
    );
    job.activity = activity;
    job.stopWaiters = waiters;
    this.activityJob = job;
    this.enqueue(job, SOFT);
  }

  stopActivity(): Promise<void> {
    const job = this.activityJob;
    if (!job) return Promise.resolve();
    return new Promise<void>((resolve) => {
      job.stopWaiters?.push(resolve);
      this.requestActivityStop(job, SOFT);
    });
  }

  currentActivity(): Activity | null {
    return this.activityJob?.activity ?? null;
  }

  beginSpeaking(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = once(resolve);
      const job = this.makeJob('speak', (j) => this.runSpeak(j, done), done);
      this.enqueue(job, SOFT);
    });
  }

  setMouth(shape: MouthType | null): void {
    if (!this.speaking || shape === this.mouth) return;
    this.mouth = shape;
    if (this.displayed) this.emitDisplay();
  }

  endSpeaking(): void {
    const wasMouth = this.mouth;
    this.speaking = false;
    this.speechActive = false;
    this.mouth = null;
    if (wasMouth !== null && this.displayed) this.emitDisplay();
    this.lastActivity = this.clock.now();
    if (this.current?.kind === 'idle') this.raise(this.current, USER);
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  isHidden(): boolean {
    return this.hidden;
  }

  stopAll(): void {
    if (this.disposed) return;
    this.cancelQueued();
    this.abortCurrent();
    this.held = null;
    this.speaking = false;
    this.speechActive = false;
    if (!this.hidden) {
      const r = this.restFrame;
      if (r) this.setDisplayed(r.animation, r.frame);
      else if (this.mouth !== null) {
        this.mouth = null;
        this.emitDisplay();
      }
    }
    this.lastActivity = this.clock.now();
    this.pump();
  }

  setIdleEnabled(enabled: boolean): void {
    if (this.disposed || enabled === this.idleEnabled) return;
    this.idleEnabled = enabled;
    if (!enabled) {
      if (this.current?.kind === 'idle') this.raise(this.current, SOFT);
    } else {
      this.lastActivity = this.clock.now();
      this.pump();
    }
  }

  notifyUserActivity(): void {
    if (this.disposed) return;
    this.lastActivity = this.clock.now();
    if (this.current?.kind === 'idle') this.raise(this.current, USER);
  }

  setTiming(timing: Partial<EngineTiming>): void {
    this.timing = { ...this.timing, ...timing };
    if (this.current?.kind === 'idle') this.raise(this.current, USER);
  }

  getTiming(): EngineTiming {
    return { ...this.timing };
  }

  getDisplay(): DisplayState | null {
    return this.displayed ? { ...this.displayed, mouth: this.mouth } : null;
  }

  debugState(): SchedulerDebugState {
    const s = this.stepper;
    return {
      job: this.current?.kind ?? null,
      animation: s ? s.anim.name : (this.displayed?.animation.name ?? null),
      frame: s ? s.index : (this.displayed?.frame ?? -1),
      queue: this.queue.length,
      held: this.held?.animation.name ?? null,
      hidden: this.hidden,
      speaking: this.speaking,
      activity: this.activityJob?.activity ?? null,
      idleLevel: this.current?.kind === 'idle' ? this.idleLevelNow : 0,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelQueued();
    this.abortCurrent();
    this.disposed = true;
    this.held = null;
  }

  // ------------------------------------------------------------------ queue

  private makeJob(kind: JobKind, run: (job: Job) => Promise<void>, cancel: () => void): Job {
    return { kind, aborted: false, level: NONE, run, cancel, cleanup: [] };
  }

  private enqueue(job: Job, level: Level): void {
    this.lastActivity = this.clock.now();
    this.queue.push(job);
    if (this.current) this.raise(this.current, level);
    this.pump();
  }

  private pump(): void {
    if (this.current || this.disposed) return;
    let job = this.queue.shift();
    if (!job && this.speechActive && !this.speaking && !this.hidden) {
      // A drag or a menu animation interrupted a sentence that is still being
      // spoken: get back to a speaking frame so lip-sync resumes.
      job = this.makeJob('speak', (j) => this.runSpeak(j, () => {}), () => {});
    }
    if (!job) {
      if (!this.idleAllowed()) return;
      this.idleBase = this.clock.now();
      job = this.makeJob('idle', (j) => this.runIdle(j), () => {});
    }
    const j = job;
    // Work is still waiting behind this job: same rule as raising the current
    // job on enqueue, so an endless gesture, a look or an activity yields.
    if (this.queue.length > 0 && j.level < SOFT) j.level = SOFT;
    this.current = j;
    j.run(j)
      .catch(() => {})
      .then(() => {
        runCleanup(j);
        if (this.current === j) {
          this.current = null;
          this.pump();
        }
      });
  }

  private cancelQueued(): void {
    const q = this.queue;
    this.queue = [];
    for (const j of q) {
      j.aborted = true;
      if (this.activityJob === j) this.activityJob = null;
      j.cancel();
    }
  }

  private abortCurrent(): void {
    const job = this.current;
    if (!job) return;
    job.aborted = true;
    this.current = null;
    if (this.activityJob === job) this.activityJob = null;
    const s = this.stepper;
    if (s) this.finish(s, 'aborted');
    const z = this.sleeper;
    if (z) this.endSleep(z, 'aborted');
    runCleanup(job);
    job.cancel();
  }

  private raise(job: Job, level: Level): void {
    if (level > job.level) job.level = level;
    const s = this.stepper;
    if (s && s.job === job && this.shouldYield(s)) {
      const cap = this.clock.now() + this.timing.exitLatencyMs;
      if (s.due > cap) {
        s.due = cap;
        this.arm(s);
      }
    }
    const z = this.sleeper;
    if (z && z.job === job && z.yieldAt > NONE && job.level >= z.yieldAt) this.endSleep(z, 'woken');
  }

  private requestActivityStop(job: Job, level: Level): void {
    const i = this.queue.indexOf(job);
    if (i >= 0) {
      this.queue.splice(i, 1);
      job.aborted = true;
      if (this.activityJob === job) this.activityJob = null;
      job.cancel();
      return;
    }
    if (this.current === job) this.raise(job, level);
  }

  private idleAllowed(): boolean {
    return this.idleEnabled && !this.hidden && !this.disposed;
  }

  // ------------------------------------------------------------------ display

  private emit(e: SchedulerEvent): void {
    try {
      this.onEvent(e);
    } catch {
      // listeners must not break playback
    }
  }

  private emitDisplay(): void {
    try {
      this.onDisplay(this.displayed ? { ...this.displayed, mouth: this.mouth } : null);
    } catch {
      // renderer errors must not break playback
    }
  }

  private setDisplayed(anim: AcsAnimation, frame: number): void {
    const d = this.displayed;
    if (d && d.animation === anim && d.frame === frame && this.mouth === null) return;
    this.displayed = { animation: anim, frame };
    this.mouth = null;
    this.emitDisplay();
  }

  private clearDisplay(): void {
    if (!this.displayed && this.mouth === null) return;
    this.displayed = null;
    this.mouth = null;
    this.emitDisplay();
  }

  private displayedHasOverlays(): boolean {
    const d = this.displayed;
    return !!d && (d.animation.frames[d.frame]?.overlays.length ?? 0) > 0;
  }

  // ------------------------------------------------------------------ stepping

  private shouldYield(s: Stepper): boolean {
    return s.yieldAt > NONE && s.job.level >= s.yieldAt;
  }

  /**
   * Plays `anim` frame by frame. In 'play' mode it follows branches and, when it
   * ends or is stopped, the last visible frame becomes the held frame. In 'exit'
   * mode it follows exit branches starting after `from` and leaves nothing held.
   */
  private animate(
    job: Job,
    anim: AcsAnimation,
    opts: {
      mode?: 'play' | 'exit';
      from?: number;
      yieldAt?: Level;
      returnOverride?: AcsAnimation | null;
      sounds?: Promise<unknown>[];
    } = {},
  ): Promise<StepResult> {
    if (job.aborted || this.disposed) return Promise.resolve('aborted');
    const mode = opts.mode ?? 'play';
    this.emit({ type: 'animation', name: anim.name, mode });
    return new Promise<StepResult>((resolve) => {
      const s: Stepper = {
        job,
        anim,
        mode,
        yieldAt: opts.yieldAt ?? NONE,
        index: -1,
        shown: -1,
        due: 0,
        timer: undefined,
        hasTimer: false,
        visited: new Set(),
        returnOverride: opts.returnOverride ?? null,
        sounds: opts.sounds ?? null,
        resolve,
      };
      if (this.stepper) this.finish(this.stepper, 'aborted');
      this.stepper = s;
      let first = 0;
      if (mode === 'exit') {
        const from = opts.from ?? 0;
        s.visited.add(from);
        s.index = from;
        s.shown = from;
        first = this.nextIndex(s, from);
      }
      if (first >= anim.frames.length) {
        this.finish(s, 'ended');
        return;
      }
      this.enter(s, first, this.clock.now());
    });
  }

  private nextIndex(s: Stepper, i: number): number {
    const n = s.anim.frames.length;
    if (s.mode === 'play') return pickNextFrame(s.anim, i, this.random);
    const next = exitNextFrame(s.anim, i);
    if (next >= n || s.visited.has(next)) return n;
    s.visited.add(next);
    return next;
  }

  private enter(s: Stepper, index: number, start: number): void {
    const frames = s.anim.frames;
    const n = frames.length;
    // An idle being wound back because the user (or a request) interrupted it:
    // idleOnce / idleLevel3 wind back while the job level is still >= USER.
    const fast = s.mode === 'exit' && s.job.kind === 'idle' && s.job.level >= USER;
    let i = index;
    let frame = frames[i];
    for (let guard = 0; ; guard++) {
      if (!frame) {
        this.present(s);
        this.finish(s, 'ended');
        return;
      }
      s.index = i;
      if (frame.audioIndex >= 0) this.playSound(s, frame.audioIndex);
      const prev = s.shown >= 0 ? frames[s.shown] : undefined;
      // A pure hold (same images as the frame on screen) adds nothing to an
      // interrupted idle's exit but delay, so it is passed through as well.
      const hold = fast && frame.images.length > 0 && !!prev && frameKey(frame) === frameKey(prev);
      if (frame.images.length > 0) s.shown = i;
      // Zero-duration frames are passed through immediately (end markers are
      // never drawn); the guard turns a zero-duration loop into 10 ms frames.
      if ((frame.duration > 0 && !hold) || guard > n * 2 + 8) break;
      const next = this.nextIndex(s, i);
      if (next >= n) {
        this.present(s);
        this.finish(s, 'ended');
        return;
      }
      i = next;
      frame = frames[i];
    }
    this.present(s);
    s.due = start + Math.max(1, frame.duration) * 10;
    if (fast) s.due = Math.min(s.due, start + this.timing.exitLatencyMs);
    if (this.shouldYield(s)) s.due = Math.min(s.due, this.clock.now() + this.timing.exitLatencyMs);
    this.arm(s);
  }

  private present(s: Stepper): void {
    if (s.shown >= 0) this.setDisplayed(s.anim, s.shown);
  }

  private arm(s: Stepper): void {
    if (s.hasTimer) this.clock.clearTimeout(s.timer);
    const delay = Math.max(0, s.due - this.clock.now());
    s.timer = this.clock.setTimeout(() => this.tick(s), delay);
    s.hasTimer = true;
  }

  private tick(s: Stepper): void {
    if (this.stepper !== s) return;
    s.hasTimer = false;
    if (this.shouldYield(s)) {
      this.finish(s, 'stopped');
      return;
    }
    const next = this.nextIndex(s, s.index);
    if (next >= s.anim.frames.length) {
      this.finish(s, 'ended');
      return;
    }
    const now = this.clock.now();
    this.enter(s, next, now - s.due > this.timing.lagResyncMs ? now : s.due);
  }

  private finish(s: Stepper, result: StepResult): void {
    if (s.hasTimer) this.clock.clearTimeout(s.timer);
    s.hasTimer = false;
    if (this.stepper === s) this.stepper = null;
    if (result !== 'aborted' && s.mode === 'play' && s.shown >= 0) {
      this.held = { animation: s.anim, frame: s.shown, returnOverride: s.returnOverride };
    }
    s.resolve(result);
  }

  private playSound(s: Stepper, index: number): void {
    try {
      const r = this.onSound(index);
      if (s.sounds && r && typeof (r as PromiseLike<unknown>).then === 'function') {
        s.sounds.push(Promise.resolve(r).catch(() => {}));
      }
    } catch {
      // audio problems never break playback
    }
  }

  /**
   * Waits (holding the last frame) until the sounds a play job started have
   * ended, as MS Agent signals completion only after the sound (RESEARCH.md
   * D1). Capped by soundTailMaxMs; playNow and hide wake it (HARD), stopAll
   * aborts it.
   */
  private async awaitSounds(job: Job, sounds: Promise<unknown>[]): Promise<void> {
    if (!sounds.length) return;
    const wait = this.sleep(job, this.timing.soundTailMaxMs, HARD);
    const z = this.sleeper;
    if (z && z.job === job) {
      void Promise.all(sounds).then(() => {
        if (this.sleeper === z) this.endSleep(z, 'done');
      });
    }
    await wait;
  }

  private sleep(job: Job, ms: number, yieldAt: Level): Promise<SleepResult> {
    if (job.aborted || this.disposed) return Promise.resolve('aborted');
    if (yieldAt > NONE && job.level >= yieldAt) return Promise.resolve('woken');
    return new Promise<SleepResult>((resolve) => {
      const z: Sleeper = { job, yieldAt, timer: undefined, hasTimer: false, resolve };
      if (this.sleeper) this.endSleep(this.sleeper, 'aborted');
      this.sleeper = z;
      if (Number.isFinite(ms)) {
        z.timer = this.clock.setTimeout(() => this.endSleep(z, 'done'), Math.max(0, ms));
        z.hasTimer = true;
      }
    });
  }

  private endSleep(z: Sleeper, r: SleepResult): void {
    if (z.hasTimer) this.clock.clearTimeout(z.timer);
    z.hasTimer = false;
    if (this.sleeper === z) this.sleeper = null;
    z.resolve(r);
  }

  /**
   * Brings the held animation back to rest: transition type 1 follows exit
   * branches, type 0 plays the return animation, type 2 does nothing (unless
   * the caller supplied a return override). Returns false when aborted.
   */
  private async windBack(job: Job): Promise<boolean> {
    for (let depth = 0; this.held && depth < 4; depth++) {
      if (job.aborted) return false;
      const h = this.held;
      this.held = null;
      const a = h.animation;
      if (a.transitionType === 1) {
        if ((await this.animate(job, a, { mode: 'exit', from: h.frame })) === 'aborted') return false;
        continue;
      }
      const ret = (a.transitionType === 0 ? getReturnAnimation(this.character, a) : undefined) ?? h.returnOverride;
      if (!ret || ret === a || !canEndNaturally(ret)) continue;
      if ((await this.animate(job, ret)) === 'aborted') return false;
    }
    this.held = null;
    return !job.aborted;
  }

  private unhide(): void {
    this.hidden = false;
  }

  // ------------------------------------------------------------------ jobs

  private async runPlay(job: Job, anim: AcsAnimation, settle: (o: PlayOutcome) => void): Promise<void> {
    this.unhide();
    this.speaking = false;
    if (!(await this.windBack(job))) return settle('interrupted');
    if (job.level >= HARD) return settle('interrupted');
    const endless = this.isEndless(anim);
    const sounds: Promise<unknown>[] = [];
    const r = await this.animate(job, anim, { yieldAt: endless ? SOFT : HARD, sounds });
    if (r === 'aborted' || (r === 'stopped' && !endless)) return settle('interrupted');
    if (r === 'ended') await this.awaitSounds(job, sounds);
    if (job.aborted) return settle('interrupted');
    settle('completed');
  }

  private async runShow(job: Job, done: () => void): Promise<void> {
    if (!this.hidden) return done();
    this.speaking = false;
    this.held = null;
    this.clearDisplay();
    this.hidden = false;
    const anim = this.stateAnim('SHOWING') ?? this.findReal('SHOW');
    if (anim) {
      await this.animate(job, anim, { yieldAt: HARD });
    } else if (this.restFrame && !job.aborted) {
      this.setDisplayed(this.restFrame.animation, this.restFrame.frame);
    }
    done();
  }

  private async runHide(job: Job, done: () => void): Promise<void> {
    if (this.hidden) return done();
    this.speaking = false;
    if (!(await this.windBack(job))) return done();
    const anim = this.stateAnim('HIDING') ?? this.findReal('HIDE');
    if (anim && (await this.animate(job, anim)) === 'aborted') return done();
    if (job.aborted) return done();
    this.held = null;
    this.hidden = true;
    this.speechActive = false;
    this.clearDisplay();
    done();
  }

  private async runSpeak(job: Job, done: () => void): Promise<void> {
    if (this.hidden) return done();
    if (!this.displayedHasOverlays()) {
      if (!(await this.windBack(job))) return done();
      if (!this.displayedHasOverlays() && this.speakingFrame) {
        const sf = this.speakingFrame;
        this.setDisplayed(sf.animation, sf.frame);
        this.held = { ...sf, returnOverride: null };
      }
    }
    this.speaking = true;
    this.speechActive = true;
    done();
  }

  private async runLook(job: Job, anim: AcsAnimation, settle: (o: PlayOutcome) => void): Promise<void> {
    this.unhide();
    this.speaking = false;
    if (!(await this.windBack(job))) return settle('interrupted');
    if (job.level >= HARD) return settle('interrupted');
    const t = this.clock.setTimeout(() => this.raise(job, SOFT), this.timing.lookHoldMs);
    job.cleanup.push(() => this.clock.clearTimeout(t));
    const r = await this.animate(job, anim, { yieldAt: SOFT });
    this.clock.clearTimeout(t);
    if (r === 'aborted') return settle('interrupted');
    const hard = job.level >= HARD;
    if (!(await this.windBack(job))) return settle('interrupted');
    settle(hard ? 'interrupted' : 'completed');
  }

  private resolvePlan(activity: Activity): { steps: ResolvedStep[]; outro: AcsAnimation | null } {
    const spec = ACTIVITY_PLANS[activity];
    const steps: ResolvedStep[] = [];
    for (const st of spec.steps) {
      const anim = this.firstReal(st.names, st.state);
      if (anim) steps.push({ anim, loop: !!st.loop, ret: this.firstReal(st.returnNames) });
    }
    return { steps, outro: this.firstReal(spec.outro) };
  }

  private async runActivity(job: Job, activity: Activity): Promise<void> {
    const plan = this.resolvePlan(activity);
    this.emit({ type: 'activity', activity, phase: 'start' });
    try {
      this.unhide();
      this.speaking = false;
      if (!(await this.windBack(job))) return;
      let started = false;
      steps: for (let k = 0; k < plan.steps.length; k++) {
        const step = plan.steps[k]!;
        if (job.level >= SOFT) break;
        for (;;) {
          started = true;
          const r = await this.animate(job, step.anim, { yieldAt: SOFT, returnOverride: step.ret });
          if (r === 'aborted') return;
          if (r === 'stopped') break steps;
          if (!step.loop || job.level >= SOFT) break;
          // A non-endless loop step (fallback) is replayed directly.
          this.held = null;
        }
        if (job.level >= SOFT) break;
        if (k === plan.steps.length - 1) {
          if ((await this.sleep(job, Infinity, SOFT)) === 'aborted') return;
          break;
        }
        if (!(await this.windBack(job))) return;
      }
      if (plan.steps.length === 0 && job.level < SOFT) {
        if ((await this.sleep(job, Infinity, SOFT)) === 'aborted') return;
      }
      if (!(await this.windBack(job))) return;
      if (plan.outro && started && job.level < HARD) {
        if ((await this.animate(job, plan.outro, { yieldAt: HARD })) === 'aborted') return;
        if (!(await this.windBack(job))) return;
      }
    } finally {
      if (this.activityJob === job) this.activityJob = null;
      this.emit({ type: 'activity', activity, phase: 'stop' });
      flush(job.stopWaiters ?? []);
    }
  }

  // ------------------------------------------------------------------ idle

  private computeIdleLevel(now: number): 1 | 2 | 3 {
    const since = now - Math.max(this.lastActivity, this.idleBase);
    if (since >= this.timing.idleLevel3Ms) return 3;
    if (since >= this.timing.idleLevel2Ms) return 2;
    return 1;
  }

  private nextIdleAt(): number {
    return Math.max(Math.max(this.lastActivity, this.idleBase) + this.timing.idleStartMs, this.idleResumeAt);
  }

  private pickIdle(level: 1 | 2): AcsAnimation | null {
    let list = animationsForState(this.character, level === 2 ? 'IDLINGLEVEL2' : 'IDLINGLEVEL1').filter(
      (a) => !this.isPlaceholder(a),
    );
    if (!list.length && level === 2) {
      list = animationsForState(this.character, 'IDLINGLEVEL1').filter((a) => !this.isPlaceholder(a));
    }
    if (!list.length) return null;
    const pool = list.length > 1 ? list.filter((a) => a !== this.lastIdlePick) : list;
    return pool[Math.min(pool.length - 1, Math.floor(this.random() * pool.length))] ?? null;
  }

  private async runIdle(job: Job): Promise<void> {
    for (;;) {
      if (job.aborted || job.level >= SOFT || !this.idleAllowed() || this.queue.length) return;
      job.level = NONE;
      this.idleLevelNow = 0;
      const wait = this.nextIdleAt() - this.clock.now();
      if (wait > 0) {
        const z = await this.sleep(job, wait, USER);
        if (z === 'aborted') return;
        if (z === 'woken') continue;
      }
      if (this.speaking) {
        if ((await this.sleep(job, Infinity, USER)) === 'aborted') return;
        continue;
      }
      const level = this.computeIdleLevel(this.clock.now());
      this.idleLevelNow = level;
      if (!(await this.windBack(job))) return;
      if (level === 3 && (await this.idleLevel3(job))) continue;
      if (job.aborted) return;
      await this.idleOnce(job, level === 3 ? 2 : level);
    }
  }

  private async idleOnce(job: Job, level: 1 | 2): Promise<void> {
    const anim = this.pickIdle(level);
    if (!anim) {
      await this.sleep(job, Infinity, USER);
      return;
    }
    this.lastIdlePick = anim;
    this.emit({ type: 'idle', level, name: anim.name });
    let clearCap = (): void => {};
    if (!canEndNaturally(anim)) {
      const cap = this.clock.setTimeout(() => this.raise(job, USER), this.timing.idleMaxAnimMs);
      clearCap = () => this.clock.clearTimeout(cap);
      job.cleanup.push(clearCap);
    }
    const r = await this.animate(job, anim, { yieldAt: USER });
    clearCap();
    if (r === 'aborted') return;
    if (!(await this.windBack(job))) return;
    const gap = this.timing.idleMinGapMs + this.random() * Math.max(0, this.timing.idleMaxGapMs - this.timing.idleMinGapMs);
    this.idleResumeAt = this.clock.now() + gap;
  }

  /** Yawn, then doze until woken. Returns false when the character has no level 3 animations. */
  private async idleLevel3(job: Job): Promise<boolean> {
    const list = animationsForState(this.character, 'IDLINGLEVEL3').filter((a) => !this.isPlaceholder(a));
    if (!list.length) return false;
    for (let i = 0; i < list.length; i++) {
      const anim = list[i]!;
      this.lastIdlePick = anim;
      this.emit({ type: 'idle', level: 3, name: anim.name });
      const r = await this.animate(job, anim, { yieldAt: USER });
      if (r === 'aborted') return true;
      if (r === 'stopped') {
        await this.windBack(job);
        return true;
      }
      if (i < list.length - 1 && !(await this.windBack(job))) return true;
    }
    // The last one ended on its own: hold it until something wakes him.
    if ((await this.sleep(job, Infinity, USER)) === 'aborted') return true;
    await this.windBack(job);
    return true;
  }
}

function once<T>(fn: (v: T) => void): (v: T) => void {
  let done = false;
  return (v: T) => {
    if (done) return;
    done = true;
    fn(v);
  };
}

function flush(waiters: Array<() => void>): void {
  const list = waiters.splice(0);
  for (const w of list) w();
}

function runCleanup(job: Job): void {
  const list = job.cleanup.splice(0);
  for (const c of list) {
    try {
      c();
    } catch {
      // ignore
    }
  }
}
