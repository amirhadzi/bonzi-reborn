// Settings persistence: userData/settings.json, validated on load with
// loadSettings(), updated with applySettingsPatch(), saved atomically and
// debounced. No Electron imports (unit-tested with a temp dir).

import fs from 'node:fs';
import { applySettingsPatch, loadSettings, DEFAULT_SETTINGS, LIMITS } from '../shared/settings.ts';
import type { PublicSettings, Settings } from '../shared/settings.ts';
import type { ApiKeySource } from './secrets.ts';
import type { Logger } from './logger.ts';
import { writeFileAtomicSync } from './fs-util.ts';

export type SettingsKey = keyof Settings;

export interface SettingsChange {
  previous: Settings;
  next: Settings;
  changed: ReadonlySet<SettingsKey>;
}

export type SettingsListener = (change: SettingsChange) => void;

/** Keys whose values differ between two settings objects (position compared by value). */
export function changedKeys(a: Settings, b: Settings): Set<SettingsKey> {
  const out = new Set<SettingsKey>();
  for (const k of Object.keys(b) as SettingsKey[]) {
    const av = a[k];
    const bv = b[k];
    if (k === 'position') {
      const ap = a.position;
      const bp = b.position;
      if (ap === null || bp === null ? ap !== bp : ap.x !== bp.x || ap.y !== bp.y) out.add(k);
    } else if (av !== bv) {
      out.add(k);
    }
  }
  return out;
}

export interface SettingsStoreOptions {
  filePath: string;
  log: Logger;
  /** Debounce for disk writes in ms (default 300). */
  debounceMs?: number;
}

export class SettingsStore {
  readonly #filePath: string;
  readonly #log: Logger;
  readonly #debounceMs: number;
  #settings: Settings = { ...DEFAULT_SETTINGS };
  #listeners = new Set<SettingsListener>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #dirty = false;

  constructor(options: SettingsStoreOptions) {
    this.#filePath = options.filePath;
    this.#log = options.log;
    this.#debounceMs = options.debounceMs ?? 300;
  }

  /** Loads settings from disk; missing or corrupt files fall back to defaults. */
  load(): Settings {
    let raw: unknown = {};
    let text: string | null = null;
    try {
      text = fs.readFileSync(this.#filePath, 'utf8');
    } catch {
      text = null;
    }
    if (text !== null) {
      try {
        raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
      } catch {
        this.#log.warn('settings.json is not valid JSON; using defaults (a backup was kept).');
        try {
          fs.copyFileSync(this.#filePath, `${this.#filePath}.corrupt`);
        } catch {
          // ignore
        }
        raw = {};
      }
    }
    this.#settings = loadSettings(raw);
    // Write back when the file was missing, corrupt or needed migration so it matches the schema.
    if (text === null || JSON.stringify(this.#settings, null, 2) !== text.trim()) this.#scheduleSave();
    return this.get();
  }

  get(): Settings {
    return { ...this.#settings, position: this.#settings.position ? { ...this.#settings.position } : null };
  }

  /** Applies an untrusted patch (from a renderer) through applySettingsPatch. */
  update(patch: unknown): Settings {
    return this.#commit(applySettingsPatch(this.#settings, patch));
  }

  /**
   * Trusted main-process update, e.g. characterPath after a file dialog.
   * Still validated, but characterPath may be set to a string here.
   */
  updateTrusted(patch: Partial<Omit<Settings, 'schemaVersion'>>): Settings {
    const next = applySettingsPatch(this.#settings, patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'characterPath')) {
      const cp = patch.characterPath;
      if (cp === null || cp === undefined) next.characterPath = null;
      else if (typeof cp === 'string' && cp.length > 0 && cp.length <= LIMITS.characterPath) next.characterPath = cp;
    }
    return this.#commit(next);
  }

  onChange(listener: SettingsListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Writes pending changes synchronously (app shutdown). */
  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (!this.#dirty) return;
    this.#dirty = false;
    try {
      writeFileAtomicSync(this.#filePath, JSON.stringify(this.#settings, null, 2) + '\n');
    } catch (err) {
      this.#dirty = true;
      this.#log.error(`Could not save settings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #commit(next: Settings): Settings {
    const changed = changedKeys(this.#settings, next);
    if (changed.size === 0) return this.get();
    const previous = this.#settings;
    this.#settings = next;
    this.#scheduleSave();
    const change: SettingsChange = { previous, next: this.get(), changed };
    for (const l of [...this.#listeners]) {
      try {
        l(change);
      } catch (err) {
        this.#log.error(`Settings listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return this.get();
  }

  #scheduleSave(): void {
    this.#dirty = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, this.#debounceMs);
  }
}

export interface PublicSettingsExtras {
  apiKeyHint: string | null;
  apiKeySource: ApiKeySource;
  safeStorageAvailable: boolean;
  characterName: string;
  hotkeyError: string | null;
}

export function buildPublicSettings(settings: Settings, extras: PublicSettingsExtras): PublicSettings {
  return {
    ...settings,
    position: settings.position ? { ...settings.position } : null,
    hasApiKey: extras.apiKeySource !== 'none',
    apiKeyHint: extras.apiKeySource === 'none' ? null : extras.apiKeyHint,
    apiKeySource: extras.apiKeySource,
    safeStorageAvailable: extras.safeStorageAvailable,
    characterName: extras.characterName,
    hotkeyError: extras.hotkeyError,
  };
}
