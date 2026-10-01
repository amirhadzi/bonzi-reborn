// Single-instance, normally framed settings window.

import { BrowserWindow, nativeTheme } from 'electron';
import type { WebContents } from 'electron';
import { log } from '../logger.ts';
import { SETTINGS_URL } from '../paths.ts';

export interface SettingsWindowOptions {
  preloadPath: string;
  iconPath: string | undefined;
  isPackaged: boolean;
  /**
   * The window lost focus, closed or crashed. Anything tied to the focused window (the
   * suspended global hotkey while the shortcut box records) must end here.
   */
  onDeactivate?: () => void;
}

export class SettingsWindow {
  readonly #opts: SettingsWindowOptions;
  #win: BrowserWindow | null = null;

  constructor(options: SettingsWindowOptions) {
    this.#opts = options;
  }

  get window(): BrowserWindow | null {
    return this.#win && !this.#win.isDestroyed() ? this.#win : null;
  }

  get webContents(): WebContents | null {
    const w = this.window;
    return w && !w.webContents.isDestroyed() ? w.webContents : null;
  }

  isOpen(): boolean {
    return this.window !== null;
  }

  open(): BrowserWindow {
    const existing = this.window;
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return existing;
    }
    const win = new BrowserWindow({
      width: 760,
      height: 640,
      minWidth: 640,
      minHeight: 520,
      show: false,
      title: 'BonziBuddy Reborn Settings',
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#ffffff',
      ...(this.#opts.iconPath ? { icon: this.#opts.iconPath } : {}),
      webPreferences: {
        preload: this.#opts.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        devTools: !this.#opts.isPackaged,
      },
    });
    this.#win = win;
    win.setMenu(null);
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
      }
    });
    // Keep the fixed title even if the page sets document.title differently.
    win.on('page-title-updated', (event) => event.preventDefault());
    win.on('blur', () => this.#opts.onDeactivate?.());
    win.on('closed', () => {
      if (this.#win === win) this.#win = null;
      this.#opts.onDeactivate?.();
    });
    win.webContents.on('preload-error', (_e, preloadPath, error) => {
      log.error(`Settings preload failed (${preloadPath}): ${error.message}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error(`Settings renderer gone (${details.reason}); closing the window.`);
      this.#opts.onDeactivate?.();
      if (!win.isDestroyed()) win.destroy();
    });
    void win.loadURL(SETTINGS_URL).catch((err: unknown) => {
      log.error(`Settings window failed to load: ${err instanceof Error ? err.message : String(err)}`);
    });
    return win;
  }

  close(): void {
    this.window?.close();
  }
}
