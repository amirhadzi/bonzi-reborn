import { describe, expect, it } from 'vitest';
import {
  validateBoolean,
  validateGrabPoint,
  validateChatSend,
  validateExternalLinkId,
  validateIdleThreshold,
  validateOptionalRequestId,
  validateSttRequest,
  validateTtsRequest,
} from '../src/main/ipc-validate.ts';
import { LIMITS } from '../src/shared/settings.ts';

describe('validateChatSend', () => {
  it('accepts valid requests and trims text', () => {
    expect(validateChatSend({ text: '  hi Bonzi ', source: 'typed' })).toEqual({ text: 'hi Bonzi', source: 'typed' });
    for (const source of ['voice', 'quick-action', 'idle-chatter', 'greeting']) {
      expect(validateChatSend({ text: 'x', source })).not.toBeNull();
    }
  });

  it('rejects empty, too long, wrong types and unknown sources', () => {
    expect(validateChatSend({ text: '   ', source: 'typed' })).toBeNull();
    expect(validateChatSend({ text: 'a'.repeat(LIMITS.chatText + 1), source: 'typed' })).toBeNull();
    expect(validateChatSend({ text: 'a'.repeat(LIMITS.chatText), source: 'typed' })).not.toBeNull();
    expect(validateChatSend({ text: 42, source: 'typed' })).toBeNull();
    expect(validateChatSend({ text: 'hi', source: 'admin' })).toBeNull();
    expect(validateChatSend({ text: 'hi' })).toBeNull();
    expect(validateChatSend(null)).toBeNull();
    expect(validateChatSend('hi')).toBeNull();
    expect(validateChatSend(['hi', 'typed'])).toBeNull();
  });
});

describe('validateTtsRequest', () => {
  it('accepts text with optional overrides', () => {
    expect(validateTtsRequest({ text: 'Hello' })).toEqual({ text: 'Hello' });
    expect(validateTtsRequest({ text: 'Hello', voice: ' cedar ', model: 'tts-1', instructions: 'cheerful' })).toEqual({
      text: 'Hello',
      voice: 'cedar',
      model: 'tts-1',
      instructions: 'cheerful',
    });
  });

  it('enforces limits', () => {
    expect(validateTtsRequest({ text: '' })).toBeNull();
    expect(validateTtsRequest({ text: 'a'.repeat(LIMITS.ttsText + 1) })).toBeNull();
    expect(validateTtsRequest({ text: 'a'.repeat(LIMITS.ttsText) })).not.toBeNull();
    expect(validateTtsRequest({ text: 'hi', voice: 'v'.repeat(LIMITS.ttsVoice + 1) })).toBeNull();
    expect(validateTtsRequest({ text: 'hi', model: 7 })).toBeNull();
    expect(validateTtsRequest({ text: 'hi', instructions: 'i'.repeat(LIMITS.ttsInstructions + 1) })).toBeNull();
  });

  it('accepts the engine field and longer Windows voice names', () => {
    expect(validateTtsRequest({ text: 'Hello', engine: 'system' })).toEqual({ text: 'Hello', engine: 'system' });
    expect(validateTtsRequest({ text: 'Hello', engine: 'openai' })).toEqual({ text: 'Hello', engine: 'openai' });
    expect(validateTtsRequest({ text: 'Hello', engine: null })).toEqual({ text: 'Hello' });
    expect(validateTtsRequest({ text: 'Hello', engine: 'sapi' })).toBeNull();
    expect(validateTtsRequest({ text: 'Hello', engine: 1 })).toBeNull();
    const longName = 'Microsoft Some Very Long Windows Voice Name Desktop - English (United States)';
    expect(longName.length).toBeGreaterThan(LIMITS.ttsVoice);
    expect(validateTtsRequest({ text: 'Hi', engine: 'system', voice: longName })).toEqual({ text: 'Hi', engine: 'system', voice: longName });
    expect(validateTtsRequest({ text: 'Hi', voice: longName })).toBeNull();
    expect(validateTtsRequest({ text: 'Hi', engine: 'system', voice: 'v'.repeat(LIMITS.systemVoiceName + 1) })).toBeNull();
  });
});

