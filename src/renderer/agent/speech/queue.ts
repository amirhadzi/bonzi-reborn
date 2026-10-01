// Speech queue: sentences go in as they complete; audio is prefetched (max 2
// in flight) and items play strictly in order: gesture, beginSpeaking, audio
// with lip-sync and balloon reveal, endSpeaking. stop() cancels everything
// and makes late synthesis results harmless.
//
// Engines per item follow speechEngineChain(): OpenAI TTS, then the Windows
// (SAPI) voice rendered by main, then paced silent text. Both audio engines
// play through the same TtsPlayer (AnalyserNode lip-sync).

import type { CharacterController } from '../../../shared/character-controller.ts';
import { resolveGesture } from '../../../shared/gestures.ts';
import type { AiError, TtsEngine, TtsRequest, TtsResult } from '../../../shared/ipc.ts';
import { LIMITS, type VoiceMode } from '../../../shared/settings.ts';
import { playbackRateForPitch } from '../../../shared/voice-tuning.ts';
import type { BalloonVariant, RevealHandle } from '../balloon.ts';
import { ttsNote } from '../lines.ts';
import { cleanSpeechText } from './clean.ts';
import { speechEngineChain, type SpeechEngine } from './engine-chain.ts';
import { PacedSpeaker } from './paced.ts';
import { TtsPlayer, type SpeakHooks, type SpeakOutcome } from './tts-player.ts';

export interface VoiceSettings {
  mode: VoiceMode;
  volume: number;
  /** An OpenAI key is configured (OpenAI TTS is only tried when true). */
  hasApiKey: boolean;
  systemVoicePitch: number;
}

export interface QueueBalloon {
  /** nextChars: length of the sentence expected after this one (0: none), so the balloon can size the page once. */
  startItem(text: string, variant?: BalloonVariant, nextChars?: number): RevealHandle;
  appendNote(text: string): void;
  newPage(): void;
  scheduleHide(ms: number): void;
  cancelHide(): void;
  hide(immediate?: boolean): void;
}

export interface SpokenItem {
  text: string;
  gestures: string[];
}

/** One playback attempt, for the dev-only __bonziDebug.audioLog. */
export interface AudioLogEntry {
  engine: SpeechEngine;
  outcome: SpeakOutcome;
  /** Audio length as heard (paced: the reading time actually spent). */
  durationMs: number;
  /** Highest RMS the analyser saw; 0 for paced text. */
  peakRms: number;
  chars: number;
  at: number;
}

export interface SpeechQueueDeps {
  getCharacter(): CharacterController | null;
  balloon: QueueBalloon;
  getAudioContext(): AudioContext;
  synthesize(req: TtsRequest): Promise<TtsResult>;
  getVoice(): VoiceSettings;
  /** Every item that was (at least partly) shown or spoken. */
  onSpoken(item: SpokenItem): void;
  /** Called once the queue is empty and no more items are expected. */
  onDrained(): void;
  onTtsError?(error: AiError): void;
  onAudio?(entry: AudioLogEntry): void;
}

export interface EnqueueOptions {
  /**
   * Allow OpenAI TTS for this item. Items that opt out (local error lines) are
   * still spoken aloud with the Windows voice.
   */
  tts?: boolean;
  variant?: BalloonVariant;
  /** Called once when the item starts playing (shown or spoken); never after stop(). */
  onStart?: () => void;
}

interface Entry {
  text: string;
  gestures: string[];
  allowOpenAi: boolean;
  variant: BalloonVariant;
  onStart: (() => void) | null;
  synth: { engine: TtsEngine; result: Promise<TtsResult> } | null;
}

interface Synthesized {
  /** null: no engine produced audio, use paced text. */
  audio: ArrayBuffer | null;
  engine: SpeechEngine;
  /** Set when OpenAI TTS was tried and failed for this item. */
  openAiError: AiError | null;
}

/** Balloon stays up this long after the last item. */
export const HIDE_AFTER_MS = 2500;
const MAX_IN_FLIGHT = 2;

export class SpeechQueue {
  private readonly deps: SpeechQueueDeps;
  private readonly player: TtsPlayer;
  private readonly paced = new PacedSpeaker();
  private entries: Entry[] = [];
  private gen = 0;
  private streaming = false;
  private running = false;
  private inFlight = 0;
  private ttsBroken = false;
  private systemBroken = false;
  private readonly notedKinds = new Set<string>();
  private wake: (() => void) | null = null;
  private speaking = false;

