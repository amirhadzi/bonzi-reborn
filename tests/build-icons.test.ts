import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pngjs from 'pngjs';
import { describe, expect, it } from 'vitest';
import { composeFrame, parseAcs } from '../src/shared/acs/index.ts';
import { encodeIco, encodeIcoBmp, readIcoDirectory } from '../scripts/lib/ico.ts';
import { findRegions, makeIconBitmaps, renderRegion } from '../scripts/lib/icon-art.ts';
import { createBitmap, crop, fitSquare, opaqueBounds, scaleArea, scaleNearest, squareAround } from '../scripts/lib/image.ts';
import type { Bitmap } from '../scripts/lib/image.ts';

const { PNG } = pngjs;
const root = join(import.meta.dirname, '..');

function solid(width: number, height: number, rgba: [number, number, number, number]): Bitmap {
  const img = createBitmap(width, height);
  for (let i = 0; i < width * height; i++) img.data.set(rgba, i * 4);
  return img;
}

function pixel(img: Bitmap, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(i, i + 4));
}

function pngBytes(width: number, height: number): Uint8Array {
  const png = new PNG({ width, height });
  png.data.fill(200);
  return PNG.sync.write(png);
}

describe('ico writer', () => {
  it('writes a valid header and directory', () => {
    const ico = encodeIco([
      { width: 16, height: 16, format: 'bmp', data: encodeIcoBmp(16, 16, new Uint8Array(16 * 16 * 4)) },
      { width: 256, height: 256, format: 'png', data: pngBytes(256, 256) },
    ]);
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    expect(view.getUint16(0, true)).toBe(0);
    expect(view.getUint16(2, true)).toBe(1);
    expect(view.getUint16(4, true)).toBe(2);
    // 256 is stored as 0 in the byte-sized width/height fields.
    expect(ico[6]).toBe(16);
    expect(ico[6 + 16]).toBe(0);
    expect(ico[6 + 16 + 1]).toBe(0);

    const dir = readIcoDirectory(ico);
    expect(dir.map((e) => [e.width, e.height, e.format, e.bitCount, e.planes])).toEqual([
      [16, 16, 'bmp', 32, 1],
      [256, 256, 'png', 32, 1],
    ]);
    expect(dir[0]?.offset).toBe(6 + 16 * 2);
    expect(dir[1]?.offset).toBe((dir[0]?.offset ?? 0) + (dir[0]?.size ?? 0));
    expect((dir[1]?.offset ?? 0) + (dir[1]?.size ?? 0)).toBe(ico.length);
  });

  it('encodes 32-bit DIBs bottom-up in BGRA with an AND mask for transparent pixels', () => {
    const rgba = new Uint8Array(2 * 2 * 4);
    rgba.set([255, 0, 0, 255], 0); // top-left red, opaque
    rgba.set([0, 0, 255, 128], 12); // bottom-right blue, half transparent
    const dib = encodeIcoBmp(2, 2, rgba);
    const view = new DataView(dib.buffer);
    expect(view.getUint32(0, true)).toBe(40);
    expect(view.getInt32(4, true)).toBe(2);
    expect(view.getInt32(8, true)).toBe(4); // doubled height
    expect(view.getUint16(14, true)).toBe(32);
    expect(dib.length).toBe(40 + 16 + 4 * 2); // pixels + 2 mask rows of 4 bytes
    // Row 0 in the file is the bottom row of the image.
    expect(Array.from(dib.subarray(40 + 4, 40 + 8))).toEqual([255, 0, 0, 128]); // bottom-right as BGRA
    expect(Array.from(dib.subarray(40 + 8, 40 + 12))).toEqual([0, 0, 255, 255]); // top-left as BGRA
    // Mask: bottom row has bottom-left transparent (bit 7), top row has top-right transparent (bit 6).
    expect(dib[56]).toBe(0x80);
    expect(dib[60]).toBe(0x40);
  });

  it('rejects bad input', () => {
    expect(() => encodeIco([])).toThrow();
    expect(() => encodeIco([{ width: 300, height: 300, format: 'png', data: pngBytes(1, 1) }])).toThrow();
    expect(() => encodeIco([{ width: 16, height: 16, format: 'png', data: new Uint8Array(10) }])).toThrow(/PNG/);
    expect(() => encodeIcoBmp(2, 2, new Uint8Array(3))).toThrow();
    expect(() => readIcoDirectory(new Uint8Array([0, 0, 2, 0, 0, 0]))).toThrow(/not an .ico/);
  });
});

