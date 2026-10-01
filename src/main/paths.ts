// Filesystem locations of bundled resources and per-user data.

import path from 'node:path';
import { app } from 'electron';

export interface AppPaths {
  /** dist/renderer, served via app://bonzi/ */
  rendererRoot: string;
  agentPreload: string;
  settingsPreload: string;
  bundledCharacter: string;
  icon: string;
  userData: string;
  settingsFile: string;
  credentialsFile: string;
  historyFile: string;
  logsDir: string;
}

export function resolveAppPaths(): AppPaths {
  // __dirname is dist/main inside the CommonJS bundle (also inside app.asar).
  const distDir = path.join(__dirname, '..');
  const userData = app.getPath('userData');
  const packaged = app.isPackaged;
  return {
    rendererRoot: path.join(distDir, 'renderer'),
    agentPreload: path.join(__dirname, '../preload/agent.cjs'),
    settingsPreload: path.join(__dirname, '../preload/settings.cjs'),
    bundledCharacter: packaged
      ? path.join(process.resourcesPath, 'characters/Bonzi.acs')
      : path.join(app.getAppPath(), 'assets/characters/Bonzi.acs'),
    icon: packaged ? path.join(process.resourcesPath, 'icon.ico') : path.join(app.getAppPath(), 'build/icon.ico'),
    userData,
    settingsFile: path.join(userData, 'settings.json'),
    credentialsFile: path.join(userData, 'credentials.bin'),
    historyFile: path.join(userData, 'history.bin'),
    logsDir: path.join(userData, 'logs'),
  };
}

export const AGENT_URL = 'app://bonzi/agent/index.html';
export const SETTINGS_URL = 'app://bonzi/settings/index.html';
