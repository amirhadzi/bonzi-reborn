/**
 * ACS (Microsoft Agent 2.0 character file) parser.
 *
 * parseAcs() walks the whole structure eagerly EXCEPT image pixel data, which
 * is kept as raw (usually compressed) bytes and decoded on demand by
 * decodeImage() in render.ts.
 */

import { AcsFormatError, BinaryReader } from './binary-reader.ts';
import { decompress } from './decompress.ts';
import {
  ACS_FLAGS,
  type AcsAnimation,
  type AcsAudio,
  type AcsBalloonInfo,
  type AcsBranch,
  type AcsCharacter,
  type AcsCharacterInfo,
  type AcsFrame,
  type AcsFrameImage,
  type AcsHeader,
  type AcsImage,
  type AcsLocalizedInfo,
  type AcsOverlay,
  type AcsRect,
  type AcsRegion,
  type AcsTransitionType,
  type AcsTrayIcon,
  type AcsVoiceInfo,
  type MouthType,
  type RgbaImage,
} from './types.ts';

export const ACS_SIGNATURE = 0xabcdabc3;

export { AcsFormatError };

/**
 * Work limits so a small crafted file cannot expand into gigabytes (list
 * entries may share locators, and every shared one used to be parsed again).
 * Bonzi.acs: 146 animations, 2788 frames, 1253 images, about 2 MB of regions.
 */
export const ACS_LIMITS = {
  maxAnimations: 4096,
  maxImages: 65536,
  maxTotalFrames: 200_000,
  /** Frame images + branches + overlays, summed over all frames. */
  maxTotalFrameItems: 2_000_000,
  maxTotalRegionBytes: 64 * 1024 * 1024,
} as const;

interface ParseBudget {
  frames: number;
  items: number;
  regionBytes: number;
}

function spend(budget: ParseBudget, key: keyof ParseBudget, n: number, max: number, what: string): void {
  budget[key] += n;
  if (budget[key] > max) throw new AcsFormatError(`too many ${what} (over ${max})`);
}

function toBytes(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
}

/** Parses a complete ACS file. Throws AcsFormatError on malformed input. */
export function parseAcs(input: ArrayBuffer | ArrayBufferView): AcsCharacter {
  const bytes = toBytes(input);
  const r = new BinaryReader(bytes);

  const signature = r.u32();
  if (signature !== ACS_SIGNATURE) {
    throw new AcsFormatError(
      `not an ACS file (signature 0x${signature.toString(16)}, expected 0x${ACS_SIGNATURE.toString(16)})`,
    );
  }
  const header: AcsHeader = {
    signature,
    characterInfo: r.locator(),
    animationInfo: r.locator(),
    imageInfo: r.locator(),
    audioInfo: r.locator(),
  };

  const info = parseCharacterInfo(r.seek(header.characterInfo.offset));
  const localized = parseLocalizedInfo(r.seek(info.localizedInfoLocator.offset));
  const budget: ParseBudget = { frames: 0, items: 0, regionBytes: 0 };
  const animations = parseAnimationList(r.seek(header.animationInfo.offset), budget);
  const images = parseImageList(r.seek(header.imageInfo.offset), budget);
  const audio = parseAudioList(r.seek(header.audioInfo.offset));

  const animationsByName = new Map<string, AcsAnimation>();
  for (const a of animations) animationsByName.set(a.name.toLowerCase(), a);

  return {
    header,
    info,
    localized,
    animations,
    animationsByName,
    images,
    audio,
    decodedCache: new Map(),
  };
}

