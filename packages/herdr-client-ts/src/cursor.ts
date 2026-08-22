import { CorruptError, IncompleteError } from "./errors.js";
import { decodeVarint } from "./varint.js";
import { utf8Decode } from "./utf8.js";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Sequential reader over a bincode payload. All reads advance {@link ByteCursor.offset}. */
export class ByteCursor {
  readonly bytes: Uint8Array;
  offset: number;

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes;
    this.offset = offset;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  get atEnd(): boolean {
    return this.remaining <= 0;
  }

  private ensure(n: number, what: string): void {
    if (this.remaining < n) {
      throw new IncompleteError(
        `${what}: need ${n} bytes at offset ${this.offset}, have ${this.remaining}`,
        n - this.remaining,
      );
    }
  }

  readU8(): number {
    this.ensure(1, "u8");
    const value = this.bytes[this.offset]!;
    this.offset += 1;
    return value;
  }

  /** bincode writes `bool` as a single byte; anything but 0/1 is a corrupt frame. */
  readBool(): boolean {
    const raw = this.readU8();
    if (raw > 1) {
      throw new CorruptError(`bool at offset ${this.offset - 1} has value ${raw}, expected 0 or 1`);
    }
    return raw === 1;
  }

  readVarint(): bigint {
    const { value, size } = decodeVarint(this.bytes, this.offset);
    this.offset += size;
    return value;
  }

  /** Varint constrained to a JS `number`. `max` guards fields with a narrower Rust type. */
  readVarintAsNumber(what: string, max: number = Number.MAX_SAFE_INTEGER): number {
    const value = this.readVarint();
    if (value > MAX_SAFE || value > BigInt(max)) {
      throw new CorruptError(`${what} is ${value}, above its maximum of ${max}`);
    }
    return Number(value);
  }

  /** Copies out `length` bytes (a copy, not a view, so the frame buffer can be released). */
  readBytes(length: number): Uint8Array {
    this.ensure(length, "byte string");
    const out = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  /** bincode `Vec<u8>` / `String` body: varint length followed by raw bytes. */
  readByteVec(): Uint8Array {
    const length = this.readVarintAsNumber("byte-vector length");
    return this.readBytes(length);
  }

  readString(): string {
    return utf8Decode(this.readByteVec());
  }

  /** bincode `Option<T>`: one tag byte (0 = None, 1 = Some), then `T`. */
  readOption<T>(read: (cursor: ByteCursor) => T): T | null {
    const tag = this.readU8();
    if (tag === 0) return null;
    if (tag === 1) return read(this);
    throw new CorruptError(
      `Option tag at offset ${this.offset - 1} has value ${tag}, expected 0 or 1`,
    );
  }

  /**
   * Mirrors the Rust reader's `consumed != claimed_len` check (`src/protocol/wire.rs:1175`):
   * trailing bytes after a decoded message are a protocol violation, not padding.
   */
  assertConsumed(what: string): void {
    if (!this.atEnd) {
      throw new CorruptError(
        `${what}: decoded ${this.offset} bytes but the frame carries ${this.bytes.length}; ` +
          "trailing bytes are not allowed",
      );
    }
  }
}
