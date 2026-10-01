// Tiny DOM helpers for building settings rows and controls without a framework.

import { icon } from './icons.ts';

type Child = Node | string | null | undefined | false;

export interface Props {
  class?: string;
  id?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.id) el.id = props.id;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) {
      if (v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c);
  }
  return el;
}

let uidCounter = 0;
export function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

export function show(el: Element, visible: boolean): void {
  if (visible) el.removeAttribute('hidden');
  else el.setAttribute('hidden', '');
}

// ---------------------------------------------------------------------------
// Layout

export function group(title: string, ...children: Child[]): HTMLElement {
  const id = uid('grp');
  return h('section', { class: 'group', attrs: { 'aria-labelledby': id } }, h('h2', { class: 'group-title', id, text: title }), ...children);
}

export function card(...rows: Child[]): HTMLDivElement {
  return h('div', { class: 'card' }, ...rows);
}

export interface RowOptions {
  label: string;
  description?: string;
  /** id of the control the label is for. */
  forId?: string;
  control?: Node | null;
  /** Control goes below the text at full width (text areas, key field). */
  stack?: boolean;
  iconName?: string;
}

export interface Row {
  row: HTMLDivElement;
  label: HTMLElement;
  desc: HTMLParagraphElement;
  labelId: string;
  descId: string;
}

/**
 * A settings row: label + description on the left, control on the right (or below
 * when `stack` is set). The control should reference labelId/descId for a11y.
 */
export function row(o: RowOptions): Row {
  const labelId = uid('lbl');
  const descId = uid('desc');
  const label = o.forId
    ? h('label', { class: 'row-label', id: labelId, text: o.label, attrs: { for: o.forId } })
    : h('div', { class: 'row-label', id: labelId, text: o.label });
  const desc = h('p', { class: 'row-desc', id: descId, text: o.description ?? '' });
  show(desc, !!o.description);
  const text = h('div', { class: 'row-text' }, label, desc);
  const head = o.iconName ? h('div', { class: 'row-icon' }, icon(o.iconName)) : null;
  const r = h('div', { class: o.stack ? 'row row-stack' : 'row' }, head, text);
  if (o.control) r.append(h('div', { class: 'row-control' }, o.control));
  return { row: r, label, desc, labelId, descId };
}

export function setDescribedBy(el: Element, ...ids: Array<string | null | undefined>): void {
  const v = ids.filter(Boolean).join(' ');
  if (v) el.setAttribute('aria-describedby', v);
  else el.removeAttribute('aria-describedby');
}

// ---------------------------------------------------------------------------
// Controls

export type ButtonVariant = 'primary' | 'secondary' | 'subtle' | 'danger';

export function button(text: string, variant: ButtonVariant = 'secondary', iconName?: string): HTMLButtonElement {
  const b = h('button', { class: `btn btn-${variant}`, attrs: { type: 'button' } });
  if (iconName) b.append(icon(iconName));
  b.append(h('span', { class: 'btn-text', text }));
  return b;
}

export function setButtonText(b: HTMLButtonElement, text: string): void {
  const span = b.querySelector('.btn-text');
  if (span) span.textContent = text;
}

export function linkButton(text: string): HTMLButtonElement {
  const b = h('button', { class: 'link', attrs: { type: 'button' } }, h('span', { text }), icon('external', 'icon icon-sm'));
  return b;
}

export interface Toggle {
  wrap: HTMLLabelElement;
  input: HTMLInputElement;
  set(on: boolean): void;
}

/** Windows 11 style switch with an On/Off caption. */
export function toggle(id: string, labelledBy: string, describedBy?: string): Toggle {
  const input = h('input', { id, class: 'switch', attrs: { type: 'checkbox', role: 'switch', 'aria-labelledby': labelledBy } });
  if (describedBy) input.setAttribute('aria-describedby', describedBy);
  const state = h('span', { class: 'switch-state', attrs: { 'aria-hidden': 'true' } });
  const wrap = h('label', { class: 'switch-wrap' }, state, input);
  const set = (on: boolean): void => {
    input.checked = on;
    state.textContent = on ? 'On' : 'Off';
  };
  input.addEventListener('change', () => {
    state.textContent = input.checked ? 'On' : 'Off';
  });
  return { wrap, input, set };
}

export function select(id: string, options: ReadonlyArray<{ value: string; label: string }>): HTMLSelectElement {
  const s = h('select', { id, class: 'select' });
  setOptions(s, options);
  return s;
}

export function setOptions(s: HTMLSelectElement, options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>): void {
  const current = s.value;
  s.replaceChildren(
    ...options.map((o) => h('option', { text: o.label, attrs: { value: o.value, disabled: o.disabled === true } })),
  );
  if (options.some((o) => o.value === current)) s.value = current;
}

