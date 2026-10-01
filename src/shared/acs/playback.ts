/**
 * Pure helpers implementing MS Agent frame sequencing, so the app's
 * animation player does not have to rediscover the rules. No timers here:
 * the caller owns the clock.
 *
 * Rules (verified against Bonzi.acs data, see docs/ACS-NOTES.md):
 *  - Normal play: after a frame's duration, roll r in [0,100). Walk the
 *    frame's branches accumulating probability; the first branch whose
 *    cumulative probability exceeds r wins. If none wins (probabilities sum
 *    to < 100, or there are no branches) go to index + 1.
 *  - Reaching index === frames.length means the animation has ended.
 *  - Exiting (the app wants the animation to finish early, e.g. to start
 *    another one): ignore branches; go to exitFrameIndex when it is >= 0,
 *    otherwise index + 1. A self-referencing exit index (SHOW frame 26 points
 *    at itself) or any revisited frame is treated as "ended".
 *  - transitionType 0 (RETURN_ANIMATION): when the animation ends or is
 *    exited, play `returnAnimation` (if it exists) to get back to rest.
 *    transitionType 1 (EXIT_BRANCHES): exit by following exit indexes.
 *    transitionType 2 (NONE): just stop.
 *  - Trailing frames with no images and duration 0 are end markers: keep
 *    showing the previous frame rather than an empty one.
 */

import type { AcsAnimation, AcsCharacter } from './types.ts';

/** Returns the next frame index during normal play, or frames.length when the animation ends. */
export function pickNextFrame(anim: AcsAnimation, index: number, random: () => number = Math.random): number {
  const frame = anim.frames[index];
  if (!frame) return anim.frames.length;
  if (frame.branches.length) {
    const r = random() * 100;
    let acc = 0;
    for (const b of frame.branches) {
      acc += b.probability;
      if (r < acc) return clampIndex(anim, b.frameIndex);
    }
  }
  return index + 1;
}

/** Returns the next frame index while exiting, or frames.length when done. */
export function exitNextFrame(anim: AcsAnimation, index: number): number {
  const frame = anim.frames[index];
  if (!frame) return anim.frames.length;
  if (frame.exitFrameIndex >= 0) {
    if (frame.exitFrameIndex === index) return anim.frames.length;
    return clampIndex(anim, frame.exitFrameIndex);
  }
  return index + 1;
}

/**
 * The full list of frames visited when exiting from `index` (excluding
 * `index` itself), ending before the end of the animation. Cycles end the path.
 */
export function exitPath(anim: AcsAnimation, index: number): number[] {
  const path: number[] = [];
  const seen = new Set<number>([index]);
  let i = exitNextFrame(anim, index);
  while (i < anim.frames.length && !seen.has(i)) {
    seen.add(i);
    path.push(i);
    i = exitNextFrame(anim, i);
  }
  return path;
}

/** True when the frame is a pure end marker (no images, zero duration). */
export function isEndMarker(anim: AcsAnimation, index: number): boolean {
  const f = anim.frames[index];
  return !!f && f.images.length === 0 && f.duration === 0;
}

/**
 * True when normal play can reach the end of the animation from frame 0.
 * False means the animation loops forever (e.g. READING, SEARCHING,
 * LOOKDOWN, HEADPHONESCONTINUED) and must be exited/interrupted by the app.
 */
export function canEndNaturally(anim: AcsAnimation): boolean {
  const n = anim.frames.length;
  if (n === 0) return true;
  const seen = new Set<number>();
  const stack = [0];
  while (stack.length) {
    const i = stack.pop()!;
    if (i >= n) return true;
    if (seen.has(i)) continue;
    seen.add(i);
    const f = anim.frames[i]!;
    let total = 0;
    for (const b of f.branches) {
      if (b.probability > 0) stack.push(clampIndex(anim, b.frameIndex));
      total += b.probability;
    }
    if (total < 100) stack.push(i + 1);
  }
  return false;
}

/** True when some branch can jump backwards (to the same or an earlier frame). */
export function hasLoop(anim: AcsAnimation): boolean {
  return anim.frames.some((f, i) => f.branches.some((b) => b.probability > 0 && b.frameIndex <= i));
}

/** Resolves the animation to play after `anim` finishes (return animation), if any. */
export function getReturnAnimation(character: AcsCharacter, anim: AcsAnimation): AcsAnimation | undefined {
  if (anim.transitionType !== 0 || !anim.returnAnimation) return undefined;
  return character.animationsByName.get(anim.returnAnimation.toLowerCase());
}

/** Picks a random animation for a state (e.g. 'IDLINGLEVEL1'), case-insensitive. */
export function animationsForState(character: AcsCharacter, state: string): AcsAnimation[] {
  const key = Object.keys(character.info.states).find((k) => k.toLowerCase() === state.toLowerCase());
  if (!key) return [];
  const out: AcsAnimation[] = [];
  for (const name of character.info.states[key] ?? []) {
    const a = character.animationsByName.get(name.toLowerCase());
    if (a) out.push(a);
  }
  return out;
}

function clampIndex(anim: AcsAnimation, i: number): number {
  return i < 0 || i >= anim.frames.length ? anim.frames.length : i;
}
