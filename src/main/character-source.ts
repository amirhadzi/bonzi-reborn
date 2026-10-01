// Loads and validates the character file (.acs) in the main process.
// Pure Node (no Electron): paths and locale are injected.

import fs from 'node:fs';
import path from 'node:path';
import { parseAcs } from '../shared/acs/index.ts';
import type { AcsLocalizedInfo, RgbaImage } from '../shared/acs/index.ts';
import type { CharacterPayload } from '../shared/ipc.ts';

export const MAX_ACS_BYTES = 64 * 1024 * 1024;

export interface LoadedCharacter {
  filePath: string;
  fileName: string;
  isBundled: boolean;
  bytes: Buffer;
  name: string;
  width: number;
  height: number;
  /** Animation names as stored in the file (upper case record names). */
  animations: string[];
  trayIcon: RgbaImage | null;
}

export class CharacterLoadError extends Error {
  override name = 'CharacterLoadError';
  /**
   * True when the file could not be found or read (a drive that is not mounted yet, a
   * cloud placeholder, a locked file), as opposed to a file that is not a valid character.
   * The condition may clear up later, so a saved choice should be kept.
   */
  readonly unavailable: boolean;

  constructor(message: string, unavailable = false) {
    super(message);
    this.unavailable = unavailable;
  }
}

// Primary language ids (low 10 bits of a Windows LANGID) for common locales.
const PRIMARY_LANG: Record<string, number> = {
  ar: 0x01, bg: 0x02, ca: 0x03, zh: 0x04, cs: 0x05, da: 0x06, de: 0x07, el: 0x08, en: 0x09, es: 0x0a,
  fi: 0x0b, fr: 0x0c, he: 0x0d, hu: 0x0e, it: 0x10, ja: 0x11, ko: 0x12, nl: 0x13, nb: 0x14, no: 0x14,
  pl: 0x15, pt: 0x16, ro: 0x18, ru: 0x19, hr: 0x1a, sk: 0x1b, sv: 0x1d, th: 0x1e, tr: 0x1f, sl: 0x24,
  et: 0x25, lv: 0x26, lt: 0x27, vi: 0x2a, eu: 0x2d,
};

/** Picks the localized name for the user's locale (e.g. "en-GB"), else the first non-empty one. */
export function pickLocalizedName(localized: readonly AcsLocalizedInfo[], locale: string, fallback: string): string {
  const lang = locale.toLowerCase().split(/[-_]/)[0] ?? '';
  const primary = PRIMARY_LANG[lang];
  if (primary !== undefined) {
    const match = localized.find((l) => (l.languageId & 0x3ff) === primary && l.name.trim());
    if (match) return match.name.trim();
  }
  const first = localized.find((l) => l.name.trim());
  return first ? first.name.trim() : fallback;
}

/** Copies a Node Buffer into a standalone ArrayBuffer (Buffers may share a pooled ArrayBuffer). */
export function toArrayBuffer(buf: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  return out;
}

export function toCharacterPayload(ch: LoadedCharacter): CharacterPayload {
  return { bytes: toArrayBuffer(ch.bytes), fileName: ch.fileName, isBundled: ch.isBundled };
}

/** Reads, size-checks and parses an .acs file. Throws CharacterLoadError with a user-presentable message. */
export async function readCharacterFile(filePath: string, isBundled: boolean, locale: string): Promise<LoadedCharacter> {
  const fileName = path.basename(filePath);
  if (path.extname(filePath).toLowerCase() !== '.acs') {
    throw new CharacterLoadError(`"${fileName}" is not a Microsoft Agent character (.acs) file.`);
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    throw new CharacterLoadError(`The character file "${fileName}" could not be found.`, true);
  }
  if (!stat.isFile()) throw new CharacterLoadError(`"${fileName}" is not a file.`);
  if (stat.size > MAX_ACS_BYTES) throw new CharacterLoadError(`"${fileName}" is too large (over 64 MB).`);
  if (stat.size < 64) throw new CharacterLoadError(`"${fileName}" is too small to be a character file.`);

  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(filePath);
  } catch {
    throw new CharacterLoadError(`The character file "${fileName}" could not be read.`, true);
  }
  if (bytes.byteLength > MAX_ACS_BYTES) throw new CharacterLoadError(`"${fileName}" is too large (over 64 MB).`);

  let acs: ReturnType<typeof parseAcs>;
  try {
    acs = parseAcs(bytes);
  } catch {
    throw new CharacterLoadError(`"${fileName}" is not a valid Microsoft Agent character file.`);
  }
  const { width, height } = acs.info;
  if (!(width > 0 && height > 0 && width <= 2048 && height <= 2048)) {
    throw new CharacterLoadError(`"${fileName}" has an unsupported character size.`);
  }
  if (acs.animations.length === 0) throw new CharacterLoadError(`"${fileName}" contains no animations.`);

  const baseName = fileName.replace(/\.acs$/i, '');
  return {
    filePath,
    fileName,
    isBundled,
    bytes,
    name: pickLocalizedName(acs.localized, locale, baseName),
    width,
    height,
    animations: acs.animations.map((a) => a.name),
    trayIcon: acs.info.trayIcon?.rgba ?? null,
  };
}

export interface CharacterLoadResult {
  character: LoadedCharacter;
  /** Set when a custom character failed and the bundled one was used instead. */
  error: string | null;
  /**
   * True when the custom character failed only because its file could not be found or
   * read right now; the saved path should then be kept for the next start.
   */
  unavailable: boolean;
}

/**
 * Loads the custom character when configured, falling back to the bundled
 * one on any failure. Throws only when the bundled character itself fails.
 */
export async function loadCharacterWithFallback(customPath: string | null, bundledPath: string, locale: string): Promise<CharacterLoadResult> {
  let error: string | null = null;
  let unavailable = false;
  if (customPath) {
    try {
      return { character: await readCharacterFile(customPath, false, locale), error: null, unavailable: false };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      unavailable = err instanceof CharacterLoadError && err.unavailable;
    }
  }
  return { character: await readCharacterFile(bundledPath, true, locale), error, unavailable };
}
