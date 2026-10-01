// Speech without audio (voiceMode 'off', or a TTS fallback): reveals the text
// at a comfortable reading pace while the mouth flaps from letter visemes.

import { textVisemes, visemeAt } from './lipsync.ts';
import type { SpeakHooks, SpeakOutcome } from './tts-player.ts';

const TICK_MS = 66;

/** Reading time for a line: about 15 chars/s, quicker for short lines. */
export function readingDurationMs(text: string): number {
  const n = text.length;
  const cps = n < 40 ? 20 : 15;
  return Math.max(700, Math.round((n / cps) * 1000));
}

export class PacedSpeaker {
  private current: { stop: () => void } | null = null;

  stop(): void {
    this.current?.stop();
  }

  speak(text: string, hooks: SpeakHooks, durationMs = readingDurationMs(text)): Promise<SpeakOutcome> {
    this.stop();
    const timeline = textVisemes(text, durationMs);
    const start = performance.now();
    return new Promise<SpeakOutcome>((resolve) => {
      let last = -1;
      const finish = (outcome: SpeakOutcome): void => {
        clearInterval(timer);
        if (this.current === handle) this.current = null;
        if (outcome === 'ended') hooks.onProgress(1);
        resolve(outcome);
      };
      const timer = setInterval(() => {
        const t = performance.now() - start;
        hooks.onProgress(Math.min(1, t / durationMs));
        const shape = visemeAt(timeline, t);
        if (shape !== last) {
          last = shape;
          hooks.onMouth(shape);
        }
        if (t >= durationMs) finish('ended');
      }, TICK_MS);
      const handle = { stop: () => finish('stopped') };
      this.current = handle;
    });
  }
}
