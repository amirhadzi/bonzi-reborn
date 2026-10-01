// Central main-process controller: owns the windows, the loaded character and
// the user-facing actions shared by the tray, context menu, hotkey and IPC.

import fs from 'node:fs';
import { app, dialog, powerMonitor } from 'electron';
import type { BrowserWindow, OpenDialogOptions } from 'electron';
import { IPC } from '../shared/ipc.ts';
import type { AppCommand, AppInfo, ChatEvent, ChooseCharacterResult, PowerState, SystemIdleState } from '../shared/ipc.ts';
import type { PublicSettings } from '../shared/settings.ts';
import type { AiService } from './ai/contract.ts';
import { CharacterLoadError, readCharacterFile } from './character-source.ts';
import type { LoadedCharacter } from './character-source.ts';
import type { HistoryStore } from './history-store.ts';
import { registerHotkey, unregisterAllHotkeys, unregisterHotkey } from './hotkey.ts';
import { log, errorMessage } from './logger.ts';
import { syncLoginItem } from './login-item.ts';
import type { AppPaths } from './paths.ts';
import type { SecretStore } from './secrets.ts';
import { apiKeyHint } from './secrets.ts';
import { buildPublicSettings } from './settings-store.ts';
import type { SettingsChange, SettingsStore } from './settings-store.ts';
import type { SystemVoiceService } from './voice/system-voice-service.ts';
import { AgentWindow } from './windows/agent-window.ts';
import { SettingsWindow } from './windows/settings-window.ts';
const EXIT_FORCE_MS = 5_000;
/**
 * First run without a key: the renderer opens settings when the intro finishes
 * (Bonzi says he is opening it). This only covers an intro that never runs or is
 * interrupted, e.g. a character load error.
 */
export const FIRST_RUN_SETTINGS_FALLBACK_MS = 45_000;

export interface ControllerDeps {
  paths: AppPaths;
  settings: SettingsStore;
  secrets: SecretStore;
  history: HistoryStore;
  ai: AiService;
  /** Windows (SAPI) voice used for voiceMode 'system' and as the OpenAI TTS fallback. */
  voice: SystemVoiceService;
  character: LoadedCharacter;
  /** Set when the configured custom character failed to load at startup. */
  characterError: string | null;
  /**
   * The custom character failed because its file could not be found or read (a drive
   * that is not ready yet, say); its path was kept so the next start tries it again.
   */
  characterUnavailable?: boolean;
  locale: string;
}

export interface TrayHandle {
  refresh(): void;
  destroy(): void;
  /** Shows a notification balloon from the tray icon. Returns false when it could not be shown. */
  showHint(title: string, content: string): boolean;
}

export class AppController {
  readonly paths: AppPaths;
  readonly settings: SettingsStore;
  readonly secrets: SecretStore;
  readonly history: HistoryStore;
  readonly ai: AiService;
  readonly voice: SystemVoiceService;
  readonly agent: AgentWindow;
  readonly settingsWindow: SettingsWindow;
  readonly locale: string;
  character: LoadedCharacter;
  hotkeyError: string | null = null;
  tray: TrayHandle | null = null;
  #quitting = false;
  #exitTimer: ReturnType<typeof setTimeout> | null = null;
  #startupCharacterError: string | null;
  #startupCharacterUnavailable: boolean;
  #firstReadyHandled = false;
  #firstRunSettingsTimer: ReturnType<typeof setTimeout> | null = null;
  /** The settings shortcut box is recording, so the global hotkey is suspended. */
  #hotkeyCapture = false;
  /** Called after an agent window win:ready (used by the dev-only e2e capture). */
  onAgentReady: (() => void) | null = null;
  /** Called for every chat event forwarded to the agent (used by the dev-only e2e capture). */
  onChatEvent: ((ev: ChatEvent) => void) | null = null;

