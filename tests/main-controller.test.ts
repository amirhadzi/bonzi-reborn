// AppController with mocked Electron: the first-run settings fallback, the hotkey
// suspension while Settings records a shortcut, power events and the startup
// dialog for a custom character that is temporarily unavailable.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppCommand } from '../src/shared/ipc.ts';

class FakeWebContents extends EventEmitter {
  readonly sent: { channel: string; payload: unknown }[] = [];
  isDestroyed(): boolean {
    return false;
  }
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
  focus(): void {}
  openDevTools(): void {}
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  visible = false;
  destroyed = false;
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isVisible(): boolean {
    return this.visible;
  }
  isFocused(): boolean {
    return false;
  }
  isMinimized(): boolean {
    return false;
  }
  showInactive(): void {
    this.visible = true;
  }
  show(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
  restore(): void {}
  focus(): void {}
  blur(): void {}
  setAlwaysOnTop(): void {}
  setMenu(): void {}
  setIgnoreMouseEvents(): void {}
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 400, height: 400 };
  }
  setBounds(): void {}
  loadURL(): Promise<void> {
    return Promise.resolve();
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('closed');
  }
}

const h = vi.hoisted(() => ({
  windows: [] as unknown[],
  registered: new Set<string>(),
  /** Accelerators another app holds. */
  taken: new Set<string>(),
  idleState: 'active' as string,
  dialogResponse: 0,
  dialogCalls: [] as { message: string; buttons: string[] }[],
}));

vi.mock('electron', () => {
  return {
    BrowserWindow: function FakeBrowserWindow() {
      const w = new FakeWindow();
      h.windows.push(w);
      return w;
    },
    screen: {
      getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      on: () => undefined,
      off: () => undefined,
    },
    nativeTheme: { shouldUseDarkColors: false },
    app: { isPackaged: false, getVersion: () => '0.0.0', quit: () => undefined },
    dialog: {
      showMessageBox: (opts: { message: string; buttons: string[] }) => {
        h.dialogCalls.push({ message: opts.message, buttons: opts.buttons });
        return Promise.resolve({ response: h.dialogResponse, checkboxChecked: false });
      },
    },
    globalShortcut: {
      register: (accel: string) => {
        if (h.taken.has(accel)) return false;
        h.registered.add(accel);
        return true;
      },
      unregister: (accel: string) => {
        h.registered.delete(accel);
      },
      unregisterAll: () => h.registered.clear(),
    },
    powerMonitor: { getSystemIdleState: (sec: number) => (sec >= 60 ? h.idleState : 'unknown') },
  };
});
vi.mock('../src/main/paths.ts', () => ({ AGENT_URL: 'app://bonzi/agent/index.html', SETTINGS_URL: 'app://bonzi/settings/index.html' }));
vi.mock('../src/main/logger.ts', () => ({
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  errorMessage: (e: unknown) => String(e),
}));

const { AppController, FIRST_RUN_SETTINGS_FALLBACK_MS } = await import('../src/main/controller.ts');
const { SettingsStore } = await import('../src/main/settings-store.ts');
import type { LoadedCharacter } from '../src/main/character-source.ts';
import type { ControllerDeps } from '../src/main/controller.ts';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonzi-controller-test-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
  h.windows.length = 0;
  h.registered.clear();
  h.taken.clear();
  h.dialogCalls.length = 0;
  h.dialogResponse = 0;
});

let n = 0;
function setup(o: { key?: string | null; firstRunComplete?: boolean; characterError?: string | null; characterUnavailable?: boolean; characterPath?: string | null } = {}) {
  const settings = new SettingsStore({ filePath: path.join(dir, `settings-${++n}.json`), log: quiet });
  settings.load();
  settings.updateTrusted({ firstRunComplete: o.firstRunComplete ?? true, characterPath: o.characterPath ?? null });
  const key = o.key ?? null;
  const character: LoadedCharacter = {
    filePath: 'Bonzi.acs',
    fileName: 'Bonzi.acs',
    isBundled: true,
    bytes: Buffer.alloc(0),
    name: 'Bonzi',
    width: 200,
    height: 160,
    animations: ['GREET'],
    trayIcon: null,
  };
  const deps = {
    paths: { icon: path.join(dir, 'no-icon.ico'), agentPreload: 'a.cjs', settingsPreload: 's.cjs', bundledCharacter: 'Bonzi.acs' },
    settings,
    secrets: { get: () => key, source: () => (key ? 'stored' : 'none'), encryptionAvailable: true },
    history: { flush: async () => undefined, schedule: () => undefined, clear: async () => undefined },
    ai: { setCharacterInfo: () => undefined, dispose: () => undefined, getHistory: () => [], resetConversation: () => undefined },
    voice: { dispose: () => undefined },
    character,
    characterError: o.characterError ?? null,
    characterUnavailable: o.characterUnavailable ?? false,
    locale: 'en-GB',
  } as unknown as ControllerDeps;
  const ctl = new AppController(deps);
  return { ctl, settings };
}

