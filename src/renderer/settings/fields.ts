// Two-way bindings between controls and settings. Every binding re-renders from
// ctx.apply() (onChanged pushes) without clobbering a field the user is editing.

import type { PublicSettings, SettingsPatch } from '../../shared/settings.ts';
import { isEditing } from './context.ts';
import type { SettingsContext } from './context.ts';
import type { Slider, Toggle } from './dom.ts';
import { parseIntInRange, snapToStep } from './lib/format.ts';

type Read<T> = (s: PublicSettings) => T;

export interface TextBindingOptions {
  /** Return null to skip saving (invalid input); the field is restored on blur. */
  write: (value: string) => SettingsPatch | null;
  after?: (s: PublicSettings) => void;
  onInput?: (value: string) => void;
}

export function bindText(
  ctx: SettingsContext,
  input: HTMLInputElement | HTMLTextAreaElement,
  read: Read<string>,
  o: TextBindingOptions,
): void {
  const save = ctx.debouncedSave(() => {
    if (input.value === read(ctx.settings)) return null;
    return o.write(input.value);
  });
  ctx.bind((s) => {
    if (!isEditing(input) && !save.pending()) input.value = read(s);
    o.after?.(s);
  });
  input.addEventListener('input', () => {
    o.onInput?.(input.value);
    save();
  });
  input.addEventListener('blur', () => {
    const wasPending = save.pending();
    save.flush();
    const savedNow = wasPending && input.value !== read(ctx.settings) && o.write(input.value) !== null;
    // Unless a save just went out for this value, show what is actually stored
    // (restores invalid input and shows the main process's normalised value).
    if (!savedNow) {
      input.value = read(ctx.settings);
      o.onInput?.(input.value);
      o.after?.(ctx.settings);
    }
  });
}

export function bindNumber(
  ctx: SettingsContext,
  input: HTMLInputElement,
  read: Read<number>,
  write: (n: number) => SettingsPatch,
  min: number,
  max: number,
): void {
  const save = ctx.debouncedSave(() => {
    const n = parseIntInRange(input.value, min, max);
    if (n === null || n === read(ctx.settings)) return null;
    return write(n);
  });
  ctx.bind((s) => {
    if (!isEditing(input) && !save.pending()) input.value = String(read(s));
  });
  input.addEventListener('input', () => save());
  input.addEventListener('blur', () => {
    save.flush();
    const n = parseIntInRange(input.value, min, max);
    input.value = String(n ?? read(ctx.settings));
  });
}

export function bindToggle(ctx: SettingsContext, t: Toggle, read: Read<boolean>, write: (on: boolean) => SettingsPatch, after?: (s: PublicSettings) => void): void {
  ctx.bind((s) => {
    t.set(read(s));
    after?.(s);
  });
  t.input.addEventListener('change', () => {
    void ctx.save(write(t.input.checked));
  });
}

export function bindSelect(ctx: SettingsContext, sel: HTMLSelectElement, read: Read<string>, write: (v: string) => SettingsPatch, after?: (s: PublicSettings) => void): void {
  ctx.bind((s) => {
    sel.value = read(s);
    after?.(s);
  });
  sel.addEventListener('change', () => {
    void ctx.save(write(sel.value));
  });
}

export function bindSlider(
  ctx: SettingsContext,
  sl: Slider,
  read: Read<number>,
  write: (v: number) => SettingsPatch,
  range: { min: number; max: number; step: number },
): void {
  let dragging = false;
  ctx.bind((s) => {
    if (!dragging) sl.set(read(s));
  });
  sl.input.addEventListener('pointerdown', () => {
    dragging = true;
  });
  sl.input.addEventListener('change', () => {
    dragging = false;
    const v = snapToStep(Number(sl.input.value), range.step, range.min, range.max);
    if (v !== read(ctx.settings)) void ctx.save(write(v));
  });
  sl.input.addEventListener('blur', () => {
    dragging = false;
  });
}