  constructor(deps: ControllerDeps) {
    this.paths = deps.paths;
    this.settings = deps.settings;
    this.secrets = deps.secrets;
    this.history = deps.history;
    this.ai = deps.ai;
    this.voice = deps.voice;
    this.character = deps.character;
    this.locale = deps.locale;
    this.#startupCharacterError = deps.characterError;
    this.#startupCharacterUnavailable = deps.characterUnavailable === true;
    const iconPath = fs.existsSync(deps.paths.icon) ? deps.paths.icon : undefined;

    this.agent = new AgentWindow({
      preloadPath: deps.paths.agentPreload,
      iconPath,
      isPackaged: app.isPackaged,
      getSettings: () => this.settings.get(),
      savePosition: (pos) => {
        this.settings.updateTrusted({ position: pos });
      },
      getCharacterSize: () => ({ width: this.character.width, height: this.character.height }),
      isQuitting: () => this.#quitting,
      onReady: () => this.#onAgentReady(),
      onVisibilityChanged: (shown) => {
        this.tray?.refresh();
        if (!shown) this.#maybeShowHideHint();
      },
      onSessionEnd: () => {
        this.#quitting = true;
        this.settings.flush();
        void this.history.flush();
      },
    });
    this.settingsWindow = new SettingsWindow({
      preloadPath: deps.paths.settingsPreload,
      iconPath,
      isPackaged: app.isPackaged,
      // Capture can never outlive the focused settings window: blur, close and crash all end it.
      onDeactivate: () => this.setHotkeyCapture(false),
    });

    this.settings.onChange((change) => this.#onSettingsChanged(change));
  }

  get quitting(): boolean {
    return this.#quitting;
  }

  markQuitting(): void {
    this.#quitting = true;
  }

  // ---------------------------------------------------------------------------
  // Startup

  start(): void {
    this.ai.setCharacterInfo({ name: this.character.name, animations: this.character.animations });
    this.applyHotkey();
    syncLoginItem(this.settings.get().launchAtLogin);
    this.agent.create();
  }

  #onAgentReady(): void {
    this.onAgentReady?.();
    if (this.#firstReadyHandled) return;
    this.#firstReadyHandled = true;
    const s = this.settings.get();
    if (!s.firstRunComplete) {
      if (!this.secrets.get()) {
        // Fallback only: the renderer opens settings when the no-key intro finishes.
        this.#clearFirstRunSettingsTimer();
        this.#firstRunSettingsTimer = setTimeout(() => {
          this.#firstRunSettingsTimer = null;
          if (!this.#quitting && !this.secrets.get()) this.openSettings();
        }, FIRST_RUN_SETTINGS_FALLBACK_MS);
      }
      // The renderer read firstRunComplete before signalling ready and plays the intro from that copy.
      this.settings.updateTrusted({ firstRunComplete: true });
    }
    const charErr = this.#startupCharacterError;
    if (charErr) {
      this.#startupCharacterError = null;
      if (this.#startupCharacterUnavailable) this.#showCharacterUnavailableDialog(charErr);
      else {
        void dialog.showMessageBox({
          type: 'warning',
          title: 'BonziBuddy Reborn',
          message: 'Your custom character could not be loaded, so Bonzi is back.',
          detail: charErr,
          buttons: ['OK'],
          noLink: true,
        });
      }
    }
  }

  /** The custom character's file is missing or unreadable right now; its path was kept. */
  #showCharacterUnavailableDialog(detail: string): void {
    void dialog
      .showMessageBox({
        type: 'warning',
        title: 'BonziBuddy Reborn',
        message: 'Your custom character is not available right now, so Bonzi is filling in. BonziBuddy Reborn will try it again next time it starts.',
        detail,
        buttons: ['OK', 'Use Bonzi from now on'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      .then((r) => {
        // Bonzi is already loaded, so forgetting the path needs no reload.
        if (r.response === 1 && this.character.isBundled && this.settings.get().characterPath !== null) {
          this.settings.updateTrusted({ characterPath: null });
        }
      })
      .catch((err: unknown) => log.warn(`Character dialog failed: ${errorMessage(err)}`));
  }

  #clearFirstRunSettingsTimer(): void {
    if (this.#firstRunSettingsTimer) clearTimeout(this.#firstRunSettingsTimer);
    this.#firstRunSettingsTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Settings

  publicSettings(): PublicSettings {
    const key = this.secrets.get();
    return buildPublicSettings(this.settings.get(), {
      apiKeyHint: apiKeyHint(key),
      apiKeySource: this.secrets.source(),
      safeStorageAvailable: this.secrets.encryptionAvailable,
      characterName: this.character.name,
      hotkeyError: this.hotkeyError,
    });
  }

  broadcastSettings(): void {
    const payload = this.publicSettings();
    for (const wc of [this.agent.webContents, this.settingsWindow.webContents]) {
      if (!wc) continue;
      try {
        wc.send(IPC.settingsChanged, payload);
      } catch {
        // window closing
      }
    }
  }

  #onSettingsChanged(change: SettingsChange): void {
    const { changed, next } = change;
    if (changed.has('alwaysOnTop')) this.agent.setAlwaysOnTop(next.alwaysOnTop);
    if (changed.has('scale')) this.agent.relayout();
    if (changed.has('hotkey')) this.applyHotkey();
    if (changed.has('launchAtLogin')) syncLoginItem(next.launchAtLogin);
    if (changed.has('rememberConversation')) {
      if (next.rememberConversation) this.history.schedule(this.ai.getHistory());
      else void this.history.clear();
    }
    if (changed.has('characterPath') && next.characterPath === null && !this.character.isBundled) {
      void this.resetCharacter().catch((err: unknown) => log.error(`Resetting the character failed: ${errorMessage(err)}`));
    }
    // micEnabled is read live by the permission handlers.
    this.broadcastSettings();
  }

  applyHotkey(): void {
    const accel = this.settings.get().hotkey;
    const err = registerHotkey(accel, () => this.talk());
    // While Settings records a shortcut, register only to validate it (so "in use by another
    // app" is still reported) and release it at once, so pressing it reaches the capture box.
    // It is registered for real when capture ends.
    if (this.#hotkeyCapture) unregisterHotkey();
    if (err !== this.hotkeyError) {
      this.hotkeyError = err;
      this.broadcastSettings();
    }
  }

  /** Suspends (true) or restores (false) the global hotkey while the settings shortcut box records. */
  setHotkeyCapture(active: boolean): void {
    if (active === this.#hotkeyCapture) return;
    this.#hotkeyCapture = active;
    if (active) {
      unregisterHotkey();
      log.debug('Global hotkey suspended while Settings records a shortcut.');
    } else if (!this.#quitting) {
      this.applyHotkey();
    }
  }

  get hotkeyCaptureActive(): boolean {
    return this.#hotkeyCapture;
  }

  async setApiKey(key: string | null): Promise<PublicSettings> {
    await this.secrets.set(key);
    this.broadcastSettings();
    return this.publicSettings();
  }

  async clearHistory(): Promise<void> {
    this.ai.resetConversation();
    await this.history.clear();
  }

  // ---------------------------------------------------------------------------
  // Character

  applyCharacter(ch: LoadedCharacter): void {
    this.character = ch;
    this.ai.setCharacterInfo({ name: ch.name, animations: ch.animations });
    this.settings.updateTrusted({ characterPath: ch.isBundled ? null : ch.filePath });
    this.agent.relayout();
    this.agent.send({ type: 'reload-character' });
    this.tray?.refresh();
    this.broadcastSettings();
    log.info(`Character loaded: ${ch.fileName} (${ch.width}x${ch.height}, ${ch.animations.length} animations)`);
  }

  async chooseCharacter(parent: BrowserWindow | null): Promise<ChooseCharacterResult> {
    const options: OpenDialogOptions = {
      title: 'Choose a Microsoft Agent character',
      filters: [{ name: 'Microsoft Agent character', extensions: ['acs'] }],
      properties: ['openFile', 'dontAddToRecent'],
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return { ok: false, cancelled: true };
    try {
      const ch = await readCharacterFile(filePath, false, this.locale);
      this.applyCharacter(ch);
      return { ok: true, settings: this.publicSettings() };
    } catch (err) {
      const message = err instanceof CharacterLoadError ? err.message : 'That file could not be loaded as a character.';
      log.warn(`Custom character rejected: ${errorMessage(err)}`);
      return { ok: false, cancelled: false, message };
    }
  }

  async resetCharacter(): Promise<PublicSettings> {
    if (!this.character.isBundled) {
      const ch = await readCharacterFile(this.paths.bundledCharacter, true, this.locale);
      this.applyCharacter(ch);
    } else if (this.settings.get().characterPath !== null) {
      this.settings.updateTrusted({ characterPath: null });
    }
    return this.publicSettings();
  }

  // ---------------------------------------------------------------------------
  // Actions

  sendCommand(cmd: AppCommand): void {
    this.agent.send(cmd);
  }

  /** Session lock or unlock, suspend or resume (from powerMonitor): tells the agent so idle chatter pauses. */
  notifyPower(state: PowerState): void {
    log.info(`Power event: ${state}`);
    this.sendCommand({ type: 'power', state });
  }

  /** The OS idle state for a threshold in seconds; 'unknown' when it cannot be read. */
  systemIdleState(thresholdSec: number): SystemIdleState {
    try {
      return powerMonitor.getSystemIdleState(thresholdSec);
    } catch (err) {
      log.warn(`Could not read the system idle state: ${errorMessage(err)}`);
      return 'unknown';
    }
  }

  showBonzi(): void {
    if (!this.agent.window) this.agent.create();
    this.agent.show();
  }

  hideBonzi(): void {
    this.agent.requestHide();
  }

  /**
   * The first time the user hides Bonzi, a tray balloon says where he went, so
   * nobody thinks the app quit. Shown once ever (persisted), never while quitting.
   */
  #maybeShowHideHint(): void {
    if (this.#quitting || this.settings.get().hideHintShown || !this.tray) return;
    const name = this.character.name || 'Bonzi';
    const shown = this.tray.showHint(
      `${name} is still here`,
      `${name} is hiding in the notification area. Click this icon to bring ${name} back, or right-click it for more options.`,
    );
    if (shown) this.settings.updateTrusted({ hideHintShown: true });
  }

  toggleBonzi(): void {
    if (this.agent.isShown()) this.hideBonzi();
    else this.showBonzi();
  }

  /** Shows Bonzi if needed, opens the chat bar and focuses the window. */
  talk(): void {
    this.showBonzi();
    this.sendCommand({ type: 'open-chat' });
    this.agent.focus();
  }

  openSettings(): void {
    // Any open (renderer after the intro, tray, context menu) makes the first-run fallback moot.
    this.#clearFirstRunSettingsTimer();
    this.settingsWindow.open();
  }

  /** Exit: let Bonzi say goodbye, then quit (forced after a timeout). */
  quit(): void {
    if (this.#quitting || this.#exitTimer) return;
    const win = this.agent.window;
    if (win && this.agent.isReady() && this.agent.isShown() && win.isVisible() && this.agent.send({ type: 'exit' })) {
      this.#exitTimer = setTimeout(() => this.quitNow(), EXIT_FORCE_MS);
      return;
    }
    this.quitNow();
  }

  quitNow(): void {
    if (this.#exitTimer) {
      clearTimeout(this.#exitTimer);
      this.#exitTimer = null;
    }
    this.#quitting = true;
    app.quit();
  }

  /** Synchronous shutdown work; async flushes are awaited in main.ts. */
  shutdown(): void {
    this.#quitting = true;
    this.#clearFirstRunSettingsTimer();
    unregisterAllHotkeys();
    try {
      this.ai.dispose();
    } catch (err) {
      log.warn(`AI dispose failed: ${errorMessage(err)}`);
    }
    try {
      this.voice.dispose();
    } catch (err) {
      log.warn(`Voice dispose failed: ${errorMessage(err)}`);
    }
    this.settings.flush();
    this.tray?.destroy();
    this.tray = null;
  }

  appInfo(): AppInfo {
    return {
      name: 'BonziBuddy Reborn',
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
    };
  }
}