function parseCharacterInfo(r: BinaryReader): AcsCharacterInfo {
  const minorVersion = r.u16();
  const majorVersion = r.u16();
  const localizedInfoLocator = r.locator();
  const guid = r.guid();
  const width = r.u16();
  const height = r.u16();
  const transparentIndex = r.u8();
  const flags = r.u32();
  const animationSetMajorVersion = r.u16();
  const animationSetMinorVersion = r.u16();

  let voice: AcsVoiceInfo | null = null;
  if (flags & ACS_FLAGS.VOICE_ENABLED) {
    const ttsEngineId = r.guid();
    const ttsModeId = r.guid();
    const speed = r.u32();
    const pitch = r.u16();
    const hasExtra = r.bool();
    let extra: AcsVoiceInfo['extra'] = null;
    if (hasExtra) {
      const languageId = r.u16();
      const languageDialect = r.string();
      const gender = r.u16();
      const age = r.u16();
      const style = r.string();
      extra = { languageId, languageDialect, gender, age, style };
    }
    voice = { ttsEngineId, ttsModeId, speed, pitch, extra };
  }

  let balloon: AcsBalloonInfo | null = null;
  if (flags & ACS_FLAGS.BALLOON_ENABLED) {
    const lines = r.u8();
    const charsPerLine = r.u8();
    // Balloon colors are COLORREFs (R, G, B, 0), unlike the RGBQUAD palette.
    // Bonzi's background bytes FF FF E1 decode to the classic tooltip yellow #FFFFE1.
    const foreground = r.colorRef();
    const background = r.colorRef();
    const border = r.colorRef();
    const fontName = r.string();
    const fontHeight = r.i32();
    const fontWeight = r.i32();
    const italic = r.bool();
    const unknown = r.u8();
    balloon = { lines, charsPerLine, foreground, background, border, fontName, fontHeight, fontWeight, italic, unknown };
  }

  const paletteCount = r.u32();
  if (paletteCount > 256) throw new AcsFormatError(`palette has ${paletteCount} entries (max 256)`);
  const palette = [];
  for (let i = 0; i < paletteCount; i++) palette.push(r.rgbQuad());

  let trayIcon: AcsTrayIcon | null = null;
  if (r.bool()) {
    const monoSize = r.u32();
    const monoBitmap = r.bytesView(monoSize);
    const colorSize = r.u32();
    const colorBitmap = r.bytesView(colorSize);
    let rgba: RgbaImage | null = null;
    try {
      rgba = decodeIcon(monoBitmap, colorBitmap);
    } catch {
      rgba = null;
    }
    trayIcon = { monoBitmap, colorBitmap, rgba };
  }

  const states: Record<string, string[]> = {};
  const stateCount = r.u16();
  for (let i = 0; i < stateCount; i++) {
    const name = r.string();
    const n = r.u16();
    const anims: string[] = [];
    for (let j = 0; j < n; j++) anims.push(r.string());
    states[name] = anims;
  }

  return {
    minorVersion,
    majorVersion,
    localizedInfoLocator,
    guid,
    width,
    height,
    transparentIndex,
    flags,
    animationSetMajorVersion,
    animationSetMinorVersion,
    voice,
    balloon,
    palette,
    trayIcon,
    states,
  };
}

function parseLocalizedInfo(r: BinaryReader): AcsLocalizedInfo[] {
  const count = r.u16();
  const out: AcsLocalizedInfo[] = [];
  for (let i = 0; i < count; i++) {
    const languageId = r.u16();
    const name = r.string();
    const description = r.string();
    const extraData = r.string();
    out.push({ languageId, name, description, extraData });
  }
  return out;
}

function parseAnimationList(r: BinaryReader, budget: ParseBudget): AcsAnimation[] {
  const count = r.u32();
  if (count > ACS_LIMITS.maxAnimations) {
    throw new AcsFormatError(`too many animations (${count}, max ${ACS_LIMITS.maxAnimations})`);
  }
  const entries: { name: string; loc: { offset: number; size: number } }[] = [];
  for (let i = 0; i < count; i++) {
    const name = r.string();
    const loc = r.locator();
    entries.push({ name, loc });
  }
  // Entries sharing a locator are parsed once. Sharing the frames is safe:
  // nothing mutates them after parsing.
  const byOffset = new Map<number, AcsAnimation>();
  return entries.map(({ name, loc }) => {
    let base = byOffset.get(loc.offset);
    if (!base) {
      base = parseAnimation(r.seek(loc.offset), budget);
      byOffset.set(loc.offset, base);
    }
    const anim: AcsAnimation = { ...base };
    if (anim.name !== name && anim.name.toLowerCase() !== name.toLowerCase()) {
      // The list name is authoritative for lookup; keep the struct name otherwise.
      anim.name = name;
    }
    return anim;
  });
}

