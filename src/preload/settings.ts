// Settings window preload: exposes window.bonziSettings (BonziSettingsApi).
// Sandboxed: bundled to a single CommonJS file that only requires 'electron'.
// Never exposes ipcRenderer or IPC event objects.

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc.ts';
import type {
  AppInfo,
  BonziSettingsApi,
  ChooseCharacterResult,
  ConnectionTestResult,
  ExternalLinkId,
  ModelListResult,
  SystemVoiceListResult,
  TtsRequest,
  TtsResult,
  Unsubscribe,
} from '../shared/ipc.ts';
import type { PublicSettings, SettingsPatch } from '../shared/settings.ts';

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  if (typeof cb !== 'function') throw new TypeError('callback must be a function');
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: BonziSettingsApi = {
  get: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<PublicSettings>,
  update: (patch: SettingsPatch) => ipcRenderer.invoke(IPC.settingsUpdate, patch) as Promise<PublicSettings>,
  setApiKey: (key: string | null) => ipcRenderer.invoke(IPC.settingsSetApiKey, key) as Promise<PublicSettings>,
  testConnection: () => ipcRenderer.invoke(IPC.settingsTest) as Promise<ConnectionTestResult>,
  listModels: () => ipcRenderer.invoke(IPC.settingsListModels) as Promise<ModelListResult>,
  chooseCharacter: () => ipcRenderer.invoke(IPC.settingsChooseCharacter) as Promise<ChooseCharacterResult>,
  resetCharacter: () => ipcRenderer.invoke(IPC.settingsResetCharacter) as Promise<PublicSettings>,
  clearHistory: async () => {
    await ipcRenderer.invoke(IPC.settingsClearHistory);
  },
  previewVoice: (req: TtsRequest) => ipcRenderer.invoke(IPC.ttsSynthesize, req) as Promise<TtsResult>,
  listSystemVoices: () => ipcRenderer.invoke(IPC.settingsListSystemVoices) as Promise<SystemVoiceListResult>,
  getInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
  openExternal: (id: ExternalLinkId) => ipcRenderer.send(IPC.appOpenExternal, id),
  setHotkeyCapture: (active: boolean) => ipcRenderer.send(IPC.settingsHotkeyCapture, active === true),
  onChanged: (cb: (s: PublicSettings) => void) => subscribe(IPC.settingsChanged, cb),
};

contextBridge.exposeInMainWorld('bonziSettings', api);
