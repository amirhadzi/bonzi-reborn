/**
 * Turns one composed character frame into a set of square icon bitmaps. Pure functions.
 *
 * Framing: 128 px and up show the whole character, smaller sizes a head crop so the face still
 * reads in the taskbar and the tray.
 */

import { crop, createBitmap, fitSquare, inflate, opaqueBounds, scaleNearest, squareAround } from './image.ts';
import type { Bitmap, Rect } from './image.ts';

export interface CharacterRegions {
  /** Whole opaque character. */
  body: Rect;
  /** Head (top of the character down to the neck). */
  head: Rect;
}

/** Opaque extent [left, right] of one row, or null when the row is empty. */
function rowExtent(img: Bitmap, y: number, threshold: number): [number, number] | null {
  let l = -1;
  let r = -1;
  for (let x = 0; x < img.width; x++) {
    if ((img.data[(y * img.width + x) * 4 + 3] ?? 0) >= threshold) {
      if (l < 0) l = x;
      r = x;
    }
  }
  return l < 0 ? null : [l, r];
}

/**
 * Finds the head by looking for the narrowest row (the neck) between 30% and 60% of the body
 * height, measured from the top. Works for upright Microsoft Agent characters such as Bonzi.
 */
export function findRegions(img: Bitmap, threshold = 128): CharacterRegions {
  const body = opaqueBounds(img, threshold);
  if (!body) throw new Error('frame is fully transparent');
  const from = body.y + Math.floor(body.height * 0.3);
  const to = body.y + Math.floor(body.height * 0.6);
  let neck = to;
  let neckWidth = Number.POSITIVE_INFINITY;
  for (let y = from; y <= to; y++) {
    const ext = rowExtent(img, y, threshold);
    if (!ext) continue;
    const w = ext[1] - ext[0] + 1;
    if (w < neckWidth) {
      neckWidth = w;
      neck = y;
    }
  }
  let left = img.width;
  let right = -1;
  for (let y = body.y; y <= neck; y++) {
    const ext = rowExtent(img, y, threshold);
    if (!ext) continue;
    left = Math.min(left, ext[0]);
    right = Math.max(right, ext[1]);
  }
  const head: Rect = { x: left, y: body.y, width: right - left + 1, height: neck - body.y + 1 };
  return { body, head };
}

/**
 * Renders a region at an exact square pixel size. When the region fits, the crop grows around it to
 * fill the target at the largest integer nearest-neighbour factor (crisp pixel art, no blur).
 * Otherwise the region (plus `pad` px) is area-averaged down. `above` is the share of the spare
 * vertical room placed above the region (0.5 centres it; lower values show more of the body).
 */
export function renderRegion(img: Bitmap, region: Rect, size: number, above = 0.5, pad = 1): Bitmap {
  const square = squareAround(region, 'center');
  const k = Math.floor(size / square.width);
  if (k >= 1) {
    const cropSize = Math.ceil(size / k);
    const extra = cropSize - square.width;
    const area: Rect = {
      x: square.x - Math.floor(extra / 2),
      y: square.y - Math.round(extra * above),
      width: cropSize,
      height: cropSize,
    };
    const scaled = scaleNearest(crop(img, area), cropSize * k, cropSize * k);
    const trim = Math.floor((scaled.width - size) / 2);
    return crop(scaled, { x: trim, y: trim, width: size, height: size });
  }
  return fitSquare(crop(img, inflate(square, pad)), size);
}

export interface IconFrameOptions {
  sizes: readonly number[];
  /** Sizes below this use the head crop, the rest show the whole character. */
  bodyMinSize?: number;
}

/** Produces one bitmap per requested size. */
export function makeIconBitmaps(frame: Bitmap, options: IconFrameOptions): Map<number, Bitmap> {
  const regions = findRegions(frame);
  const bodyMin = options.bodyMinSize ?? 128;
  const out = new Map<number, Bitmap>();
  for (const size of options.sizes) {
    out.set(size, size >= bodyMin ? renderRegion(frame, regions.body, size, 0.5) : renderRegion(frame, regions.head, size, 0.2));
  }
  return out;
}

/** Lays bitmaps out side by side on a solid background, scaled up by `zoom` (for previews). */
export function contactSheet(images: readonly Bitmap[], background: readonly [number, number, number], zoom = 1, gap = 8): Bitmap {
  const width = images.reduce((w, img) => w + img.width * zoom + gap, gap);
  const height = images.reduce((h, img) => Math.max(h, img.height * zoom), 0) + gap * 2;
  const sheet = createBitmap(width, height);
  for (let i = 0; i < width * height; i++) {
    sheet.data[i * 4] = background[0];
    sheet.data[i * 4 + 1] = background[1];
    sheet.data[i * 4 + 2] = background[2];
    sheet.data[i * 4 + 3] = 255;
  }
  let x = gap;
  for (const img of images) {
    const big = zoom === 1 ? img : scaleNearest(img, img.width * zoom, img.height * zoom);
    for (let y = 0; y < big.height; y++) {
      for (let xx = 0; xx < big.width; xx++) {
        const s = (y * big.width + xx) * 4;
        const d = ((gap + y) * width + x + xx) * 4;
        const a = (big.data[s + 3] ?? 0) / 255;
        for (let c = 0; c < 3; c++) {
          sheet.data[d + c] = Math.round((big.data[s + c] ?? 0) * a + (sheet.data[d + c] ?? 0) * (1 - a));
        }
      }
    }
    x += big.width + gap;
  }
  return sheet;
}
