// Pure security decisions (no Electron imports): trusted URLs, navigation
// and permission policy. The Electron wiring lives in security.ts / ipc.ts.

import { APP_ORIGIN, APP_URL_PREFIX } from './app-protocol.ts';

/** True for URLs served by our own app:// protocol (exact origin, no lookalikes). */
export function isAppUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url.startsWith(APP_URL_PREFIX)) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'app:' && u.host === 'bonzi' && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function isAppOrigin(origin: unknown): boolean {
  if (typeof origin !== 'string') return false;
  return origin === APP_ORIGIN || origin === APP_URL_PREFIX;
}

/** Navigation inside the app is allowed (e.g. reload); everything else is blocked. */
export function isAllowedNavigation(url: string): boolean {
  return isAppUrl(url);
}

/** Schemes renderers may request resources from (enforced in addition to the CSP). */
export function isAllowedRendererRequest(url: string): boolean {
  const colon = url.indexOf(':');
  if (colon <= 0) return false;
  const scheme = url.slice(0, colon).toLowerCase();
  if (scheme === 'app') return isAppUrl(url);
  return scheme === 'data' || scheme === 'blob' || scheme === 'devtools' || scheme === 'chrome-extension';
}

export interface PermissionRequestInput {
  permission: string;
  /** True when the requesting web contents is the agent window. */
  fromAgentWindow: boolean;
  /** requestingUrl or securityOrigin of the request. */
  requestingUrl: string | undefined;
  /** For 'media' requests: the requested media types. */
  mediaTypes: readonly string[] | undefined;
  micEnabled: boolean;
}

/** Permission request policy: only microphone (audio only) for the agent window. */
export function shouldGrantPermissionRequest(input: PermissionRequestInput): boolean {
  if (input.permission !== 'media') return false;
  if (!input.fromAgentWindow || !input.micEnabled) return false;
  if (!isAppUrl(input.requestingUrl) && !isAppOrigin(input.requestingUrl)) return false;
  const types = input.mediaTypes ?? [];
  return types.length > 0 && types.every((t) => t === 'audio');
}

export interface PermissionCheckInput {
  permission: string;
  fromAgentWindow: boolean;
  requestingOrigin: string | undefined;
  /** details.mediaType from the check handler. */
  mediaType: string | undefined;
  micEnabled: boolean;
}

export function shouldGrantPermissionCheck(input: PermissionCheckInput): boolean {
  if (input.permission !== 'media') return false;
  if (!input.fromAgentWindow || !input.micEnabled) return false;
  if (!isAppOrigin(input.requestingOrigin) && !isAppUrl(input.requestingOrigin)) return false;
  return input.mediaType === 'audio';
}
