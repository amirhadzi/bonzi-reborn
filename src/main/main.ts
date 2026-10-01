// Main process entry: lifecycle, single instance, security setup and wiring.

import path from 'node:path';
import { app, dialog, Menu, powerMonitor, safeStorage } from 'electron';
import { createAiService } from './ai/index.ts';
import type { AiService } from './ai/contract.ts';
import { loadCharacterWithFallback } from './character-source.ts';
import type { CharacterLoadResult } from './character-source.ts';
import { AppController } from './controller.ts';
import { installE2eCapture } from './e2e-capture.ts';
import { HistoryStore } from './history-store.ts';
import { unregisterAllHotkeys } from './hotkey.ts';
import { registerIpc } from './ipc.ts';
import { errorMessage, initFileLogging, log, setLogLevel } from './logger.ts';
import { resolveAppPaths } from './paths.ts';
import { handleAppProtocol, registerAppScheme } from './protocol.ts';
import { SecretStore, takeEnvApiKey } from './secrets.ts';
import type { StringCipher } from './secrets.ts';
import { installSessionPolicy, installWebContentsGuards } from './security.ts';
import { SettingsStore } from './settings-store.ts';
import { createTray } from './tray.ts';
import { SapiHost } from './voice/sapi-host.ts';
import { SystemVoiceService } from './voice/system-voice-service.ts';

const SHUTDOWN_FLUSH_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// Before ready

// Read the env fallback key once and remove it from the environment before any child
// process exists, so Chromium children (and the sandboxed preloads' process.env copy)
// never inherit it. SecretStore reads the captured value instead.
const envApiKey = takeEnvApiKey();

if (!app.isPackaged && process.env.BONZI_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.BONZI_USER_DATA));
}
initFileLogging(path.join(app.getPath('userData'), 'logs'));
setLogLevel(!app.isPackaged || process.env.BONZI_DEBUG === '1' ? 'debug' : 'info');

// Packaged builds never expose Chromium remote debugging (the fuses only cover Node's
// --inspect). This must stay synchronous top-level code: Electron starts the DevTools
// handler only after the main script's first pass, so removing the switch here prevents it.
if (app.isPackaged) {
  for (const sw of ['remote-debugging-port', 'remote-debugging-pipe']) {
    if (app.commandLine.hasSwitch(sw)) {
      app.commandLine.removeSwitch(sw);
      log.warn(`Ignoring --${sw}: remote debugging is disabled in packaged builds.`);
    }
  }
}

process.on('uncaughtException', (err) => log.error(`Uncaught exception: ${err.stack ?? err.message}`));
process.on('unhandledRejection', (reason) => log.error(`Unhandled rejection: ${errorMessage(reason)}`));

app.setAppUserModelId('io.github.amirhadzi.bonzireborn');
app.enableSandbox();
registerAppScheme();
installWebContentsGuards();
Menu.setApplicationMenu(null);

const safeStorageCipher: StringCipher = {
  isAvailable: async () => {
    try {
      return await safeStorage.isAsyncEncryptionAvailable();
    } catch {
      return safeStorage.isEncryptionAvailable();
    }
  },
  encrypt: (plain) => safeStorage.encryptStringAsync(plain),
  decrypt: async (data) => {
    const r = await safeStorage.decryptStringAsync(data);
    return { text: r.result, shouldReEncrypt: r.shouldReEncrypt };
  },
};

