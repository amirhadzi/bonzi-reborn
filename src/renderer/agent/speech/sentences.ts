// Streaming sentence splitter. Turns the tag-free text stream (plus tag
// positions from TagParser) into speech items, one per sentence, so TTS can
// start on the first sentence while the model is still writing the rest.

import type { TagToken } from './tags.ts';

export interface SpeechItem {
  /** Raw sentence text (still needs cleanSpeechText before display / TTS). */
  text: string;
  /** Gesture tags that appeared before or inside this sentence, in order. */
  gestures: string[];
}

export interface SplitterOptions {
  /** Sentences longer than this are cut at a comma, semicolon or space. */
  maxLength?: number;
}

const TERMINATORS = '.!?…';
const CLOSERS = '"\'”’)]';
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'etc', 'jr', 'sr', 'prof', 'approx', 'no', 'fig', 'mt', 'ft', 'p.s', 'a.m', 'p.m', 'u.s', 'u.k',
]);

interface PendingTag {
  name: string;
  pos: number;
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

function hasWords(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

/** The word right before index `dot` (letters, digits and inner dots), lower-cased. */
function wordBefore(buf: string, dot: number): string {
  let j = dot;
  while (j > 0 && /[\p{L}\p{N}.]/u.test(buf[j - 1]!)) j--;
  return buf.slice(j, dot).toLowerCase();
}

export class SentenceSplitter {
  private buf = '';
  private tags: PendingTag[] = [];
  private readonly maxLength: number;

  constructor(options: SplitterOptions = {}) {
    this.maxLength = options.maxLength ?? 220;
  }

  /** Feeds tokens from TagParser. Returns sentences completed so far. */
  push(tokens: readonly TagToken[]): SpeechItem[] {
    const out: SpeechItem[] = [];
    for (const t of tokens) {
      if (t.type === 'tag') this.tags.push({ name: t.name, pos: this.buf.length });
      else {
        this.buf += t.text;
        out.push(...this.split(false));
      }
    }
    return out;
  }

  pushText(text: string): SpeechItem[] {
    return this.push([{ type: 'text', text, pos: 0 }]);
  }

  pushTag(name: string): void {
    this.tags.push({ name, pos: this.buf.length });
  }

  /** Ends the stream and returns whatever is left (including leftover gestures). */
  flush(): SpeechItem[] {
    const out = this.split(true);
    const rest = this.buf.trim();
    if (hasWords(rest) || this.tags.length > 0) {
      out.push({ text: hasWords(rest) ? rest : '', gestures: this.tags.map((t) => t.name) });
    }
    this.buf = '';
    this.tags = [];
    return out;
  }

  private split(final: boolean): SpeechItem[] {
    const out: SpeechItem[] = [];
    for (;;) {
      const end = this.findBoundary(final);
      if (end < 0) break;
      const item = this.take(end);
      if (item) out.push(item);
    }
    return out;
  }

  /** Cuts buf[0, end) off as a sentence. Gestures carry over when it has no words. */
  private take(end: number): SpeechItem | null {
    const text = this.buf.slice(0, end).trim();
    this.buf = this.buf.slice(end);
    if (!hasWords(text)) {
      for (const t of this.tags) t.pos = Math.max(0, t.pos - end);
      return null;
    }
    const mine = this.tags.filter((t) => t.pos < end);
    this.tags = this.tags.filter((t) => t.pos >= end).map((t) => ({ name: t.name, pos: t.pos - end }));
    return { text, gestures: mine.map((t) => t.name) };
  }

  /** Index just past the first sentence in buf, or -1 when undecided. */
  private findBoundary(final: boolean): number {
    const buf = this.buf;
    let inStraight = false;
    let inCurly = 0;
    let i = 0;
    let undecided = false;

    while (i < buf.length) {
      if (i >= this.maxLength) break;
      const ch = buf[i]!;
      if (ch === '\n' || ch === '\r') {
        let end = i + 1;
        while (end < buf.length && (buf[end] === '\n' || buf[end] === '\r')) end++;
        return end;
      }
      if (ch === '"') inStraight = !inStraight;
      else if (ch === '“') inCurly++;
      else if (ch === '”') inCurly = Math.max(0, inCurly - 1);

      if (TERMINATORS.includes(ch)) {
        let end = i;
        while (end < buf.length && TERMINATORS.includes(buf[end]!)) end++;
        const runLen = end - i;
        let quoteState: boolean = inStraight;
        let curly = inCurly;
        while (end < buf.length && CLOSERS.includes(buf[end]!)) {
          if (buf[end] === '"') quoteState = !quoteState;
          else if (buf[end] === '”') curly = Math.max(0, curly - 1);
          end++;
        }
        if (end >= buf.length && !final) {
          undecided = true;
          break;
        }
        const next = buf[end];
        const atEnd = end >= buf.length;
        if ((atEnd || isSpace(next)) && !quoteState && curly === 0 && !this.isNonBoundaryDot(buf, i, runLen)) {
          return end;
        }
        inStraight = quoteState;
        inCurly = curly;
        i = end;
        continue;
      }
      i++;
    }

    if (!undecided && buf.length > this.maxLength) return this.longCut();
    return -1;
  }

  private isNonBoundaryDot(buf: string, i: number, runLen: number): boolean {
    if (buf[i] !== '.' || runLen !== 1) return false;
    const word = wordBefore(buf, i);
    if (!word) return false;
    if (ABBREVIATIONS.has(word)) return true;
    // Initials such as "J. R. R. Tolkien".
    if (/^\p{Lu}$/u.test(buf.slice(i - 1, i)) && word.length === 1) return true;
    // A list number at the start of a line: "1. First".
    if (/^\d+$/.test(word)) {
      const before = buf.slice(0, i - word.length).trim();
      if (before === '') return true;
    }
    return false;
  }

  /** Where to cut an over-long sentence: comma/semicolon/colon, else a space. */
  private longCut(): number {
    const window = this.buf.slice(0, this.maxLength);
    const minCut = Math.floor(this.maxLength / 4);
    let best = -1;
    for (const m of window.matchAll(/[,;:–]\s/g)) {
      const at = (m.index ?? 0) + 1;
      if (at >= minCut) best = at;
    }
    if (best < 0) {
      const sp = window.lastIndexOf(' ');
      best = sp >= minCut ? sp : this.maxLength;
    }
    return best;
  }
}
