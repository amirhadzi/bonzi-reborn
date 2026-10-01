import { describe, expect, it } from 'vitest';
import { createSseParser, decodeChatData } from '../src/main/ai/sse.ts';
import type { SseMessage } from '../src/main/ai/sse.ts';

const enc = new TextEncoder();

function parseAll(chunks: Array<Uint8Array | string>): SseMessage[] {
  const out: SseMessage[] = [];
  const p = createSseParser((m) => out.push(m));
  for (const c of chunks) p.push(c);
  p.end();
  return out;
}

function splitEveryByte(text: string): Uint8Array[] {
  const bytes = enc.encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i++) out.push(bytes.subarray(i, i + 1));
  return out;
}

function splitRandom(text: string, seed: number): Uint8Array[] {
  const bytes = enc.encode(text);
  const out: Uint8Array[] = [];
  let s = seed;
  let i = 0;
  while (i < bytes.length) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const n = 1 + (s % 7);
    out.push(bytes.subarray(i, i + n));
    i += n;
  }
  return out;
}

const chunk = (content: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
    obfuscation: 'x1Yz',
    ...extra,
  });

const STREAM = [
  ': OPENROUTER PROCESSING',
  '',
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }], usage: null })}`,
  '',
  `data: ${chunk('[[Wa')}`,
  '',
  `data: ${chunk('ve]] Héllo, 世界 🍌!')}`,
  '',
  'event: message',
  'id: 7',
  `data: ${chunk(' Bye.')}`,
  '',
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
  '',
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}`,
  '',
  'data: [DONE]',
  '',
  '',
];

function assemble(msgs: SseMessage[]) {
  let text = '';
  let finish: string | null = null;
  let done = false;
  let usage: unknown = null;
  for (const m of msgs) {
    const item = decodeChatData(m.data);
    if (item.kind === 'done') done = true;
    if (item.kind === 'chunk') {
      text += item.content;
      if (item.finishReason) finish = item.finishReason;
      if (item.usage) usage = item.usage;
    }
  }
  return { text, finish, done, usage };
}

describe('SSE parser', () => {
  for (const [name, eol] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']] as const) {
    const text = STREAM.join(eol);
    it(`parses a ${name} stream identically whole, split every byte and split randomly`, () => {
      const whole = parseAll([text]);
      const bytes = parseAll(splitEveryByte(text));
      const random = parseAll(splitRandom(text, 42));
      expect(whole).toHaveLength(7);
      expect(bytes).toEqual(whole);
      expect(random).toEqual(whole);
      const a = assemble(bytes);
      expect(a.text).toBe('[[Wave]] Héllo, 世界 🍌! Bye.');
      expect(a.finish).toBe('stop');
      expect(a.done).toBe(true);
      expect(a.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    });
  }

  it('ignores comments, keeps event and id fields, and joins multi-line data', () => {
    const msgs = parseAll([':keepalive\n\nevent: custom\nid: 42\ndata: line one\ndata:line two\n\n']);
    expect(msgs).toEqual([{ event: 'custom', data: 'line one\nline two', id: '42' }]);
  });

  it('strips a leading BOM and handles a CR at the very end of a chunk', () => {
    const msgs = parseAll(['﻿data: a\r', '\n\r', '\ndata: b\r\n\r\n']);
    expect(msgs.map((m) => m.data)).toEqual(['a', 'b']);
  });

  it('dispatches a final event without a trailing blank line on end()', () => {
    expect(parseAll(['data: {"x":1}']).map((m) => m.data)).toEqual(['{"x":1}']);
  });

  it('does not dispatch events without data lines', () => {
    expect(parseAll(['event: ping\n\nid: 3\n\n'])).toEqual([]);
  });
});

describe('decodeChatData', () => {
  it('recognises [DONE], an error object, usage-only chunks and ignores junk', () => {
    expect(decodeChatData('[DONE]')).toEqual({ kind: 'done' });
    expect(decodeChatData('not json')).toEqual({ kind: 'ignore' });
    const err = decodeChatData(JSON.stringify({ error: { message: 'boom', type: 'server_error', code: 'server_is_overloaded', param: null } }));
    expect(err).toEqual({ kind: 'error', error: { message: 'boom', type: 'server_error', code: 'server_is_overloaded', param: null } });
    const strErr = decodeChatData(JSON.stringify({ error: 'upstream died' }));
    expect(strErr.kind === 'error' && strErr.error.message).toBe('upstream died');
    expect(decodeChatData(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }))).toEqual({
      kind: 'chunk',
      content: '',
      finishReason: null,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
  });

  it('uses refusal text when there is no content and ignores choices other than index 0', () => {
    const r = decodeChatData(JSON.stringify({ choices: [{ index: 0, delta: { refusal: 'Nope.' }, finish_reason: null }, { index: 1, delta: { content: 'other' } }] }));
    expect(r).toEqual({ kind: 'chunk', content: 'Nope.', finishReason: null });
  });

  it('tolerates Azure-style prompt_filter_results chunks with empty choices', () => {
    expect(decodeChatData(JSON.stringify({ choices: [], prompt_filter_results: [{}] }))).toEqual({ kind: 'chunk', content: '', finishReason: null });
  });
});
