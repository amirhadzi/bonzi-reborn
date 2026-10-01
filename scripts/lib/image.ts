/**
 * Small RGBA bitmap helpers used by scripts/make-icon.ts. Pure functions, no Node or DOM imports.
 * Pixels are straight (non-premultiplied) RGBA, row-major, top-down.
 */

export interface Bitmap {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function createBitmap(width: number, height: number): Bitmap {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError(`invalid bitmap size ${width}x${height}`);
  }
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Bounding box of pixels with alpha >= threshold, or null when the bitmap is fully transparent. */
export function opaqueBounds(img: Bitmap, threshold = 1): Rect | null {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if ((img.data[(y * img.width + x) * 4 + 3] ?? 0) >= threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Copies a rectangle out of a bitmap. Areas outside the source are transparent. */
export function crop(img: Bitmap, rect: Rect): Bitmap {
  const out = createBitmap(rect.width, rect.height);
  for (let y = 0; y < rect.height; y++) {
    const sy = rect.y + y;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < rect.width; x++) {
      const sx = rect.x + x;
      if (sx < 0 || sx >= img.width) continue;
      const s = (sy * img.width + sx) * 4;
      const d = (y * rect.width + x) * 4;
      out.data[d] = img.data[s] ?? 0;
      out.data[d + 1] = img.data[s + 1] ?? 0;
      out.data[d + 2] = img.data[s + 2] ?? 0;
      out.data[d + 3] = img.data[s + 3] ?? 0;
    }
  }
  return out;
}

/**
 * Smallest square rectangle that contains `rect`, centred on it horizontally. Vertically the square
 * is anchored according to `anchor` ('top' keeps rect.y, 'center' centres, 'bottom' keeps the bottom edge).
 */
export function squareAround(rect: Rect, anchor: 'top' | 'center' | 'bottom' = 'center'): Rect {
  const size = Math.max(rect.width, rect.height);
  const x = rect.x - Math.floor((size - rect.width) / 2);
  let y: number;
  if (anchor === 'top') y = rect.y;
  else if (anchor === 'bottom') y = rect.y + rect.height - size;
  else y = rect.y - Math.floor((size - rect.height) / 2);
  return { x, y, width: size, height: size };
}

/** Grows a rectangle by `margin` pixels on every side. */
export function inflate(rect: Rect, margin: number): Rect {
  return { x: rect.x - margin, y: rect.y - margin, width: rect.width + margin * 2, height: rect.height + margin * 2 };
}

/** Nearest-neighbour resample (crisp pixel art). */
export function scaleNearest(img: Bitmap, width: number, height: number): Bitmap {
  const out = createBitmap(width, height);
  if (img.width === 0 || img.height === 0) return out;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / width));
      const s = (sy * img.width + sx) * 4;
      const d = (y * width + x) * 4;
      out.data[d] = img.data[s] ?? 0;
      out.data[d + 1] = img.data[s + 1] ?? 0;
      out.data[d + 2] = img.data[s + 2] ?? 0;
      out.data[d + 3] = img.data[s + 3] ?? 0;
    }
  }
  return out;
}

/**
 * Area-averaging downscale with premultiplied alpha, so transparent pixels do not darken the edges.
 * Each destination pixel is the coverage-weighted mean of the source pixels it covers.
 */
export function scaleArea(img: Bitmap, width: number, height: number): Bitmap {
  const out = createBitmap(width, height);
  if (img.width === 0 || img.height === 0 || width === 0 || height === 0) return out;
  const fx = img.width / width;
  const fy = img.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = y * fy;
    const y1 = y0 + fy;
    for (let x = 0; x < width; x++) {
      const x0 = x * fx;
      const x1 = x0 + fx;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1) && sy < img.height; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1) && sx < img.width; sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const s = (sy * img.width + sx) * 4;
          const pa = (img.data[s + 3] ?? 0) / 255;
          r += (img.data[s] ?? 0) * pa * w;
          g += (img.data[s + 1] ?? 0) * pa * w;
          b += (img.data[s + 2] ?? 0) * pa * w;
          a += pa * w;
          area += w;
        }
      }
      const d = (y * width + x) * 4;
      if (a > 0) {
        out.data[d] = Math.round(r / a);
        out.data[d + 1] = Math.round(g / a);
        out.data[d + 2] = Math.round(b / a);
      }
      out.data[d + 3] = area > 0 ? Math.round((a / area) * 255) : 0;
    }
  }
  return out;
}

/** Draws `src` onto `dst` at (dx, dy) with source-over alpha blending. */
export function drawOver(dst: Bitmap, src: Bitmap, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      const d = (ty * dst.width + tx) * 4;
      const sa = (src.data[s + 3] ?? 0) / 255;
      if (sa === 0) continue;
      const da = (dst.data[d + 3] ?? 0) / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        const sc = src.data[s + c] ?? 0;
        const dc = dst.data[d + c] ?? 0;
        dst.data[d + c] = Math.round((sc * sa + dc * da * (1 - sa)) / oa);
      }
      dst.data[d + 3] = Math.round(oa * 255);
    }
  }
}

/**
 * Fits a square bitmap into a `size` x `size` canvas. Upscaling uses the largest integer factor
 * (nearest neighbour, centred, transparent padding) so pixels stay square and crisp; downscaling
 * uses area averaging, which reads far better than nearest neighbour at icon sizes.
 */
export function fitSquare(img: Bitmap, size: number): Bitmap {
  const src = Math.max(img.width, img.height);
  if (src === 0) return createBitmap(size, size);
  if (src <= size) {
    const k = Math.max(1, Math.floor(size / src));
    const scaled = scaleNearest(img, img.width * k, img.height * k);
    const out = createBitmap(size, size);
    drawOver(out, scaled, Math.floor((size - scaled.width) / 2), Math.floor((size - scaled.height) / 2));
    return out;
  }
  const w = Math.max(1, Math.round((img.width * size) / src));
  const h = Math.max(1, Math.round((img.height * size) / src));
  const scaled = scaleArea(img, w, h);
  const out = createBitmap(size, size);
  drawOver(out, scaled, Math.floor((size - w) / 2), Math.floor((size - h) / 2));
  return out;
}
