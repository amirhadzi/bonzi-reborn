import type { BalloonStyle, PublicSettings } from '../../../shared/settings.ts';
import { LIMITS } from '../../../shared/settings.ts';
import type { SettingsContext } from '../context.ts';
import { button, card, group, h, numberInput, row, select, setOptions, status, toggle, uid } from '../dom.ts';
import { bindNumber, bindSelect, bindToggle } from '../fields.ts';
import { icon } from '../icons.ts';
import { errorText } from '../lib/format.ts';
import { SIZE_OPTIONS, sizeLabel } from '../lib/models.ts';
import type { Section } from './types.ts';

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function characterSection(ctx: SettingsContext): Section {
  // --- Current character
  const nameEl = h('div', { class: 'char-name' });
  const fileEl = h('div', { class: 'char-file' });
  const choose = button('Choose .acs file...', 'secondary', 'folder');
  const useBonzi = button('Use Bonzi', 'subtle');
  const charStatus = status();
  const charHeader = h(
    'div',
    { class: 'char-card' },
    h('div', { class: 'char-avatar', attrs: { 'aria-hidden': 'true' } }, icon('character')),
    h('div', { class: 'char-text' }, nameEl, fileEl, h('div', { class: 'inline char-actions' }, choose, useBonzi)),
  );
  choose.addEventListener('click', async () => {
    choose.disabled = true;
    charStatus.set('busy', 'Waiting for a file...');
    try {
      const r = await ctx.api.chooseCharacter();
      if (r.ok) {
        ctx.apply(r.settings);
        charStatus.set('success', `${r.settings.characterName} is ready.`);
      } else if (r.cancelled) {
        charStatus.clear();
      } else {
        charStatus.set('error', r.message || 'That file is not a Microsoft Agent character.');
      }
    } catch (e) {
      charStatus.set('error', errorText(e, 'The character could not be loaded.'));
    } finally {
      choose.disabled = false;
    }
  });
  useBonzi.addEventListener('click', async () => {
    useBonzi.disabled = true;
    try {
      await ctx.run(() => ctx.api.resetCharacter());
      charStatus.set('success', 'Bonzi is back.');
    } catch (e) {
      charStatus.set('error', errorText(e, 'Could not switch back to Bonzi.'));
      useBonzi.disabled = false;
    }
  });
  ctx.bind((s) => {
    nameEl.textContent = s.characterName || 'Bonzi';
    fileEl.textContent = s.characterPath ? baseName(s.characterPath) : 'Built-in character';
    fileEl.title = s.characterPath ?? '';
    useBonzi.disabled = s.characterPath === null;
  });
  const charNote = h('p', { class: 'card-footer', text: 'Any Microsoft Agent character file (.acs) works, such as Merlin, Genie or Peedy.' });

  // --- Size
  const sizeId = uid('size');
  const size = select(sizeId, SIZE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })));
  const sizeRow = row({ label: 'Size', description: 'Pixel-perfect scaling of the original artwork.', forId: sizeId, control: size });
  size.setAttribute('aria-describedby', sizeRow.descId);
  const renderSizes = (s: PublicSettings): void => {
    const opts = SIZE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }));
    if (!SIZE_OPTIONS.some((o) => o.value === s.scale)) opts.push({ value: String(s.scale), label: sizeLabel(s.scale) });
    setOptions(size, opts);
  };
  ctx.bind(renderSizes);
  bindSelect(ctx, size, (s) => String(s.scale), (v) => ({ scale: Number(v) }));

  const topRow = row({ label: 'Always on top', description: 'Keep Bonzi above other windows.' });
  const top = toggle(uid('top'), topRow.labelId, topRow.descId);
  topRow.row.append(h('div', { class: 'row-control' }, top.wrap));
  bindToggle(ctx, top, (s) => s.alwaysOnTop, (on) => ({ alwaysOnTop: on }));

  const balloonId = uid('balloon');
  const balloon = select(balloonId, [
    { value: 'modern', label: 'Modern' },
    { value: 'classic', label: 'Classic' },
  ]);
  const balloonRow = row({ label: 'Speech balloon', description: 'Modern is clean and rounded. Classic uses the character\'s original colours and font.', forId: balloonId, control: balloon });
  balloon.setAttribute('aria-describedby', balloonRow.descId);
  bindSelect(ctx, balloon, (s) => s.balloonStyle, (v) => ({ balloonStyle: v as BalloonStyle }));

  // --- Behaviour
  const idleRow = row({ label: 'Idle animations', description: 'Bonzi fidgets, looks around and eventually dozes off when left alone.' });
  const idle = toggle(uid('idle'), idleRow.labelId, idleRow.descId);
  idleRow.row.append(h('div', { class: 'row-control' }, idle.wrap));
  bindToggle(ctx, idle, (s) => s.idleAnimations, (on) => ({ idleAnimations: on }));

  const chatterRow = row({ label: 'Idle chatter', description: 'Bonzi occasionally says something on his own. Each remark is a request to your AI provider.' });
  const chatter = toggle(uid('chatter'), chatterRow.labelId, chatterRow.descId);
  chatterRow.row.append(h('div', { class: 'row-control' }, chatter.wrap));

  const minutesId = uid('minutes');
  const minutes = numberInput(minutesId, LIMITS.idleChatterMinutes.min, LIMITS.idleChatterMinutes.max);
  const minutesRow = row({
    label: 'Chatter interval',
    description: `Minutes without interaction before Bonzi speaks up (${LIMITS.idleChatterMinutes.min} to ${LIMITS.idleChatterMinutes.max}).`,
    forId: minutesId,
    control: h('div', { class: 'inline' }, minutes, h('span', { class: 'unit', text: 'min' })),
  });
  minutesRow.row.classList.add('row-sub');
  minutes.setAttribute('aria-describedby', minutesRow.descId);
  bindNumber(ctx, minutes, (s) => s.idleChatterMinutes, (n) => ({ idleChatterMinutes: n }), LIMITS.idleChatterMinutes.min, LIMITS.idleChatterMinutes.max);
  bindToggle(ctx, chatter, (s) => s.idleChatter, (on) => ({ idleChatter: on }), (s) => {
    minutes.disabled = !s.idleChatter;
    minutesRow.row.classList.toggle('row-disabled', !s.idleChatter);
  });

  const element = h(
    'div',
    { class: 'page' },
    group('Character', card(charHeader, charStatus.el, charNote)),
    group('Appearance', card(sizeRow.row, balloonRow.row, topRow.row)),
    group('Behaviour', card(idleRow.row, chatterRow.row, minutesRow.row)),
  );

  return {
    id: 'character',
    title: 'Character',
    subtitle: 'Who sits on your desktop and how he behaves.',
    iconName: 'character',
    element,
  };
}
