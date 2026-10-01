// Shared state for the settings window: the current PublicSettings, saving with
// a "Saved" indicator, re-rendering bound controls, and the cached model list.

import type { AppInfo, BonziSettingsApi, ModelListResult, ModelLists } from '../../shared/ipc.ts';
import type { PublicSettings, SettingsPatch } from '../../shared/settings.ts';
import { debounce } from './lib/debounce.ts';
import type { Debounced } from './lib/debounce.ts';
import { errorText } from './lib/format.ts';

export type SyncFn = (s: PublicSettings) => void;
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export const TEXT_DEBOUNCE_MS = 400;

export class SettingsContext {
  readonly api: BonziSettingsApi;
  settings: PublicSettings;
  info: AppInfo | null = null;
  models: ModelLists | null = null;

  private syncers: SyncFn[] = [];
  private flushers: Array<() => void> = [];
  private modelListeners: Array<(m: ModelLists) => void> = [];
  private modelsPromise: Promise<ModelListResult> | null = null;
  private saveSeq = 0;
  private inFlight = 0;
  private stateListener: ((state: SaveState, message?: string) => void) | null = null;
  private savedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(api: BonziSettingsApi, initial: PublicSettings) {
    this.api = api;
    this.settings = initial;
  }

  /** Registers a function that renders settings into controls. Runs immediately. */
  bind(fn: SyncFn): void {
    this.syncers.push(fn);
    fn(this.settings);
  }

  /** Applies settings pushed by the main process (or returned by an API call). */
  apply(s: PublicSettings): void {
    this.settings = s;
    for (const fn of this.syncers) {
      try {
        fn(s);
      } catch (e) {
        console.error('settings sync failed', e instanceof Error ? e.message : e);
      }
    }
  }

  onSaveState(cb: (state: SaveState, message?: string) => void): void {
    this.stateListener = cb;
  }

  private emit(state: SaveState, message?: string): void {
    if (this.savedTimer !== null) clearTimeout(this.savedTimer);
    this.savedTimer = null;
    this.stateListener?.(state, message);
    if (state === 'saved') {
      this.savedTimer = setTimeout(() => this.stateListener?.('idle'), 2200);
    }
  }

  /** Saves a patch. Returns the new settings, or null when the main process rejected it. */
  async save(patch: SettingsPatch): Promise<PublicSettings | null> {
    const seq = ++this.saveSeq;
    this.inFlight += 1;
    this.emit('saving');
    try {
      const next = await this.api.update(patch);
      this.inFlight -= 1;
      // Only the newest response re-renders; older ones would flicker stale values.
      if (seq === this.saveSeq) this.apply(next);
      if (this.inFlight === 0) this.emit('saved');
      return next;
    } catch (e) {
      this.inFlight -= 1;
      this.emit('error', errorText(e, 'Could not save'));
      // Re-render from the last known good settings.
      this.apply(this.settings);
      return null;
    }
  }

  /** Wraps an action that returns fresh settings (key, character) with the same indicator. */
  async run(action: () => Promise<PublicSettings>): Promise<PublicSettings> {
    this.emit('saving');
    try {
      const next = await action();
      this.apply(next);
      this.emit('saved');
      return next;
    } catch (e) {
      this.emit('idle');
      throw e;
    }
  }

  /** Debounced saver for typed fields; flushed on blur and before previews. */
  debouncedSave(build: () => SettingsPatch | null, ms = TEXT_DEBOUNCE_MS): Debounced<[]> {
    const d = debounce(() => {
      const patch = build();
      if (patch) void this.save(patch);
    }, ms);
    this.flushers.push(() => d.flush());
    return d;
  }

  flushAll(): void {
    for (const f of this.flushers) f();
  }

  onModels(cb: (m: ModelLists) => void): void {
    this.modelListeners.push(cb);
    if (this.models) cb(this.models);
  }

  /** Loads the model list once (or again when forced) and notifies listeners. */
  loadModels(force = false): Promise<ModelListResult> {
    if (this.modelsPromise && !force) return this.modelsPromise;
    const p = this.api
      .listModels()
      .then((r) => {
        if (r.ok) {
          this.models = r.models;
          for (const cb of this.modelListeners) cb(r.models);
        }
        return r;
      })
      .catch((e: unknown): ModelListResult => ({
        ok: false,
        error: { kind: 'unknown', message: errorText(e, 'Could not load the model list.') },
      }));
    this.modelsPromise = p;
    // A failed load may be retried by the next caller.
    void p.then((r) => {
      if (!r.ok && this.modelsPromise === p) this.modelsPromise = null;
    });
    return p;
  }
}

/** True while the user is typing in this element, so pushes from main must not overwrite it. */
export function isEditing(el: Element): boolean {
  return document.activeElement === el;
}
