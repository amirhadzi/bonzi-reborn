// IPC handlers. Every message is checked for a trusted sender (app://bonzi/
// main frame of the expected window) and every payload is validated.

import { ipcMain, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import { EXTERNAL_LINKS, IPC } from '../shared/ipc.ts';
import type {
  AgentReadyResult,
  AiError,
  ChatSendResult,
  SttResult,
  SystemIdleState,
  SystemVoiceListResult,
  TtsResult,
} from '../shared/ipc.ts';
import { toCharacterPayload } from './character-source.ts';
import type { AppController } from './controller.ts';
import {
  validateBoolean,
  validateGrabPoint,
  validateChatSend,
  validateExternalLinkId,
  validateIdleThreshold,
  validateOptionalRequestId,
  validateSttRequest,
  validateTtsRequest,
} from './ipc-validate.ts';
import { errorMessage, log } from './logger.ts';
import { showAgentContextMenu } from './menus.ts';
import { validateApiKey } from './secrets.ts';
import { isAppUrl } from './security-policy.ts';

type Target = 'agent' | 'settings' | 'both';

function badRequest(message: string): AiError {
  return { kind: 'bad-request', message };
}

export function registerIpc(controller: AppController): void {
  const allowedFor = (target: Target): (WebContents | null)[] => {
    const agent = controller.agent.webContents;
    const settings = controller.settingsWindow.webContents;
    return target === 'agent' ? [agent] : target === 'settings' ? [settings] : [agent, settings];
  };

  const senderOk = (event: IpcMainEvent | IpcMainInvokeEvent, target: Target, channel: string): boolean => {
    const frame = event.senderFrame;
    const ok =
      frame !== null &&
      frame.parent === null &&
      isAppUrl(frame.url) &&
      allowedFor(target).some((wc) => wc !== null && wc.id === event.sender.id);
    if (!ok) log.warn(`Rejected IPC ${channel} from an untrusted sender`);
    return ok;
  };

  const handle = (channel: string, target: Target, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!senderOk(event, target, channel)) throw new Error('Forbidden');
      return fn(...args);
    });
  };

  const on = (channel: string, target: Target, fn: (...args: unknown[]) => void): void => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      if (!senderOk(event, target, channel)) return;
      try {
        fn(...args);
      } catch (err) {
        log.error(`IPC ${channel} failed: ${errorMessage(err)}`);
      }
    });
  };

  // Character
  handle(IPC.characterLoad, 'agent', () => toCharacterPayload(controller.character));

  // Chat
  handle(IPC.chatSend, 'agent', (raw): ChatSendResult => {
    const req = validateChatSend(raw);
    if (!req) return { ok: false, error: badRequest('That message is empty or too long.') };
    return controller.ai.sendChat(req, (ev) => {
      controller.agent.sendChannel(IPC.chatEvent, ev);
      controller.onChatEvent?.(ev);
    });
  });
  handle(IPC.chatCancel, 'agent', (raw) => {
    const id = validateOptionalRequestId(raw);
    if (id === null) return;
    controller.ai.cancelChat(id);
  });
  handle(IPC.chatReset, 'agent', () => {
    controller.ai.resetConversation();
  });

  // Voice (the settings window uses tts:synthesize for "Test voice")
  handle(IPC.ttsSynthesize, 'both', async (raw): Promise<TtsResult> => {
    const req = validateTtsRequest(raw);
    if (!req) return { ok: false, error: badRequest('Nothing to say, or the text is too long.') };
    if (req.engine === 'system') {
      const s = controller.settings.get();
      return controller.voice.synthesize({
        text: req.text,
        voiceName: req.voice ?? s.systemVoiceName,
        rate: s.systemVoiceRate,
        pitch: s.systemVoicePitch,
      });
    }
    return controller.ai.synthesize(req);
  });
  handle(IPC.sttTranscribe, 'agent', async (raw): Promise<SttResult> => {
    if (!controller.settings.get().micEnabled) return { ok: false, error: badRequest('Voice input is turned off in settings.') };
    const req = validateSttRequest(raw);
    if (!req) return { ok: false, error: badRequest('The recording is empty, too large or in an unsupported format.') };
    return controller.ai.transcribe(req);
  });

  // Agent window
  on(IPC.winSetIgnoreMouse, 'agent', (raw) => {
    const ignore = validateBoolean(raw);
    if (ignore !== null) controller.agent.setIgnoreMouse(ignore);
  });
  on(IPC.winDragStart, 'agent', (raw) => controller.agent.dragStart(validateGrabPoint(raw)));
  on(IPC.winDragEnd, 'agent', () => controller.agent.dragEnd());
  on(IPC.winContextMenu, 'agent', () => showAgentContextMenu(controller));
  on(IPC.winFocus, 'agent', () => controller.agent.focus());
  on(IPC.winReleaseFocus, 'agent', () => controller.agent.releaseFocus());
  on(IPC.winHidden, 'agent', () => controller.agent.confirmHidden());
  handle(IPC.winReady, 'agent', (): AgentReadyResult => controller.agent.markReady());

  // App
  on(IPC.appOpenSettings, 'agent', () => controller.openSettings());
  on(IPC.appQuit, 'agent', () => controller.quitNow());
  handle(IPC.appInfo, 'both', () => controller.appInfo());
  handle(IPC.appIdleState, 'agent', (raw): SystemIdleState => {
    const threshold = validateIdleThreshold(raw);
    return threshold === null ? 'unknown' : controller.systemIdleState(threshold);
  });
  on(IPC.appOpenExternal, 'settings', (raw) => {
    const id = validateExternalLinkId(raw);
    if (id) void shell.openExternal(EXTERNAL_LINKS[id]).catch((err: unknown) => log.warn(`openExternal failed: ${errorMessage(err)}`));
  });

  // Settings
  handle(IPC.settingsGet, 'both', () => controller.publicSettings());
  handle(IPC.settingsUpdate, 'settings', (raw) => {
    controller.settings.update(raw);
    return controller.publicSettings();
  });
  handle(IPC.settingsSetApiKey, 'settings', async (raw) => {
    if (raw === null) return controller.setApiKey(null);
    const key = validateApiKey(raw);
    if (!key) throw new Error('That API key does not look valid. Paste the whole key without spaces.');
    return controller.setApiKey(key);
  });
  handle(IPC.settingsTest, 'settings', () => controller.ai.testConnection());
  handle(IPC.settingsListModels, 'settings', () => controller.ai.listModels());
  handle(IPC.settingsChooseCharacter, 'settings', () => controller.chooseCharacter(controller.settingsWindow.window));
  handle(IPC.settingsResetCharacter, 'settings', () => controller.resetCharacter());
  handle(IPC.settingsClearHistory, 'settings', () => controller.clearHistory());
  handle(IPC.settingsListSystemVoices, 'settings', (): Promise<SystemVoiceListResult> => controller.voice.listVoices());
  on(IPC.settingsHotkeyCapture, 'settings', (raw) => {
    const active = validateBoolean(raw);
    if (active !== null) controller.setHotkeyCapture(active);
  });
}
