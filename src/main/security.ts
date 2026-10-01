// Global web-contents hardening and the session permission policy.

import { app, session } from 'electron';
import type { WebContents } from 'electron';
import { log } from './logger.ts';
import {
  isAllowedNavigation,
  isAllowedRendererRequest,
  shouldGrantPermissionCheck,
  shouldGrantPermissionRequest,
} from './security-policy.ts';

export interface SecurityDeps {
  /** The agent window's webContents id, or null when it does not exist. */
  agentWebContentsId: () => number | null;
  micEnabled: () => boolean;
}

/** Registers the web-contents-created hook. Safe to call before 'ready'. */
export function installWebContentsGuards(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      log.warn(`Blocked window.open (${safeOrigin(url)})`);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedNavigation(url)) {
        event.preventDefault();
        log.warn(`Blocked navigation (${safeOrigin(url)})`);
      }
    });
    contents.on('will-redirect', (event, url) => {
      if (!isAllowedNavigation(url)) {
        event.preventDefault();
        log.warn(`Blocked redirect (${safeOrigin(url)})`);
      }
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });
}

/** Session-level policy. Call after 'ready'. */
export function installSessionPolicy(deps: SecurityDeps): void {
  const ses = session.defaultSession;
  const isAgent = (wc: WebContents | null): boolean => wc !== null && !wc.isDestroyed() && wc.id === deps.agentWebContentsId();

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    const requestingUrl = ('securityOrigin' in details && details.securityOrigin) || details.requestingUrl;
    const granted = shouldGrantPermissionRequest({
      permission,
      fromAgentWindow: isAgent(webContents),
      requestingUrl,
      mediaTypes,
      micEnabled: deps.micEnabled(),
    });
    if (!granted) log.info(`Denied permission request: ${permission}`);
    callback(granted);
  });

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return shouldGrantPermissionCheck({
      permission,
      fromAgentWindow: isAgent(webContents),
      requestingOrigin: requestingOrigin || details.securityOrigin,
      mediaType: details.mediaType,
      micEnabled: deps.micEnabled(),
    });
  });

  ses.setDevicePermissionHandler(() => false);

  // Renderers never talk to the network: everything goes through the main process.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedRendererRequest(details.url);
    if (!allowed) log.warn(`Blocked renderer request (${safeOrigin(details.url)})`);
    callback({ cancel: !allowed });
  });

  ses.on('will-download', (event) => {
    event.preventDefault();
  });
}

function safeOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'invalid url';
  }
}
