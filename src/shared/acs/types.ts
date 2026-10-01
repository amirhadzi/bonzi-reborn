/**
 * Public types for the Microsoft Agent ACS character file parser.
 *
 * Everything here is plain data (no classes) so a parsed character can be
 * inspected, serialised (except for the Uint8Array payloads) and passed around
 * freely. Pixel data stays compressed until it is requested through
 * `decodeImage()`, which caches the result on the character.
 */

/** Offset/size pair pointing at a block inside the ACS file. */
export interface AcsLocator {
  offset: number;
  size: number;
}

/** An RGB colour. `RGBQUAD` in the file is stored as B, G, R, reserved. */
export interface AcsColor {
  r: number;
  g: number;
  b: number;
}

/** Character-level flag bits (ACSCHARACTERINFO.flags). */
export const ACS_FLAGS = {
  /** Voice output is disabled. */
  VOICE_DISABLED: 0x00000010,
  /** Voice output is enabled; a VOICEINFO block follows. */
  VOICE_ENABLED: 0x00000020,
  /** Word balloon is disabled. */
  BALLOON_DISABLED: 0x00000100,
  /** Word balloon is enabled; a BALLOONINFO block follows. */
  BALLOON_ENABLED: 0x00000200,
  /** Balloon sizes itself to the text. */
  BALLOON_SIZE_TO_TEXT: 0x00010000,
  /** Balloon does NOT auto-hide. */
  BALLOON_NO_AUTO_HIDE: 0x00020000,
  /** Balloon does NOT auto-pace the text. */
  BALLOON_NO_AUTO_PACE: 0x00040000,
  /** Character supports the standard animation set. */
  STANDARD_ANIMATION_SET: 0x00100000,
} as const;

export interface AcsVoiceExtra {
  languageId: number;
  languageDialect: string;
  gender: number;
  age: number;
  style: string;
}

export interface AcsVoiceInfo {
  /** TTS engine CLSID, formatted as {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}. */
  ttsEngineId: string;
  /** TTS mode id GUID. */
  ttsModeId: string;
  /** Speaking speed (words per minute). */
  speed: number;
  /** Voice pitch (Hz). */
  pitch: number;
  extra: AcsVoiceExtra | null;
}

export interface AcsBalloonInfo {
  /** Number of text lines in the balloon. */
  lines: number;
  /** Characters per line. */
  charsPerLine: number;
  foreground: AcsColor;
  background: AcsColor;
  border: AcsColor;
  fontName: string;
  /** LOGFONT-style height (negative means character height in pixels). */
  fontHeight: number;
  fontWeight: number;
  italic: boolean;
  /** Unidentified trailing byte (kept for completeness). */
  unknown: number;
}

export interface AcsTrayIcon {
  /** Monochrome (AND mask) DIB, raw bytes. */
  monoBitmap: Uint8Array;
  /** Colour (XOR) DIB, raw bytes. */
  colorBitmap: Uint8Array;
  /** Decoded icon (colour bitmap with AND-mask transparency), or null if the DIB format is unsupported. */
  rgba: RgbaImage | null;
}

export interface AcsCharacterInfo {
  minorVersion: number;
  majorVersion: number;
  localizedInfoLocator: AcsLocator;
  /** Character GUID formatted as {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}. */
  guid: string;
  width: number;
  height: number;
  /** Palette index that is rendered transparent. */
  transparentIndex: number;
  /** Raw flag bits; see ACS_FLAGS. */
  flags: number;
  animationSetMajorVersion: number;
  animationSetMinorVersion: number;
  voice: AcsVoiceInfo | null;
  balloon: AcsBalloonInfo | null;
  /** 256 (or fewer) colours. */
  palette: AcsColor[];
  trayIcon: AcsTrayIcon | null;
  /** State name -> animation names, in file order. */
  states: Record<string, string[]>;
}

export interface AcsLocalizedInfo {
  languageId: number;
  name: string;
  description: string;
  extraData: string;
}

/** One image placed in a frame. */
export interface AcsFrameImage {
  imageIndex: number;
  x: number;
  y: number;
}

export interface AcsBranch {
  frameIndex: number;
  /** Probability in percent (0..100). */
  probability: number;
}