function agentCommands(): AppCommand[] {
  const agent = h.windows[0] as FakeWindow;
  return agent.webContents.sent.filter((s) => s.channel === 'app:command').map((s) => s.payload as AppCommand);
}

describe('first-run settings', () => {
  it('waits for the intro instead of opening settings after a fixed 4 s', () => {
    vi.useFakeTimers();
    const { ctl } = setup({ key: null, firstRunComplete: false });
    ctl.start();
    ctl.agent.markReady();
    vi.advanceTimersByTime(20_000); // the four intro lines are still playing
    expect(ctl.settingsWindow.isOpen()).toBe(false);
    vi.advanceTimersByTime(FIRST_RUN_SETTINGS_FALLBACK_MS);
    expect(ctl.settingsWindow.isOpen()).toBe(true);
    ctl.shutdown();
  });

  it('cancels the fallback when settings opens from the renderer (end of the intro) or the tray', () => {
    vi.useFakeTimers();
    const { ctl } = setup({ key: null, firstRunComplete: false });
    ctl.start();
    ctl.agent.markReady();
    ctl.openSettings();
    const settingsWin = h.windows[1] as FakeWindow;
    settingsWin.destroy(); // the user closes it
    expect(ctl.settingsWindow.isOpen()).toBe(false);
    vi.advanceTimersByTime(FIRST_RUN_SETTINGS_FALLBACK_MS * 2);
    expect(ctl.settingsWindow.isOpen()).toBe(false);
    ctl.shutdown();
  });

  it('does not open settings when a key exists, or after shutdown', () => {
    vi.useFakeTimers();
    const a = setup({ key: 'sk-test-local', firstRunComplete: false });
    a.ctl.start();
    a.ctl.agent.markReady();
    vi.advanceTimersByTime(FIRST_RUN_SETTINGS_FALLBACK_MS * 2);
    expect(a.ctl.settingsWindow.isOpen()).toBe(false);
    a.ctl.shutdown();

    h.windows.length = 0;
    const b = setup({ key: null, firstRunComplete: false });
    b.ctl.start();
    b.ctl.agent.markReady();
    b.ctl.shutdown();
    vi.advanceTimersByTime(FIRST_RUN_SETTINGS_FALLBACK_MS * 2);
    expect(b.ctl.settingsWindow.isOpen()).toBe(false);
  });
});

describe('hotkey capture', () => {
  const accel = 'CommandOrControl+Shift+B';

  it('releases the global hotkey while Settings records and restores it afterwards', () => {
    const { ctl } = setup();
    ctl.start();
    expect(h.registered.has(accel)).toBe(true);
    ctl.setHotkeyCapture(true);
    expect(h.registered.has(accel)).toBe(false);
    ctl.setHotkeyCapture(false);
    expect(h.registered.has(accel)).toBe(true);
    ctl.shutdown();
  });

  it('validates a newly saved combination during capture without holding it', () => {
    const { ctl, settings } = setup();
    ctl.start();
    ctl.setHotkeyCapture(true);
    settings.update({ hotkey: 'CommandOrControl+Alt+K' });
    expect(h.registered.size).toBe(0); // a second press still reaches the capture box
    expect(ctl.hotkeyError).toBeNull();
    h.taken.add('CommandOrControl+Alt+J');
    settings.update({ hotkey: 'CommandOrControl+Alt+J' });
    expect(ctl.hotkeyError).toMatch(/in use/);
    expect(h.registered.size).toBe(0);
    h.taken.clear();
    settings.update({ hotkey: 'CommandOrControl+Alt+K' });
    ctl.setHotkeyCapture(false);
    expect([...h.registered]).toEqual(['CommandOrControl+Alt+K']);
    expect(ctl.hotkeyError).toBeNull();
    ctl.shutdown();
  });

  it('ends capture when the settings window loses focus, closes or crashes', () => {
    const { ctl } = setup();
    ctl.start();
    ctl.openSettings();
    const settingsWin = h.windows[1] as FakeWindow;
    ctl.setHotkeyCapture(true);
    settingsWin.emit('blur');
    expect(ctl.hotkeyCaptureActive).toBe(false);
    expect(h.registered.has(accel)).toBe(true);

    ctl.setHotkeyCapture(true);
    settingsWin.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(h.registered.has(accel)).toBe(true);

    ctl.openSettings();
    ctl.setHotkeyCapture(true);
    (h.windows[2] as FakeWindow).destroy();
    expect(h.registered.has(accel)).toBe(true);
    ctl.shutdown();
  });

  it('does not re-register after shutdown', () => {
    const { ctl } = setup();
    ctl.start();
    ctl.setHotkeyCapture(true);
    ctl.shutdown();
    ctl.setHotkeyCapture(false);
    expect(h.registered.size).toBe(0);
  });
});

