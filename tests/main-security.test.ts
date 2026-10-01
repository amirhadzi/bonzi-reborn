import { describe, expect, it } from 'vitest';
import {
  isAllowedNavigation,
  isAllowedRendererRequest,
  isAppUrl,
  shouldGrantPermissionCheck,
  shouldGrantPermissionRequest,
} from '../src/main/security-policy.ts';

describe('isAppUrl (IPC sender validation)', () => {
  it('accepts our pages', () => {
    expect(isAppUrl('app://bonzi/agent/index.html')).toBe(true);
    expect(isAppUrl('app://bonzi/settings/index.html#general')).toBe(true);
  });

  it('rejects lookalikes and other schemes', () => {
    expect(isAppUrl('app://bonzi.evil.com/agent/index.html')).toBe(false);
    expect(isAppUrl('app://bonzix/agent/index.html')).toBe(false);
    expect(isAppUrl('app://evil/bonzi/')).toBe(false);
    expect(isAppUrl('https://bonzi/agent/index.html')).toBe(false);
    expect(isAppUrl('file:///C:/agent/index.html')).toBe(false);
    expect(isAppUrl('about:blank')).toBe(false);
    expect(isAppUrl('')).toBe(false);
    expect(isAppUrl(undefined)).toBe(false);
    expect(isAppUrl(null)).toBe(false);
    expect(isAppUrl('app://bonzi')).toBe(false);
  });
});

describe('navigation and request policy', () => {
  it('only allows in-app navigation', () => {
    expect(isAllowedNavigation('app://bonzi/agent/index.html')).toBe(true);
    expect(isAllowedNavigation('https://example.com/')).toBe(false);
    expect(isAllowedNavigation('javascript:alert(1)')).toBe(false);
  });

  it('blocks renderer network requests', () => {
    expect(isAllowedRendererRequest('app://bonzi/agent/main.js')).toBe(true);
    expect(isAllowedRendererRequest('data:image/png;base64,AAAA')).toBe(true);
    expect(isAllowedRendererRequest('blob:app://bonzi/1234')).toBe(true);
    expect(isAllowedRendererRequest('https://api.openai.com/v1/models')).toBe(false);
    expect(isAllowedRendererRequest('http://127.0.0.1:18787/v1/models')).toBe(false);
    expect(isAllowedRendererRequest('wss://example.com/')).toBe(false);
    expect(isAllowedRendererRequest('file:///C:/Windows/win.ini')).toBe(false);
    expect(isAllowedRendererRequest('app://evil/x')).toBe(false);
  });
});

describe('permission policy', () => {
  const base = {
    permission: 'media',
    fromAgentWindow: true,
    requestingUrl: 'app://bonzi/agent/index.html',
    mediaTypes: ['audio'],
    micEnabled: true,
  };

  it('allows audio-only media for the agent window', () => {
    expect(shouldGrantPermissionRequest(base)).toBe(true);
    expect(shouldGrantPermissionRequest({ ...base, requestingUrl: 'app://bonzi' })).toBe(true);
  });

  it('denies video, other windows, other origins and disabled mic', () => {
    expect(shouldGrantPermissionRequest({ ...base, mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(shouldGrantPermissionRequest({ ...base, mediaTypes: ['video'] })).toBe(false);
    expect(shouldGrantPermissionRequest({ ...base, mediaTypes: [] })).toBe(false);
    expect(shouldGrantPermissionRequest({ ...base, mediaTypes: undefined })).toBe(false);
    expect(shouldGrantPermissionRequest({ ...base, fromAgentWindow: false })).toBe(false);
    expect(shouldGrantPermissionRequest({ ...base, requestingUrl: 'https://evil.example/' })).toBe(false);
    expect(shouldGrantPermissionRequest({ ...base, micEnabled: false })).toBe(false);
  });

  it('denies every other permission', () => {
    for (const permission of ['notifications', 'clipboard-read', 'geolocation', 'openExternal', 'display-capture', 'local-network-access']) {
      expect(shouldGrantPermissionRequest({ ...base, permission })).toBe(false);
    }
  });

  it('applies the same rules to permission checks', () => {
    const check = { permission: 'media', fromAgentWindow: true, requestingOrigin: 'app://bonzi', mediaType: 'audio', micEnabled: true };
    expect(shouldGrantPermissionCheck(check)).toBe(true);
    expect(shouldGrantPermissionCheck({ ...check, mediaType: 'video' })).toBe(false);
    expect(shouldGrantPermissionCheck({ ...check, mediaType: 'unknown' })).toBe(false);
    expect(shouldGrantPermissionCheck({ ...check, fromAgentWindow: false })).toBe(false);
    expect(shouldGrantPermissionCheck({ ...check, micEnabled: false })).toBe(false);
    expect(shouldGrantPermissionCheck({ ...check, requestingOrigin: 'https://evil.example' })).toBe(false);
    expect(shouldGrantPermissionCheck({ ...check, permission: 'notifications' })).toBe(false);
  });
});
