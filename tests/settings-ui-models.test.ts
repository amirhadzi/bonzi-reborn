import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce } from '../src/renderer/settings/lib/debounce.ts';
import {
  OPENAI_VOICES,
  SIZE_OPTIONS,
  TTS1_VOICES,
  isTts1Model,
  mergeModelOptions,
  sizeLabel,
  supportsTtsInstructions,
  voiceSupported,
} from '../src/renderer/settings/lib/models.ts';

describe('TTS model helpers', () => {
  it('detects tts-1 family models', () => {
    expect(isTts1Model('tts-1')).toBe(true);
    expect(isTts1Model('tts-1-hd')).toBe(true);
    expect(isTts1Model('tts-1-hd-1106')).toBe(true);
    expect(isTts1Model(' TTS-1 ')).toBe(true);
    expect(isTts1Model('gpt-4o-mini-tts')).toBe(false);
    expect(isTts1Model('tts-10')).toBe(false);
  });

  it('knows which features tts-1 lacks', () => {
    expect(supportsTtsInstructions('gpt-4o-mini-tts')).toBe(true);
    expect(supportsTtsInstructions('tts-1-hd')).toBe(false);
    expect(voiceSupported('tts-1', 'cedar')).toBe(false);
    expect(voiceSupported('tts-1', 'alloy')).toBe(true);
    expect(voiceSupported('gpt-4o-mini-tts', 'cedar')).toBe(true);
    expect(OPENAI_VOICES).toHaveLength(13);
    expect(TTS1_VOICES).toHaveLength(9);
  });
});

describe('mergeModelOptions', () => {
  it('dedupes, trims and sorts with suggestions included', () => {
    expect(mergeModelOptions(['whisper-1', ' gpt-transcribe ', ''], ['gpt-transcribe', 'gpt-4o-mini-transcribe'])).toEqual([
      'gpt-4o-mini-transcribe',
      'gpt-transcribe',
      'whisper-1',
    ]);
  });

  it('sorts numerically', () => {
    expect(mergeModelOptions(['gpt-10', 'gpt-9'], [])).toEqual(['gpt-9', 'gpt-10']);
  });
});

describe('sizes', () => {
  it('labels known and custom scales', () => {
    expect(SIZE_OPTIONS.map((o) => o.value)).toEqual([1, 1.5, 2, 3]);
    expect(sizeLabel(1.5)).toBe('Medium (1.5x)');
    expect(sizeLabel(1.25)).toBe('Custom (1.25x)');
  });
});

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once with the last arguments', () => {
    const fn = vi.fn();
    const d = debounce(fn, 400);
    d(1);
    d(2);
    expect(d.pending()).toBe(true);
    vi.advanceTimersByTime(399);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2);
    expect(d.pending()).toBe(false);
  });

  it('flushes and cancels', () => {
    const fn = vi.fn();
    const d = debounce(fn, 400);
    d('a');
    d.flush();
    expect(fn).toHaveBeenCalledWith('a');
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    d('b');
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