  constructor(deps: SpeechQueueDeps) {
    this.deps = deps;
    this.player = new TtsPlayer(deps.getAudioContext);
  }

  /** True while anything is playing, queued, or expected. */
  get busy(): boolean {
    return this.running || this.entries.length > 0 || this.streaming;
  }

  /** A new turn begins: more items will follow until closeStream(). */
  openStream(newPage = true): void {
    this.streaming = true;
    this.ttsBroken = false;
    this.systemBroken = false;
    this.deps.balloon.cancelHide();
    if (newPage) this.deps.balloon.newPage();
  }

  closeStream(): void {
    this.streaming = false;
    this.kick();
    if (!this.running) this.finishIfIdle();
  }

  enqueue(item: SpokenItem, options: EnqueueOptions = {}): void {
    const text = cleanSpeechText(item.text);
    if (!text && item.gestures.length === 0) return;
    this.entries.push({
      text,
      gestures: item.gestures,
      allowOpenAi: options.tts ?? true,
      variant: options.variant ?? 'normal',
      onStart: options.onStart ?? null,
      synth: null,
    });
    this.deps.balloon.cancelHide();
    this.pump();
    this.kick();
    if (!this.running) void this.run(this.gen);
  }

  /**
   * Stops speech, clears the queue and ignores late TTS results.
   * resetCharacter: also interrupt the character's animations (user interrupt).
   */
  stop(options: { resetCharacter?: boolean; hideBalloon?: boolean } = {}): void {
    this.gen++;
    this.entries = [];
    this.streaming = false;
    this.running = false;
    this.inFlight = 0;
    this.player.stop();
    this.paced.stop();
    this.kick();
    const ch = this.deps.getCharacter();
    if (ch) {
      if (options.resetCharacter) ch.stopAll();
      else if (this.speaking) void ch.endSpeaking();
    }
    this.speaking = false;
    if (options.hideBalloon ?? true) this.deps.balloon.hide();
  }

