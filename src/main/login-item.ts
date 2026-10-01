// Launch at login. The portable build self-extracts to %TEMP% on each launch,
// so its login item must point at PORTABLE_EXECUTABLE_FILE instead of execPath.

import { app } from 'electron';
import { log } from './logger.ts';

export function syncLoginItem(openAtLogin: boolean): void {
  if (!app.isPackaged) {
    log.info(`Launch at login ${openAtLogin ? 'enabled' : 'disabled'} (not applied in development builds).`);
    return;
  }
  try {
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    app.setLoginItemSettings({ openAtLogin, path: exe });
    log.info(`Launch at login ${openAtLogin ? 'enabled' : 'disabled'}.`);
  } catch (err) {
    log.warn(`Could not update launch at login: ${err instanceof Error ? err.message : String(err)}`);
  }
}
