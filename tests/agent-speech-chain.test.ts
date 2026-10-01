import { describe, expect, it } from 'vitest';
import { speechEngineChain, type EngineChainInput } from '../src/renderer/agent/speech/engine-chain.ts';

const base: EngineChainInput = { mode: 'openai', hasApiKey: true, allowOpenAi: true, openAiBroken: false, systemBroken: false };
const chain = (o: Partial<EngineChainInput>) => speechEngineChain({ ...base, ...o });

describe('speech engine fallback chain', () => {
  it("voiceMode 'openai' tries OpenAI, then the Windows voice, then paced text", () => {
    expect(chain({})).toEqual(['openai', 'system', 'paced']);
  });

  it('without a key (first-run intro, no-key line) Bonzi still speaks with the Windows voice', () => {
    expect(chain({ hasApiKey: false })).toEqual(['system', 'paced']);
  });

  it('local error lines skip OpenAI so they are audible when OpenAI is the problem', () => {
    expect(chain({ allowOpenAi: false })).toEqual(['system', 'paced']);
  });

  it('after OpenAI TTS failed this turn the rest of the turn uses the Windows voice', () => {
    expect(chain({ openAiBroken: true })).toEqual(['system', 'paced']);
  });

  it('when the Windows voice also failed only paced text is left', () => {
    expect(chain({ openAiBroken: true, systemBroken: true })).toEqual(['paced']);
    expect(chain({ systemBroken: true })).toEqual(['openai', 'paced']);
  });

  it("voiceMode 'system' never uses OpenAI", () => {
    expect(chain({ mode: 'system' })).toEqual(['system', 'paced']);
    expect(chain({ mode: 'system', hasApiKey: false, allowOpenAi: false })).toEqual(['system', 'paced']);
    expect(chain({ mode: 'system', systemBroken: true })).toEqual(['paced']);
  });

  it("voiceMode 'off' is always silent", () => {
    for (const hasApiKey of [true, false]) {
      for (const allowOpenAi of [true, false]) {
        expect(chain({ mode: 'off', hasApiKey, allowOpenAi })).toEqual(['paced']);
      }
    }
  });

  it('always ends with paced text so a line is never lost', () => {
    const modes = ['openai', 'system', 'off'] as const;
    for (const mode of modes) {
      for (let bits = 0; bits < 16; bits++) {
        const c = chain({ mode, hasApiKey: !!(bits & 1), allowOpenAi: !!(bits & 2), openAiBroken: !!(bits & 4), systemBroken: !!(bits & 8) });
        expect(c.at(-1)).toBe('paced');
        expect(new Set(c).size).toBe(c.length);
      }
    }
  });
});
