/**
 * Little-endian cursor over a byte buffer, with the ACS primitive types.
 * Pure TypeScript (DataView only); safe in Node and in a sandboxed renderer.
 */

import type { AcsColor, AcsLocator } from './types.ts';

export class AcsFormatError extends Error {
  override name = 'AcsFormatError';
}

export class BinaryReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  pos: number;

  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = pos;
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  private need(n: number): void {
    if (this.pos < 0 || this.pos + n > this.bytes.byteLength) {
      throw new AcsFormatError(
        `read of ${n} byte(s) at offset ${this.pos} is past end of buffer (${this.bytes.byteLength})`,
      );
    }
  }

  seek(pos: number): this {
    if (pos < 0 || pos > this.bytes.byteLength) {
      throw new AcsFormatError(`seek to ${pos} outside buffer (${this.bytes.byteLength})`);
    }
    this.pos = pos;
    return this;
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** Returns a view (no copy) of the next n bytes. */
  bytesView(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  locator(): AcsLocator {
    const offset = this.u32();
    const size = this.u32();
    return { offset, size };
  }

  /** Windows GUID, formatted in registry form. */
  guid(): string {
    const d1 = this.u32();
    const d2 = this.u16();
    const d3 = this.u16();
    const d4 = this.bytesView(8);
    const hex = (v: number, w: number) => v.toString(16).toUpperCase().padStart(w, '0');
    const tail = Array.from(d4, (b) => hex(b, 2));
    return `{${hex(d1, 8)}-${hex(d2, 4)}-${hex(d3, 4)}-${tail.slice(0, 2).join('')}-${tail.slice(2).join('')}}`;
  }

  /** RGBQUAD: stored B, G, R, reserved. */
  rgbQuad(): AcsColor {
    const b = this.u8();
    const g = this.u8();
    const r = this.u8();
    this.u8();
    return { r, g, b };
  }

  /** Windows COLORREF (0x00BBGGRR little-endian): bytes R, G, B, 0. Used by balloon colors. */
  colorRef(): AcsColor {
    const r = this.u8();
    const g = this.u8();
    const b = this.u8();
    this.u8();
    return { r, g, b };
  }

  /**
   * ACS STRING: ULONG character count, then (count + 1) UTF-16LE code units
   * including a null terminator. When count is 0 there is no terminator.
   */
  string(): string {
    const count = this.u32();
    if (count === 0) return '';
    if (count > 0x100000) throw new AcsFormatError(`implausible string length ${count} at ${this.pos - 4}`);
    this.need((count + 1) * 2);
    let s = '';
    for (let i = 0; i < count; i++) {
      s += String.fromCharCode(this.view.getUint16(this.pos + i * 2, true));
    }
    this.pos += (count + 1) * 2;
    return s;
  }
}