describe('bitmap helpers', () => {
  it('finds the opaque bounding box', () => {
    const img = createBitmap(10, 8);
    img.data.set([1, 2, 3, 255], (2 * 10 + 3) * 4);
    img.data.set([1, 2, 3, 255], (5 * 10 + 7) * 4);
    expect(opaqueBounds(img)).toEqual({ x: 3, y: 2, width: 5, height: 4 });
    expect(opaqueBounds(createBitmap(4, 4))).toBeNull();
  });

  it('crops with transparent padding outside the source', () => {
    const img = solid(2, 2, [10, 20, 30, 255]);
    const out = crop(img, { x: -1, y: -1, width: 4, height: 4 });
    expect(pixel(out, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(out, 1, 1)).toEqual([10, 20, 30, 255]);
    expect(pixel(out, 3, 3)).toEqual([0, 0, 0, 0]);
  });

  it('builds squares around rectangles', () => {
    expect(squareAround({ x: 10, y: 10, width: 4, height: 10 })).toEqual({ x: 7, y: 10, width: 10, height: 10 });
    expect(squareAround({ x: 0, y: 0, width: 10, height: 4 }, 'top')).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(squareAround({ x: 0, y: 0, width: 10, height: 4 }, 'bottom')).toEqual({ x: 0, y: -6, width: 10, height: 10 });
  });

  it('scales nearest neighbour without inventing colours', () => {
    const img = createBitmap(2, 1);
    img.data.set([255, 0, 0, 255, 0, 0, 255, 255]);
    const big = scaleNearest(img, 4, 2);
    expect(pixel(big, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(big, 1, 1)).toEqual([255, 0, 0, 255]);
    expect(pixel(big, 2, 0)).toEqual([0, 0, 255, 255]);
    expect(pixel(big, 3, 1)).toEqual([0, 0, 255, 255]);
  });

  it('area-averages with premultiplied alpha (no dark fringes)', () => {
    const img = createBitmap(2, 1);
    img.data.set([200, 100, 50, 255, 0, 0, 0, 0]);
    const small = scaleArea(img, 1, 1);
    expect(pixel(small, 0, 0)).toEqual([200, 100, 50, 128]);
  });

  it('fits squares by integer upscaling or downscaling', () => {
    const up = fitSquare(solid(10, 10, [1, 2, 3, 255]), 32);
    expect(up.width).toBe(32);
    expect(pixel(up, 0, 0)[3]).toBe(0); // 3x = 30 px, centred with a 1 px border
    expect(pixel(up, 1, 1)).toEqual([1, 2, 3, 255]);
    const down = fitSquare(solid(64, 32, [9, 9, 9, 255]), 16);
    expect(down.width).toBe(16);
    expect(pixel(down, 8, 0)[3]).toBe(0); // letterboxed
    expect(pixel(down, 8, 8)).toEqual([9, 9, 9, 255]);
  });

  it('renders regions at integer factors when they fit', () => {
    const img = solid(20, 20, [5, 6, 7, 255]);
    const out = renderRegion(img, { x: 5, y: 5, width: 10, height: 10 }, 32);
    expect(out.width).toBe(32);
    expect(out.height).toBe(32);
    expect(pixel(out, 16, 16)).toEqual([5, 6, 7, 255]);
  });
});

describe('Bonzi icon art', () => {
  const acs = parseAcs(readFileSync(join(root, 'assets/characters/Bonzi.acs')));
  const frame = composeFrame(acs, 'PLEASED', 12);

  it('finds a head above the neck inside the body', () => {
    const { body, head } = findRegions(frame);
    expect(head.y).toBe(body.y);
    expect(head.height).toBeGreaterThan(body.height * 0.3);
    expect(head.height).toBeLessThan(body.height * 0.6);
    expect(head.x).toBeGreaterThanOrEqual(body.x);
    expect(head.width).toBeLessThan(body.width);
  });

  it('produces every size with visible, non-clipped content', () => {
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const icons = makeIconBitmaps(frame, { sizes });
    for (const size of sizes) {
      const img = icons.get(size);
      expect(img?.width).toBe(size);
      expect(img?.height).toBe(size);
      const b = img ? opaqueBounds(img, 128) : null;
      expect(b, `size ${size}`).not.toBeNull();
      expect((b?.width ?? 0) * (b?.height ?? 0)).toBeGreaterThan(size * size * 0.25);
    }
    // The large icon shows the whole character with transparent margins on every side.
    const big = icons.get(256);
    const b = big ? opaqueBounds(big, 1) : null;
    expect(b?.x).toBeGreaterThan(0);
    expect(b?.y).toBeGreaterThan(0);
    expect((b?.x ?? 0) + (b?.width ?? 0)).toBeLessThan(256);
    expect((b?.y ?? 0) + (b?.height ?? 0)).toBeLessThan(256);
  });

  it.runIf(existsSync(join(root, 'build/icon.ico')))('generated build/icon.ico contains all sizes', () => {
    const dir = readIcoDirectory(readFileSync(join(root, 'build/icon.ico')));
    expect(dir.map((e) => e.width).sort((a, b) => a - b)).toEqual([16, 24, 32, 48, 64, 128, 256]);
    expect(dir.find((e) => e.width === 256)?.format).toBe('png');
  });
});
