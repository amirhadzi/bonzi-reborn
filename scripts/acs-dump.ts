/**
 * Dumps an ACS character file:
 *   - docs/bonzi-acs-summary.json  (character info + per-animation summary)
 *   - .scratch/acs-dump/*.png       (contact sheet per animation, mouth sheet,
 *                                    layering comparison, tray icon)
 *
 * Usage: node scripts/acs-dump.ts [path-to-acs] [--no-png]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import {
  MOUTH_NAMES,
  animationDurationMs,
  canEndNaturally,
  composeFrameData,
  hasLoop,
  parseAcs,
  type AcsAnimation,
  type AcsCharacter,
  type MouthType,
  type RgbaImage,
} from '../src/shared/acs/index.ts';

const { PNG } = pngjs;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const noPng = args.includes('--no-png');
const acsPath = resolve(args.find((a) => !a.startsWith('--')) ?? join(root, 'assets/characters/Bonzi.acs'));
const outDir = join(root, '.scratch/acs-dump');
const summaryPath = join(root, 'docs/bonzi-acs-summary.json');

// ---------------------------------------------------------------- canvas utils

class Canvas {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  constructor(width: number, height: number, bg: [number, number, number] = [255, 255, 255]) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      this.data[i * 4] = bg[0];
      this.data[i * 4 + 1] = bg[1];
      this.data[i * 4 + 2] = bg[2];
      this.data[i * 4 + 3] = 255;
    }
  }
  fillRect(x: number, y: number, w: number, h: number, c: [number, number, number]): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) {
        const o = (yy * this.width + xx) * 4;
        this.data[o] = c[0];
        this.data[o + 1] = c[1];
        this.data[o + 2] = c[2];
        this.data[o + 3] = 255;
      }
    }
  }
  /** Checkerboard so transparency (and any garbage box) is obvious. */
  checker(x: number, y: number, w: number, h: number, size = 8): void {
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const dark = ((xx / size) ^ (yy / size)) & 1;
        const v = dark ? 206 : 236;
        const px = x + xx;
        const py = y + yy;
        if (px < 0 || py < 0 || px >= this.width || py >= this.height) continue;
        const o = (py * this.width + px) * 4;
        this.data[o] = v;
        this.data[o + 1] = v;
        this.data[o + 2] = v + 8;
        this.data[o + 3] = 255;
      }
    }
  }
  /** Alpha-blends an RGBA image (alpha is 0 or 255 for ACS frames). */
  draw(img: RgbaImage, x: number, y: number, scale = 1): void {
    for (let yy = 0; yy < img.height * scale; yy++) {
      for (let xx = 0; xx < img.width * scale; xx++) {
        const sx = Math.floor(xx / scale);
        const sy = Math.floor(yy / scale);
        const s = (sy * img.width + sx) * 4;
        const a = img.data[s + 3] as number;
        if (a === 0) continue;
        const px = x + xx;
        const py = y + yy;
        if (px < 0 || py < 0 || px >= this.width || py >= this.height) continue;
        const o = (py * this.width + px) * 4;
        this.data[o] = img.data[s] as number;
        this.data[o + 1] = img.data[s + 1] as number;
        this.data[o + 2] = img.data[s + 2] as number;
        this.data[o + 3] = 255;
      }
    }
  }
  text(s: string, x: number, y: number, c: [number, number, number] = [20, 20, 20], scale = 2): void {
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const glyph = FONT[ch] ?? FONT['?']!;
      for (let row = 0; row < 5; row++) {
        const bits = glyph[row] ?? 0;
        for (let col = 0; col < 3; col++) {
          if (bits & (4 >> col)) this.fillRect(cx + col * scale, y + row * scale, scale, scale, c);
        }
      }
      cx += 4 * scale;
    }
  }
  save(path: string): void {
    const png = new PNG({ width: this.width, height: this.height });
    png.data = Buffer.from(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    writeFileSync(path, PNG.sync.write(png));
  }
}

// 3x5 pixel font, rows top->bottom, 3 bits per row (MSB = left column).
const FONT: Record<string, number[]> = {
  '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [7, 1, 7, 4, 7], '3': [7, 1, 7, 1, 7],
  '4': [5, 5, 7, 1, 1], '5': [7, 4, 7, 1, 7], '6': [7, 4, 7, 5, 7], '7': [7, 1, 1, 1, 1],
  '8': [7, 5, 7, 5, 7], '9': [7, 5, 7, 1, 7], A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6],
  C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6], E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4],
  G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5], I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2],
  K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7], M: [5, 7, 7, 5, 5], N: [6, 5, 5, 5, 5],
  O: [2, 5, 5, 5, 2], P: [6, 5, 6, 4, 4], Q: [2, 5, 5, 6, 3], R: [6, 5, 6, 5, 5],
  S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2], U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2],
  W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5], Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7],
  ' ': [0, 0, 0, 0, 0], '_': [0, 0, 0, 0, 7], '-': [0, 0, 7, 0, 0], ':': [0, 2, 0, 2, 0],
  '.': [0, 0, 0, 0, 2], '(': [1, 2, 2, 2, 1], ')': [4, 2, 2, 2, 4], '/': [1, 1, 2, 4, 4],
  '>': [4, 2, 1, 2, 4], '=': [0, 7, 0, 7, 0], '#': [5, 7, 5, 7, 5], '+': [0, 2, 7, 2, 0],
  '?': [7, 1, 2, 0, 2], '%': [5, 1, 2, 4, 5],
};

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '_');
}

