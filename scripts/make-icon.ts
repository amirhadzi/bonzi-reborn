/**
 * Generates the app icons from the bundled character:
 *   build/icon.ico   16, 24, 32, 48, 64, 128, 256 px (256 PNG-compressed, smaller sizes 32-bit BMP)
 *   build/icon.png   256 px
 *   build/tray.png   32 px
 *
 * Usage: node scripts/make-icon.ts [--anim PLEASED] [--frame 12] [--acs path] [--png-only] [--preview]
 *   --png-only  store every .ico entry as PNG (default keeps small sizes as BMP for maximum
 *               compatibility with NSIS and older shell code paths)
 *   --preview   also write .scratch/build/icon-preview.png (all sizes on light and dark, zoomed)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import { composeFrame, parseAcs } from '../src/shared/acs/index.ts';
import { encodeIco, encodeIcoBmp, readIcoDirectory } from './lib/ico.ts';
import type { IcoImage } from './lib/ico.ts';
import { contactSheet, makeIconBitmaps } from './lib/icon-art.ts';
import type { Bitmap } from './lib/image.ts';

const { PNG } = pngjs;

export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function encodePng(img: Bitmap): Uint8Array {
  const png = new PNG({ width: img.width, height: img.height, colorType: 6 });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return PNG.sync.write(png, { colorType: 6 });
}

function main(): void {
  const args = process.argv.slice(2);
  const acsPath = resolve(argValue(args, '--acs') ?? join(root, 'assets/characters/Bonzi.acs'));
  const anim = argValue(args, '--anim') ?? 'PLEASED';
  const frameIndex = Number(argValue(args, '--frame') ?? '12');
  const pngOnly = args.includes('--png-only');
  if (!Number.isInteger(frameIndex) || frameIndex < 0) throw new Error('--frame must be a non-negative integer');

  const character = parseAcs(readFileSync(acsPath));
  const frame = composeFrame(character, anim, frameIndex);
  const bitmaps = makeIconBitmaps(frame, { sizes: ICON_SIZES });

  const entries: IcoImage[] = ICON_SIZES.map((size) => {
    const img = bitmaps.get(size);
    if (!img) throw new Error(`missing ${size}px bitmap`);
    return size === 256 || pngOnly
      ? { width: size, height: size, format: 'png', data: encodePng(img) }
      : { width: size, height: size, format: 'bmp', data: encodeIcoBmp(size, size, img.data) };
  });
  const ico = encodeIco(entries);
  readIcoDirectory(ico); // self-check

  const buildDir = join(root, 'build');
  mkdirSync(buildDir, { recursive: true });
  const icon256 = bitmaps.get(256);
  const icon32 = bitmaps.get(32);
  if (!icon256 || !icon32) throw new Error('missing base sizes');
  writeFileSync(join(buildDir, 'icon.ico'), ico);
  writeFileSync(join(buildDir, 'icon.png'), encodePng(icon256));
  writeFileSync(join(buildDir, 'tray.png'), encodePng(icon32));
  console.log(`icon: ${anim} frame ${frameIndex} -> build/icon.ico (${ico.length} bytes, ${ICON_SIZES.join('/')}), build/icon.png, build/tray.png`);

  if (args.includes('--preview')) {
    const all = ICON_SIZES.map((s) => bitmaps.get(s)).filter((b): b is Bitmap => b !== undefined);
    const small = all.filter((b) => b.width <= 48);
    const sheets = [
      contactSheet(all, [240, 240, 240]),
      contactSheet(all, [32, 32, 32]),
      contactSheet(small, [240, 240, 240], 4),
      contactSheet(small, [32, 32, 32], 4),
    ];
    const width = Math.max(...sheets.map((s) => s.width));
    const height = sheets.reduce((h, s) => h + s.height, 0);
    const out = new PNG({ width, height, colorType: 6 });
    out.data.fill(255);
    let y = 0;
    for (const s of sheets) {
      for (let row = 0; row < s.height; row++) {
        out.data.set(s.data.subarray(row * s.width * 4, (row + 1) * s.width * 4), ((y + row) * width) * 4);
      }
      y += s.height;
    }
    const previewDir = join(root, '.scratch/build');
    mkdirSync(previewDir, { recursive: true });
    writeFileSync(join(previewDir, 'icon-preview.png'), PNG.sync.write(out));
    console.log('preview: .scratch/build/icon-preview.png');
  }
}

try {
  main();
} catch (err) {
  console.error(`make-icon failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
