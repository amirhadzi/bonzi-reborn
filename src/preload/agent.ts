// Agent window preload: exposes window.bonzi (BonziAgentApi).
// Sandboxed: bundled to a single CommonJS file that only requires 'electron'.
// Never exposes ipcRenderer or IPC event objects.

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc.ts';
import type {
  AgentReadyResult,
  AppCommand,
  AppInfo,
  BonziAgentApi,
  CharacterPayload,
  ChatEvent,
  ChatSendRequest,
  ChatSendResult,
  PointerSample,
  SttRequest,
  SttResult,
  SystemIdleState,
  TtsRequest,
  TtsResult,
  Unsubscribe,
} from '../shared/ipc.ts';
import type { PublicSettings } from '../shared/settings.ts';

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  if (typeof cb !== 'function') throw new TypeError('callback must be a function');
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: BonziAgentApi = {
  loadCharacter: () => ipcRenderer.invoke(IPC.characterLoad) as Promise<CharacterPayload>,
  chat: {
    send: (req: ChatSendRequest) => ipcRenderer.invoke(IPC.chatSend, req) as Promise<ChatSendResult>,
    cancel: async (requestId?: string) => {
      await ipcRenderer.invoke(IPC.chatCancel, requestId);
    },
    reset: async () => {
      await ipcRenderer.invoke(IPC.chatReset);
    },
    onEvent: (cb: (ev: ChatEvent) => void) => subscribe(IPC.chatEvent, cb),
  },
  tts: {
    synthesize: (req: TtsRequest) => ipcRenderer.invoke(IPC.ttsSynthesize, req) as Promise<TtsResult>,
  },
  stt: {
    transcribe: (req: SttRequest) => ipcRenderer.invoke(IPC.sttTranscribe, req) as Promise<SttResult>,
  },
  window: {
    setIgnoreMouseEvents: (ignore: boolean) => ipcRenderer.send(IPC.winSetIgnoreMouse, ignore === true),
    onPointer: (cb: (p: PointerSample) => void) => subscribe(IPC.winPointer, cb),
    dragStart: (grab?: { x: number; y: number }) =>
      ipcRenderer.send(IPC.winDragStart, grab && typeof grab.x === 'number' && typeof grab.y === 'number' ? { x: grab.x, y: grab.y } : undefined),
    dragEnd: () => ipcRenderer.send(IPC.winDragEnd),
    showContextMenu: () => ipcRenderer.send(IPC.winContextMenu),
    focus: () => ipcRenderer.send(IPC.winFocus),
    releaseFocus: () => ipcRenderer.send(IPC.winReleaseFocus),
    hidden: () => ipcRenderer.send(IPC.winHidden),
    ready: () => ipcRenderer.invoke(IPC.winReady) as Promise<AgentReadyResult>,
  },
  app: {
    openSettings: () => ipcRenderer.send(IPC.appOpenSettings),
    quit: () => ipcRenderer.send(IPC.appQuit),
    getInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
    getIdleState: (thresholdSec: number) => ipcRenderer.invoke(IPC.appIdleState, thresholdSec) as Promise<SystemIdleState>,
    onCommand: (cb: (cmd: AppCommand) => void) => subscribe(IPC.appCommand, cb),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<PublicSettings>,
    onChanged: (cb: (s: PublicSettings) => void) => subscribe(IPC.settingsChanged, cb),
  },
};

contextBridge.exposeInMainWorld('bonzi', api);
