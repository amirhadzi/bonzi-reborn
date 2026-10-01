/**
 * Microsoft Agent ACS character file support (pure TypeScript, no Node/DOM deps).
 *
 *   const ch = parseAcs(bytes);
 *   const frame = composeFrame(ch, 'Greet', 0);          // { width, height, data: RGBA }
 *   const talking = composeFrame(ch, 'RestPose', 0, { mouth: MOUTH.WIDE2 });
 */

export * from './types.ts';
export { BinaryReader, AcsFormatError } from './binary-reader.ts';
export { decompress, compress, DecompressError } from './decompress.ts';
export { parseAcs, parseRegion, ACS_SIGNATURE, ACS_LIMITS } from './parse.ts';
export {
  decodeImage,
  clearImageCache,
  paletteToRgba,
  blitImage,
  imageToRgba,
  getAnimation,
  composeFrame,
  composeFrameData,
  animationDurationMs,
} from './render.ts';
export {
  pickNextFrame,
  exitNextFrame,
  exitPath,
  isEndMarker,
  canEndNaturally,
  hasLoop,
  getReturnAnimation,
  animationsForState,
} from './playback.ts';
