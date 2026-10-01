// Animation engine entry point: wires the pure scheduler to the canvas
// renderer and the sound player, implementing CharacterController.

import type { AcsCharacter } from '../../../shared/acs/types.ts';
import type {
  Activity,
  CharacterController,
  LookDirection,
  MouthShape,
  PlayOutcome,
} from '../../../shared/character-controller.ts';
import { SoundPlayer } from './audio.ts';
import { FrameRenderer } from './renderer.ts';
import {
  AnimationScheduler,
  type EngineTiming,
  type SchedulerClock,
  type SchedulerDebugState,
  type SchedulerEvent,
} from './scheduler.ts';

export { DEFAULT_TIMING } from './scheduler.ts';
export type { EngineTiming, SchedulerDebugState, SchedulerEvent } from './scheduler.ts';

export interface CreateCharacterOptions {
  audioContext?: AudioContext;
  random?: () => number;
  scale?: number;
  soundEnabled?: boolean;
  volume?: number;
  idleEnabled?: boolean;
  /** Overrides for idle / look timing (mainly for the dev harness). */
  timing?: Partial<EngineTiming>;
}

type FrameInfo = { animation: string | null; frame: number };

/** CharacterController plus a few debugging helpers. */
export interface EngineCharacter extends CharacterController {
  setTiming(timing: Partial<EngineTiming>): void;
  getTiming(): EngineTiming;
  debugState(): SchedulerDebugState;
  /** The frame currently on screen, with the mouth overlay in use. */
  currentFrame(): { animation: string | null; frame: number; mouth: MouthShape | null };
  /** Scheduler events (animation starts, idle picks, activity start/stop). */
  onEvent(cb: (event: SchedulerEvent) => void): () => void;
}

function browserClock(): SchedulerClock {
  return {
    now: () => performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => {
      if (typeof handle === 'number') window.clearTimeout(handle);
    },
  };
}

function characterName(acs: AcsCharacter): string {
  const loc = acs.localized;
  const en = loc.find((l) => l.languageId === 0x09 || l.languageId === 0x409) ?? loc[0];
  return en?.name?.trim() || 'Character';
}

export function createCharacter(acs: AcsCharacter, options: CreateCharacterOptions = {}): EngineCharacter {
  const renderer = new FrameRenderer(acs, options.scale ?? 1);
  const sound = new SoundPlayer(acs, {
    audioContext: options.audioContext,
    enabled: options.soundEnabled ?? true,
    volume: options.volume ?? 1,
  });
  const frameListeners = new Set<(info: FrameInfo) => void>();
  const eventListeners = new Set<(event: SchedulerEvent) => void>();
  let disposed = false;

  const scheduler = new AnimationScheduler({
    character: acs,
    clock: browserClock(),
    random: options.random ?? Math.random,
    timing: options.timing,
    idleEnabled: options.idleEnabled ?? true,
    onDisplay: (state) => {
      const frame = state ? (state.animation.frames[state.frame] ?? null) : null;
      if (!renderer.draw(frame, state?.mouth ?? null)) return;
      const info: FrameInfo = { animation: state ? state.animation.name : null, frame: state ? state.frame : -1 };
      for (const cb of frameListeners) {
        try {
          cb(info);
        } catch {
          // listener errors are not the engine's problem
        }
      }
    },
    onSound: (index) => sound.play(index),
    onEvent: (event) => {
      for (const cb of eventListeners) {
        try {
          cb(event);
        } catch {
          // ignore
        }
      }
    },
  });

  const names = acs.animations.map((a) => a.name);

  const controller: EngineCharacter = {
    name: characterName(acs),
    width: acs.info.width,
    height: acs.info.height,
    canvas: renderer.canvas,

    hasAnimation: (name: string) => scheduler.find(name) !== undefined,
    animationNames: () => names.slice(),

    show: () => scheduler.show(),
    hide: () => scheduler.hide(),
    play: (name: string): Promise<PlayOutcome> => scheduler.play(name),
    playNow: (name: string): Promise<PlayOutcome> => scheduler.playNow(name),

    startActivity: (activity: Activity) => scheduler.startActivity(activity),
    stopActivity: () => scheduler.stopActivity(),
    look: (direction: LookDirection) => scheduler.look(direction),

    beginSpeaking: () => scheduler.beginSpeaking(),
    setMouth: (shape: MouthShape | null) => scheduler.setMouth(shape),
    endSpeaking: () => {
      scheduler.endSpeaking();
      return Promise.resolve();
    },
    canSpeakDuring: (name: string) => scheduler.canSpeakDuring(name),

    stopAll: () => {
      sound.stopAll();
      scheduler.stopAll();
    },

    setIdleEnabled: (enabled: boolean) => scheduler.setIdleEnabled(enabled),
    notifyUserActivity: () => scheduler.notifyUserActivity(),

    setScale: (scale: number) => renderer.setScale(scale),
    setSoundEnabled: (enabled: boolean) => sound.setEnabled(enabled),
    setVolume: (volume: number) => sound.setVolume(volume),

    hitTest: (x: number, y: number) => renderer.hitTest(x, y),

    onFrame: (cb) => {
      frameListeners.add(cb);
      return () => frameListeners.delete(cb);
    },

    dispose: () => {
      if (disposed) return;
      disposed = true;
      scheduler.dispose();
      sound.dispose();
      renderer.dispose();
      frameListeners.clear();
      eventListeners.clear();
    },

    setTiming: (timing) => scheduler.setTiming(timing),
    getTiming: () => scheduler.getTiming(),
    debugState: () => scheduler.debugState(),
    currentFrame: () => {
      const d = scheduler.getDisplay();
      return { animation: d ? d.animation.name : null, frame: d ? d.frame : -1, mouth: d ? d.mouth : null };
    },
    onEvent: (cb) => {
      eventListeners.add(cb);
      return () => eventListeners.delete(cb);
    },
  };
  return controller;
}