let controller: AppController | null = null;
let history: HistoryStore | null = null;
let shutdownStarted = false;
let shutdownDone = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    log.info('Second instance started; showing Bonzi.');
    controller?.talk();
  });

  // The app lives in the tray: closing windows never quits it, only Exit does.
  app.on('window-all-closed', () => undefined);

  app.on('before-quit', (event) => {
    controller?.markQuitting();
    if (shutdownDone) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void shutdown().finally(() => {
      shutdownDone = true;
      app.quit();
    });
  });

  app.on('will-quit', () => {
    unregisterAllHotkeys();
  });

  app.on('child-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') log.warn(`Child process gone: ${details.type} (${details.reason})`);
  });

  app
    .whenReady()
    .then(onReady)
    .catch((err: unknown) => {
      log.error(`Startup failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      dialog.showErrorBox('BonziBuddy Reborn', `BonziBuddy Reborn could not start.\n\n${errorMessage(err)}`);
      app.exit(1);
    });
}

async function shutdown(): Promise<void> {
  log.info('Shutting down.');
  try {
    controller?.shutdown();
  } catch (err) {
    log.warn(`Shutdown error: ${errorMessage(err)}`);
  }
  if (history) {
    await Promise.race([history.flush(), new Promise((r) => setTimeout(r, SHUTDOWN_FLUSH_TIMEOUT_MS))]);
  }
}

async function onReady(): Promise<void> {
  const paths = resolveAppPaths();
  log.info(`Starting BonziBuddy Reborn ${app.getVersion()} (Electron ${process.versions.electron}, packaged: ${app.isPackaged})`);
  handleAppProtocol(paths.rendererRoot);

  const settings = new SettingsStore({ filePath: paths.settingsFile, log });
  settings.load();

  const secrets = new SecretStore({ filePath: paths.credentialsFile, cipher: safeStorageCipher, readEnvKey: () => envApiKey, log });
  await secrets.load();
  log.info(`API key source: ${secrets.source()}; OS encryption available: ${secrets.encryptionAvailable}`);

  history = new HistoryStore({ filePath: paths.historyFile, cipher: safeStorageCipher, log });
  const historyStore = history;

  const locale = app.getLocale();
  let loaded: CharacterLoadResult;
  try {
    loaded = await loadCharacterWithFallback(settings.get().characterPath, paths.bundledCharacter, locale);
  } catch (err) {
    throw new Error(`The bundled character could not be loaded (${errorMessage(err)}).`);
  }
  if (loaded.error) {
    log.warn(`Custom character failed, using the bundled one: ${loaded.error}`);
    // A file that is only missing or unreadable right now (a drive not ready at sign-in)
    // keeps the user's choice for the next start; an invalid file is forgotten.
    if (!loaded.unavailable) settings.updateTrusted({ characterPath: null });
  }

  const ai: AiService = createAiService({
    getConfig: () => ({ settings: settings.get(), apiKey: secrets.get() }),
    onHistoryChanged: (h) => {
      if (settings.get().rememberConversation) historyStore.schedule(h);
    },
    log: (level, message) => log[level](`[ai] ${message}`),
  });

  if (settings.get().rememberConversation) {
    const saved = await historyStore.load();
    if (saved.length > 0) ai.setHistory(saved);
  } else {
    await historyStore.clear();
  }

  // Spawned lazily on the first Windows-voice request; killed in controller.shutdown().
  const voiceLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string): void => log[level](`[voice] ${message}`);
  const voice = new SystemVoiceService({ host: new SapiHost({ log: voiceLog }), log: voiceLog });

  const ctl = new AppController({
    paths,
    settings,
    secrets,
    history: historyStore,
    ai,
    voice,
    character: loaded.character,
    characterError: loaded.error,
    characterUnavailable: loaded.unavailable,
    locale,
  });
  controller = ctl;

  installSessionPolicy({
    agentWebContentsId: () => ctl.agent.webContents?.id ?? null,
    micEnabled: () => settings.get().micEnabled,
  });
  registerIpc(ctl);
  ctl.tray = createTray(ctl);

  // powerMonitor is only usable after ready. The agent pauses idle chatter while away.
  powerMonitor.on('suspend', () => ctl.notifyPower('suspend'));
  powerMonitor.on('resume', () => ctl.notifyPower('resume'));
  powerMonitor.on('lock-screen', () => ctl.notifyPower('lock'));
  powerMonitor.on('unlock-screen', () => ctl.notifyPower('unlock'));

  if (!app.isPackaged && process.env.BONZI_E2E_CAPTURE) installE2eCapture(ctl, process.env.BONZI_E2E_CAPTURE);

  ctl.start();
}
