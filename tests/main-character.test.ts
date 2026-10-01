import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CharacterLoadError,
  loadCharacterWithFallback,
  pickLocalizedName,
  readCharacterFile,
  toArrayBuffer,
  toCharacterPayload,
} from '../src/main/character-source.ts';
import { availableGestures } from '../src/shared/gestures.ts';

const bundled = path.resolve('assets/characters/Bonzi.acs');
let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonzi-char-test-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('character source', () => {
  it('loads the bundled Bonzi', async () => {
    const ch = await readCharacterFile(bundled, true, 'en-GB');
    expect(ch.name).toBe('Bonzi');
    expect(ch.width).toBe(200);
    expect(ch.height).toBe(160);
    expect(ch.isBundled).toBe(true);
    expect(ch.fileName).toBe('Bonzi.acs');
    expect(ch.animations).toContain('GREET');
    expect(ch.trayIcon?.width).toBe(16);
    expect(availableGestures(ch.animations).length).toBeGreaterThan(20);
    const payload = toCharacterPayload(ch);
    expect(payload.bytes).toBeInstanceOf(ArrayBuffer);
    expect(payload.bytes.byteLength).toBe(ch.bytes.byteLength);
  });

  it('rejects missing, wrong-extension and corrupt files with friendly errors', async () => {
    await expect(readCharacterFile(path.join(dir, 'missing.acs'), false, 'en')).rejects.toBeInstanceOf(CharacterLoadError);
    const txt = path.join(dir, 'notes.txt');
    fs.writeFileSync(txt, 'hello');
    await expect(readCharacterFile(txt, false, 'en')).rejects.toThrow(/not a Microsoft Agent character/);
    const junk = path.join(dir, 'junk.acs');
    fs.writeFileSync(junk, Buffer.alloc(4096, 7));
    await expect(readCharacterFile(junk, false, 'en')).rejects.toThrow(/not a valid Microsoft Agent character/);
  });

  it('falls back to the bundled character and reports why', async () => {
    const junk = path.join(dir, 'junk2.acs');
    fs.writeFileSync(junk, Buffer.alloc(4096, 1));
    const r = await loadCharacterWithFallback(junk, bundled, 'en-US');
    expect(r.character.isBundled).toBe(true);
    expect(r.error).toMatch(/junk2\.acs/);
    // An invalid file is not "temporarily unavailable": the saved choice is cleared.
    expect(r.unavailable).toBe(false);
    const ok = await loadCharacterWithFallback(null, bundled, 'en-US');
    expect(ok.error).toBeNull();
    expect(ok.unavailable).toBe(false);
  });

  it('marks a missing or unreadable custom file as unavailable so the saved path is kept', async () => {
    const r = await loadCharacterWithFallback(path.join(dir, 'on-a-usb-stick.acs'), bundled, 'en-US');
    expect(r.character.isBundled).toBe(true);
    expect(r.error).toMatch(/could not be found/);
    expect(r.unavailable).toBe(true);
    const err = await readCharacterFile(path.join(dir, 'gone.acs'), false, 'en').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CharacterLoadError);
    expect((err as CharacterLoadError).unavailable).toBe(true);
    // Validation failures are never "unavailable".
    const txt = path.join(dir, 'other.txt');
    fs.writeFileSync(txt, 'hello');
    const bad = await readCharacterFile(txt, false, 'en').catch((e: unknown) => e);
    expect((bad as CharacterLoadError).unavailable).toBe(false);
    const folder = path.join(dir, 'folder.acs');
    fs.mkdirSync(folder);
    const notFile = await readCharacterFile(folder, false, 'en').catch((e: unknown) => e);
    expect((notFile as CharacterLoadError).unavailable).toBe(false);
  });

  it('picks the localized name for the locale, else the first', () => {
    const loc = [
      { languageId: 0x0409, name: 'Genie', description: '', extraData: '' },
      { languageId: 0x0407, name: 'Dschinni', description: '', extraData: '' },
    ];
    expect(pickLocalizedName(loc, 'de-DE', 'x')).toBe('Dschinni');
    expect(pickLocalizedName(loc, 'en-GB', 'x')).toBe('Genie');
    expect(pickLocalizedName(loc, 'fr', 'x')).toBe('Genie');
    expect(pickLocalizedName([], 'fr', 'Fallback')).toBe('Fallback');
  });

  it('copies buffers into standalone ArrayBuffers', () => {
    const big = Buffer.from([1, 2, 3, 4, 5]);
    const slice = big.subarray(1, 3);
    const ab = toArrayBuffer(slice);
    expect(ab.byteLength).toBe(2);
    expect([...new Uint8Array(ab)]).toEqual([2, 3]);
  });
});
