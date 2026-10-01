import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterController } from '../src/shared/character-controller.ts';
import { nextSharesPage, type RevealHandle } from '../src/renderer/agent/balloon.ts';
import { SpeechQueue, type QueueBalloon } from '../src/renderer/agent/speech/queue.ts';

interface StartCall {
  text: string;
  nextChars: number | undefined;
}

function fakeBalloon(): QueueBalloon & { starts: StartCall[] } {
  const starts: StartCall[] = [];
  const handle: RevealHandle = { setProgress: () => {}, complete: () => {} };
  return {
    starts,
    startItem: (text, _variant, nextChars) => {
      starts.push({ text, nextChars });
      return handle;
    },
    appendNote: () => {},
    newPage: () => {},
    scheduleHide: () => {},
    cancelHide: () => {},
    hide: () => {},
  };
}

function fakeCharacter(): CharacterController {
  const done = Promise.resolve();
  return {
    hasAnimation: () => false,
    play: async () => 'completed',
    beginSpeaking: () => done,
    endSpeaking: () => done,
    setMouth: () => {},
    stopAll: () => {},
  } as unknown as CharacterController;
}

function makeQueue(balloon = fakeBalloon()): { queue: SpeechQueue; balloon: ReturnType<typeof fakeBalloon>; drained: number[] } {
  const drained: number[] = [];
  const ch = fakeCharacter();
  const queue = new SpeechQueue({
    getCharacter: () => ch,
    balloon,
    getAudioContext: () => {
      throw new Error('no audio in paced mode');
    },
    synthesize: async () => ({ ok: false, error: { kind: 'unknown', message: 'unused' } }),
    // Voice off: paced text only, driven by timers.
    getVoice: () => ({ mode: 'off', volume: 0.8, hasApiKey: false, systemVoicePitch: 1 }),
    onSpoken: () => {},
    onDrained: () => drained.push(Date.now()),
  });
  return { queue, balloon, drained };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SpeechQueue onStart', () => {
  it('fires once per item, when that item starts playing', async () => {
    const { queue } = makeQueue();
    const started: string[] = [];
    queue.openStream();
    queue.enqueue({ text: 'First line here.', gestures: [] }, { onStart: () => started.push('a') });
    queue.enqueue({ text: 'Second line here.', gestures: [] }, { onStart: () => started.push('b') });
    queue.closeStream();
    await vi.advanceTimersByTimeAsync(10);
    // Only the first item has started; the second waits for its turn.
    expect(started).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started).toEqual(['a', 'b']);
    expect(queue.busy).toBe(false);
  });

  it('never fires for an item that stop() dropped', async () => {
    const { queue } = makeQueue();
    const started: string[] = [];
    queue.openStream();
    queue.enqueue({ text: 'First line here.', gestures: [] }, { onStart: () => started.push('a') });
    queue.enqueue({ text: 'Second line here.', gestures: [] }, { onStart: () => started.push('b') });
    queue.closeStream();
    await vi.advanceTimersByTimeAsync(10);
    queue.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started).toEqual(['a']);
  });
});

describe('SpeechQueue balloon sizing hint', () => {
  it('tells the balloon how long the next sentence is', async () => {
    const { queue, balloon } = makeQueue();
    const second = 'This second sentence is quite a bit longer than the first one.';
    queue.openStream();
    queue.enqueue({ text: 'Howdy, my friend!', gestures: [] });
    queue.enqueue({ text: second, gestures: [] });
    queue.closeStream();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(balloon.starts).toEqual([
      { text: 'Howdy, my friend!', nextChars: second.length },
      { text: second, nextChars: 0 },
    ]);
  });

  it('expects more text while the reply is still streaming', async () => {
    const { queue, balloon } = makeQueue();
    queue.openStream();
    queue.enqueue({ text: 'Howdy, my friend!', gestures: [] });
    await vi.advanceTimersByTimeAsync(10);
    expect(balloon.starts[0]).toEqual({ text: 'Howdy, my friend!', nextChars: 1 });
    queue.closeStream();
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it('a single local line keeps its natural width', async () => {
    const { queue, balloon } = makeQueue();
    queue.openStream();
    queue.enqueue({ text: 'Fresh start!', gestures: [] });
    queue.closeStream();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(balloon.starts[0]).toEqual({ text: 'Fresh start!', nextChars: 0 });
  });
});

describe('nextSharesPage', () => {
  it('is true only when the next sentence lands on the same page', () => {
    expect(nextSharesPage(17, 0)).toBe(false);
    expect(nextSharesPage(17, 60)).toBe(true);
    // 280 characters per page: 200 + 1 space + 79 fits, 80 starts a new page.
    expect(nextSharesPage(200, 79)).toBe(true);
    expect(nextSharesPage(200, 80)).toBe(false);
  });
});
