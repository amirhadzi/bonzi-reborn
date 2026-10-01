import { describe, expect, it } from 'vitest';
import type { KeyLike } from '../src/renderer/settings/lib/accelerator.ts';
import { HotkeyRecorder, TOO_LONG_MESSAGE } from '../src/renderer/settings/lib/hotkey-recorder.ts';
import type { HotkeyRecorderHost } from '../src/renderer/settings/lib/hotkey-recorder.ts';

function key(code: string, mods: Partial<KeyLike> = {}, k = ''): KeyLike {
  return { code, key: k || code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}

function setup(initial = 'CommandOrControl+Shift+B', maxLength = 100) {
  const capture: boolean[] = [];
  const saved: string[] = [];
  let current = initial;
  const host: HotkeyRecorderHost = {
    setCapture: (on) => capture.push(on),
    save: (accel) => {
      saved.push(accel);
      current = accel;
    },
    current: () => current,
    maxLength,
  };
  return { rec: new HotkeyRecorder(host), capture, saved };
}

describe('HotkeyRecorder global shortcut pause', () => {
  it('pauses the global shortcut before recording starts and resumes it on stop', () => {
    const { rec, capture } = setup();
    expect(rec.recording).toBe(false);
    rec.start();
    expect(capture).toEqual([true]);
    expect(rec.recording).toBe(true);
    rec.stop();
    expect(capture).toEqual([true, false]);
    expect(rec.recording).toBe(false);
  });

  it('sends nothing for a stop without an active capture (stray blur)', () => {
    const { rec, capture } = setup();
    rec.stop();
    rec.stop();
    expect(capture).toEqual([]);
  });

  it('does not double-pause or double-resume', () => {
    const { rec, capture } = setup();
    rec.start();
    rec.start();
    rec.stop();
    rec.stop();
    expect(capture).toEqual([true, false]);
  });

  it('restarts capture when focus returns after a window-level blur', () => {
    const { rec, capture } = setup();
    rec.start();
    rec.stop(); // window lost focus
    rec.start(); // Chromium refocuses the input on reactivation
    expect(capture).toEqual([true, false, true]);
    expect(rec.recording).toBe(true);
  });

  it('records the currently registered shortcut while paused and keeps the pause after saving', () => {
    const { rec, capture, saved } = setup('CommandOrControl+Shift+B');
    rec.start();
    const r = rec.keydown(key('KeyB', { ctrlKey: true, shiftKey: true }, 'B'));
    expect(r).toEqual({ kind: 'captured', accelerator: 'CommandOrControl+Shift+B', text: expect.any(String) });
    expect(saved).toEqual(['CommandOrControl+Shift+B']);
    // Saving must not resume the shortcut, or a second press would be swallowed.
    expect(capture).toEqual([true]);
    const again = rec.keydown(key('KeyB', { ctrlKey: true, shiftKey: true }, 'B'));
    expect(again.kind).toBe('captured');
    expect(saved).toHaveLength(2);
    expect(capture).toEqual([true]);
  });

  it('Escape asks the caller to blur, and the resulting stop resumes the shortcut', () => {
    const { rec, capture } = setup();
    rec.start();
    expect(rec.keydown(key('Escape', {}, 'Escape'))).toEqual({ kind: 'cancel' });
    rec.stop();
    expect(capture).toEqual([true, false]);
  });
});

describe('HotkeyRecorder keys', () => {
  it('ignores keys when not recording', () => {
    const { rec, saved } = setup();
    expect(rec.keydown(key('KeyB', { ctrlKey: true }, 'b'))).toEqual({ kind: 'ignore' });
    expect(saved).toEqual([]);
  });

  it('lets plain Tab through for keyboard navigation', () => {
    const { rec } = setup();
    rec.start();
    expect(rec.keydown(key('Tab', {}, 'Tab'))).toEqual({ kind: 'ignore' });
  });

  it('previews modifiers held without a key', () => {
    const { rec } = setup();
    rec.start();
    const r = rec.keydown(key('ControlLeft', { ctrlKey: true }, 'Control'));
    expect(r.kind).toBe('preview');
    if (r.kind === 'preview') expect(r.text.endsWith('...')).toBe(true);
  });

  it('reports an invalid combination and clears the box', () => {
    const { rec, saved } = setup();
    rec.start();
    const r = rec.keydown(key('KeyB', {}, 'b'));
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.clear).toBe(true);
    expect(saved).toEqual([]);
  });

  it('rejects an accelerator longer than the limit without saving', () => {
    const { rec, saved } = setup('', 5);
    rec.start();
    const r = rec.keydown(key('KeyB', { ctrlKey: true, shiftKey: true }, 'B'));
    expect(r).toEqual({ kind: 'error', message: TOO_LONG_MESSAGE, clear: false });
    expect(saved).toEqual([]);
  });

  it('keyup restores the empty prompt, or the combination captured this session', () => {
    const { rec } = setup('');
    expect(rec.keyup('Ctrl + ...')).toBeNull(); // not recording
    rec.start();
    expect(rec.keyup('Ctrl + Shift + B')).toBeNull();
    expect(rec.keyup('Ctrl + ...')).toBe('');
    rec.keydown(key('KeyK', { ctrlKey: true, altKey: true }, 'k'));
    const restored = rec.keyup('Ctrl + ...');
    expect(restored).not.toBeNull();
    expect(restored).not.toBe('');
  });

  it('a new session forgets the previous capture', () => {
    const { rec } = setup('');
    rec.start();
    rec.keydown(key('KeyK', { ctrlKey: true, altKey: true }, 'k'));
    rec.stop();
    rec.start();
    expect(rec.keyup('Ctrl + ...')).toBe('');
  });
});