  private kick(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private chainFor(e: Entry): SpeechEngine[] {
    const v = this.deps.getVoice();
    return speechEngineChain({
      mode: v.mode,
      hasApiKey: v.hasApiKey,
      allowOpenAi: e.allowOpenAi,
      openAiBroken: this.ttsBroken,
      systemBroken: this.systemBroken,
    });
  }

  /** Prefetches audio for upcoming entries with their first-choice engine. */
  private pump(): void {
    for (const e of this.entries) {
      if (this.inFlight >= MAX_IN_FLIGHT) break;
      if (e.synth || !e.text) continue;
      const first = this.chainFor(e)[0];
      if (first && first !== 'paced') this.startSynth(e, first);
    }
  }

  private startSynth(e: Entry, engine: TtsEngine): void {
    const g = this.gen;
    this.inFlight++;
    const text = e.text.slice(0, LIMITS.ttsText);
    const req: TtsRequest = engine === 'system' ? { text, engine: 'system' } : { text };
    const result = this.deps
      .synthesize(req)
      .catch((err: unknown): TtsResult => ({ ok: false, error: { kind: 'unknown', message: String(err) } }))
      .finally(() => {
        if (g !== this.gen) return;
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.pump();
      });
    e.synth = { engine, result };
  }

  private async run(gen: number): Promise<void> {
    this.running = true;
    try {
      while (gen === this.gen) {
        const entry = this.entries.shift();
        if (!entry) {
          if (this.streaming) {
            await new Promise<void>((r) => (this.wake = r));
            continue;
          }
          break;
        }
        await this.playEntry(entry, gen);
      }
    } catch (err) {
      console.error('speech queue failed', err);
    } finally {
      if (gen === this.gen) {
        this.running = false;
        this.finishIfIdle();
      }
    }
  }

  private finishIfIdle(): void {
    if (this.running || this.streaming || this.entries.length > 0) return;
    this.deps.balloon.scheduleHide(HIDE_AFTER_MS);
    this.deps.onDrained();
  }

  /** Tries the audio engines in order; returns the first audio that synthesized. */
  private async synthesizeFor(entry: Entry, stale: () => boolean): Promise<Synthesized | null> {
    let openAiError: AiError | null = null;
    for (const engine of this.chainFor(entry)) {
      if (engine === 'paced') break;
      if (!entry.synth || entry.synth.engine !== engine) this.startSynth(entry, engine);
      const res = await entry.synth!.result;
      if (stale()) return null;
      if (res.ok) return { audio: res.audio, engine, openAiError };
      if (engine === 'openai') {
        this.ttsBroken = true;
        openAiError = res.error;
      } else if (res.error.kind !== 'cancelled') {
        this.systemBroken = true;
      }
    }
    return { audio: null, engine: 'paced', openAiError };
  }

  private async playEntry(entry: Entry, gen: number): Promise<void> {
    const stale = (): boolean => gen !== this.gen;
    const ch = this.deps.getCharacter();

    let gesture: string | null = null;
    if (ch) {
      for (const tag of entry.gestures) {
        gesture = resolveGesture(tag, (n) => ch.hasAnimation(n));
        if (gesture) break;
      }
      if (gesture) void ch.play(gesture);
    }
    if (!entry.text) {
      this.deps.onSpoken({ text: '', gestures: entry.gestures });
      entry.onStart?.();
      return;
    }

    const voice = this.deps.getVoice();
    const synth = await this.synthesizeFor(entry, stale);
    if (!synth || stale()) return;
    const { audio, engine } = synth;
    const note = synth.openAiError ? this.onTtsFailure(synth.openAiError, engine === 'system') : null;

    if (ch) {
      await ch.beginSpeaking();
      if (stale()) return;
      this.speaking = true;
    }

    // Tell the balloon how much text follows, so a short first sentence does not
    // open a narrow bubble that jumps wider when the next one arrives. While the
    // reply is still streaming, more text is likely even if none has arrived yet.
    const next = this.entries.find((e) => e.text);
    const nextChars = next ? next.text.length : this.streaming ? 1 : 0;
    const handle = this.deps.balloon.startItem(entry.text, entry.variant, nextChars);
    // Show the first word right away so the balloon never appears empty while audio decodes.
    handle.setProgress(Number.EPSILON);
    if (note) this.deps.balloon.appendNote(note);
    this.deps.onSpoken({ text: entry.text, gestures: entry.gestures });
    if (!stale()) entry.onStart?.();
    const hooks: SpeakHooks = {
      onProgress: (f) => {
        if (!stale()) handle.setProgress(f);
      },
      onMouth: (shape) => {
        if (!stale()) ch?.setMouth(shape);
      },
    };

    let outcome: SpeakOutcome = 'failed';
    if (audio && engine !== 'paced') {
      const playbackRate = engine === 'system' ? playbackRateForPitch(voice.systemVoicePitch) : 1;
      outcome = await this.player.play(audio, voice.volume, hooks, { playbackRate });
      const stats = this.player.lastStats;
      this.logAudio(engine, outcome, stats?.durationMs ?? 0, stats?.peakRms ?? 0, entry.text.length);
      if (outcome === 'failed' && !stale()) {
        if (engine === 'openai') this.ttsBroken = true;
        else this.systemBroken = true;
      }
    }
    if (outcome === 'failed' && !stale()) {
      const t0 = performance.now();
      outcome = await this.paced.speak(entry.text, hooks);
      this.logAudio('paced', outcome, Math.round(performance.now() - t0), 0, entry.text.length);
    }

    if (stale()) return;
    handle.complete();
    if (ch) {
      this.speaking = false;
      ch.setMouth(null);
      await ch.endSpeaking();
    }
  }

  private logAudio(engine: SpeechEngine, outcome: SpeakOutcome, durationMs: number, peakRms: number, chars: number): void {
    this.deps.onAudio?.({ engine, outcome, durationMs, peakRms, chars, at: Date.now() });
  }

  /** Reports an OpenAI TTS failure; returns a note to show once per session and kind. */
  private onTtsFailure(error: AiError, fellBackToSystem: boolean): string | null {
    if (error.kind === 'cancelled') return null;
    this.deps.onTtsError?.(error);
    const note = ttsNote(error.kind, fellBackToSystem);
    if (!note || this.notedKinds.has(error.kind)) return null;
    this.notedKinds.add(error.kind);
    return note;
  }
}
