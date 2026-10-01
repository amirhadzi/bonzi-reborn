import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ACS_LIMITS,
  AcsFormatError,
  DecompressError,
  MOUTH,
  canEndNaturally,
  composeFrame,
  compress,
  decodeImage,
  decompress,
  exitNextFrame,
  exitPath,
  getAnimation,
  getReturnAnimation,
  animationsForState,
  imageToRgba,
  isEndMarker,
  parseAcs,
  parseRegion,
  pickNextFrame,
  type AcsCharacter,
} from '../src/shared/acs/index.ts';

const ACS_PATH = fileURLToPath(new URL('../assets/characters/Bonzi.acs', import.meta.url));

// ------------------------------------------------------------------ helpers

/** Builds an LSB-first bit stream prefixed with the mandatory 0x00 byte. */
function bitStream(bits: string): Uint8Array {
  const clean = bits.replace(/\s+/g, '');
  const out = new Uint8Array(1 + Math.ceil(clean.length / 8));
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '1') out[1 + (i >> 3)]! |= 1 << (i & 7);
  }
  return out;
}
/** n-bit value as LSB-first bit string. */
function v(value: number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += (value >> i) & 1 ? '1' : '0';
  return s;
}
const lit = (byte: number) => '0' + v(byte, 8);
const END = '1' + '111' + v(0xfffff, 20);

// ------------------------------------------------------------------ decompress()

describe('decompress', () => {
  it('decodes literals and the end marker', () => {
    const out = decompress(bitStream(lit(0x41) + lit(0x42) + lit(0xff) + END));
    expect(Array.from(out)).toEqual([0x41, 0x42, 0xff]);
  });

  it('decodes a short (6-bit offset) back-reference of minimum length 2', () => {
    // "AB" then copy 2 bytes from offset 2 -> "ABAB"
    const out = decompress(bitStream(lit(65) + lit(66) + '1' + '0' + v(2 - 1, 6) + '0' + END));
    expect(new TextDecoder().decode(out)).toBe('ABAB');
  });

  it('supports overlapping copies (run-length style)', () => {
    // "A" then copy from offset 1 with length 2 + (1<<2)-1 + 3 = 8 -> 9 x "A"
    const out = decompress(bitStream(lit(65) + '1' + '0' + v(0, 6) + '110' + v(3, 2) + END));
    expect(new TextDecoder().decode(out)).toBe('A'.repeat(9));
  });

  it('decodes the 9-bit and 12-bit offset classes', () => {
    const data = new Uint8Array(700);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 11) & 0xff;
    // 100 literals, then a ref at offset 100 (9-bit class: 100-65 = 35)
    let bits = '';
    for (let i = 0; i < 100; i++) bits += lit(data[i]!);
    bits += '1' + '10' + v(100 - 65, 9) + '0'; // copy 2 bytes from offset 100
    let out = decompress(bitStream(bits + END));
    expect(out.length).toBe(102);
    expect(out[100]).toBe(data[0]);
    expect(out[101]).toBe(data[1]);

    bits = '';
    for (let i = 0; i < 600; i++) bits += lit(data[i]!);
    bits += '1' + '110' + v(600 - 577, 12) + '0'; // offset 600
    out = decompress(bitStream(bits + END));
    expect(out.length).toBe(602);
    expect(out[600]).toBe(data[0]);
  });

  it('decodes the 20-bit offset class with its extra length byte', () => {
    const n = 5000;
    let bits = '';
    for (let i = 0; i < n; i++) bits += lit(i & 0xff);
    bits += '1' + '111' + v(n - 4673, 20) + '0'; // offset 5000, length 3
    const out = decompress(bitStream(bits + END));
    expect(out.length).toBe(n + 3);
    expect(Array.from(out.subarray(n))).toEqual([0, 1, 2]);
  });

  it('enforces expectedSize', () => {
    const stream = bitStream(lit(1) + lit(2) + END);
    expect(Array.from(decompress(stream, 2))).toEqual([1, 2]);
    expect(() => decompress(stream, 3)).toThrow(DecompressError);
    expect(() => decompress(stream, 1)).toThrow(DecompressError);
  });

  it('rejects malformed streams', () => {
    expect(() => decompress(new Uint8Array([1, 0, 0]))).toThrow(/0x00/);
    expect(() => decompress(new Uint8Array([]))).toThrow(DecompressError);
    // truncated: literal with no end marker
    expect(() => decompress(bitStream(lit(5)))).toThrow(/unexpected end/);
    // back-reference before start of output
    expect(() => decompress(bitStream('1' + '0' + v(4, 6) + '0' + END))).toThrow(/before start/);
  });

  it('round-trips through the test encoder', () => {
    const data = new Uint8Array(3000);
    for (let i = 0; i < data.length; i++) data[i] = i % 300 < 150 ? 254 : (i * 7) & 0xff;
    const packed = compress(data);
    expect(packed[0]).toBe(0);
    expect(packed.length).toBeLessThan(data.length);
    expect(Array.from(decompress(packed, data.length))).toEqual(Array.from(data));
  });
});

