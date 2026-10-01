// Settings window entry point. Talks to the main process only through
// window.bonziSettings (BonziSettingsApi); never sees the API key.

import type { BonziSettingsApi } from '../../shared/ipc.ts';
import type { SaveState } from './context.ts';
import { SettingsContext } from './context.ts';
import { h } from './dom.ts';
import { bananaIcon, icon } from './icons.ts';
import { errorText } from './lib/format.ts';
import { accountSection } from './sections/account.ts';
import { appSection } from './sections/app.ts';
import { brainSection } from './sections/brain.ts';
import { characterSection } from './sections/character.ts';
import { listeningSection } from './sections/listening.ts';
import type { Section } from './sections/types.ts';
import { voiceSection } from './sections/voice.ts';

function saveIndicator(): { el: HTMLElement; set(state: SaveState, message?: string): void } {
  const el = h('div', { class: 'save-indicator', attrs: { role: 'status', 'aria-live': 'polite' } });
  const set = (state: SaveState, message?: string): void => {
    el.dataset.state = state;
    switch (state) {
      case 'saving':
        el.replaceChildren(h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'Saving' }));
        break;
      case 'saved':
        el.replaceChildren(icon('check', 'icon icon-sm'), h('span', { text: 'Saved' }));
        break;
      case 'error':
        el.replaceChildren(icon('error', 'icon icon-sm'), h('span', { text: message ?? 'Could not save' }));
        break;
      case 'idle':
        // Keep the content so the fade-out is smooth; CSS hides it.
        break;
    }
  };
  return { el, set };
}

function buildShell(ctx: SettingsContext, sections: Section[]): { root: HTMLElement; showSection(id: string, focus?: boolean): void } {
  const title = h('h1', { class: 'page-title', id: 'page-title' });
  const subtitle = h('p', { class: 'page-sub' });
  const indicator = saveIndicator();
  ctx.onSaveState(indicator.set);

  const navButtons = new Map<string, HTMLButtonElement>();
  const nav = h('nav', { class: 'nav', attrs: { 'aria-label': 'Settings sections' } });
  const list = h('ul', { class: 'nav-list' });
  for (const s of sections) {
    const b = h(
      'button',
      { class: 'nav-item', attrs: { type: 'button', 'data-section': s.id, 'aria-controls': `page-${s.id}`, title: s.title } },
      icon(s.iconName, 'icon nav-icon'),
      h('span', { class: 'nav-label', text: s.title }),
    );
    navButtons.set(s.id, b);
    list.append(h('li', {}, b));
    s.element.id = `page-${s.id}`;
    s.element.setAttribute('aria-labelledby', 'page-title');
  }
  nav.append(list);

  const brand = h(
    'div',
    { class: 'brand' },
    h('div', { class: 'brand-logo' }, bananaIcon()),
    h('div', { class: 'brand-text' }, h('div', { class: 'brand-name', text: 'BonziBuddy' }), h('div', { class: 'brand-sub', text: 'Reborn' })),
  );

  const content = h('main', { class: 'content', attrs: { tabindex: '-1' } });
  const inner = h(
    'div',
    { class: 'content-inner' },
    h('header', { class: 'page-header' }, h('div', { class: 'page-heading' }, title, subtitle), indicator.el),
    ...sections.map((s) => s.element),
  );
  content.append(inner);

  let current = '';
  const showSection = (id: string, focus = false): void => {
    const target = sections.find((s) => s.id === id) ?? sections[0];
    if (!target) return;
    for (const s of sections) {
      const active = s === target;
      if (active) s.element.removeAttribute('hidden');
      else s.element.setAttribute('hidden', '');
      const b = navButtons.get(s.id);
      if (active) b?.setAttribute('aria-current', 'page');
      else b?.removeAttribute('aria-current');
    }
    title.textContent = target.title;
    subtitle.textContent = target.subtitle;
    document.title = `${target.title} - BonziBuddy Settings`;
    if (current !== target.id) content.scrollTop = 0;
    current = target.id;
    if (location.hash !== `#${target.id}`) history.replaceState(null, '', `#${target.id}`);
    target.onShow?.();
    if (focus) content.focus({ preventScroll: true });
  };

  list.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('.nav-item');
    if (b?.dataset.section) showSection(b.dataset.section);
  });
  list.addEventListener('keydown', (e) => {
    const buttons = [...navButtons.values()];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % buttons.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const b = buttons[next];
    if (b) {
      b.focus();
      if (b.dataset.section) showSection(b.dataset.section);
    }
  });

  const skip = h('a', { class: 'skip-link', text: 'Skip to settings', attrs: { href: '#' } });
  skip.addEventListener('click', (e) => {
    e.preventDefault();
    content.focus();
  });

  const aiNote = h(
    'p',
    { class: 'sidebar-note', attrs: { title: 'Bonzi is an AI. His voice is AI-generated.' } },
    icon('shield', 'icon icon-sm'),
    h('span', { class: 'sidebar-note-text', text: 'Bonzi is an AI. His voice is AI-generated.' }),
  );
  const root = h('div', { class: 'shell' }, skip, h('aside', { class: 'sidebar' }, brand, nav, aiNote), content);
  return { root, showSection };
}

function fatal(message: string): void {
  const app = document.getElementById('app') ?? document.body;
  app.className = 'app-fatal';
  app.replaceChildren(
    h('div', { class: 'fatal' }, icon('error', 'icon fatal-icon'), h('h1', { text: 'Settings could not be loaded' }), h('p', { text: message })),
  );
}

async function start(): Promise<void> {
  const api = (window as { bonziSettings?: BonziSettingsApi }).bonziSettings;
  if (!api) {
    fatal('The settings bridge is missing. Please restart BonziBuddy.');
    return;
  }
  let ctx: SettingsContext;
  try {
    const [settings, info] = await Promise.all([api.get(), api.getInfo().catch(() => null)]);
    ctx = new SettingsContext(api, settings);
    ctx.info = info;
  } catch (e) {
    fatal(errorText(e, 'Please close this window and try again.'));
    return;
  }

  const sections = [accountSection(ctx), brainSection(ctx), voiceSection(ctx), listeningSection(ctx), characterSection(ctx), appSection(ctx)];
  const shell = buildShell(ctx, sections);
  const app = document.getElementById('app') ?? document.body;
  app.className = '';
  app.removeAttribute('aria-busy');
  app.replaceChildren(shell.root);

  api.onChanged((s) => ctx.apply(s));
  window.addEventListener('beforeunload', () => ctx.flushAll());
  window.addEventListener('hashchange', () => shell.showSection(location.hash.slice(1)));

  const initial = location.hash.slice(1);
  shell.showSection(sections.some((s) => s.id === initial) ? initial : 'account');
}

void start();