// ---------------------------------------------------------------- summary

function summarize(ch: AcsCharacter) {
  const { info } = ch;
  const restImage = ch.animationsByName.get('restpose')?.frames[0]?.images[0]?.imageIndex ?? -1;
  const animations = ch.animations.map((a: AcsAnimation) => {
    const sounds = new Set<number>();
    const mouths = new Set<number>();
    let minImgs = Infinity;
    let maxImgs = 0;
    let hasBranches = false;
    let hasExitBranches = false;
    let overlayFrames: number[] = [];
    a.frames.forEach((f, i) => {
      if (f.audioIndex >= 0) sounds.add(f.audioIndex);
      for (const o of f.overlays) mouths.add(o.type);
      if (f.overlays.length) overlayFrames.push(i);
      minImgs = Math.min(minImgs, f.images.length);
      maxImgs = Math.max(maxImgs, f.images.length);
      if (f.branches.length) hasBranches = true;
      if (f.exitFrameIndex >= 0) hasExitBranches = true;
    });
    if (overlayFrames.length > 12) overlayFrames = [...overlayFrames.slice(0, 12)];
    return {
      name: a.name,
      frameCount: a.frames.length,
      totalDurationMs: animationDurationMs(a),
      transitionType: a.transitionType,
      transitionTypeName: (['returnAnimation', 'exitBranches', 'none'] as const)[a.transitionType],
      returnAnimation: a.returnAnimation || null,
      hasBranches,
      hasExitBranches,
      /** true if some branch jumps back to the same or an earlier frame. */
      loops: hasLoop(a),
      /** false = loops forever; the app must exit it (exit branches) or interrupt + play the return animation. */
      endsNaturally: canEndNaturally(a),
      /** 1-frame animation that is just the rest pose (placeholder in this character). */
      isRestPoseStub: a.frames.length === 1 && a.frames[0]!.images.length === 1 && a.frames[0]!.images[0]!.imageIndex === restImage,
      mouthOverlayTypes: [...mouths].sort((x, y) => x - y).map((m) => MOUTH_NAMES[m] ?? String(m)),
      overlayFrames,
      soundIndexes: [...sounds].sort((x, y) => x - y),
      imagesPerFrame: a.frames.length ? [minImgs, maxImgs] : [0, 0],
    };
  });
  return {
    source: 'assets/characters/Bonzi.acs',
    signature: '0x' + ch.header.signature.toString(16).toUpperCase(),
    character: {
      version: `${info.majorVersion}.${info.minorVersion}`,
      guid: info.guid,
      width: info.width,
      height: info.height,
      transparentIndex: info.transparentIndex,
      transparentColor: info.palette[info.transparentIndex] ?? null,
      flags: '0x' + info.flags.toString(16).toUpperCase().padStart(8, '0'),
      animationSetVersion: `${info.animationSetMajorVersion}.${info.animationSetMinorVersion}`,
      voice: info.voice,
      balloon: info.balloon,
      paletteSize: info.palette.length,
      trayIcon: info.trayIcon
        ? {
            monoBitmapBytes: info.trayIcon.monoBitmap.length,
            colorBitmapBytes: info.trayIcon.colorBitmap.length,
            decoded: info.trayIcon.rgba ? [info.trayIcon.rgba.width, info.trayIcon.rgba.height] : null,
          }
        : null,
    },
    localized: ch.localized,
    states: info.states,
    counts: { animations: ch.animations.length, images: ch.images.length, audio: ch.audio.length },
    audio: ch.audio.map((a, i) => ({ index: i, bytes: a.data.length, ...wavInfo(a.data) })),
    animations,
  };
}