// ------------------------------------------------------------------ real file

describe('Bonzi.acs', () => {
  let ch: AcsCharacter;
  beforeAll(() => {
    ch = parseAcs(readFileSync(ACS_PATH));
  });

  it('rejects non-ACS input', () => {
    expect(() => parseAcs(new Uint8Array(64))).toThrow(AcsFormatError);
  });

  it('parses header and character info', () => {
    expect(ch.header.signature).toBe(0xabcdabc3);
    expect(ch.animations).toHaveLength(146);
    expect(ch.images).toHaveLength(1253);
    expect(ch.audio).toHaveLength(22);
    expect(ch.info.width).toBe(200);
    expect(ch.info.height).toBe(160);
    expect(ch.info.palette).toHaveLength(256);
    expect(ch.info.transparentIndex).toBe(254);
    expect(ch.info.guid).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/);
    expect(ch.info.balloon?.fontName).toBe('MS Sans Serif');
    expect(ch.info.balloon?.background).toEqual({ r: 255, g: 255, b: 225 });
    expect(ch.info.voice?.extra?.languageId).toBe(1033);
    expect(ch.localized[0]?.name).toBe('Bonzi');
    expect(Object.keys(ch.info.states)).toContain('SPEAKING');
  });

  it('decodes the tray icon', () => {
    const icon = ch.info.trayIcon;
    expect(icon).not.toBeNull();
    expect(icon!.rgba?.width).toBe(16);
    expect(icon!.rgba?.height).toBe(16);
    const alphas = new Set<number>();
    for (let i = 3; i < icon!.rgba!.data.length; i += 4) alphas.add(icon!.rgba!.data[i]!);
    expect([...alphas].sort()).toEqual([0, 255]); // has both transparent and opaque pixels
  });

  it('decodes every image to stride * height bytes', () => {
    for (let i = 0; i < ch.images.length; i++) {
      const img = ch.images[i]!;
      expect(img.stride % 4).toBe(0);
      expect(img.stride).toBeGreaterThanOrEqual(img.width);
      expect(decodeImage(ch, i).length, `image ${i}`).toBe(img.stride * img.height);
    }
  });

  it('caches decoded images', () => {
    expect(decodeImage(ch, 0)).toBe(decodeImage(ch, 0));
  });

  it('has valid image region data', () => {
    for (const img of ch.images) {
      if (!img.regionData) continue;
      const rgn = parseRegion(img.regionData);
      expect(rgn.bounds.right).toBeLessThanOrEqual(img.width);
      expect(rgn.bounds.bottom).toBeLessThanOrEqual(img.height);
    }
  });

  it('has in-range frame, overlay, branch, exit and audio references', () => {
    for (const a of ch.animations) {
      a.frames.forEach((f, fi) => {
        const where = `${a.name}[${fi}]`;
        for (const im of f.images) expect(im.imageIndex, where).toBeLessThan(ch.images.length);
        for (const o of f.overlays) {
          expect(o.imageIndex, where).toBeLessThan(ch.images.length);
          expect(o.type, where).toBeGreaterThanOrEqual(0);
          expect(o.type, where).toBeLessThanOrEqual(6);
        }
        for (const b of f.branches) {
          expect(b.frameIndex, where).toBeLessThan(a.frames.length);
          expect(b.probability, where).toBeLessThanOrEqual(100);
        }
        expect(f.branches.reduce((s, b) => s + b.probability, 0), where).toBeLessThanOrEqual(100);
        // -1 and -2 both occur in the file and both mean "no exit branch"
        expect(f.exitFrameIndex, where).toBeGreaterThanOrEqual(-2);
        // an exit index equal to frames.length means "jump to the end" (SEARCHINGRETURN[6])
        expect(f.exitFrameIndex, where).toBeLessThanOrEqual(a.frames.length);
        if (f.audioIndex !== -1) expect(f.audioIndex, where).toBeLessThan(ch.audio.length);
      });
    }
  });

  it('stores audio as RIFF/WAVE', () => {
    for (const au of ch.audio) {
      const head = String.fromCharCode(...au.data.subarray(0, 4));
      const wave = String.fromCharCode(...au.data.subarray(8, 12));
      expect(head).toBe('RIFF');
      expect(wave).toBe('WAVE');
    }
  });

  it('references existing animations from return animations and states', () => {
    const problems: string[] = [];
    for (const a of ch.animations) {
      if (a.returnAnimation && !getAnimation(ch, a.returnAnimation)) problems.push(`${a.name} -> ${a.returnAnimation}`);
      if (a.transitionType === 0 && !a.returnAnimation) problems.push(`${a.name}: type 0 without return animation`);
    }
    for (const [state, names] of Object.entries(ch.info.states)) {
      for (const n of names) if (!getAnimation(ch, n)) problems.push(`state ${state} -> ${n}`);
    }
    if (problems.length) console.warn('ACS consistency exceptions:', problems);
    expect(problems).toEqual([]); // Bonzi.acs is fully consistent
  });

  it('composes frames at character size with transparency', () => {
    const img = composeFrame(ch, 'RestPose', 0);
    expect(img.width).toBe(200);
    expect(img.height).toBe(160);
    expect(img.data.length).toBe(200 * 160 * 4);
    // corners are transparent, the body centre is opaque purple-ish
    expect(img.data[3]).toBe(0);
    expect(img.data[(160 * 200 - 1) * 4 + 3]).toBe(0);
    const c = (110 * 200 + 100) * 4; // belly
    expect(img.data[c + 3]).toBe(255);
    expect(img.data[c + 2]!).toBeGreaterThan(img.data[c + 1]!); // blue > green (purple, not BGR-swapped)
    // the transparent palette colour never appears opaque
    const t = ch.info.palette[ch.info.transparentIndex]!;
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i + 3] === 255) {
        expect(img.data[i] === t.r && img.data[i + 1] === t.g && img.data[i + 2] === t.b).toBe(false);
      }
    }
  });

  it('lays out images top-down (head above feet)', () => {
    const img = composeFrame(ch, 'RestPose', 0);
    const rowOpaque = (y: number) => {
      let n = 0;
      for (let x = 0; x < 200; x++) if (img.data[(y * 200 + x) * 4 + 3]) n++;
      return n;
    };
    let top = 0;
    while (top < 160 && rowOpaque(top) === 0) top++;
    let bottom = 159;
    while (bottom > 0 && rowOpaque(bottom) === 0) bottom--;
    // head (narrow) at the top, feet (wide) at the bottom
    expect(rowOpaque(top + 2)).toBeLessThan(rowOpaque(bottom - 2) + 40);
    expect(top).toBeLessThan(60);
    expect(bottom).toBeGreaterThan(130);
  });

  it('draws the first listed image on top (reverse paint order)', () => {
    // IDLE1_9 frame 1 = [eyelid patch, full body]; the blink must be visible
    const anim = getAnimation(ch, 'IDLE1_9')!;
    const f = anim.frames[1]!;
    expect(f.images.length).toBe(2);
    const patch = imageToRgba(ch, f.images[0]!.imageIndex);
    const composed = composeFrame(ch, anim, 1);
    const forward = composeFrame(ch, anim, 1, { order: 'forward' });
    let matchReverse = 0;
    let matchForward = 0;
    for (let i = 0; i < patch.data.length; i += 4) {
      if (!patch.data[i + 3]) continue;
      if (composed.data[i] === patch.data[i] && composed.data[i + 1] === patch.data[i + 1]) matchReverse++;
      if (forward.data[i] === patch.data[i] && forward.data[i + 1] === patch.data[i + 1]) matchForward++;
    }
    expect(matchReverse).toBeGreaterThan(matchForward);
  });

  it('applies mouth overlays', () => {
    const base = composeFrame(ch, 'RestPose', 0);
    const wide = composeFrame(ch, 'RestPose', 0, { mouth: MOUTH.WIDE4 });
    let diff = 0;
    let minY = 999;
    let maxY = -1;
    for (let i = 0; i < base.data.length; i += 4) {
      if (base.data[i] !== wide.data[i] || base.data[i + 1] !== wide.data[i + 1] || base.data[i + 2] !== wide.data[i + 2]) {
        diff++;
        const y = Math.floor(i / 4 / 200);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    expect(diff).toBeGreaterThan(50);
    // the changed area is the mouth: within the head region, not the body
    expect(minY).toBeGreaterThan(50);
    expect(maxY).toBeLessThan(100);
    // a frame without overlays ignores the option
    const noOv = getAnimation(ch, 'IDLE1_9')!;
    expect(noOv.frames[0]!.overlays).toHaveLength(0);
    expect(composeFrame(ch, noOv, 0, { mouth: 3 }).data).toEqual(composeFrame(ch, noOv, 0).data);
  });

  it('supports a reusable target buffer', () => {
    const target = new Uint8ClampedArray(200 * 160 * 4);
    const out = composeFrame(ch, 'Greet', 3, { target });
    expect(out.data).toBe(target);
    expect(() => composeFrame(ch, 'Greet', 3, { target: new Uint8ClampedArray(4) })).toThrow(RangeError);
    expect(() => composeFrame(ch, 'NoSuchAnimation', 0)).toThrow(RangeError);
    expect(() => composeFrame(ch, 'Greet', 999)).toThrow(RangeError);
  });

  it('sequences frames per MS Agent rules', () => {
    const idle = getAnimation(ch, 'IDLE1_1')!; // last frame: 70% back to 0
    const last = idle.frames.length - 1;
    expect(pickNextFrame(idle, last, () => 0.1)).toBe(0);
    expect(pickNextFrame(idle, last, () => 0.9)).toBe(idle.frames.length); // ends
    expect(pickNextFrame(idle, 0, () => 0.5)).toBe(1);

    const wave = getAnimation(ch, 'Wave')!; // exit branches walk back to frame 0 then to the end
    const path = exitPath(wave, 10);
    // exits rewind the gesture: 10 -> 9 ... 5 -> 25 .. 28 -> 0 -> 29 (trailing end marker)
    expect(path.slice(0, 5)).toEqual([9, 8, 7, 6, 5]);
    expect(path.slice(-2)).toEqual([0, 29]);
    expect(isEndMarker(wave, 29)).toBe(true);
    expect(exitNextFrame(wave, 0)).toBe(wave.frames.length - 1);

    const show = getAnimation(ch, 'Show')!; // last frame's exit index points at itself
    expect(exitNextFrame(show, show.frames.length - 1)).toBe(show.frames.length);

    expect(canEndNaturally(getAnimation(ch, 'Reading')!)).toBe(false);
    expect(canEndNaturally(getAnimation(ch, 'Greet')!)).toBe(true);
    expect(getReturnAnimation(ch, getAnimation(ch, 'Reading')!)?.name).toBe('READRETURN');
    expect(animationsForState(ch, 'IdlingLevel1').length).toBeGreaterThan(5);
  });
});

