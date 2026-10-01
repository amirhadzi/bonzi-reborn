// Voice previews: OpenAI TTS and Windows (SAPI) voice WAVs played through Web Audio.

export const PREVIEW_LINES: readonly string[] = [
  "Hiya! I'm Bonzi, your purple pal. This time I'm squeaky clean, no toolbars, I promise!",
  'Well hello there, friend! Want to hear a joke? Why did the banana go to the doctor? It was not peeling well!',
  "Ooh, a new voice! How do I sound? Pretty groovy, if you ask me. Let's explore together!",
];

export function pickPreviewLine(random: () => number = Math.random): string {
  return PREVIEW_LINES[Math.floor(random() * PREVIEW_LINES.length)] ?? PREVIEW_LINES[0] ?? 'Hello!';
}

export class AudioPreview {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private finish: (() => void) | null = null;

  get playing(): boolean {
    return this.source !== null;
  }

  /**
   * Decodes and plays a whole audio file. Resolves when playback ends or is stopped.
   * playbackRate raises the pitch of the Windows voice (main already slowed it down).
   */
  async play(data: ArrayBuffer, volume: number, playbackRate = 1): Promise<void> {
    this.stop();
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    // decodeAudioData detaches its input; keep the caller's buffer intact.
    const buffer = await this.ctx.decodeAudioData(data.slice(0));
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = Number.isFinite(playbackRate) ? Math.min(4, Math.max(0.25, playbackRate)) : 1;
    const gain = this.ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, volume));
    src.connect(gain).connect(this.ctx.destination);
    this.source = src;
    return new Promise<void>((resolve) => {
      const done = (): void => {
        if (this.source === src) this.source = null;
        this.finish = null;
        resolve();
      };
      this.finish = done;
      src.onended = done;
      src.start();
    });
  }

  stop(): void {
    const src = this.source;
    this.source = null;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    this.finish?.();
  }
}