function parseAnimation(r: BinaryReader, budget: ParseBudget): AcsAnimation {
  const name = r.string();
  const tt = r.u8();
  const transitionType: AcsTransitionType = tt === 0 || tt === 1 || tt === 2 ? tt : 2;
  const returnAnimation = r.string();
  const frameCount = r.u16();
  spend(budget, 'frames', frameCount, ACS_LIMITS.maxTotalFrames, 'animation frames');
  const frames: AcsFrame[] = [];
  for (let f = 0; f < frameCount; f++) frames.push(parseFrame(r, budget));
  return { name, transitionType, returnAnimation, frames };
}

function parseFrame(r: BinaryReader, budget: ParseBudget): AcsFrame {
  const imageCount = r.u16();
  spend(budget, 'items', imageCount, ACS_LIMITS.maxTotalFrameItems, 'frame elements');
  const images: AcsFrameImage[] = [];
  for (let i = 0; i < imageCount; i++) {
    const imageIndex = r.u32();
    const x = r.i16();
    const y = r.i16();
    images.push({ imageIndex, x, y });
  }
  const audioRaw = r.u16();
  const audioIndex = audioRaw === 0xffff ? -1 : audioRaw;
  const duration = r.u16();
  const exitFrameIndex = r.i16();
  const branchCount = r.u8();
  spend(budget, 'items', branchCount, ACS_LIMITS.maxTotalFrameItems, 'frame elements');
  const branches: AcsBranch[] = [];
  for (let i = 0; i < branchCount; i++) {
    const frameIndex = r.u16();
    const probability = r.u16();
    branches.push({ frameIndex, probability });
  }
  const overlayCount = r.u8();
  spend(budget, 'items', overlayCount, ACS_LIMITS.maxTotalFrameItems, 'frame elements');
  const overlays: AcsOverlay[] = [];
  for (let i = 0; i < overlayCount; i++) {
    const type = r.u8() as MouthType;
    const replace = r.bool();
    const imageIndex = r.u16();
    const unknown = r.u8();
    const hasRegion = r.bool();
    const x = r.i16();
    const y = r.i16();
    const width = r.u16();
    const height = r.u16();
    let regionData: Uint8Array | null = null;
    if (hasRegion) {
      const size = r.u32();
      regionData = r.bytesView(size);
    }
    overlays.push({ type, replace, imageIndex, unknown, x, y, width, height, regionData });
  }
  return { images, audioIndex, duration, exitFrameIndex, branches, overlays };
}

function parseImageList(r: BinaryReader, budget: ParseBudget): AcsImage[] {
  const count = r.u32();
  if (count > ACS_LIMITS.maxImages) {
    throw new AcsFormatError(`too many images (${count}, max ${ACS_LIMITS.maxImages})`);
  }
  const entries: { loc: { offset: number; size: number }; checksum: number }[] = [];
  for (let i = 0; i < count; i++) entries.push({ loc: r.locator(), checksum: r.u32() });
  // Entries sharing a locator are read (and their region decompressed) once.
  const byOffset = new Map<number, AcsImage>();
  return entries.map(({ loc, checksum }) => {
    const cached = byOffset.get(loc.offset);
    if (cached) return { ...cached, checksum };
    r.seek(loc.offset);
    const unknown = r.u8();
    const width = r.u16();
    const height = r.u16();
    const compressed = r.bool();
    const dataSize = r.u32();
    const data = r.bytesView(dataSize);
    // Region data: ULONG compressed size, ULONG uncompressed size, bytes.
    let regionData: Uint8Array | null = null;
    const end = loc.offset + loc.size;
    if (r.pos + 8 <= end) {
      const compSize = r.u32();
      const rawSize = r.u32();
      if (compSize > 0) {
        spend(budget, 'regionBytes', rawSize, ACS_LIMITS.maxTotalRegionBytes, 'region bytes');
        regionData = decompress(r.bytesView(compSize), rawSize);
      } else if (rawSize > 0) {
        regionData = r.bytesView(rawSize);
      }
    }
    const stride = (width + 3) & ~3;
    const image: AcsImage = { width, height, stride, compressed, unknown, data, regionData, checksum };
    byOffset.set(loc.offset, image);
    return image;
  });
}

