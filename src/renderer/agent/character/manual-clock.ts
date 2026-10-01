// A deterministic SchedulerClock for tests and offline stepping. Timers fire
// in time order (ties in creation order) only when advance() is called.

import type { SchedulerClock } from './scheduler.ts';

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
}

export class ManualClock implements SchedulerClock {
  private t: number;
  private seq = 0;
  private readonly timers = new Map<number, Timer>();
  /** Extra delay added to every timer, to simulate a busy event loop. */
  lateness = 0;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms) + this.lateness, seq: id, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle);
  }

  pending(): number {
    return this.timers.size;
  }

  /**
   * Advances time by `ms`, firing due timers in order. `flush` is awaited
   * before and after each timer so promise continuations run at the right time.
   */
  async advance(ms: number, flush: () => Promise<void> = flushMicrotasks): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flush();
      let next: [number, Timer] | null = null;
      for (const e of this.timers) {
        if (e[1].at > end) continue;
        if (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[1].seq < next[1].seq)) next = e;
      }
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
    }
    this.t = end;
    await flush();
  }
}

/** Lets pending promise continuations run (several rounds of microtasks). */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
