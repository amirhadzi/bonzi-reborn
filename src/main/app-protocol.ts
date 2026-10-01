// Pure helpers for the app:// protocol: URL-to-file mapping with a strict
// path traversal guard, MIME types and the Content Security Policy.
// No Electron imports so this is unit-testable.

import path from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'bonzi';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
/** Every trusted renderer URL starts with this prefix. */
export const APP_URL_PREFIX = `${APP_ORIGIN}/`;

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.acs': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export type AppRequestResolution = { ok: true; filePath: string } | { ok: false; status: 400 | 403 | 404 };

// Windows device names are rejected as path segments (with or without extension).
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Maps an app://bonzi/... URL to a file inside rootDir, or rejects it.
 * Rejects other hosts/schemes, credentials, ports, backslashes, encoded
 * separators, null bytes, dot segments, drive letters / stream names and
 * anything that would resolve outside rootDir. A trailing slash maps to
 * index.html.
 */
export function resolveAppRequest(rawUrl: string, rootDir: string, pathImpl: typeof path = path): AppRequestResolution {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) return { ok: false, status: 400 };
  if (/[\\\u0000]/.test(rawUrl)) return { ok: false, status: 400 };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, status: 400 };
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.hostname !== APP_HOST) return { ok: false, status: 404 };
  if (url.username || url.password || url.port) return { ok: false, status: 400 };

  const rawPath = url.pathname;
  if (!rawPath.startsWith('/')) return { ok: false, status: 400 };
  // Encoded separators, encoded dots and encoded nulls are never legitimate here.
  if (/%(2f|5c|00|2e)/i.test(rawPath)) return { ok: false, status: 400 };

  const rawSegments = rawPath.slice(1).split('/');
  if (rawSegments[rawSegments.length - 1] === '') rawSegments[rawSegments.length - 1] = 'index.html';

  const segments: string[] = [];
  for (const raw of rawSegments) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return { ok: false, status: 400 };
    }
    if (seg === '' || seg === '.' || seg === '..') return { ok: false, status: 400 };
    if (/[\\/:*?"<>|\u0000-\u001f]/.test(seg)) return { ok: false, status: 400 };
    if (seg.endsWith('.') || seg.endsWith(' ')) return { ok: false, status: 400 };
    if (RESERVED_NAMES.test(seg)) return { ok: false, status: 400 };
    segments.push(seg);
  }

  const root = pathImpl.resolve(rootDir);
  const filePath = pathImpl.resolve(root, ...segments);
  const rel = pathImpl.relative(root, filePath);
  if (rel === '' || rel.startsWith('..') || pathImpl.isAbsolute(rel)) return { ok: false, status: 403 };
  return { ok: true, filePath };
}

export function securityHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
  };
}
