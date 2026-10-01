import { describe, expect, it } from 'vitest';
import { TagParser, extractTags, type TagToken } from '../src/renderer/agent/speech/tags.ts';

function run(chunks: readonly string[]): TagToken[] {
  const p = new TagParser();
  const out: TagToken[] = [];
  for (const c of chunks) out.push(...p.push(c));
  out.push(...p.flush());
  return out;
}

function summarize(tokens: readonly TagToken[]): { text: string; tags: Array<[string, number]> } {
  let text = '';
  const tags: Array<[string, number]> = [];
  for (const t of tokens) {
    if (t.type === 'text') {
      expect(t.pos).toBe(text.length);
      text += t.text;
    } else tags.push([t.name, t.pos]);
  }
  return { text, tags };
}

function bytewise(s: string): string[] {
  return [...s];
}

describe('TagParser', () => {
  it('parses a simple tag', () => {
    expect(summarize(run(['[[Wave]] Hi there!']))).toEqual({ text: ' Hi there!', tags: [['Wave', 0]] });
  });

  it('handles tags split across deltas', () => {
    expect(summarize(run(['[', '[Wa', 've]] Hi']))).toEqual({ text: ' Hi', tags: [['Wave', 0]] });
    expect(summarize(run(['Hello [[Plea', 'sed]', '] you']))).toEqual({ text: 'Hello  you', tags: [['Pleased', 6]] });
  });

  it('gives the same result for any chunking (byte by byte)', () => {
    const input = 'Hey [[Wave]] there! A [b] [[not a tag!]] and [[Pleased]]. [x]] [[ Excited ]] end [';
    const whole = summarize(run([input]));
    expect(summarize(run(bytewise(input)))).toEqual(whole);
    for (let cut = 1; cut < input.length; cut++) {
      expect(summarize(run([input.slice(0, cut), input.slice(cut)]))).toEqual(whole);
    }
    expect(whole.tags.map((t) => t[0])).toEqual(['Wave', 'Pleased', 'Excited']);
    expect(whole.text).toBe('Hey  there! A [b] [[not a tag!]] and . [x]]  end [');
  });

  it('passes plain brackets through', () => {
    expect(extractTags('array[0] and [link](x) and [[1]] and a]]b')).toEqual({
      text: 'array[0] and [link](x) and [[1]] and a]]b',
      tags: [],
    });
  });

  it('strips unknown but well-formed tags (they are still tags)', () => {
    expect(extractTags('[[Dance]]Go!')).toEqual({ text: 'Go!', tags: ['Dance'] });
  });

  it('treats tags longer than 40 characters as text', () => {
    const long = `[[${'A'.repeat(41)}]]`;
    expect(extractTags(long)).toEqual({ text: long, tags: [] });
    const ok = `[[${'A'.repeat(40)}]]`;
    expect(extractTags(ok).tags).toHaveLength(1);
    // Streaming: a long run without a close is released as text before the end.
    const p = new TagParser();
    const out = p.push(`[[${'B'.repeat(45)}`);
    expect(out.map((t) => (t.type === 'text' ? t.text : '')).join('')).toBe(`[[${'B'.repeat(45)}`);
  });

  it('releases text as soon as it cannot be a tag', () => {
    const p = new TagParser();
    expect(p.push('Hi [')).toEqual([{ type: 'text', text: 'Hi ', pos: 0 }]);
    expect(p.push('x')).toEqual([{ type: 'text', text: '[x', pos: 3 }]);
    expect(p.push('[[Wave')).toEqual([]);
    expect(p.push('!')).toEqual([{ type: 'text', text: '[[Wave!', pos: 5 }]);
  });

  it('handles triple brackets and empty tags', () => {
    expect(extractTags('[[[Wave]]x')).toEqual({ text: '[x', tags: ['Wave'] });
    expect(extractTags('[[]] [[  ]]')).toEqual({ text: '[[]] [[  ]]', tags: [] });
  });

  it('flushes a half-open tag as text', () => {
    expect(summarize(run(['Bye [[Wav']))).toEqual({ text: 'Bye [[Wav', tags: [] });
    expect(summarize(run(['Bye [']))).toEqual({ text: 'Bye [', tags: [] });
  });
});
