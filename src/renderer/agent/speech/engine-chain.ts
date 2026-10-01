// Which engines may speak an item, in the order they are tried. Pure, so the
// fallback rules are unit-tested without Web Audio or IPC.
//
//   voiceMode 'openai': OpenAI TTS (key present, item allows it, not broken this
//                       turn), then the Windows voice, then paced silent text.
//   voiceMode 'system': the Windows voice, then paced silent text.
//   voiceMode 'off':    paced silent text only.

import type { VoiceMode } from '../../../shared/settings.ts';

export type SpeechEngine = 'openai' | 'system' | 'paced';

export interface EngineChainInput {
  mode: VoiceMode;
  hasApiKey: boolean;
  /** The item may use OpenAI TTS (local error lines opt out so they are audible when OpenAI is the problem). */
  allowOpenAi: boolean;
  /** OpenAI TTS failed earlier in this turn. */
  openAiBroken: boolean;
  /** The Windows voice failed earlier in this turn. */
  systemBroken: boolean;
}

export function speechEngineChain(i: EngineChainInput): SpeechEngine[] {
  if (i.mode === 'off') return ['paced'];
  const chain: SpeechEngine[] = [];
  if (i.mode === 'openai' && i.hasApiKey && i.allowOpenAi && !i.openAiBroken) chain.push('openai');
  if (!i.systemBroken) chain.push('system');
  chain.push('paced');
  return chain;
}
