import { describe, expect, it } from 'vitest';
import { cleanSpeechText } from '../src/renderer/agent/speech/clean.ts';
import { SentenceSplitter, type SpeechItem } from '../src/renderer/agent/speech/sentences.ts';
import { TagParser } from '../src/renderer/agent/speech/tags.ts';

describe('cleanSpeechText', () => {
  it('strips emphasis', () => {
    expect(cleanSpeechText('This is **really** _very_ *cool* and ~~not~~ __bold__.')).toBe('This is really very cool and not bold.');
  });

  it('keeps snake_case and arithmetic', () => {
    expect(cleanSpeechText('Use my_var_name and 2*3*4 is 24.')).toBe('Use my_var_name and 2*3*4 is 24.');
  });

  it('strips headings, bullets and quotes', () => {
    expect(cleanSpeechText('## Fun facts')).toBe('Fun facts');
    expect(cleanSpeechText('- Bananas are berries')).toBe('Bananas are berries');
    expect(cleanSpeechText('* Item')).toBe('Item');
    expect(cleanSpeechText('> quoted text')).toBe('quoted text');
    expect(cleanSpeechText('---')).toBe('');
  });

  it('keeps a leading number, which is often the answer', () => {
    expect(cleanSpeechText('3. Third thing')).toBe('3. Third thing');
    expect(cleanSpeechText('1) First')).toBe('1) First');
    expect(cleanSpeechText('4. Easy peasy!')).toBe('4. Easy peasy!');
    expect(cleanSpeechText('42. That is the answer.')).toBe('42. That is the answer.');
  });

  it('handles code fences and inline code', () => {
    expect(cleanSpeechText('```js')).toBe('');
    expect(cleanSpeechText('```')).toBe('');
    expect(cleanSpeechText('Run `npm test` now.')).toBe('Run npm test now.');
  });

  it('turns links into their text and URLs into domains', () => {
    expect(cleanSpeechText('See [the docs](https://example.com/docs?a=1) now.')).toBe('See the docs now.');
    expect(cleanSpeechText('Visit https://www.example.co.uk/some/path?x=1.')).toBe('Visit example.co.uk.');
    expect(cleanSpeechText('Go to www.bananas.com, fast!')).toBe('Go to bananas.com, fast!');
    expect(cleanSpeechText('![a monkey](http://x.com/a.png)')).toBe('a monkey');
  });

  it('removes emoji and pictographs', () => {
    expect(cleanSpeechText('Hi 👋 there 🍌🍌!')).toBe('Hi there!');
    expect(cleanSpeechText('Family 👨‍👩‍👧 and flag 🇬🇧 and thumbs 👍🏽 ok ❤️')).toBe('Family and flag and thumbs ok');
    expect(cleanSpeechText('🎉')).toBe('');
  });

  it('collapses whitespace and tidies punctuation', () => {
    expect(cleanSpeechText('  Hello   there  ,\n friend !  ')).toBe('Hello there, friend!');
  });

  it('strips simple HTML tags', () => {
    expect(cleanSpeechText('Line one<br>line <b>two</b>')).toBe('Line one line two');
  });

  it('leaves plain text alone', () => {
    const s = "It's 3:42 PM on Tuesday. Isn't that neat? (Yes.)";
    expect(cleanSpeechText(s)).toBe(s);
  });
});

describe('tags + splitter + cleaner pipeline', () => {
  /** Runs the real streaming pipeline the agent uses, either in one chunk or one character at a time. */
  function run(input: string, byteByByte: boolean): { texts: string[]; gestures: string[] } {
    const tags = new TagParser();
    const splitter = new SentenceSplitter();
    const items: SpeechItem[] = [];
    const chunks = byteByByte ? [...input] : [input];
    for (const c of chunks) items.push(...splitter.push(tags.push(c)));
    items.push(...splitter.push(tags.flush()));
    items.push(...splitter.flush());
    return {
      texts: items.map((i) => cleanSpeechText(i.text)).filter((t) => t.length > 0),
      gestures: items.flatMap((i) => i.gestures),
    };
  }

  const cases: Array<[string, string[], string[]]> = [
    ['[[Pleased]] 4. Easy peasy!', ['4. Easy peasy!'], ['Pleased']],
    ['Hi! 8. Wow.', ['Hi!', '8. Wow.'], []],
    ["What's two plus two? 4. Easy!", ["What's two plus two?", '4. Easy!'], []],
    ['Great question! 42. That is the answer to everything.', ['Great question!', '42. That is the answer to everything.'], []],
  ];

  for (const [input, texts, gestures] of cases) {
    it(`keeps the number in ${JSON.stringify(input)}`, () => {
      for (const byteByByte of [false, true]) {
        const out = run(input, byteByByte);
        expect(out.texts, `byteByByte=${byteByByte}`).toEqual(texts);
        expect(out.gestures).toEqual(gestures);
      }
    });
  }
});
