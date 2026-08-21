import { encodeVarintInto, varintSize } from "./varint.js";
import { utf8Encode } from "./utf8.js";

/** Growable little-endian byte sink for bincode payloads. */
export class ByteWriter {
  private buffer: Uint8Array;
  private length = 0;

  constructor(initialCapacity = 64) {
    this.buffer = new Uint8Array(initialCapacity);
  }

  private reserve(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.buffer.length) return;
    let capacity = Math.max(this.buffer.length * 2, 64);
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  writeU8(value: number): this {
    this.reserve(1);
    this.buffer[this.length] = value;
    this.length += 1;
    return this;
  }

  writeBool(value: boolean): this {
    return this.writeU8(value ? 1 : 0);
  }

  writeVarint(value: number | bigint): this {
    this.reserve(varintSize(value));
    this.length += encodeVarintInto(this.buffer, this.length, value);
    return this;
  }

  writeRawBytes(bytes: Uint8Array): this {
    this.reserve(bytes.length);
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
    return this;
  }

  /** bincode `Vec<u8>`: varint length then the bytes. */
  writeByteVec(bytes: Uint8Array): this {
    return this.writeVarint(bytes.length).writeRawBytes(bytes);
  }

  writeString(text: string): this {
    return this.writeByteVec(utf8Encode(text));
  }

  writeOption<T>(value: T | null | undefined, write: (writer: ByteWriter, value: T) => void): this {
    if (value === null || value === undefined) {
      return this.writeU8(0);
    }
    this.writeU8(1);
    write(this, value);
    return this;
  }

  toBytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}
