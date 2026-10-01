// Incremental Server-Sent Events parser (WHATWG rules) plus a decoder for
// Chat Completions stream chunks. Robust to arbitrary chunk boundaries,
// including splits inside UTF-8 sequences and between CR and LF.

import { normalizeErrorObject } from './http.ts';
import type { ProviderError } from './http.ts';

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

export interface SseParser {
  /** Feeds raw bytes (decoded as UTF-8 across calls) or already-decoded text. */
  push(chunk: Uint8Array | string): void;
  /** Flushes a final event that was not followed by a blank line. */
  end(): void;
}

export function createSseParser(onMessage: (msg: SseMessage) => void): SseParser {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let first = true;
  let pendingCr = false;
  let dataLines: string[] = [];
  let eventName = '';
  let lastId: string | undefined;
  let hasData = false;

  const dispatch = (): void => {
    if (hasData) {
      const msg: SseMessage = { event: eventName || 'message', data: dataLines.join('\n') };
      if (lastId !== undefined) msg.id = lastId;
      onMessage(msg);
    }
    dataLines = [];
    eventName = '';
    hasData = false;
  };

  const line = (l: string): void => {
    if (l === '') {
      dispatch();
      return;
    }
    if (l.startsWith(':')) return; // comment / keep-alive
    const colon = l.indexOf(':');
    let field = l;
    let value = '';
    if (colon >= 0) {
      field = l.slice(0, colon);
      value = l.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    switch (field) {
      case 'data':
        dataLines.push(value);
        hasData = true;
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        if (!value.includes('\u0000')) lastId = value;
        break;
      default:
        break; // 'retry' and unknown fields are ignored
    }
  };

  const feed = (text: string): void => {
    if (!text) return;
    if (first) {
      first = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    let s = text;
    if (pendingCr) {
      pendingCr = false;
      if (s.startsWith('\n')) s = s.slice(1);
    }
    buf += s;
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const c = buf.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      line(buf.slice(start, i));
      if (c === 13) {
        if (i + 1 < buf.length) {
          if (buf.charCodeAt(i + 1) === 10) i++;
        } else {
          pendingCr = true; // the matching LF may arrive in the next chunk
        }
      }
      start = i + 1;
    }
    buf = buf.slice(start);
  };

  return {
    push(chunk) {
      feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    },
    end() {
      feed(decoder.decode());
      if (buf.length > 0) {
        line(buf);
        buf = '';
      }
      dispatch();
    },
  };
}

// ---------------------------------------------------------------------------
// Chat Completions chunk decoding

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type ChatStreamItem =
  | { kind: 'done' }
  | { kind: 'error'; error: Omit<ProviderError, 'status'> }
  | { kind: 'chunk'; content: string; finishReason: string | null; usage?: ChatUsage }
  | { kind: 'ignore' };

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Interprets the data of one SSE message from a Chat Completions stream. */
export function decodeChatData(data: string): ChatStreamItem {
  const trimmed = data.trim();
  if (trimmed === '[DONE]') return { kind: 'done' };
  if (!trimmed) return { kind: 'ignore' };
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { kind: 'ignore' };
  }
  if (typeof obj !== 'object' || obj === null) return { kind: 'ignore' };
  const o = obj as Record<string, unknown>;
  if (o.error !== undefined && o.error !== null) {
    return { kind: 'error', error: normalizeErrorObject(o) };
  }
  let content = '';
  let finishReason: string | null = null;
  if (Array.isArray(o.choices)) {
    for (const ch of o.choices) {
      if (typeof ch !== 'object' || ch === null) continue;
      const c = ch as Record<string, unknown>;
      if (typeof c.index === 'number' && c.index !== 0) continue;
      const delta = c.delta;
      if (typeof delta === 'object' && delta !== null) {
        const d = delta as Record<string, unknown>;
        if (typeof d.content === 'string') content += d.content;
        else if (typeof d.refusal === 'string') content += d.refusal;
      }
      if (typeof c.finish_reason === 'string') finishReason = c.finish_reason;
    }
  }
  const item: ChatStreamItem = { kind: 'chunk', content, finishReason };
  if (typeof o.usage === 'object' && o.usage !== null) {
    const u = o.usage as Record<string, unknown>;
    item.usage = { promptTokens: num(u.prompt_tokens), completionTokens: num(u.completion_tokens), totalTokens: num(u.total_tokens) };
  }
  return item;
}
