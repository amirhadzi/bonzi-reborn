import { describe, expect, it } from 'vitest';
import { emptyReplyLine, errorLine, greetingLine, introLines, timeLine, ttsNote } from '../src/renderer/agent/lines.ts';
import { findGesture } from '../src/shared/gestures.ts';
import type { AiErrorKind } from '../src/shared/ipc.ts';

const KINDS: AiErrorKind[] = ['no-key', 'auth', 'quota', 'rate-limit', 'model', 'bad-request', 'network', 'timeout', 'server', 'unknown'];

describe('local lines', () => {
  it('has a friendly line with a known gesture for every error kind', () => {
    for (const kind of KINDS) {
      const line = errorLine({ kind, message: 'x' });
      expect(line, kind).not.toBeNull();
      expect(line!.text.length).toBeGreaterThan(10);
      expect(findGesture(line!.gesture ?? '')).toBeDefined();
    }
    expect(errorLine({ kind: 'cancelled', message: '' })).toBeNull();
  });

  it('mentions the retry delay for rate limits', () => {
    expect(errorLine({ kind: 'rate-limit', message: '', retryAfterSec: 12 })!.text).toContain('12 seconds');
    expect(errorLine({ kind: 'rate-limit', message: '', retryAfterSec: 1 })!.text).toContain('1 second.');
  });

  it('formats the time locally', () => {
    const line = timeLine(new Date(2026, 9, 6, 15, 42), 'en-US');
    expect(line.text).toBe("It's 3:42 PM on Tuesday.");
  });

  it('intro mentions the key only when missing', () => {
    expect(introLines(true).some((l) => /API key/.test(l.text))).toBe(false);
    expect(introLines(false).some((l) => /API key/.test(l.text))).toBe(true);
    expect(introLines(true)[0]!.gesture).toBe('Wave');
  });

  it('greeting varies and uses the name', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(greetingLine('', () => i / 20).text);
    expect(seen.size).toBeGreaterThan(2);
    expect(greetingLine('Amir', () => 0).text).toContain('Amir');
    expect(['Wave', 'Greet']).toContain(greetingLine('', () => 0.7).gesture);
  });

  it('tts notes only for account problems', () => {
    expect(ttsNote('auth')).toBeTruthy();
    expect(ttsNote('quota')).toBeTruthy();
    expect(ttsNote('network')).toBeNull();
    expect(ttsNote('auth', true)).toMatch(/Windows voice/);
    expect(ttsNote('quota', true)).toMatch(/Windows voice/);
    expect(ttsNote('quota', false)).toMatch(/type/);
    expect(ttsNote('network', true)).toBeNull();
  });

  it('the no-key intro line asks to open settings, and only that line', () => {
    const lines = introLines(false);
    expect(lines.filter((l) => l.openSettings).map((l) => l.text)).toEqual([lines.find((l) => /API key/.test(l.text))!.text]);
    expect(introLines(true).some((l) => l.openSettings)).toBe(false);
  });

  it('the intro explains click, right-click and drag', () => {
    const text = introLines(true).map((l) => l.text).join(' ');
    expect(text).toMatch(/right-click/i);
    expect(text).toMatch(/drag/i);
  });

  it('has a line for a reply that finished without words', () => {
    expect(emptyReplyLine('length').text).toMatch(/Max reply tokens/);
    const filtered = emptyReplyLine('content_filter').text;
    const other = emptyReplyLine(null).text;
    expect(filtered.length).toBeGreaterThan(10);
    expect(other.length).toBeGreaterThan(10);
    expect(filtered).not.toBe(other);
    expect(emptyReplyLine('stop').text).toBe(other);
    for (const r of ['length', 'content_filter', null]) expect(findGesture(emptyReplyLine(r).gesture ?? '')).toBeDefined();
  });

  it('contains no em dashes', () => {
    const all = [
      ...introLines(false),
      greetingLine('x'),
      ...KINDS.map((k) => errorLine({ kind: k, message: '' })!),
      ...['length', 'content_filter', null].map((r) => emptyReplyLine(r)),
    ]
      .map((l) => l.text)
      .join(' ');
    expect(all).not.toContain(String.fromCharCode(0x2014));
  });
});
