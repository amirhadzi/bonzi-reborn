import { describe, expect, it } from 'vitest';
import type { KeyLike } from '../src/renderer/settings/lib/accelerator.ts';
import { acceleratorFromKeyEvent, acceleratorKeyFromCode, formatAccelerator, isModifierOnly } from '../src/renderer/settings/lib/accelerator.ts';

function key(code: string, mods: Partial<KeyLike> = {}, k = ''): KeyLike {
  return { code, key: k || code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}

describe('acceleratorKeyFromCode', () => {
  it('maps letters, digits, function keys and numpad', () => {
    expect(acceleratorKeyFromCode('KeyB')).toBe('B');
    expect(acceleratorKeyFromCode('Digit7')).toBe('7');
    expect(acceleratorKeyFromCode('F1')).toBe('F1');
    expect(acceleratorKeyFromCode('F24')).toBe('F24');
    expect(acceleratorKeyFromCode('F25')).toBeNull();
    expect(acceleratorKeyFromCode('Numpad5')).toBe('num5');
    expect(acceleratorKeyFromCode('NumpadAdd')).toBe('numadd');
  });

  it('maps named keys to Electron names', () => {
    expect(acceleratorKeyFromCode('ArrowUp')).toBe('Up');
    expect(acceleratorKeyFromCode('Space')).toBe('Space');
    expect(acceleratorKeyFromCode('Escape')).toBe('Esc');
    expect(acceleratorKeyFromCode('Slash')).toBe('/');
    expect(acceleratorKeyFromCode('IntlBackslash')).toBeNull();
  });
});

describe('acceleratorFromKeyEvent', () => {
  it('builds CommandOrControl+Shift+B in canonical modifier order', () => {
    expect(acceleratorFromKeyEvent(key('KeyB', { ctrlKey: true, shiftKey: true }))).toEqual({
      kind: 'complete',
      accelerator: 'CommandOrControl+Shift+B',
    });
    expect(acceleratorFromKeyEvent(key('KeyK', { metaKey: true, altKey: true, ctrlKey: true, shiftKey: true }))).toEqual({
      kind: 'complete',
      accelerator: 'CommandOrControl+Alt+Shift+Super+K',
    });
  });

  it('allows bare function keys', () => {
    expect(acceleratorFromKeyEvent(key('F9'))).toEqual({ kind: 'complete', accelerator: 'F9' });
    expect(acceleratorFromKeyEvent(key('F9', { shiftKey: true }))).toEqual({ kind: 'complete', accelerator: 'Shift+F9' });
  });

  it('rejects plain or shift-only letters', () => {
    expect(acceleratorFromKeyEvent(key('KeyA')).kind).toBe('invalid');
    expect(acceleratorFromKeyEvent(key('KeyA', { shiftKey: true })).kind).toBe('invalid');
  });

  it('reports modifier-only presses as partial with a readable preview', () => {
    const r = acceleratorFromKeyEvent(key('ControlLeft', { ctrlKey: true, shiftKey: true }, 'Control'));
    expect(r).toEqual({ kind: 'partial', preview: 'Ctrl + Shift + ...' });
    expect(isModifierOnly(key('ShiftRight', {}, 'Shift'))).toBe(true);
    expect(isModifierOnly(key('KeyA', {}, 'a'))).toBe(false);
  });

  it('rejects keys that have no accelerator name', () => {
    expect(acceleratorFromKeyEvent(key('IntlRo', { ctrlKey: true })).kind).toBe('invalid');
  });
});

describe('formatAccelerator', () => {
  it('formats for Windows users', () => {
    expect(formatAccelerator('CommandOrControl+Shift+B')).toBe('Ctrl + Shift + B');
    expect(formatAccelerator('CmdOrCtrl+Alt+Super+num5')).toBe('Ctrl + Alt + Win + Num 5');
    expect(formatAccelerator('Shift+F9')).toBe('Shift + F9');
    expect(formatAccelerator('Alt+Up')).toBe('Alt + Up');
    expect(formatAccelerator('')).toBe('');
  });
});
