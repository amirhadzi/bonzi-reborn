// 16-bit PCM helpers for the SAPI bridge: trim silence and wrap in a RIFF/WAVE header.

/** Wraps 16-bit little-endian mono PCM in a canonical 44-byte WAV header. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number, channels = 1): Buffer {
  const dataLen = pcm.byteLength - (pcm.byteLength % 2);
  const out = Buffer.alloc(44 + dataLen);
  const blockAlign = channels * 2;
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + dataLen, 4);
  out.write('WAVE', 8, 'latin1');
  out.write('fmt ', 12, 'latin1');
  out.writeUInt32LE(16, 16); // fmt chunk size
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * blockAlign, 28);
  out.writeUInt16LE(blockAlign, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(dataLen, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, dataLen).copy(out, 44);
  return out;
}

export interface TrimOptions {
  /** Samples whose absolute value is at or below this count as silence. */
  threshold?: number;
  /** Silence kept before the first and after the last loud sample. */
  keepLeadMs?: number;
  keepTailMs?: number;
}

/**
 * Trims leading and trailing silence from 16-bit mono PCM, keeping a little
 * padding, so consecutive sentences follow each other without long gaps.
 * Returns the input unchanged when it is all silence.
 */
export function trimPcm16Silence(pcm: Uint8Array, sampleRate: number, o: TrimOptions = {}): Uint8Array {
  const threshold = o.threshold ?? 96;
  const n = Math.floor(pcm.byteLength / 2);
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (Math.abs(view.getInt16(i * 2, true)) > threshold) {
      first = i;
      break;
    }
  }
  if (first < 0) return pcm;
  let last = first;
  for (let i = n - 1; i > first; i--) {
    if (Math.abs(view.getInt16(i * 2, true)) > threshold) {
      last = i;
      break;
    }
  }
  const lead = Math.round(((o.keepLeadMs ?? 40) / 1000) * sampleRate);
  const tail = Math.round(((o.keepTailMs ?? 150) / 1000) * sampleRate);
  const start = Math.max(0, first - lead);
  const end = Math.min(n, last + 1 + tail);
  return pcm.subarray(start * 2, end * 2);
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Byte offset and length of the data chunk. */
  dataOffset: number;
  dataLength: number;
}

/** Parses a canonical PCM WAV header (used by tests and the sample script). Null when not a RIFF/WAVE file. */
export function parseWav(buf: Uint8Array): WavInfo | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.byteLength < 44 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  while (off + 8 <= b.byteLength) {
    const id = b.toString('latin1', off, off + 4);
    const len = b.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 24 <= b.byteLength) {
      fmt = { channels: b.readUInt16LE(off + 10), sampleRate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    } else if (id === 'data' && fmt) {
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, dataOffset: off + 8, dataLength: Math.min(len, b.byteLength - off - 8) };
    }
    off += 8 + len + (len % 2);
  }
  return null;
}

/** Peak absolute sample (0..1) and RMS (0..1) of 16-bit PCM. */
export function pcm16Levels(pcm: Uint8Array): { peak: number; rms: number } {
  const n = Math.floor(pcm.byteLength / 2);
  if (n === 0) return { peak: 0, rms: 0 };
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = view.getInt16(i * 2, true) / 32768;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / n) };
}
