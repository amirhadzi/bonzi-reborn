import { DEFAULT_SETTINGS, LIMITS } from '../../../shared/settings.ts';
import type { SettingsContext } from '../context.ts';
import { button, callout, card, group, h, row, show, toggle, uid } from '../dom.ts';
import { bindToggle } from '../fields.ts';
import { bananaIcon, icon } from '../icons.ts';
import { formatAccelerator } from '../lib/accelerator.ts';
import { hostOf } from '../lib/format.ts';
import { CAPTURED_HINT, HotkeyRecorder, RECORDING_PLACEHOLDER } from '../lib/hotkey-recorder.ts';
import type { Section } from './types.ts';

export function appSection(ctx: SettingsContext): Section {
  // --- Launch at login
  const loginRow = row({ label: 'Start with Windows', description: 'Bonzi appears when you sign in.' });
  const login = toggle(uid('login'), loginRow.labelId, loginRow.descId);
  loginRow.row.append(h('div', { class: 'row-control' }, login.wrap));
  bindToggle(ctx, login, (s) => s.launchAtLogin, (on) => ({ launchAtLogin: on }));

  // --- Hotkey capture
  const hotkeyId = uid('hotkey');
  const hotkey = h('input', {
    id: hotkeyId,
    class: 'input hotkey',
    attrs: { type: 'text', readonly: true, autocomplete: 'off', spellcheck: 'false', 'aria-roledescription': 'shortcut recorder' },
  });
  const clearKey = button('Clear', 'subtle');
  const resetKey = button('Default', 'subtle');
  const hotkeyHint = h('p', { class: 'field-hint' });
  const hotkeyError = callout('warning');
  const hotkeyRow = row({
    label: 'Chat shortcut',
    description: 'Opens the chat bar from anywhere. Click the box, then press a key combination.',
    forId: hotkeyId,
    stack: true,
    control: h('div', { class: 'stack' }, h('div', { class: 'inline' }, hotkey, clearKey, resetKey), hotkeyHint, hotkeyError.el),
  });
  hotkey.setAttribute('aria-describedby', `${hotkeyRow.descId}`);
  show(hotkeyHint, false);

  // The recorder pauses the global shortcut in main while the box has focus;
  // otherwise Windows consumes the combination (and Bonzi steals focus) before
  // this input sees it. See lib/hotkey-recorder.ts.
  const recorder = new HotkeyRecorder({
    setCapture: (on) => ctx.api.setHotkeyCapture(on),
    save: (accelerator) => void ctx.save({ hotkey: accelerator }),
    current: () => ctx.settings.hotkey,
    maxLength: LIMITS.hotkey,
  });
  const display = (accel: string): void => {
    hotkey.value = accel ? formatAccelerator(accel) : '';
    hotkey.placeholder = accel ? '' : 'None';
  };
  const setHint = (text: string, error = false): void => {
    hotkeyHint.textContent = text;
    hotkeyHint.className = error ? 'field-hint field-hint-error' : 'field-hint';
    show(hotkeyHint, !!text);
  };
  const stopRecording = (): void => {
    recorder.stop();
    hotkey.classList.remove('recording');
    display(ctx.settings.hotkey);
  };
  hotkey.addEventListener('focus', () => {
    // Chromium refires focus here when the window is reactivated, which
    // restarts the capture after a window-level blur ended it.
    recorder.start();
    hotkey.classList.add('recording');
    hotkey.value = '';
    hotkey.placeholder = RECORDING_PLACEHOLDER;
    setHint('');
  });
  hotkey.addEventListener('blur', () => {
    stopRecording();
    setHint('');
  });
  // Blur is not guaranteed while the page is torn down; main also resets the
  // capture when the window closes, this just ends it as early as possible.
  window.addEventListener('pagehide', () => recorder.stop());
  hotkey.addEventListener('keydown', (e) => {
    const r = recorder.keydown(e);
    if (r.kind === 'ignore') return;
    e.preventDefault();
    e.stopPropagation();
    switch (r.kind) {
      case 'cancel':
        hotkey.blur();
        return;
      case 'preview':
        hotkey.value = r.text;
        return;
      case 'error':
        if (r.clear) hotkey.value = '';
        setHint(r.message, true);
        return;
      case 'captured':
        hotkey.value = r.text;
        setHint(CAPTURED_HINT);
        return;
    }
  });
  hotkey.addEventListener('keyup', () => {
    const text = recorder.keyup(hotkey.value);
    if (text !== null) hotkey.value = text;
  });
  clearKey.addEventListener('click', () => {
    setHint('');
    void ctx.save({ hotkey: '' });
  });
  resetKey.addEventListener('click', () => {
    setHint('');
    void ctx.save({ hotkey: DEFAULT_SETTINGS.hotkey });
  });
  ctx.bind((s) => {
    if (!recorder.recording) display(s.hotkey);
    clearKey.disabled = s.hotkey === '';
    resetKey.disabled = s.hotkey === DEFAULT_SETTINGS.hotkey;
    if (s.hotkeyError) hotkeyError.set('warning', s.hotkeyError);
    else hotkeyError.hide();
  });

  // --- About
  const versionEl = h('div', { class: 'about-version', text: 'Version -' });
  const techEl = h('div', { class: 'about-tech', text: '' });
  const privacyEl = h('p', { class: 'about-text' });
  ctx.bind((s) => {
    const host = hostOf(s.baseUrl) ?? 'your configured AI server';
    privacyEl.textContent = `No telemetry, no ads, no tracking. Your key is encrypted on this PC with Windows DPAPI and only ever sent to ${host}.`;
  });
  const renderInfo = (): void => {
    const i = ctx.info;
    if (!i) return;
    versionEl.textContent = `Version ${i.version}`;
    techEl.textContent = `Electron ${i.electron}  ·  Chrome ${i.chrome}  ·  ${i.arch}`;
  };
  renderInfo();

  const about = card(
    h(
      'div',
      { class: 'about-head' },
      h('div', { class: 'about-logo', attrs: { 'aria-hidden': 'true' } }, bananaIcon()),
      h('div', {}, h('div', { class: 'about-name', text: 'BonziBuddy Reborn' }), versionEl, techEl),
    ),
    h('div', { class: 'about-row' }, icon('shield', 'icon about-icon'), privacyEl),
    h('div', { class: 'about-row' }, icon('info', 'icon about-icon'), h('p', { class: 'about-text', text: 'Bonzi is an AI. His voices are AI-generated, and he will never claim to be a person.' })),
    h(
      'div',
      { class: 'about-row' },
      icon('character', 'icon about-icon'),
      h('p', { class: 'about-text', text: 'BonziBuddy is a trademark of its respective owners. This is an unofficial fan recreation, not affiliated with or endorsed by them.' }),
    ),
  );

  const element = h('div', { class: 'page' }, group('Startup and shortcuts', card(loginRow.row, hotkeyRow.row)), group('About', about));

  return {
    id: 'app',
    title: 'App',
    subtitle: 'Startup, shortcuts and version information.',
    iconName: 'app',
    element,
    onShow: renderInfo,
  };
}