// ------------------------------------------------------------------ robustness

describe('malformed input', () => {
  const good = new Uint8Array(readFileSync(ACS_PATH));

  it('rejects a wrong signature with a clear message', () => {
    const bad = good.slice(0, 64);
    bad[0] = 0x12;
    expect(() => parseAcs(bad)).toThrow(/not an ACS file/);
  });

  it('rejects empty and truncated buffers without hanging', () => {
    const cuts = [0, 3, 4, 20, 36, 37, 200, 5_000, 100_000, good.length >> 1, good.length - 1];
    for (const n of cuts) {
      expect(() => parseAcs(good.subarray(0, n)), `cut at ${n}`).toThrow(AcsFormatError);
    }
  });

  it('rejects an implausible decompressed size before allocating', () => {
    const stream = bitStream(lit(1) + END);
    expect(() => decompress(stream, 0x7fffffff)).toThrow(/impossible/);
    expect(() => decompress(stream, -1)).toThrow(DecompressError);
  });

  it('reports corrupt pixel data as a DecompressError naming the image', () => {
    const ch = parseAcs(good);
    const img = ch.images[0]!;
    // Replace the compressed bytes with a stream that has no end marker.
    img.data = bitStream(lit(1).repeat(40));
    expect(() => decodeImage(ch, 0)).toThrow(/image 0: .*unexpected end/);
    expect(() => decodeImage(ch, ch.images.length)).toThrow(RangeError);
  });

  it('survives random corruption by throwing typed errors only', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    for (let t = 0; t < 40; t++) {
      const b = good.slice();
      for (let h = 0; h < 4; h++) b[Math.floor(rnd() * 150_000)] = Math.floor(rnd() * 256);
      try {
        const ch = parseAcs(b);
        for (let i = 0; i < ch.images.length; i += 25) decodeImage(ch, i);
        for (const a of ch.animations.slice(0, 10)) for (let f = 0; f < a.frames.length; f++) composeFrame(ch, a, f);
      } catch (e) {
        expect(
          e instanceof AcsFormatError || e instanceof DecompressError || e instanceof RangeError,
          String(e),
        ).toBe(true);
      }
    }
  });
});

