// Canvas renderer for ACS frames: crisp nearest-neighbour scaling at any
// devicePixelRatio, lazily cached per-image sources, alpha hit testing.

import { clearImageCache, imageToRgba } from '../../../shared/acs/render.ts';
import type { AcsCharacter, AcsFrame, AcsOverlay, MouthType } from '../../../shared/acs/types.ts';

type Surface = OffscreenCanvas | HTMLCanvasElement;
type Surface2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** Upper bound on cached per-image surfaces (each is width * height * 4 bytes). */
const MAX_CACHED_IMAGES = 256;

function makeSurface(doc: Document, w: number, h: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = doc.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function context2d(s: Surface, willReadFrequently = false): Surface2D {
  const ctx = s.getContext('2d', { willReadFrequently }) as Surface2D | null;
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

export class FrameRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ch: AcsCharacter;
  private readonly doc: Document;
  private readonly win: Window;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly work: Surface;
  private readonly workCtx: Surface2D;
  private readonly w: number;
  private readonly h: number;
  private scale: number;
  private dpr: number;
  private readonly images = new Map<number, Surface>();
  private frame: AcsFrame | null = null;
  private overlay: AcsOverlay | null = null;
  private alpha: Uint8ClampedArray | null = null;
  private mql: MediaQueryList | null = null;
  private readonly onDprChange = (): void => this.handleDprChange();
  private disposed = false;

  constructor(ch: AcsCharacter, scale = 1, doc: Document = document) {
    this.ch = ch;
    this.doc = doc;
    this.win = doc.defaultView ?? window;
    this.w = ch.info.width;
    this.h = ch.info.height;
    this.scale = scale > 0 && Number.isFinite(scale) ? scale : 1;
    this.dpr = this.win.devicePixelRatio || 1;
    this.canvas = doc.createElement('canvas');
    this.canvas.style.imageRendering = 'pixelated';
    this.canvas.style.display = 'block';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.work = makeSurface(doc, this.w, this.h);
    this.workCtx = context2d(this.work, true);
    this.resize();
    this.watchDpr();
  }

  /** CSS size of the canvas. */
  get cssWidth(): number {
    return Math.round(this.w * this.scale);
  }

  get cssHeight(): number {
    return Math.round(this.h * this.scale);
  }

  /**
   * Draws a frame (null = blank) with an optional mouth overlay. Returns false
   * when nothing visible changed, so callers can skip notifications.
   */
  draw(frame: AcsFrame | null, mouth: MouthType | null): boolean {
    if (this.disposed) return false;
    const overlay = frame && mouth !== null ? (frame.overlays.find((o) => o.type === mouth) ?? null) : null;
    if (frame === this.frame && overlay === this.overlay) return false;
    this.frame = frame;
    this.overlay = overlay;
    this.compose();
    this.present();
    return true;
  }

  setScale(scale: number): void {
    if (!(scale > 0) || !Number.isFinite(scale) || scale === this.scale) return;
    this.scale = scale;
    this.resize();
    this.present();
  }

  /** x/y in CSS pixels relative to the canvas top-left. */
  hitTest(x: number, y: number): boolean {
    if (!this.frame || this.disposed) return false;
    const sx = Math.floor(x / this.scale);
    const sy = Math.floor(y / this.scale);
    if (sx < 0 || sy < 0 || sx >= this.w || sy >= this.h) return false;
    if (!this.alpha) {
      try {
        this.alpha = this.workCtx.getImageData(0, 0, this.w, this.h).data;
      } catch {
        return false;
      }
    }
    return (this.alpha[(sy * this.w + sx) * 4 + 3] ?? 0) > 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mql?.removeEventListener('change', this.onDprChange);
    this.mql = null;
    this.images.clear();
    this.alpha = null;
    this.frame = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.work.width = 1;
    this.work.height = 1;
  }

  // ------------------------------------------------------------------ internals

  private imageSource(index: number): Surface | null {
    const cached = this.images.get(index);
    if (cached) {
      // refresh LRU position
      this.images.delete(index);
      this.images.set(index, cached);
      return cached;
    }
    let rgba;
    try {
      rgba = imageToRgba(this.ch, index);
    } catch {
      return null;
    }
    const surface = makeSurface(this.doc, rgba.width, rgba.height);
    const ctx = context2d(surface);
    ctx.putImageData(new ImageData(rgba.data as Uint8ClampedArray<ArrayBuffer>, rgba.width, rgba.height), 0, 0);
    // The surface now owns the pixels; drop the decoded 8-bit copy.
    clearImageCache(this.ch, index);
    this.images.set(index, surface);
    if (this.images.size > MAX_CACHED_IMAGES) {
      const oldest = this.images.keys().next();
      if (!oldest.done) this.images.delete(oldest.value);
    }
    return surface;
  }

  /** Composes the current frame at 1x into the work surface. */
  private compose(): void {
    const ctx = this.workCtx;
    this.alpha = null;
    ctx.clearRect(0, 0, this.w, this.h);
    const frame = this.frame;
    if (!frame) return;
    const overlay = this.overlay;
    const imgs = frame.images;
    // Entry 0 is top-most: paint in reverse. A replace overlay stands in for entry 0.
    const skipTop = !!overlay && overlay.replace && imgs.length > 0;
    for (let i = imgs.length - 1; i >= 0; i--) {
      if (i === 0 && skipTop) continue;
      const fi = imgs[i]!;
      const src = this.imageSource(fi.imageIndex);
      if (src) ctx.drawImage(src, fi.x, fi.y);
    }
    if (overlay) {
      const src = this.imageSource(overlay.imageIndex);
      if (src) ctx.drawImage(src, overlay.x, overlay.y);
    }
  }

  /** Scales the work surface onto the visible canvas with nearest-neighbour sampling. */
  private present(): void {
    const c = this.canvas;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (!this.frame) return;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.work as CanvasImageSource, 0, 0, this.w, this.h, 0, 0, c.width, c.height);
  }

  private resize(): void {
    const cw = this.cssWidth;
    const chh = this.cssHeight;
    this.canvas.style.width = `${cw}px`;
    this.canvas.style.height = `${chh}px`;
    this.canvas.width = Math.max(1, Math.round(cw * this.dpr));
    this.canvas.height = Math.max(1, Math.round(chh * this.dpr));
    this.ctx.imageSmoothingEnabled = false;
  }

  private watchDpr(): void {
    this.mql?.removeEventListener('change', this.onDprChange);
    this.mql = null;
    if (typeof this.win.matchMedia !== 'function') return;
    try {
      this.mql = this.win.matchMedia(`(resolution: ${this.dpr}dppx)`);
      this.mql.addEventListener('change', this.onDprChange);
    } catch {
      this.mql = null;
    }
  }

  private handleDprChange(): void {
    if (this.disposed) return;
    const dpr = this.win.devicePixelRatio || 1;
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this.resize();
      this.present();
    }
    this.watchDpr();
  }
}
