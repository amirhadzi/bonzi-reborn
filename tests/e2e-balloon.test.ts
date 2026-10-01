/**
 * Tests for the e2e balloon visibility check (scripts/lib/e2e-balloon.mjs).
 * Run: npx vitest run tests/e2e-balloon.test.ts
 *
 * Regression for F34: the e2e 'mid-speech' step matched the greeting while it
 * faded out (Balloon.hide() removes 'open' at once but keeps the text and
 * hidden === false for 170 ms), so it passed without the reply balloon.
 */
import { describe, expect, it } from 'vitest';
import { balloonTextExpression, balloonTextMessage, readVisibleBalloon } from '../scripts/lib/e2e-balloon.mjs';
import type { BalloonSnapshot } from '../scripts/lib/e2e-balloon.mjs';

const GREETING = "Hey there, I'm back!";
const REPLY = "I'm doing great, thanks for asking how are you today!";

function snap(over: Partial<BalloonSnapshot> = {}): BalloonSnapshot {
  return { exists: true, hidden: false, open: true, text: GREETING, spoken: null, ...over };
}

describe('readVisibleBalloon', () => {
  it('returns the trimmed text of an open, unhidden balloon', () => {
    expect(readVisibleBalloon(snap({ text: `  ${GREETING}\n` }), {})).toBe(GREETING);
  });

  it('rejects a balloon fading out (open class removed, still unhidden with old text)', () => {
    expect(readVisibleBalloon(snap({ open: false }), {})).toBeNull();
  });

  it('rejects hidden, missing and empty balloons', () => {
    expect(readVisibleBalloon(snap({ hidden: true }), {})).toBeNull();
    expect(readVisibleBalloon(snap({ exists: false }), {})).toBeNull();
    expect(readVisibleBalloon(snap({ text: '   ' }), {})).toBeNull();
    expect(readVisibleBalloon(null, {})).toBeNull();
  });

  it('applies the pattern case-insensitively', () => {
    expect(readVisibleBalloon(snap({ text: 'It is 10:45 now' }), { pattern: '\\d{1,2}[:.]\\d{2}' })).toBe('It is 10:45 now');
    expect(readVisibleBalloon(snap(), { pattern: 'O.CLOCK' })).toBeNull();
  });

  it('with since, requires a line spoken since the action', () => {
    // Greeting still fully open but nothing new spoken yet: not the reply.
    expect(readVisibleBalloon(snap({ spoken: [] }), { since: 1 })).toBeNull();
    expect(readVisibleBalloon(snap({ spoken: [REPLY] }), { since: 1 })).toBeNull();
    // Reply balloon open (startItem shows all text, pending part included).
    expect(readVisibleBalloon(snap({ text: REPLY, spoken: [REPLY] }), { since: 1 })).toBe(REPLY);
    // A later sentence on the same page, with whitespace differences.
    expect(readVisibleBalloon(snap({ text: `First line. ${REPLY.replace(/ /g, '\n ')}`, spoken: ['', REPLY] }), { since: 1 })).not.toBeNull();
    // Missing speechLog (spoken null) never counts when since is set.
    expect(readVisibleBalloon(snap({ text: REPLY, spoken: null }), { since: 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The page expression, evaluated against a fake DOM that mirrors balloon.ts.

class FakeBalloon {
  hidden = true;
  private readonly classes = new Set<string>();
  text = '';
  readonly classList = { contains: (c: string): boolean => this.classes.has(c) };
  /** Balloon.open(): unhide and add 'open' synchronously. */
  open(text: string): void {
    this.text = text;
    this.hidden = false;
    this.classes.add('open');
  }
  /** Balloon.hide() before the 170 ms fade timer fires. */
  startFade(): void {
    this.classes.delete('open');
  }
  /** The fade timer: hidden and cleared. */
  finishFade(): void {
    this.hidden = true;
    this.text = '';
  }
}

interface Entry { text: string; gestures: string[]; at: number }

function evaluate(expr: string, balloon: FakeBalloon, speechLog: Entry[] | null): unknown {
  const textEl = { get textContent(): string { return balloon.text; } };
  const document = { getElementById: (id: string): unknown => (id === 'balloon' ? balloon : id === 'balloon-text' ? textEl : null) };
  const window = { __bonziDebug: speechLog ? { speechLog } : undefined };
  return new Function('document', 'window', `return ${expr};`)(document, window);
}

describe('balloonTextExpression (page code)', () => {
  it('does not match the interrupted greeting during its fade (F34)', () => {
    const b = new FakeBalloon();
    b.open(GREETING);
    const log: Entry[] = [{ text: GREETING, gestures: ['Wave'], at: 100 }];
    const expr = balloonTextExpression();
    expect(evaluate(expr, b, log)).toBe(GREETING);

    // Send: interrupt -> Balloon.hide() starts the fade synchronously.
    b.startFade();
    expect(evaluate(expr, b, log)).toBeNull();
    b.finishFade();
    expect(evaluate(expr, b, log)).toBeNull();

    // About 3 s later the reply item opens the balloon and is logged.
    const tSend = 200;
    log.push({ text: '', gestures: ['Wave'], at: 250 }, { text: REPLY, gestures: [], at: 3200 });
    b.open(REPLY);
    expect(evaluate(expr, b, log)).toBe(REPLY);
    expect(evaluate(balloonTextExpression({ since: tSend }), b, log)).toBe(REPLY);
  });

  it('with since, ignores lines logged before the action', () => {
    const b = new FakeBalloon();
    b.open(GREETING);
    const log: Entry[] = [{ text: GREETING, gestures: [], at: 100 }];
    expect(evaluate(balloonTextExpression({ since: 200 }), b, log)).toBeNull();
    expect(evaluate(balloonTextExpression({ since: 100 }), b, log)).toBe(GREETING);
    expect(evaluate(balloonTextExpression({ since: 100 }), b, null)).toBeNull();
  });

  it('embeds the pattern safely', () => {
    const b = new FakeBalloon();
    b.open("It's 10:45, o'clock \"quoted\"");
    expect(evaluate(balloonTextExpression({ pattern: "\\d{1,2}[:.]\\d{2}|o.clock" }), b, [])).toContain('10:45');
    expect(evaluate(balloonTextExpression({ pattern: "noon|midnight" }), b, [])).toBeNull();
  });

  it('describes what it waits for', () => {
    expect(balloonTextMessage()).toMatch(/open/);
    expect(balloonTextMessage({ pattern: 'x', since: 5 })).toMatch(/matching \/x\/.*spoken since/);
  });
});