function wavInfo(d: Uint8Array): { durationMs: number | null; sampleRate: number | null } {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d.length < 44 || v.getUint32(0, false) !== 0x52494646) return { durationMs: null, sampleRate: null };
  let pos = 12;
  let byteRate = 0;
  let sampleRate = 0;
  while (pos + 8 <= d.length) {
    const id = String.fromCharCode(d[pos]!, d[pos + 1]!, d[pos + 2]!, d[pos + 3]!);
    const size = v.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      sampleRate = v.getUint32(pos + 12, true);
      byteRate = v.getUint32(pos + 16, true);
    } else if (id === 'data') {
      return { durationMs: byteRate ? Math.round((size / byteRate) * 1000) : null, sampleRate };
    }
    pos += 8 + size + (size & 1);
  }
  return { durationMs: null, sampleRate: sampleRate || null };
}

// ---------------------------------------------------------------- PNG output

const W = 200;
const H = 160;
const LABEL = 16;

function contactSheet(ch: AcsCharacter, a: AcsAnimation, path: string): void {
  const n = a.frames.length;
  const cols = Math.min(n, 10);
  const rows = Math.ceil(n / cols);
  const cw = W;
  const chh = H + LABEL;
  const header = 22;
  const c = new Canvas(Math.max(cols * cw, 420), header + rows * chh, [250, 250, 250]);
  c.text(`${a.name}  ${n}F  ${animationDurationMs(a)}MS  T${a.transitionType}${a.returnAnimation ? ' >' + a.returnAnimation : ''}`, 4, 4, [0, 0, 120]);
  a.frames.forEach((f, i) => {
    const x = (i % cols) * cw;
    const y = header + Math.floor(i / cols) * chh;
    c.checker(x, y + LABEL, W, H);
    c.draw(composeFrameData(ch, f), x, y + LABEL);
    let label = `${i} D${f.duration} I${f.images.length}`;
    if (f.audioIndex >= 0) label += ` S${f.audioIndex}`;
    if (f.exitFrameIndex >= 0) label += ` X${f.exitFrameIndex}`;
    if (f.branches.length) label += ' B' + f.branches.map((b) => `${b.frameIndex}:${b.probability}`).join('/');
    if (f.overlays.length) label += ' M';
    c.text(label, x + 2, y + 3, [40, 40, 40]);
  });
  c.save(path);
}

/** One frame with each of the 7 mouth overlays (plus no overlay), at 2x scale. */
function mouthSheet(ch: AcsCharacter, a: AcsAnimation, frameIndex: number, path: string): void {
  const f = a.frames[frameIndex]!;
  const scale = 2;
  const cols = 4;
  const types: (MouthType | null)[] = [null, 0, 1, 2, 3, 4, 5, 6];
  const cw = W * scale;
  const chh = H * scale + LABEL + 4;
  const c = new Canvas(cols * cw, 24 + 2 * chh, [250, 250, 250]);
  c.text(`${a.name} FRAME ${frameIndex} MOUTH OVERLAYS`, 4, 4, [0, 0, 120]);
  types.forEach((m, i) => {
    const x = (i % cols) * cw;
    const y = 24 + Math.floor(i / cols) * chh;
    const ov = m === null ? undefined : f.overlays.find((o) => o.type === m);
    c.text(m === null ? 'NONE' : `${m} ${MOUTH_NAMES[m]}${ov ? (ov.replace ? ' REPLACE' : ' ADD') : ' MISSING'}`, x + 4, y + 2);
    c.checker(x, y + LABEL, W * scale, H * scale);
    c.draw(composeFrameData(ch, f, { mouth: m }), x, y + LABEL, scale);
  });
  c.save(path);
}

/** Multi-image frames rendered with both draw orders side by side. */
function layeringSheet(ch: AcsCharacter, path: string): string[] {
  const picks: { a: AcsAnimation; i: number }[] = [];
  const seen = new Set<string>();
  for (const a of ch.animations) {
    a.frames.forEach((f, i) => {
      if (f.images.length >= 2 && !seen.has(a.name) && picks.length < 10) {
        // prefer frames whose images overlap noticeably
        seen.add(a.name);
        picks.push({ a, i });
      }
    });
  }
  const c = new Canvas(2 * W + 8, 24 + picks.length * (H + LABEL), [250, 250, 250]);
  c.text('LEFT=REVERSE (FIRST ON TOP)  RIGHT=FORWARD', 4, 4, [0, 0, 120]);
  picks.forEach(({ a, i }, row) => {
    const y = 24 + row * (H + LABEL);
    const f = a.frames[i]!;
    c.text(`${a.name} ${i} I${f.images.length}`, 4, y + 2);
    c.checker(0, y + LABEL, W, H);
    c.checker(W + 8, y + LABEL, W, H);
    c.draw(composeFrameData(ch, f, { order: 'reverse' }), 0, y + LABEL);
    c.draw(composeFrameData(ch, f, { order: 'forward' }), W + 8, y + LABEL);
  });
  c.save(path);
  return picks.map(({ a, i }) => `${a.name}#${i}`);
}

