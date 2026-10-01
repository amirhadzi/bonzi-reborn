/**
 * Minimal Windows .ico writer and reader. Pure functions, no Node or DOM imports.
 *
 * Entries are either PNG-compressed (any size, Vista and later) or classic 32-bit BMP/DIB
 * (BITMAPINFOHEADER with doubled height, BGRA bottom-up pixels, then a 1 bpp AND mask).
 */

export interface IcoImage {
  width: number;
  height: number;
  /** PNG file bytes, or a DIB payload produced by encodeIcoBmp(). */
  data: Uint8Array;
  format: 'png' | 'bmp';
}

export interface IcoDirEntry {
  width: number;
  height: number;
  colorCount: number;
  planes: number;
  bitCount: number;
  size: number;
  offset: number;
  format: 'png' | 'bmp';
}

const HEADER_SIZE = 6;
const ENTRY_SIZE = 16;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(data: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => data[i] === b);
}

function checkSize(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > 256) throw new RangeError(`icon dimension ${n} must be 1..256`);
}

/**
 * Encodes straight RGBA pixels (top-down) as a 32-bit DIB suitable for an .ico entry.
 * The AND mask marks fully transparent pixels so legacy consumers also get transparency.
 */
export function encodeIcoBmp(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  checkSize(width);
  checkSize(height);
  if (rgba.length !== width * height * 4) throw new RangeError('rgba length does not match dimensions');
  const xorSize = width * height * 4;
  const maskStride = Math.ceil(width / 32) * 4;
  const maskSize = maskStride * height;
  const out = new Uint8Array(40 + xorSize + maskSize);
  const view = new DataView(out.buffer);
  view.setUint32(0, 40, true); // biSize
  view.setInt32(4, width, true);
  view.setInt32(8, height * 2, true); // XOR + AND masks
  view.setUint16(12, 1, true); // planes
  view.setUint16(14, 32, true); // bit count
  view.setUint32(16, 0, true); // BI_RGB
  view.setUint32(20, xorSize + maskSize, true);
  for (let y = 0; y < height; y++) {
    const srcRow = height - 1 - y; // bottom-up
    for (let x = 0; x < width; x++) {
      const s = (srcRow * width + x) * 4;
      const d = 40 + (y * width + x) * 4;
      out[d] = rgba[s + 2] ?? 0;
      out[d + 1] = rgba[s + 1] ?? 0;
      out[d + 2] = rgba[s] ?? 0;
      out[d + 3] = rgba[s + 3] ?? 0;
      if ((rgba[s + 3] ?? 0) === 0) {
        const m = 40 + xorSize + y * maskStride + (x >> 3);
        out[m] = (out[m] ?? 0) | (0x80 >> (x & 7));
      }
    }
  }
  return out;
}

/** Builds an .ico file. Entries are written in the given order (sort them by size first if you care). */
export function encodeIco(images: readonly IcoImage[]): Uint8Array {
  if (images.length === 0) throw new RangeError('an .ico needs at least one image');
  if (images.length > 0xffff) throw new RangeError('too many images');
  const dirSize = HEADER_SIZE + ENTRY_SIZE * images.length;
  const total = images.reduce((sum, img) => sum + img.data.length, dirSize);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type 1 = icon
  view.setUint16(4, images.length, true);
  let offset = dirSize;
  images.forEach((img, i) => {
    checkSize(img.width);
    checkSize(img.height);
    if (img.format === 'png' && !isPng(img.data)) throw new Error(`entry ${i} is marked png but has no PNG signature`);
    const e = HEADER_SIZE + i * ENTRY_SIZE;
    out[e] = img.width === 256 ? 0 : img.width;
    out[e + 1] = img.height === 256 ? 0 : img.height;
    out[e + 2] = 0; // palette colours
    out[e + 3] = 0; // reserved
    view.setUint16(e + 4, 1, true); // planes
    view.setUint16(e + 6, 32, true); // bits per pixel
    view.setUint32(e + 8, img.data.length, true);
    view.setUint32(e + 12, offset, true);
    out.set(img.data, offset);
    offset += img.data.length;
  });
  return out;
}

/** Reads the directory of an .ico file (for tests and sanity checks). */
export function readIcoDirectory(bytes: Uint8Array): IcoDirEntry[] {
  if (bytes.length < HEADER_SIZE) throw new Error('file too small for an .ico header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) throw new Error('not an .ico file');
  const count = view.getUint16(4, true);
  if (bytes.length < HEADER_SIZE + count * ENTRY_SIZE) throw new Error('truncated .ico directory');
  const entries: IcoDirEntry[] = [];
  for (let i = 0; i < count; i++) {
    const e = HEADER_SIZE + i * ENTRY_SIZE;
    const size = view.getUint32(e + 8, true);
    const offset = view.getUint32(e + 12, true);
    if (offset + size > bytes.length) throw new Error(`entry ${i} points past the end of the file`);
    entries.push({
      width: (bytes[e] ?? 0) || 256,
      height: (bytes[e + 1] ?? 0) || 256,
      colorCount: bytes[e + 2] ?? 0,
      planes: view.getUint16(e + 4, true),
      bitCount: view.getUint16(e + 6, true),
      size,
      offset,
      format: isPng(bytes.subarray(offset, offset + 8)) ? 'png' : 'bmp',
    });
  }
  return entries;
}
