// Static option lists and model helpers for the settings window.

import type { ReasoningEffort } from '../../../shared/settings.ts';

export const OPENAI_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const;

/** Voices that tts-1 and tts-1-hd support (no ballad, verse, marin, cedar). */
export const TTS1_VOICES: readonly string[] = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'];

export const TTS_MODEL_SUGGESTIONS: readonly string[] = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'];
export const STT_MODEL_SUGGESTIONS: readonly string[] = ['gpt-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'];

export const REASONING_OPTIONS: ReadonlyArray<{ value: ReasoningEffort; label: string }> = [
  { value: 'auto', label: 'Auto (provider default)' },
  { value: 'none', label: 'None (fastest)' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max (slowest)' },
];

export const SIZE_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: 'Small (1x)' },
  { value: 1.5, label: 'Medium (1.5x)' },
  { value: 2, label: 'Large (2x)' },
  { value: 3, label: 'Extra large (3x)' },
];

/** tts-1 and tts-1-hd (including dated snapshots) do not accept style instructions or the newer voices. */
export function isTts1Model(model: string): boolean {
  return /^tts-1(-hd)?($|-)/i.test(model.trim());
}

export function supportsTtsInstructions(model: string): boolean {
  return !isTts1Model(model);
}

export function voiceSupported(model: string, voice: string): boolean {
  return !isTts1Model(model) || TTS1_VOICES.includes(voice.toLowerCase());
}

/** Unique, trimmed, sorted list: server models first-class, suggestions always present. */
export function mergeModelOptions(fromServer: readonly string[], suggestions: readonly string[]): string[] {
  const set = new Set<string>();
  for (const m of [...suggestions, ...fromServer]) {
    const t = m.trim();
    if (t) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

export function sizeLabel(scale: number): string {
  return SIZE_OPTIONS.find((o) => o.value === scale)?.label ?? `Custom (${Number(scale.toFixed(2))}x)`;
}
