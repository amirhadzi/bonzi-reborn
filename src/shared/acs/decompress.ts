/**
 * Microsoft Agent compression (used for image pixels and region data).
 *
 * Format, as verified against Bonzi.acs:
 *  - byte 0 is always 0x00;
 *  - the rest is a bit stream read LSB-first within each byte;
 *  - loop:
 *      bit 0 -> literal: the next 8 bits are one output byte;
 *      bit 1 -> back-reference:
 *          length = 2
 *          offset prefix: '0' -> 6 bits + 1
 *                         '10' -> 9 bits + 65
 *                         '110' -> 12 bits + 577
 *                         '111' -> 20 bits; 0xFFFFF = end of stream; else + 4673 and length++
 *          length suffix: count consecutive 1 bits (terminated by a 0 bit, at most 11 ones);
 *                         if count > 0, length += (1 << count) - 1 + next `count` bits
 *          copy `length` bytes one at a time from (out - offset) (overlap allowed).
 */

export class DecompressError extends Error {
  override name = 'DecompressError';
}

/** Upper bound on output bytes per compressed input byte (8 bits x 4096/31, rounded up). */
const MAX_EXPANSION = 1100;

/**
 * Decompresses an MS Agent compressed block.
 *
 * @param src compressed bytes
 * @param expectedSize when given, the output buffer is preallocated to this
 *   size and writing past it is an error. When omitted the buffer grows.
 * @returns the decompressed bytes (exactly the number of bytes produced).
 */
export function decompress(src: Uint8Array, expectedSize?: number): Uint8Array {
  if (src.length === 0) throw new DecompressError('empty compressed stream');
  if (src[0] !== 0) throw new DecompressError(`compressed stream must start with 0x00, got 0x${(src[0] ?? 0).toString(16)}`);
  // The best case is a 31-bit back-reference producing 4096 bytes (about 133
  // bytes per input bit), so a claimed size above this bound comes from a
  // corrupt header. Checking it first avoids a multi-GB preallocation.
  if (expectedSize !== undefined && (!Number.isInteger(expectedSize) || expectedSize < 0 || expectedSize > src.length * MAX_EXPANSION)) {
    throw new DecompressError(`expected size ${expectedSize} is impossible for ${src.length} compressed bytes`);
  }

  let out = new Uint8Array(expectedSize ?? Math.max(64, src.length * 4));
  const fixed = expectedSize !== undefined;
  let outPos = 0;

  // Bit reader state. Start after the leading 0x00 byte.
  let bytePos = 1;
  let bitBuf = 0; // pending bits, LSB first
  let bitCount = 0;
  const srcLen = src.length;

  const readBits = (n: number): number => {
    // n <= 20; JS bit ops are 32-bit, keep the buffer <= 31 bits.
    while (bitCount < n) {
      if (bytePos >= srcLen) throw new DecompressError('unexpected end of compressed stream');
      bitBuf |= (src[bytePos++] as number) << bitCount;
      bitCount += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return v;
  };

  const ensure = (extra: number): void => {
    if (outPos + extra <= out.length) return;
    if (fixed) throw new DecompressError(`decompressed data exceeds expected size ${expectedSize}`);
    let cap = out.length * 2;
    while (cap < outPos + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(out.subarray(0, outPos));
    out = next;
  };

  for (;;) {
    if (readBits(1) === 0) {
      ensure(1);
      out[outPos++] = readBits(8);
      continue;
    }

    let length = 2;
    let offset: number;
    if (readBits(1) === 0) {
      offset = readBits(6) + 1;
    } else if (readBits(1) === 0) {
      offset = readBits(9) + 65;
    } else if (readBits(1) === 0) {
      offset = readBits(12) + 577;
    } else {
      const raw = readBits(20);
      if (raw === 0xfffff) break; // end of stream
      offset = raw + 4673;
      length++;
    }

    let ones = 0;
    while (readBits(1) === 1) {
      ones++;
      if (ones > 11) throw new DecompressError('length prefix too long (corrupt stream)');
    }
    if (ones > 0) length += (1 << ones) - 1 + readBits(ones);

    if (offset > outPos) {
      throw new DecompressError(`back-reference offset ${offset} before start of output (pos ${outPos})`);
    }
    ensure(length);
    let from = outPos - offset;
    for (let i = 0; i < length; i++) out[outPos++] = out[from++] as number;
  }

  if (fixed && outPos !== expectedSize) {
    throw new DecompressError(`decompressed ${outPos} bytes, expected ${expectedSize}`);
  }
  return outPos === out.length ? out : out.slice(0, outPos);
}

/**
 * Encodes bytes into a valid MS Agent compressed stream. Produces literal
 * runs plus simple back-references (greedy, small window). Intended for tests
 * and tooling, not for size.
 */
export function compress(data: Uint8Array): Uint8Array {
  const bits: number[] = [];
  const put = (value: number, n: number) => {
    for (let i = 0; i < n; i++) bits.push((value >>> i) & 1);
  };
  let i = 0;
  while (i < data.length) {
    // look for a run match within the last 4672 bytes (offset classes 1..3)
    let bestLen = 0;
    let bestOff = 0;
    const maxOff = Math.min(i, 4672);
    for (let off = 1; off <= maxOff; off++) {
      let l = 0;
      while (i + l < data.length && l < 4096 && data[i + l] === data[i - off + l]) l++;
      if (l > bestLen) {
        bestLen = l;
        bestOff = off;
      }
    }
    if (bestLen >= 2) {
      put(1, 1);
      if (bestOff <= 64) {
        put(0, 1);
        put(bestOff - 1, 6);
      } else if (bestOff <= 576) {
        put(1, 1);
        put(0, 1);
        put(bestOff - 65, 9);
      } else {
        put(1, 1);
        put(1, 1);
        put(0, 1);
        put(bestOff - 577, 12);
      }
      // encode length: extra = bestLen - 2 = (1<<k) - 1 + v, 0 <= v < (1<<k)
      const extra = bestLen - 2;
      let k = 0;
      while ((1 << (k + 1)) - 1 <= extra) k++;
      if (k > 11) k = 11;
      let v = extra - ((1 << k) - 1);
      let len = bestLen;
      if (v >= 1 << k) {
        // clamp the match to what 11 bits can describe
        v = (1 << k) - 1;
        len = 2 + (1 << k) - 1 + v;
      }
      put((1 << k) - 1, k); // k ones
      put(0, 1);
      if (k > 0) put(v, k);
      i += len;
    } else {
      put(0, 1);
      put(data[i] as number, 8);
      i++;
    }
  }
  // end of stream marker: 1, 111, 20 x 1
  put(1, 1);
  put(0b111, 3);
  put(0xfffff, 20);
  const out = new Uint8Array(1 + Math.ceil(bits.length / 8));
  for (let b = 0; b < bits.length; b++) {
    if (bits[b]) out[1 + (b >> 3)]! |= 1 << (b & 7);
  }
  return out;
}
