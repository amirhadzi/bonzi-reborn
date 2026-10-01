import { describe, expect, it } from 'vitest';
import { SentenceSplitter, type SpeechItem } from '../src/renderer/agent/speech/sentences.ts';
import { TagParser } from '../src/renderer/agent/speech/tags.ts';

function split(chunks: readonly string[], maxLength?: number): SpeechItem[] {
  const tags = new TagParser();
  const s = new SentenceSplitter(maxLength ? { maxLength } : {});
  const out: SpeechItem[] = [];
  for (const c of chunks) out.push(...s.push(tags.push(c)));
  out.push(...s.push(tags.flush()));
  out.push(...s.flush());
  return out;
}

const texts = (items: readonly SpeechItem[]): string[] => items.map((i) => i.text);

describe('SentenceSplitter', () => {
  it('splits on sentence punctuation followed by space', () => {
    expect(texts(split(['Hello there! How are you? I am fine.']))).toEqual(['Hello there!', 'How are you?', 'I am fine.']);
  });

  it('streams: emits sentences as soon as they are known', () => {
    const tags = new TagParser();
    const s = new SentenceSplitter();
    expect(s.push(tags.push('Hi there.'))).toEqual([]);
    expect(s.push(tags.push(' How'))).toEqual([{ text: 'Hi there.', gestures: [] }]);
    expect(s.push(tags.push(' are you?'))).toEqual([]);
    expect(s.flush()).toEqual([{ text: 'How are you?', gestures: [] }]);
  });

  it('gives the same result byte by byte', () => {
    const input = '[[Wave]] Hi! Pi is 3.14, e.g. close to 3. Meet Dr. Smith at 10.30 today... Really?! Yes.\nNew line [[Pleased]] here';
    const whole = split([input]);
    expect(split([...input])).toEqual(whole);
    expect(whole).toEqual([
      { text: 'Hi!', gestures: ['Wave'] },
      { text: 'Pi is 3.14, e.g. close to 3.', gestures: [] },
      { text: 'Meet Dr. Smith at 10.30 today...', gestures: [] },
      { text: 'Really?!', gestures: [] },
      { text: 'Yes.', gestures: [] },
      { text: 'New line  here', gestures: ['Pleased'] },
    ]);
  });

  it('runs of punctuation stay together', () => {
    expect(texts(split(['Wait... what?! No way!!! OK.']))).toEqual(['Wait...', 'what?!', 'No way!!!', 'OK.']);
  });

  it('does not split abbreviations, initials, decimals or times', () => {
    expect(texts(split(['Mr. and Mrs. Jones vs. St. Bob, i.e. me, etc. are here. J. R. R. Tolkien wrote it. It costs 2.50 at 9.45.']))).toEqual([
      'Mr. and Mrs. Jones vs. St. Bob, i.e. me, etc. are here.',
      'J. R. R. Tolkien wrote it.',
      'It costs 2.50 at 9.45.',
    ]);
  });

  it('keeps quoted sentences together until the closing quote', () => {
    expect(texts(split(['He said "Hi. How are you?" and left. Then "Bye!" Done.']))).toEqual([
      'He said "Hi. How are you?"',
      'and left.',
      'Then "Bye!"',
      'Done.',
    ]);
    expect(texts(split(['"One. Two." Three.']))).toEqual(['"One. Two."', 'Three.']);
    expect(texts(split(['She said “Stop. Now.” Then ran.']))).toEqual(['She said “Stop. Now.”', 'Then ran.']);
  });

  it('splits on newlines and skips empty lines', () => {
    expect(texts(split(['First line\n\nSecond line\r\n- third']))).toEqual(['First line', 'Second line', '- third']);
  });

  it('keeps numbered list markers attached', () => {
    expect(texts(split(['1. Bananas are great.\n2. So are apples.']))).toEqual(['1. Bananas are great.', '2. So are apples.']);
  });

  it('assigns gestures to the sentence they precede or appear in', () => {
    const items = split(['Hello there![[Wave]] Nice to [[Pleased]]see you. [[Laugh]]']);
    expect(items).toEqual([
      { text: 'Hello there!', gestures: [] },
      { text: 'Nice to see you.', gestures: ['Wave', 'Pleased'] },
      { text: '', gestures: ['Laugh'] },
    ]);
  });

  it('carries gestures over empty sentences', () => {
    expect(split(['[[Wave]]\n\nHi!'])).toEqual([{ text: 'Hi!', gestures: ['Wave'] }]);
    expect(split(['[[Wave]]... Hi!'])).toEqual([{ text: 'Hi!', gestures: ['Wave'] }]);
  });

  it('cuts very long sentences at a comma or space', () => {
    const a = 'word '.repeat(10) + 'and then, ';
    const long = a + 'more words '.repeat(30) + 'end.';
    const items = split([long], 100);
    expect(items.length).toBeGreaterThan(1);
    for (const it of items) expect(it.text.length).toBeLessThanOrEqual(100);
    expect(items[0]!.text.endsWith(',')).toBe(true);
    expect(items.map((i) => i.text).join(' ').replace(/\s+/g, ' ')).toBe(long.trim().replace(/\s+/g, ' '));
  });

  it('hard-cuts a long run without spaces', () => {
    const items = split(['x'.repeat(250)], 100);
    expect(items.map((i) => i.text.length)).toEqual([100, 100, 50]);
  });

  it('flushes the remainder without terminal punctuation', () => {
    expect(texts(split(['Hello there. And this has no end']))).toEqual(['Hello there.', 'And this has no end']);
  });

  it('flushes leftover gestures with no text', () => {
    expect(split(['[[Wave]]'])).toEqual([{ text: '', gestures: ['Wave'] }]);
    expect(split([''])).toEqual([]);
  });
});
