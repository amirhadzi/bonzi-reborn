// app://bonzi/ protocol: serves dist/renderer with a strict CSP.

import fs from 'node:fs';
import { protocol } from 'electron';
import { APP_SCHEME, mimeTypeFor, resolveAppRequest, securityHeaders } from './app-protocol.ts';
import { log } from './logger.ts';

/** Must run before app 'ready'. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
    },
  ]);
}

function errorResponse(status: number): Response {
  const text = status === 404 ? 'Not found' : status === 405 ? 'Method not allowed' : status === 403 ? 'Forbidden' : 'Bad request';
  return new Response(text, { status, headers: securityHeaders('text/plain; charset=utf-8') });
}

/** Installs the handler on the default session. Call after 'ready'. */
export function handleAppProtocol(rendererRoot: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(405);
    const resolved = resolveAppRequest(request.url, rendererRoot);
    if (!resolved.ok) {
      log.warn(`app:// request rejected (${resolved.status})`);
      return errorResponse(resolved.status);
    }
    try {
      // fs reads work inside app.asar (Electron patches fs).
      const data = await fs.promises.readFile(resolved.filePath);
      const body = request.method === 'HEAD' ? null : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return new Response(body, { status: 200, headers: securityHeaders(mimeTypeFor(resolved.filePath)) });
    } catch {
      return errorResponse(404);
    }
  });
}