function parseAudioList(r: BinaryReader): AcsAudio[] {
  const count = r.u32();
  const out: AcsAudio[] = [];
  const entries: { loc: { offset: number; size: number }; checksum: number }[] = [];
  for (let i = 0; i < count; i++) entries.push({ loc: r.locator(), checksum: r.u32() });
  for (const { loc, checksum } of entries) {
    r.seek(loc.offset);
    out.push({ data: r.bytesView(loc.size), checksum });
  }
  return out;
}

/** Decodes a Windows RGNDATA blob (RGNDATAHEADER + RECT[]). */
export function parseRegion(data: Uint8Array): AcsRegion {
  const r = new BinaryReader(data);
  const dwSize = r.u32();
  const iType = r.u32();
  const nCount = r.u32();
  r.u32(); // nRgnSize
  if (dwSize !== 32 || iType !== 1) throw new AcsFormatError(`unexpected RGNDATAHEADER (size ${dwSize}, type ${iType})`);
  const rect = (): AcsRect => ({ left: r.i32(), top: r.i32(), right: r.i32(), bottom: r.i32() });
  const bounds = rect();
  const rects: AcsRect[] = [];
  for (let i = 0; i < nCount; i++) rects.push(rect());
  return { bounds, rects };
}

/**
 * Decodes the tray icon (colour DIB + monochrome AND-mask DIB) to RGBA.
 * Supports 1/4/8/24/32 bpp colour bitmaps. The DIB heights may be doubled
 * (icon convention); the real height is inferred from the data size.
 */
function decodeIcon(mono: Uint8Array, color: Uint8Array): RgbaImage | null {
  const c = readDib(color);
  const m = readDib(mono);
  if (!c) return null;
  const { width, height } = c;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [rr, gg, bb] = c.pixel(x, y);
      const masked = m ? m.index(x, y) !== 0 : false; // AND mask bit 1 = transparent
      const o = (y * width + x) * 4;
      out[o] = rr;
      out[o + 1] = gg;
      out[o + 2] = bb;
      out[o + 3] = masked ? 0 : 255;
    }
  }
  return { width, height, data: out };
}

interface DibReader {
  width: number;
  height: number;
  index(x: number, y: number): number;
  pixel(x: number, y: number): [number, number, number];
}

function readDib(bytes: Uint8Array): DibReader | null {
  if (bytes.length < 40) return null;
  const r = new BinaryReader(bytes);
  const hdrSize = r.u32();
  const width = r.i32();
  let height = r.i32();
  r.u16(); // planes
  const bitCount = r.u16();
  const compression = r.u32();
  r.u32(); // sizeImage
  r.u32();
  r.u32();
  let clrUsed = r.u32();
  if (compression !== 0) return null;
  const topDown = height < 0;
  height = Math.abs(height);
  if (bitCount <= 8 && clrUsed === 0) clrUsed = 1 << bitCount;
  if (bitCount > 8) clrUsed = 0;
  r.seek(hdrSize);
  const pal: [number, number, number][] = [];
  for (let i = 0; i < clrUsed; i++) {
    const q = r.rgbQuad();
    pal.push([q.r, q.g, q.b]);
  }
  const bitsStart = r.pos;
  const stride = (((width * bitCount + 31) >>> 5) << 2) >>> 0;
  // Icon DIBs often declare height*2 (XOR + AND). Use as many rows as fit.
  const rowsAvail = Math.floor((bytes.length - bitsStart) / stride);
  if (height > rowsAvail && height / 2 <= rowsAvail) height = height / 2;
  if (height > rowsAvail) return null;
  const rowOff = (y: number) => bitsStart + (topDown ? y : height - 1 - y) * stride;
  const index = (x: number, y: number): number => {
    const o = rowOff(y);
    switch (bitCount) {
      case 1:
        return ((bytes[o + (x >> 3)] as number) >> (7 - (x & 7))) & 1;
      case 4:
        return ((bytes[o + (x >> 1)] as number) >> ((x & 1) === 0 ? 4 : 0)) & 0xf;
      case 8:
        return bytes[o + x] as number;
      default:
        return 0;
    }
  };
  const pixel = (x: number, y: number): [number, number, number] => {
    if (bitCount <= 8) return pal[index(x, y)] ?? [0, 0, 0];
    const bpp = bitCount >> 3;
    const o = rowOff(y) + x * bpp;
    return [bytes[o + 2] as number, bytes[o + 1] as number, bytes[o] as number];
  };
  return { width, height, index, pixel };
}
