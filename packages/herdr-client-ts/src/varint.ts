import { CorruptError, FieldRangeError, IncompleteError } from "./errors.js";

/**
 * bincode v2 "standard config" variable-length integer encoding, unsigned only.
 *
 * Layout (little-endian throughout), keyed on the *magnitude* of the value, not on its declared
 * Rust type — a `u64` holding 7 occupies one byte:
 *
 *   value < 251        -> [value]
 *   value <= u16::MAX  -> [251, u16 LE]
 *   value <= u32::MAX  -> [252, u32 LE]
 *   value <= u64::MAX  -> [253, u64 LE]
 *   value <= u128::MAX -> [254, u128 LE]
 *
 * Cross-checked byte-for-byte against `bincode::serde::encode_to_vec(.., config::standard())`
 * (see `tools/gen-vectors.rs`) and against the Rust integration harness's hand-rolled subset in
 * `tests/support/mod.rs` (`encode_varint_u32` / `encode_varint_u16` / `decode_varint_u32`).
 *
 * Signed integers (zigzag) are not implemented: no field this codec touches is signed.
 */

export const VARINT_U16_MARKER = 251;
export const VARINT_U32_MARKER = 252;
export const VARINT_U64_MARKER = 253;
export const VARINT_U128_MARKER = 254;

const U16_MAX = 0xffffn;
const U32_MAX = 0xffffffffn;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

function toBigInt(value: number | bigint): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (!Number.isInteger(value)) {
    return (() => {
      throw new FieldRangeError(`varint value must be an integer, got ${value}`);
    })();
  }
  return BigInt(value);
}

/** Number of bytes {@link encodeVarint} will emit for `value`. */
export function varintSize(value: number | bigint): number {
  const v = toBigInt(value);
  if (v < 0n) {
    throw new FieldRangeError(`varint value must be non-negative, got ${v}`);
  }
  if (v < 251n) return 1;
  if (v <= U16_MAX) return 3;
  if (v <= U32_MAX) return 5;
  if (v <= U64_MAX) return 9;
  if (v <= U128_MAX) return 17;
  throw new FieldRangeError(`varint value ${v} exceeds u128::MAX`);
}

/** Writes `value` into `target` at `offset`, returning the number of bytes written. */
export function encodeVarintInto(target: Uint8Array, offset: number, value: number | bigint): number {
  const v = toBigInt(value);
  const size = varintSize(v);

  if (size === 1) {
    target[offset] = Number(v);
    return 1;
  }

  const payloadBytes = size - 1;
  target[offset] =
    payloadBytes === 2
      ? VARINT_U16_MARKER
      : payloadBytes === 4
        ? VARINT_U32_MARKER
        : payloadBytes === 8
          ? VARINT_U64_MARKER
          : VARINT_U128_MARKER;

  let rest = v;
  for (let i = 0; i < payloadBytes; i += 1) {
    target[offset + 1 + i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return size;
}

export function encodeVarint(value: number | bigint): Uint8Array {
  const out = new Uint8Array(varintSize(value));
  encodeVarintInto(out, 0, value);
  return out;
}

export interface DecodedVarint {
  value: bigint;
  /** Bytes consumed, including the marker. */
  size: number;
}

/**
 * Reads one varint at `offset`.
 *
 * Throws {@link IncompleteError} when the buffer ends inside the value (the caller decides whether
 * that means "wait for more socket bytes" or "this frame is corrupt") and {@link CorruptError} for
 * a marker bincode never emits.
 */
export function decodeVarint(bytes: Uint8Array, offset = 0): DecodedVarint {
  if (offset >= bytes.length) {
    throw new IncompleteError(`varint at offset ${offset}: buffer is exhausted`, 1);
  }

  const marker = bytes[offset]!;
  if (marker < VARINT_U16_MARKER) {
    return { value: BigInt(marker), size: 1 };
  }

  let payloadBytes: number;
  switch (marker) {
    case VARINT_U16_MARKER:
      payloadBytes = 2;
      break;
    case VARINT_U32_MARKER:
      payloadBytes = 4;
      break;
    case VARINT_U64_MARKER:
      payloadBytes = 8;
      break;
    case VARINT_U128_MARKER:
      payloadBytes = 16;
      break;
    default:
      throw new CorruptError(
        `varint at offset ${offset}: marker 0x${marker.toString(16)} is not a bincode varint marker`,
      );
  }

  const available = bytes.length - offset - 1;
  if (available < payloadBytes) {
    throw new IncompleteError(
      `varint at offset ${offset}: need ${payloadBytes} bytes after marker, have ${available}`,
      payloadBytes - available,
    );
  }

  let value = 0n;
  for (let i = payloadBytes - 1; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + 1 + i]!);
  }
  return { value, size: payloadBytes + 1 };
}