/** Half-scale overview: N animations per sheet, up to 10 evenly sampled frames each. */
function overviewSheets(ch: AcsCharacter, dir: string, perSheet = 12): number {
  const samples = 10;
  const cw = W / 2;
  const chh = H / 2;
  const labelW = 170;
  let sheets = 0;
  for (let s = 0; s * perSheet < ch.animations.length; s++) {
    const group = ch.animations.slice(s * perSheet, (s + 1) * perSheet);
    const c = new Canvas(labelW + samples * cw, group.length * (chh + 4), [250, 250, 250]);
    group.forEach((a, row) => {
      const y = row * (chh + 4);
      c.text(a.name, 2, y + 4, [0, 0, 120]);
      c.text(`${a.frames.length}F ${animationDurationMs(a)}MS`, 2, y + 18);
      const drawable = a.frames.map((f, i) => ({ f, i })).filter(({ f }) => f.images.length > 0);
      const n = Math.min(samples, drawable.length);
      for (let k = 0; k < n; k++) {
        const pick = drawable[Math.round((k * (drawable.length - 1)) / Math.max(1, n - 1))]!;
        const full = composeFrameData(ch, pick.f);
        const half: RgbaImage = { width: cw, height: chh, data: new Uint8ClampedArray(cw * chh * 4) };
        for (let yy = 0; yy < chh; yy++) {
          for (let xx = 0; xx < cw; xx++) {
            const so = (yy * 2 * W + xx * 2) * 4;
            const d = (yy * cw + xx) * 4;
            for (let q = 0; q < 4; q++) half.data[d + q] = full.data[so + q] as number;
          }
        }
        const x = labelW + k * cw;
        c.checker(x, y, cw, chh, 5);
        c.draw(half, x, y);
        c.text(String(pick.i), x + 1, y + 1, [90, 90, 90], 1);
      }
    });
    c.save(join(dir, `_overview-${String(s + 1).padStart(2, '0')}.png`));
    sheets++;
  }
  return sheets;
}

function main(): void {
  const bytes = readFileSync(acsPath);
  const ch = parseAcs(bytes);
  const summary = summarize(ch);
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`wrote ${summaryPath}`);
  if (noPng) return;

  mkdirSync(outDir, { recursive: true });
  for (const a of ch.animations) contactSheet(ch, a, join(outDir, `anim-${safeName(a.name)}.png`));
  console.log(`wrote ${ch.animations.length} contact sheets to ${outDir}`);
  console.log(`wrote ${overviewSheets(ch, outDir)} overview sheets`);

  // Mouth overlay sheet: the Speaking state animation (RestPose) frame 0 if it
  // has overlays, otherwise the first frame that has all 7.
  const speaking = (ch.info.states['SPEAKING'] ?? ch.info.states['Speaking'] ?? [])[0];
  let mouthAnim = speaking ? ch.animationsByName.get(speaking.toLowerCase()) : undefined;
  let mouthFrame = mouthAnim ? mouthAnim.frames.findIndex((f) => f.overlays.length >= 7) : -1;
  if (!mouthAnim || mouthFrame < 0) {
    for (const a of ch.animations) {
      const i = a.frames.findIndex((f) => f.overlays.length >= 7);
      if (i >= 0) {
        mouthAnim = a;
        mouthFrame = i;
        break;
      }
    }
  }
  if (mouthAnim && mouthFrame >= 0) {
    mouthSheet(ch, mouthAnim, mouthFrame, join(outDir, '_mouth-overlays.png'));
    // a second sheet from a gesture frame that uses a "replace" overlay
    for (const other of ch.animations) {
      const fi = other.frames.findIndex((f) => f.overlays.length >= 7 && f.overlays.some((o) => o.replace));
      if (fi >= 0) {
        mouthSheet(ch, other, fi, join(outDir, `_mouth-overlays-${safeName(other.name)}-${fi}.png`));
        break;
      }
    }
  }

  const picks = layeringSheet(ch, join(outDir, '_layering.png'));
  console.log(`layering sheet frames: ${picks.join(', ')}`);

  const icon = ch.info.trayIcon?.rgba;
  if (icon) {
    const scale = 8;
    const c = new Canvas(icon.width * scale, icon.height * scale);
    c.checker(0, 0, c.width, c.height, 8);
    c.draw(icon, 0, 0, scale);
    c.save(join(outDir, '_tray-icon-x8.png'));
    const c1 = new Canvas(icon.width, icon.height);
    c1.data.fill(0);
    c1.draw(icon, 0, 0);
    // keep real transparency in the 1x version
    for (let i = 0; i < icon.width * icon.height; i++) c1.data[i * 4 + 3] = icon.data[i * 4 + 3] as number;
    c1.save(join(outDir, '_tray-icon.png'));
  }
  console.log('done');
}

main();