describe('power and presence', () => {
  it('forwards lock, unlock, suspend and resume to the agent', () => {
    const { ctl } = setup();
    ctl.start();
    for (const state of ['lock', 'unlock', 'suspend', 'resume'] as const) ctl.notifyPower(state);
    expect(agentCommands()).toEqual([
      { type: 'power', state: 'lock' },
      { type: 'power', state: 'unlock' },
      { type: 'power', state: 'suspend' },
      { type: 'power', state: 'resume' },
    ]);
    ctl.shutdown();
  });

  it('reports the system idle state', () => {
    const { ctl } = setup();
    h.idleState = 'locked';
    expect(ctl.systemIdleState(1200)).toBe('locked');
    h.idleState = 'active';
    expect(ctl.systemIdleState(1200)).toBe('active');
    ctl.shutdown();
  });
});

describe('startup character dialog', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('words an unavailable custom character as temporary and can forget it on request', async () => {
    const { ctl, settings } = setup({ characterError: 'The character file "Robby.acs" could not be found.', characterUnavailable: true, characterPath: 'E:\\Robby.acs' });
    h.dialogResponse = 1;
    ctl.start();
    ctl.agent.markReady();
    await flush();
    expect(h.dialogCalls).toHaveLength(1);
    expect(h.dialogCalls[0]!.message).toMatch(/not available right now/);
    expect(h.dialogCalls[0]!.buttons).toEqual(['OK', 'Use Bonzi from now on']);
    expect(settings.get().characterPath).toBeNull();
    ctl.shutdown();
  });

  it('keeps the saved path when the user just presses OK', async () => {
    const { ctl, settings } = setup({ characterError: 'not found', characterUnavailable: true, characterPath: 'E:\\Robby.acs' });
    ctl.start();
    ctl.agent.markReady();
    await flush();
    expect(settings.get().characterPath).toBe('E:\\Robby.acs');
    ctl.shutdown();
  });

  it('keeps the old wording for an invalid custom character', async () => {
    const { ctl } = setup({ characterError: '"x.acs" is not a valid Microsoft Agent character file.' });
    ctl.start();
    ctl.agent.markReady();
    await flush();
    expect(h.dialogCalls[0]!.message).toMatch(/could not be loaded/);
    expect(h.dialogCalls[0]!.buttons).toEqual(['OK']);
    ctl.shutdown();
  });
});

describe('tray tip after the first Hide', () => {
  function withTray(ctl: InstanceType<typeof AppController>, ok = true) {
    const hints: Array<{ title: string; content: string }> = [];
    ctl.tray = {
      refresh: () => undefined,
      destroy: () => undefined,
      showHint: (title: string, content: string) => {
        hints.push({ title, content });
        return ok;
      },
    };
    return hints;
  }

  it('says where Bonzi went the first time he is hidden, then never again', () => {
    const { ctl, settings } = setup();
    const hints = withTray(ctl);
    ctl.start();
    ctl.agent.markReady();
    ctl.hideBonzi();
    expect(hints).toHaveLength(1);
    expect(hints[0]!.title).toBe('Bonzi is still here');
    expect(hints[0]!.content).toMatch(/Click this icon to bring Bonzi back/);
    expect(hints[0]!.content).not.toContain(String.fromCharCode(0x2014));
    expect(settings.get().hideHintShown).toBe(true);
    ctl.showBonzi();
    ctl.hideBonzi();
    expect(hints).toHaveLength(1);
    ctl.shutdown();
  });

  it('tries again next time when the balloon could not be shown', () => {
    const { ctl, settings } = setup();
    const hints = withTray(ctl, false);
    ctl.start();
    ctl.agent.markReady();
    ctl.hideBonzi();
    expect(hints).toHaveLength(1);
    expect(settings.get().hideHintShown).toBe(false);
    ctl.shutdown();
  });

  it('stays quiet when the tip was already shown in an earlier session', () => {
    const { ctl, settings } = setup();
    settings.updateTrusted({ hideHintShown: true });
    const hints = withTray(ctl);
    ctl.start();
    ctl.agent.markReady();
    ctl.hideBonzi();
    expect(hints).toHaveLength(0);
    ctl.shutdown();
  });
});