describe('validateSttRequest', () => {
  it('accepts an ArrayBuffer with an audio mime', () => {
    const audio = new ArrayBuffer(16);
    expect(validateSttRequest({ audio, mime: 'audio/webm;codecs=opus' })).toEqual({ audio, mime: 'audio/webm;codecs=opus' });
    expect(validateSttRequest({ audio, mime: 'audio/ogg; codecs="opus"' })).not.toBeNull();
    expect(validateSttRequest({ audio, mime: 'Audio/WAV' })?.mime).toBe('audio/wav');
  });

  it('rejects non-ArrayBuffers, empty or oversized audio and bad mime types', () => {
    expect(validateSttRequest({ audio: new Uint8Array(16), mime: 'audio/webm' })).toBeNull();
    expect(validateSttRequest({ audio: 'abc', mime: 'audio/webm' })).toBeNull();
    expect(validateSttRequest({ audio: new ArrayBuffer(0), mime: 'audio/webm' })).toBeNull();
    expect(validateSttRequest({ audio: new ArrayBuffer(LIMITS.sttBytes + 1), mime: 'audio/webm' })).toBeNull();
    expect(validateSttRequest({ audio: new ArrayBuffer(8), mime: 'video/webm' })).toBeNull();
    expect(validateSttRequest({ audio: new ArrayBuffer(8), mime: 'audio/' + 'x'.repeat(200) })).toBeNull();
    expect(validateSttRequest({ audio: new ArrayBuffer(8), mime: 'audio/webm\r\nX-Evil: 1' })).toBeNull();
    expect(validateSttRequest({ audio: new ArrayBuffer(8) })).toBeNull();
  });
});

describe('small validators', () => {
  it('request ids', () => {
    expect(validateOptionalRequestId(undefined)).toBeUndefined();
    expect(validateOptionalRequestId(null)).toBeUndefined();
    expect(validateOptionalRequestId('req_1')).toBe('req_1');
    expect(validateOptionalRequestId('')).toBeNull();
    expect(validateOptionalRequestId(5)).toBeNull();
    expect(validateOptionalRequestId('x'.repeat(129))).toBeNull();
  });

  it('booleans', () => {
    expect(validateBoolean(true)).toBe(true);
    expect(validateBoolean(false)).toBe(false);
    expect(validateBoolean('true')).toBeNull();
    expect(validateBoolean(1)).toBeNull();
  });

  it('idle-state thresholds are clamped to 1..240 minutes and must be numbers', () => {
    expect(validateIdleThreshold(1200)).toBe(1200);
    expect(validateIdleThreshold(59.6)).toBe(60);
    expect(validateIdleThreshold(5)).toBe(60);
    expect(validateIdleThreshold(-1)).toBe(60);
    expect(validateIdleThreshold(1e9)).toBe(14_400);
    expect(validateIdleThreshold(Number.NaN)).toBeNull();
    expect(validateIdleThreshold(Number.POSITIVE_INFINITY)).toBeNull();
    expect(validateIdleThreshold('1200')).toBeNull();
    expect(validateIdleThreshold(undefined)).toBeNull();
  });

  it('external link ids only from the allowlist', () => {
    expect(validateExternalLinkId('openaiKeys')).toBe('openaiKeys');
    expect(validateExternalLinkId('openaiPricing')).toBe('openaiPricing');
    expect(validateExternalLinkId('https://evil.example')).toBeNull();
    expect(validateExternalLinkId('toString')).toBeNull();
    expect(validateExternalLinkId('__proto__')).toBeNull();
    expect(validateExternalLinkId(undefined)).toBeNull();
  });
});

describe('validateGrabPoint', () => {
  it('accepts a finite in-range point and rejects everything else', () => {
    expect(validateGrabPoint({ x: 200, y: 380 })).toEqual({ x: 200, y: 380 });
    expect(validateGrabPoint({ x: 200, y: 380, extra: 1 })).toEqual({ x: 200, y: 380 });
    expect(validateGrabPoint(undefined)).toBeUndefined();
    expect(validateGrabPoint(null)).toBeUndefined();
    expect(validateGrabPoint({ x: -1, y: 5 })).toBeUndefined();
    expect(validateGrabPoint({ x: Number.NaN, y: 5 })).toBeUndefined();
    expect(validateGrabPoint({ x: 1e9, y: 5 })).toBeUndefined();
    expect(validateGrabPoint({ x: '5', y: 5 })).toBeUndefined();
  });
});
