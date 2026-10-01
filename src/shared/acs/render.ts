/**
 * Image decoding and frame compositing.
 *
 * Images are 8-bit palettised, bottom-up DIB rows padded to 4 bytes. They are
 * decompressed lazily and cached on the character (character.decodedCache).
 *
 * Layering (verified visually on Bonzi.acs, see docs/ACS-NOTES.md): a frame's
 * image list is ordered TOP-MOST FIRST, so images are painted in reverse list
 * order (last entry first).
 *
 * Mouth overlays: drawn after the frame images at the overlay's own x/y
 * (frame coordinates). See docs/ACS-NOTES.md for the replace-flag notes.
 */

import { AcsFormatError } from './binary-reader.ts';
import { DecompressError, decompress } from './decompress.ts';
import type {
  AcsAnimation,
  AcsCharacter,
  AcsColor,
  AcsFrame,
  AcsImage,
  ComposeOptions,
  RgbaImage,
} from './types.ts';

/**
 * Returns the decompressed 8-bit pixel buffer of an image: `stride * height`
 * bytes, bottom-up rows (row 0 in the buffer is the BOTTOM row of the image).
 * Results are cached on the character.
 */
export function decodeImage(character: AcsCharacter, index: number): Uint8Array {
  const cached = character.decodedCache.get(index);
  if (cached) return cached;
  const img = character.images[index];
  if (!img) throw new RangeError(`image index ${index} out of range (0..${character.images.length - 1})`);
  const size = img.stride * img.height;
  let pixels: Uint8Array;
  if (img.compressed) {
    try {
      pixels = decompress(img.data, size);
    } catch (e) {
      if (e instanceof DecompressError) e.message = `image ${index}: ${e.message}`;
      throw e;
    }
  } else {
    if (img.data.length < size) {
      throw new AcsFormatError(`image ${index}: ${img.data.length} bytes of raw data, expected ${size}`);
    }
    pixels = img.data.subarray(0, size);
  }
  character.decodedCache.set(index, pixels);
  return pixels;
}

/** Drops cached decoded images (all, or a single index). */
export function clearImageCache(character: AcsCharacter, index?: number): void {
  if (index === undefined) character.decodedCache.clear();
  else character.decodedCache.delete(index);
}

/** Palette as a packed lookup: [r,g,b,a] * 256, transparent index has alpha 0. */
export function paletteToRgba(palette: readonly AcsColor[], transparentIndex: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const c = palette[i];
    if (c) {
      lut[i * 4] = c.r;
      lut[i * 4 + 1] = c.g;
      lut[i * 4 + 2] = c.b;
    }
    lut[i * 4 + 3] = i === transparentIndex ? 0 : 255;
  }
  return lut;
}

const lutCache = new WeakMap<AcsCharacter, Uint8ClampedArray>();
function getLut(ch: AcsCharacter): Uint8ClampedArray {
  let lut = lutCache.get(ch);
  if (!lut) {
    lut = paletteToRgba(ch.info.palette, ch.info.transparentIndex);
    lutCache.set(ch, lut);
  }
  return lut;
}

/**
 * Paints image `index` into `dst` (RGBA, dstW x dstH) at (x, y), skipping
 * transparent-index pixels (so lower layers show through).
 */
export function blitImage(
  character: AcsCharacter,
  index: number,
  dst: Uint8ClampedArray,
  dstW: number,
  dstH: number,
  x: number,
  y: number,
): void {
  const img = character.images[index] as AcsImage | undefined;
  if (!img) throw new RangeError(`image index ${index} out of range`);
  const pixels = decodeImage(character, index);
  const lut = getLut(character);
  const t = character.info.transparentIndex;
  const { width, height, stride } = img;
  const x0 = Math.max(0, -x);
  const x1 = Math.min(width, dstW - x);
  if (x1 <= x0) return;
  for (let row = 0; row < height; row++) {
    const dy = y + row;
    if (dy < 0 || dy >= dstH) continue;
    const src = (height - 1 - row) * stride; // bottom-up
    let d = (dy * dstW + x + x0) * 4;
    for (let col = x0; col < x1; col++, d += 4) {
      const p = pixels[src + col] as number;
      if (p === t) continue;
      const l = p * 4;
      dst[d] = lut[l] as number;
      dst[d + 1] = lut[l + 1] as number;
      dst[d + 2] = lut[l + 2] as number;
      dst[d + 3] = 255;
    }
  }
}

/** Decodes a single image to a standalone RGBA image (transparent index -> alpha 0). */
export function imageToRgba(character: AcsCharacter, index: number): RgbaImage {
  const img = character.images[index];
  if (!img) throw new RangeError(`image index ${index} out of range`);
  const data = new Uint8ClampedArray(img.width * img.height * 4);
  blitImage(character, index, data, img.width, img.height, 0, 0);
  return { width: img.width, height: img.height, data };
}

/** Looks up an animation by (case-insensitive) name. */
export function getAnimation(character: AcsCharacter, name: string): AcsAnimation | undefined {
  return character.animationsByName.get(name.toLowerCase());
}

/**
 * Composites one frame of an animation to an RGBA buffer the size of the
 * character (info.width x info.height). Pixels not covered by any image are
 * fully transparent (0,0,0,0).
 */
export function composeFrame(
  character: AcsCharacter,
  animation: string | AcsAnimation,
  frameIndex: number,
  options: ComposeOptions = {},
): RgbaImage {
  const anim = typeof animation === 'string' ? getAnimation(character, animation) : animation;
  if (!anim) throw new RangeError(`unknown animation "${String(animation)}"`);
  const frame = anim.frames[frameIndex];
  if (!frame) throw new RangeError(`frame ${frameIndex} out of range for "${anim.name}" (${anim.frames.length} frames)`);
  return composeFrameData(character, frame, options);
}

/** Same as composeFrame() but takes the frame object directly. */
export function composeFrameData(character: AcsCharacter, frame: AcsFrame, options: ComposeOptions = {}): RgbaImage {
  const { width, height } = character.info;
  const size = width * height * 4;
  let data: Uint8ClampedArray;
  if (options.target) {
    if (options.target.length !== size) throw new RangeError(`target buffer must be ${size} bytes`);
    data = options.target;
    data.fill(0);
  } else {
    data = new Uint8ClampedArray(size);
  }

  const mouth = options.mouth ?? null;
  const overlay = mouth === null ? undefined : frame.overlays.find((o) => o.type === mouth);
  const imgs = frame.images;
  const order = options.order ?? 'reverse';

  // With a "replace" overlay the overlay stands in for the frame's top-most
  // image (list entry 0); it is drawn in that image's place in the stack.
  const skipTop = overlay !== undefined && overlay.replace && imgs.length > 0;

  if (order === 'reverse') {
    for (let i = imgs.length - 1; i >= 0; i--) {
      if (i === 0 && skipTop) continue;
      const fi = imgs[i]!;
      blitImage(character, fi.imageIndex, data, width, height, fi.x, fi.y);
    }
  } else {
    for (let i = 0; i < imgs.length; i++) {
      if (i === 0 && skipTop) continue;
      const fi = imgs[i]!;
      blitImage(character, fi.imageIndex, data, width, height, fi.x, fi.y);
    }
  }

  if (overlay) blitImage(character, overlay.imageIndex, data, width, height, overlay.x, overlay.y);
  return { width, height, data };
}

/** Total duration of a straight (no-branch) playthrough, in milliseconds. */
export function animationDurationMs(anim: AcsAnimation): number {
  let cs = 0;
  for (const f of anim.frames) cs += f.duration;
  return cs * 10;
}