export function textInput(id: string, opts: { maxLength?: number; placeholder?: string; type?: string; list?: string } = {}): HTMLInputElement {
  return h('input', {
    id,
    class: 'input',
    attrs: {
      type: opts.type ?? 'text',
      maxlength: opts.maxLength,
      placeholder: opts.placeholder,
      list: opts.list,
      spellcheck: 'false',
      autocomplete: 'off',
    },
  });
}

export function numberInput(id: string, min: number, max: number, step = 1): HTMLInputElement {
  return h('input', {
    id,
    class: 'input input-number',
    attrs: { type: 'number', min, max, step, inputmode: 'numeric' },
  });
}

export interface TextArea {
  wrap: HTMLDivElement;
  input: HTMLTextAreaElement;
  counter: HTMLSpanElement;
  updateCounter(): void;
}

export function textArea(id: string, maxLength: number, placeholder: string, rows = 4): TextArea {
  const input = h('textarea', { id, class: 'input textarea', attrs: { maxlength: maxLength, rows, placeholder, spellcheck: 'true' } });
  const counter = h('span', { class: 'counter', attrs: { 'aria-live': 'off' } });
  const updateCounter = (): void => {
    counter.textContent = `${input.value.length.toLocaleString('en-US')} / ${maxLength.toLocaleString('en-US')}`;
    counter.classList.toggle('counter-near', input.value.length >= maxLength * 0.9);
  };
  input.addEventListener('input', updateCounter);
  const wrap = h('div', { class: 'textarea-wrap' }, input, counter);
  return { wrap, input, counter, updateCounter };
}

export interface Slider {
  wrap: HTMLDivElement;
  input: HTMLInputElement;
  value: HTMLOutputElement;
  set(v: number): void;
}

export function slider(id: string, min: number, max: number, step: number, format: (v: number) => string): Slider {
  const input = h('input', { id, class: 'range', attrs: { type: 'range', min, max, step } });
  const value = h('output', { class: 'range-value', attrs: { for: id } });
  const paint = (): void => {
    const v = Number(input.value);
    const pct = ((v - min) / (max - min)) * 100;
    input.style.setProperty('--fill', `${pct}%`);
    value.textContent = format(v);
    input.setAttribute('aria-valuetext', format(v));
  };
  input.addEventListener('input', paint);
  const set = (v: number): void => {
    input.value = String(v);
    paint();
  };
  const wrap = h('div', { class: 'range-wrap' }, input, value);
  return { wrap, input, value, set };
}

export type Tone = 'info' | 'warning' | 'error' | 'success';

const TONE_ICON: Record<Tone, string> = { info: 'info', warning: 'warning', error: 'error', success: 'check' };

export interface Callout {
  el: HTMLDivElement;
  set(tone: Tone, text: string | Node[]): void;
  hide(): void;
}

/** Inline message bar (Windows InfoBar style). */
export function callout(tone: Tone = 'info', text = ''): Callout {
  const body = h('div', { class: 'callout-body' });
  const el = h('div', { class: 'callout' });
  const set = (t: Tone, content: string | Node[]): void => {
    el.className = `callout callout-${t}`;
    el.replaceChildren(icon(TONE_ICON[t], 'icon callout-icon'), body);
    if (typeof content === 'string') body.textContent = content;
    else body.replaceChildren(...content);
    show(el, true);
  };
  const hide = (): void => show(el, false);
  if (text) set(tone, text);
  else {
    el.className = `callout callout-${tone}`;
    hide();
  }
  return { el, set, hide };
}

export interface Status {
  el: HTMLParagraphElement;
  set(tone: Tone | 'busy', text: string): void;
  clear(): void;
}

/** One line of async feedback next to a button (role=status, announced politely). */
export function status(): Status {
  const el = h('p', { class: 'status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const set = (tone: Tone | 'busy', text: string): void => {
    el.className = `status status-${tone}`;
    const ic = tone === 'busy' ? h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }) : icon(TONE_ICON[tone], 'icon icon-sm');
    el.replaceChildren(ic, h('span', { text }));
  };
  const clear = (): void => {
    el.className = 'status';
    el.replaceChildren();
  };
  return { el, set, clear };
}

export function note(text: string, className = 'note'): HTMLParagraphElement {
  return h('p', { class: className, text });
}

export function datalist(id: string): HTMLDataListElement {
  return h('datalist', { id });
}

export function setDatalist(list: HTMLDataListElement, values: readonly string[]): void {
  list.replaceChildren(...values.map((v) => h('option', { attrs: { value: v } })));
}