describe('lazy decoding', () => {
  it('parses without decoding any pixels and caches only what is drawn', () => {
    const ch = parseAcs(readFileSync(ACS_PATH));
    expect(ch.decodedCache.size).toBe(0);
    composeFrame(ch, 'RestPose', 0);
    const used = new Set(getAnimation(ch, 'RestPose')!.frames[0]!.images.map((i) => i.imageIndex));
    expect(new Set(ch.decodedCache.keys())).toEqual(used);
  });
});

// ------------------------------------------------------------------ work limits

/** Little-endian writer for hand-built ACS files. */
class AcsWriter {
  private buf = new Uint8Array(1 << 16);
  private view = new DataView(this.buf.buffer);
  pos = 0;
  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(x: number): void {
    this.ensure(1);
    this.view.setUint8(this.pos++, x);
  }
  u16(x: number): void {
    this.ensure(2);
    this.view.setUint16(this.pos, x, true);
    this.pos += 2;
  }
  u32(x: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, x >>> 0, true);
    this.pos += 4;
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  str(s: string): void {
    this.u32(s.length);
    if (!s.length) return;
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    this.u16(0);
  }
  /** Reserves n bytes and returns their offset. */
  reserve(n: number): number {
    const at = this.pos;
    this.ensure(n);
    this.pos += n;
    return at;
  }
  patch32(at: number, x: number): void {
    this.view.setUint32(at, x >>> 0, true);
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

interface CraftSpec {
  /** Frame count of each distinct animation struct. */
  animStructs?: number[];
  /** Animation list entries: list name and the struct they point at. */
  animEntries?: Array<{ name: string; struct: number }>;
  /** Number of distinct image structs, each carrying the region stream below. */
  imageStructs?: number;
  /** Image list entries: the struct each one points at. */
  imageEntries?: number[];
}

/** About 1 KB of compressed region data that inflates to about 1 MB (250 back-references of 4096 bytes). */
function regionBombStream(): { comp: Uint8Array; rawSize: number } {
  const refs = 250;
  const comp = bitStream(lit(0) + ('10' + v(0, 6) + v(0x7ff, 11) + '0' + v(2047, 11)).repeat(refs) + END);
  return { comp, rawSize: 1 + refs * 4096 };
}

function buildAcs(spec: CraftSpec): Uint8Array {
  const w = new AcsWriter();
  w.u32(0xabcdabc3);
  const hdr = w.reserve(32);
  // Minimal character info: no voice, no balloon, no palette, no tray icon, no states.
  const charInfo = w.pos;
  w.u16(2);
  w.u16(2);
  const locLoc = w.reserve(8);
  w.reserve(16); // guid
  w.u16(100);
  w.u16(100);
  w.u8(0);
  w.u32(0); // flags
  w.u16(1);
  w.u16(0);
  w.u32(0); // palette
  w.u8(0); // no tray icon
  w.u16(0); // states
  const charInfoSize = w.pos - charInfo;
  const localized = w.pos;
  w.u16(0);
  w.patch32(locLoc, localized);
  w.patch32(locLoc + 4, 2);

  const animEntries = spec.animEntries ?? [];
  const animList = w.pos;
  w.u32(animEntries.length);
  const animLocs: number[] = [];
  for (const e of animEntries) {
    w.str(e.name);
    animLocs.push(w.reserve(8));
  }
  const structAt: Array<{ offset: number; size: number }> = [];
  for (const frames of spec.animStructs ?? []) {
    const at = w.pos;
    w.str('');
    w.u8(2);
    w.str('');
    w.u16(frames);
    for (let f = 0; f < frames; f++) {
      w.u16(0); // images
      w.u16(0xffff); // audio
      w.u16(10); // duration
      w.u16(0xffff); // exit
      w.u8(0); // branches
      w.u8(0); // overlays
    }
    structAt.push({ offset: at, size: w.pos - at });
  }
  animEntries.forEach((e, i) => {
    const s = structAt[e.struct]!;
    w.patch32(animLocs[i]!, s.offset);
    w.patch32(animLocs[i]! + 4, s.size);
  });
  const animSize = w.pos - animList;

  const imageEntries = spec.imageEntries ?? [];
  const images = w.pos;
  w.u32(imageEntries.length);
  const imageLocs = imageEntries.map(() => w.reserve(12));
  const { comp, rawSize } = regionBombStream();
  const imgAt: Array<{ offset: number; size: number }> = [];
  for (let k = 0; k < (spec.imageStructs ?? 0); k++) {
    const at = w.pos;
    w.u8(0);
    w.u16(1);
    w.u16(1);
    w.u8(0); // not compressed
    w.u32(0); // no pixel data
    w.u32(comp.length);
    w.u32(rawSize);
    w.bytes(comp);
    imgAt.push({ offset: at, size: w.pos - at });
  }
  imageEntries.forEach((k, i) => {
    const s = imgAt[k]!;
    w.patch32(imageLocs[i]!, s.offset);
    w.patch32(imageLocs[i]! + 4, s.size);
    w.patch32(imageLocs[i]! + 8, i); // checksum
  });
  const imageSize = w.pos - images;

  const audio = w.pos;
  w.u32(0);
  [charInfo, charInfoSize, animList, animSize, images, imageSize, audio, 4].forEach((x, i) => w.patch32(hdr + i * 4, x));
  return w.done();
}

describe('work limits (crafted files)', () => {
  it('parses an animation shared by many list entries once, keeping each list name', () => {
    // Before the limits, this 680 KB file expanded to 131M frames and crashed V8.
    const entries = Array.from({ length: 2000 }, (_, i) => ({ name: `A${i}`, struct: 0 }));
    const bytes = buildAcs({ animStructs: [65535], animEntries: entries });
    expect(bytes.length).toBeLessThan(1_000_000);
    const t0 = Date.now();
    const ch = parseAcs(bytes);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(ch.animations.length).toBe(2000);
    expect(ch.animations[0]!.frames.length).toBe(65535);
    expect(ch.animations[1999]!.frames).toBe(ch.animations[0]!.frames);
    expect(getAnimation(ch, 'a1234')?.name).toBe('A1234');
  });

  it('keeps distinct names for two entries sharing one small locator', () => {
    const ch = parseAcs(
      buildAcs({ animStructs: [3], animEntries: [{ name: 'Wave', struct: 0 }, { name: 'Greet', struct: 0 }] }),
    );
    expect(ch.animations.map((a) => a.name)).toEqual(['Wave', 'Greet']);
    expect(ch.animations[0]).not.toBe(ch.animations[1]);
    expect(ch.animations[0]!.frames).toBe(ch.animations[1]!.frames);
    expect(getAnimation(ch, 'greet')).toBe(ch.animations[1]);
  });

  it('rejects an animation list longer than the limit', () => {
    const entries = Array.from({ length: ACS_LIMITS.maxAnimations + 1 }, () => ({ name: '', struct: 0 }));
    expect(() => parseAcs(buildAcs({ animStructs: [1], animEntries: entries }))).toThrow(/too many animations/);
  });

  it('rejects distinct animations whose frames add up past the limit', () => {
    const bytes = buildAcs({
      animStructs: [65535, 65535, 65535, 65535],
      animEntries: [0, 1, 2, 3].map((k) => ({ name: `X${k}`, struct: k })),
    });
    expect(() => parseAcs(bytes)).toThrow(AcsFormatError);
    expect(() => parseAcs(bytes)).toThrow(/too many animation frames/);
  });

  it('decompresses an image region shared by many entries once', () => {
    const bytes = buildAcs({ imageStructs: 1, imageEntries: Array.from({ length: 500 }, () => 0) });
    expect(bytes.length).toBeLessThan(10_000);
    const ch = parseAcs(bytes);
    expect(ch.images.length).toBe(500);
    expect(ch.images[0]!.regionData!.length).toBe(regionBombStream().rawSize);
    expect(ch.images[499]!.regionData).toBe(ch.images[0]!.regionData);
    expect(ch.images.map((i) => i.checksum).slice(0, 3)).toEqual([0, 1, 2]);
  });

  it('rejects distinct regions whose decompressed total passes the limit', () => {
    const n = Math.ceil(ACS_LIMITS.maxTotalRegionBytes / regionBombStream().rawSize) + 1;
    const bytes = buildAcs({ imageStructs: n, imageEntries: Array.from({ length: n }, (_, i) => i) });
    expect(bytes.length).toBeLessThan(200_000);
    expect(() => parseAcs(bytes)).toThrow(/too many region bytes/);
  });

  it('rejects an image list longer than the limit', () => {
    const bytes = buildAcs({ imageStructs: 1, imageEntries: Array.from({ length: ACS_LIMITS.maxImages + 1 }, () => 0) });
    expect(() => parseAcs(bytes)).toThrow(/too many images/);
  });

  it('still parses Bonzi.acs completely, well inside the limits', () => {
    const ch = parseAcs(readFileSync(ACS_PATH));
    const frames = ch.animations.reduce((s, a) => s + a.frames.length, 0);
    expect(ch.animations.length).toBe(146);
    expect(frames).toBe(2788);
    expect(ch.images.length).toBe(1253);
    expect(frames).toBeLessThan(ACS_LIMITS.maxTotalFrames / 10);
  });
});
