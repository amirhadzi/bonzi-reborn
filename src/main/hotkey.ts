// Global hotkey that summons the chat bar. Failures are reported, never fatal.

import { globalShortcut } from 'electron';
import { log } from './logger.ts';

let current: string | null = null;

/**
 * Registers accelerator (replacing the previous one). Empty disables it.
 * Returns an error message for the settings UI, or null on success.
 */
export function registerHotkey(accelerator: string, onPress: () => void): string | null {
  unregisterHotkey();
  const accel = accelerator.trim();
  if (!accel) return null;
  let ok = false;
  try {
    ok = globalShortcut.register(accel, onPress);
  } catch (err) {
    log.warn(`Invalid hotkey "${accel}": ${err instanceof Error ? err.message : String(err)}`);
    return 'Shortcut is invalid. Try something like Ctrl+Shift+B.';
  }
  if (!ok) {
    log.warn(`Hotkey "${accel}" could not be registered.`);
    return 'Shortcut is in use by another app or invalid.';
  }
  current = accel;
  log.info(`Hotkey registered: ${accel}`);
  return null;
}

export function unregisterHotkey(): void {
  if (current) {
    try {
      globalShortcut.unregister(current);
    } catch {
      // ignore
    }
    current = null;
  }
}

export function unregisterAllHotkeys(): void {
  current = null;
  try {
    globalShortcut.unregisterAll();
  } catch {
    // ignore
  }
}
