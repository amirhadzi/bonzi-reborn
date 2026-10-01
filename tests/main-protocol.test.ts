import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, mimeTypeFor, resolveAppRequest, securityHeaders } from '../src/main/app-protocol.ts';

const root = path.resolve('C:/app/dist/renderer');

function ok(url: string): string {
  const r = resolveAppRequest(url, root);
  if (!r.ok) throw new Error(`expected ok for ${url}, got ${r.status}`);
  return r.filePath;
}

function status(url: string): number {
  const r = resolveAppRequest(url, root);
  return r.ok ? 200 : r.status;
}

describe('resolveAppRequest', () => {
  it('maps app://bonzi paths into the renderer root', () => {
    expect(ok('app://bonzi/agent/index.html')).toBe(path.join(root, 'agent', 'index.html'));
    expect(ok('app://bonzi/settings/main.js')).toBe(path.join(root, 'settings', 'main.js'));
    expect(ok('app://bonzi/agent/assets/sound%20one.wav')).toBe(path.join(root, 'agent', 'assets', 'sound one.wav'));
  });

  it('maps a trailing slash to index.html', () => {
    expect(ok('app://bonzi/agent/')).toBe(path.join(root, 'agent', 'index.html'));
  });

  it('ignores query strings and fragments', () => {
    expect(ok('app://bonzi/agent/main.js?v=1#x')).toBe(path.join(root, 'agent', 'main.js'));
  });

  it('rejects other hosts and schemes', () => {
    expect(status('app://evil/agent/index.html')).toBe(404);
    expect(status('app://bonzi.evil/agent/index.html')).toBe(404);
    expect(status('file:///C:/app/dist/renderer/agent/index.html')).toBe(404);
    expect(status('https://bonzi/agent/index.html')).toBe(404);
  });

  it('rejects credentials and ports', () => {
    expect(status('app://user:pass@bonzi/agent/index.html')).toBe(400);
    expect(status('app://bonzi:8080/agent/index.html')).toBe(400);
  });

  it('never escapes the root via dot segments', () => {
    // The URL parser normalises raw dot segments, so these stay inside the root.
    const p = ok('app://bonzi/agent/../../../secret.txt');
    expect(p).toBe(path.join(root, 'secret.txt'));
    expect(path.relative(root, p).startsWith('..')).toBe(false);
  });

  it('rejects encoded traversal, separators and nulls', () => {
    // Whole-segment %2e%2e is normalised by the URL parser like '..', so it is clamped to the root.
    expect(ok('app://bonzi/agent/%2e%2e/%2e%2e/secret.txt')).toBe(path.join(root, 'secret.txt'));
    expect(status('app://bonzi/agent/a%2e%2e/secret.txt')).toBe(400);
    expect(status('app://bonzi/agent/..%2f..%2fsecret.txt')).toBe(400);
    expect(status('app://bonzi/agent/..%5c..%5csecret.txt')).toBe(400);
    expect(status('app://bonzi/agent/%2E%2E%5Csecret.txt')).toBe(400);
    expect(status('app://bonzi/agent/index.html%00.png')).toBe(400);
    expect(status('app://bonzi/agent\\..\\secret.txt')).toBe(400);
  });

  it('rejects drive letters, streams, device names and odd segments', () => {
    expect(status('app://bonzi/C:/Windows/win.ini')).toBe(400);
    expect(status('app://bonzi/agent/index.html:stream')).toBe(400);
    expect(status('app://bonzi/agent/con')).toBe(400);
    expect(status('app://bonzi/agent/NUL.txt')).toBe(400);
    expect(status('app://bonzi/agent/index.html.')).toBe(400);
    expect(status('app://bonzi//agent/index.html')).toBe(400);
    expect(status('app://bonzi/agent/%ZZ')).toBe(400);
  });

  it('rejects the root itself and garbage input', () => {
    expect(status('not a url')).toBe(400);
    expect(status('')).toBe(400);
    expect(status('app://bonzi/' + 'a'.repeat(3000))).toBe(400);
  });
});

describe('mime types and headers', () => {
  it('returns correct MIME types', () => {
    expect(mimeTypeFor('x/index.html')).toBe('text/html; charset=utf-8');
    expect(mimeTypeFor('x/main.js')).toBe('text/javascript; charset=utf-8');
    expect(mimeTypeFor('x/styles.CSS')).toBe('text/css; charset=utf-8');
    expect(mimeTypeFor('x/a.png')).toBe('image/png');
    expect(mimeTypeFor('x/a.svg')).toBe('image/svg+xml');
    expect(mimeTypeFor('x/a.wav')).toBe('audio/wav');
    expect(mimeTypeFor('x/a.unknown')).toBe('application/octet-stream');
  });

  it('puts the exact CSP on every response', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    const h = securityHeaders('text/plain');
    expect(h['Content-Security-Policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Content-Type']).toBe('text/plain');
  });
});