/** Mouth overlay types, as stored in OVERLAYINFO.type. */
export const MOUTH = {
  CLOSED: 0,
  WIDE1: 1,
  WIDE2: 2,
  WIDE3: 3,
  WIDE4: 4,
  MEDIUM: 5,
  NARROW: 6,
} as const;
export type MouthType = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const MOUTH_NAMES: readonly string[] = ['closed', 'wide1', 'wide2', 'wide3', 'wide4', 'medium', 'narrow'];

/** A rectangle (left/top inclusive, right/bottom exclusive). */
export interface AcsRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A decoded Windows RGNDATA blob. */
export interface AcsRegion {
  bounds: AcsRect;
  rects: AcsRect[];
}

export interface AcsOverlay {
  type: MouthType;
  /** When true the overlay replaces the frame's top-most image instead of being drawn on top of the whole frame. */
  replace: boolean;
  imageIndex: number;
  /** Unidentified byte between imageIndex and the region flag. */
  unknown: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Raw RGNDATA bytes when present. */
  regionData: Uint8Array | null;
}

export interface AcsFrame {
  images: AcsFrameImage[];
  /** Index into the audio list, or -1 when the frame has no sound (0xFFFF in the file). */
  audioIndex: number;
  /** Duration in 1/100 s. */
  duration: number;
  /**
   * Frame to jump to when exiting the animation. Raw value from the file:
   * any NEGATIVE value means "no exit branch" (continue with the next frame).
   * Both -1 and -2 occur in Bonzi.acs (-2 mostly on trailing end-marker frames).
   */
  exitFrameIndex: number;
  branches: AcsBranch[];
  overlays: AcsOverlay[];
}

/** 0 = use return animation, 1 = use exit branches, 2 = none. */
export type AcsTransitionType = 0 | 1 | 2;
export const TRANSITION = {
  RETURN_ANIMATION: 0,
  EXIT_BRANCHES: 1,
  NONE: 2,
} as const;

export interface AcsAnimation {
  name: string;
  transitionType: AcsTransitionType;
  /** Name of the return animation, or '' when none. */
  returnAnimation: string;
  frames: AcsFrame[];
}

export interface AcsImage {
  width: number;
  height: number;
  /** Bytes per row of the 8-bit DIB (width padded to a multiple of 4). */
  stride: number;
  compressed: boolean;
  /** Unidentified leading byte of IMAGEINFO. */
  unknown: number;
  /** Raw (possibly compressed) pixel data as stored in the file. */
  data: Uint8Array;
  /** Decompressed RGNDATA bytes, or null when the image has none. */
  regionData: Uint8Array | null;
  /** Checksum from the image list entry. */
  checksum: number;
}

export interface AcsAudio {
  /** Raw RIFF WAVE bytes. */
  data: Uint8Array;
  checksum: number;
}

export interface AcsHeader {
  signature: number;
  characterInfo: AcsLocator;
  animationInfo: AcsLocator;
  imageInfo: AcsLocator;
  audioInfo: AcsLocator;
}

export interface AcsCharacter {
  header: AcsHeader;
  info: AcsCharacterInfo;
  localized: AcsLocalizedInfo[];
  /** Animations in file order. */
  animations: AcsAnimation[];
  /** Case-insensitive lookup: lower-cased name -> animation. */
  animationsByName: Map<string, AcsAnimation>;
  images: AcsImage[];
  audio: AcsAudio[];
  /** Cache of decoded (decompressed) 8-bit pixel buffers, keyed by image index. */
  decodedCache: Map<number, Uint8Array>;
}

/** A straight RGBA image (non-premultiplied). */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface ComposeOptions {
  /**
   * Mouth overlay to apply (0..6), or null/undefined for none. When the frame
   * has no overlay of the requested type nothing extra is drawn.
   */
  mouth?: MouthType | null;
  /**
   * Draw order of the frame's image list. 'reverse' (default, empirically
   * correct for MS Agent) draws the LAST listed image first so the FIRST
   * listed image ends up on top. 'forward' is provided for debugging.
   */
  order?: 'reverse' | 'forward';
  /** Optional destination buffer to reuse (must be width*height*4). */
  target?: Uint8ClampedArray;
}
