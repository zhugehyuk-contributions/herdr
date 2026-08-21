import { describe, expect, it } from "vitest";
import {
  CorruptError,
  FieldRangeError,
  IncompleteError,
  decodeVarint,
  encodeVarint,
  varintSize,
} from "../src/index.js";
import { fromHex, toHex } from "./helpers.js";
import { VARINT_U64_VECTORS } from "./vectors.js";

describe("varint", () => {
  it("matches bincode's bytes on every marker boundary", () => {
    for (const [value, hex] of VARINT_U64_VECTORS) {
      expect(toHex(encodeVarint(value)), `encode ${value}`).toBe(hex);
      expect(decodeVarint(fromHex(hex)).value, `decode ${hex}`).toBe(value);
      expect(decodeVarint(fromHex(hex)).size).toBe(hex.length / 2);
    }
  });

  it("round-trips the values that sit either side of each marker", () => {
    const boundaries = [
      0n,
      1n,
      249n,
      250n,
      251n,
      252n,
      65534n,
      65535n,
      65536n,
      65537n,
      4294967294n,
      4294967295n,
      4294967296n,
      4294967297n,
      18446744073709551615n,
      18446744073709551616n, // first value needing the u128 marker
      (1n << 128n) - 1n,
    ];
    for (const value of boundaries) {
      const encoded = encodeVarint(value);
      expect(encoded.length, `size of ${value}`).toBe(varintSize(value));
      const decoded = decodeVarint(encoded);
      expect(decoded.value, `round-trip ${value}`).toBe(value);
      expect(decoded.size).toBe(encoded.length);
    }
  });

  it("picks the marker by magnitude, not by declared width", () => {
    expect(toHex(encodeVarint(250))).toBe("fa"); // one byte
    expect(toHex(encodeVarint(251))).toBe("fbfb00"); // 251 marker + u16 LE
    expect(toHex(encodeVarint(65536))).toBe("fc00000100"); // 252 marker + u32 LE
    expect(varintSize(0n)).toBe(1);
    expect(varintSize(251)).toBe(3);
    expect(varintSize(65536)).toBe(5);
    expect(varintSize(4294967296n)).toBe(9);
    expect(varintSize(1n << 100n)).toBe(17);
  });

  it("accepts a number or a bigint for the same value", () => {
    expect(toHex(encodeVarint(65535))).toBe(toHex(encodeVarint(65535n)));
  });

  it("reads at an offset without copying", () => {
    const buffer = fromHex("ff" + "fbffff" + "ff");
    const decoded = decodeVarint(buffer, 1);
    expect(decoded.value).toBe(65535n);
    expect(decoded.size).toBe(3);
  });

  it("reports a truncated varint as incomplete, not corrupt", () => {
    for (const truncated of ["fb", "fbff", "fc0000", "fd00000000"]) {
      const error = (() => {
        try {
          decodeVarint(fromHex(truncated));
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error, truncated).toBeInstanceOf(IncompleteError);
      expect((error as IncompleteError).code).toBe("incomplete");
      expect((error as IncompleteError).needed).toBeGreaterThan(0);
    }
    expect(() => decodeVarint(new Uint8Array(0))).toThrow(IncompleteError);
  });

  it("rejects marker 255, which bincode never emits", () => {
    expect(() => decodeVarint(fromHex("ff00"))).toThrow(CorruptError);
  });

  it("refuses to encode negative or non-integer values", () => {
    expect(() => encodeVarint(-1)).toThrow(FieldRangeError);
    expect(() => encodeVarint(-1n)).toThrow(FieldRangeError);
    expect(() => encodeVarint(1.5)).toThrow(FieldRangeError);
    expect(() => encodeVarint(1n << 128n)).toThrow(FieldRangeError);
  });
});
