// Voice input: records one utterance with MediaRecorder and stops on a
// second click / Enter, after ~1.5 s of silence once speech was heard, after
// 8 s if no speech was heard at all (nothing is uploaded), or at a 30 s cap.
// When the level meter works but never heard speech, the clip is discarded
// ('empty') instead of being sent to speech-to-text, where silence tends to
// come back as a made-up phrase. Mic tracks are released as soon as
// recording ends.

import { LIMITS } from '../../shared/settings.ts';
import { rms } from './speech/lipsync.ts';

export type MicFailure = 'denied' | 'no-device' | 'unsupported' | 'failed';

export type RecordingResult =
  | { ok: true; audio: ArrayBuffer; mime: string }
  | { ok: false; reason: 'cancelled' | 'empty' | MicFailure };

const PREFERRED_MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
const MAX_MS = 30_000;
const SILENCE_STOP_MS = 1500;
/** Give up early when nothing that sounds like speech arrives (muted headset, quiet room). */
const NO_SPEECH_MS = 8000;
const SPEECH_LEVEL = 0.025;
const SILENCE_LEVEL = 0.012;
const SPEECH_MIN_MS = 150;
const POLL_MS = 50;

function failureOf(err: unknown): MicFailure {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') return 'no-device';
  return 'failed';
}

export class MicRecorder {
  private readonly getContext: () => AudioContext;
  private active: {
    stop: (cancel: boolean) => void;
  } | null = null;

  constructor(getContext: () => AudioContext) {
    this.getContext = getContext;
  }

  get recording(): boolean {
    return this.active !== null;
  }

  /** Ends the recording and transcribes what was captured. */
  stop(): void {
    this.active?.stop(false);
  }

  /** Ends the recording and discards it. */
  cancel(): void {
    this.active?.stop(true);
  }

  /** Records until stopped. Resolves once the recording is finished or failed. */
  async record(onStarted?: () => void): Promise<RecordingResult> {
    if (this.active) return { ok: false, reason: 'failed' };
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return { ok: false, reason: 'unsupported' };

    // Placeholder so a second click during the permission prompt cancels.
    let cancelledEarly = false;
    this.active = { stop: () => (cancelledEarly = true) };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (err) {
      this.active = null;
      return { ok: false, reason: failureOf(err) };
    }
    const release = (): void => {
      for (const t of stream.getTracks()) t.stop();
    };
    if (cancelledEarly) {
      release();
      this.active = null;
      return { ok: false, reason: 'cancelled' };
    }

    const mime = PREFERRED_MIME.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (err) {
      release();
      this.active = null;
      return { ok: false, reason: failureOf(err) };
    }

    // Level meter for silence detection.
    let analyser: AnalyserNode | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    try {
      const ctx = this.getContext();
      if (ctx.state === 'suspended') await ctx.resume();
      sourceNode = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      sourceNode.connect(analyser);
    } catch {
      analyser = null;
    }

    const chunks: Blob[] = [];
    let total = 0;
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0 && total + e.data.size <= LIMITS.sttBytes) {
        chunks.push(e.data);
        total += e.data.size;
      }
    };

    return new Promise<RecordingResult>((resolve) => {
      let cancelled = false;
      let finished = false;
      const startedAt = performance.now();
      let speechMs = 0;
      let heardSpeech = false;
      let silentSince = performance.now();
      const samples = new Float32Array(1024);

      const cleanup = (): void => {
        clearInterval(poll);
        sourceNode?.disconnect();
        analyser?.disconnect();
        release();
        this.active = null;
      };

      const end = (cancel: boolean): void => {
        if (finished) return;
        finished = true;
        cancelled = cancel;
        if (recorder.state !== 'inactive') {
          try {
            recorder.stop();
            return; // onstop resolves
          } catch {
            // fall through
          }
        }
        cleanup();
        resolve({ ok: false, reason: cancel ? 'cancelled' : 'failed' });
      };

      recorder.onstop = () => {
        cleanup();
        if (cancelled) return resolve({ ok: false, reason: 'cancelled' });
        const type = recorder.mimeType || mime || 'audio/webm';
        const blob = new Blob(chunks, { type });
        // With a working level meter, a clip without detected speech is silence: never upload it.
        if (blob.size === 0 || (analyser !== null && !heardSpeech)) return resolve({ ok: false, reason: 'empty' });
        blob.arrayBuffer().then(
          (audio) => resolve({ ok: true, audio, mime: type }),
          () => resolve({ ok: false, reason: 'failed' }),
        );
      };
      recorder.onerror = () => end(true);

      const poll = setInterval(() => {
        const now = performance.now();
        if (now - startedAt >= MAX_MS) return end(false);
        if (!analyser) return;
        analyser.getFloatTimeDomainData(samples);
        const level = rms(samples);
        if (level >= SPEECH_LEVEL) {
          speechMs += POLL_MS;
          if (speechMs >= SPEECH_MIN_MS) heardSpeech = true;
        }
        if (!heardSpeech && now - startedAt >= NO_SPEECH_MS) return end(false);
        if (level >= SILENCE_LEVEL) silentSince = now;
        else if (heardSpeech && now - silentSince >= SILENCE_STOP_MS) end(false);
      }, POLL_MS);

      this.active = { stop: (cancel) => end(cancel) };
      recorder.start(250);
      onStarted?.();
    });
  }
}
