import { describe, expect, it } from "vitest";
import { CorruptError, utf8Decode, utf8Encode } from "../src/index.js";
import { fromHex } from "./helpers.js";

/**
 * The codec hand-rolls UTF-8 so it does not depend on `TextEncoder`/`TextDecoder` being present on
 * Hermes. Node's implementations are used HERE ONLY, as an independent oracle.
 */
const nodeEncoder = new TextEncoder();
const nodeDecoder = new TextDecoder("utf-8", { fatal: true });

describe("utf8", () => {
  const samples = [
    "",
    "ok",
    "client version 19 is older than server version 20",
    "거부: 한글 ✅", // 거부: 한글 ✅
    "emoji \u{1F468}‍\u{1F469}‍\u{1F467} and math ∑",
    "߿ࠀ￿", // every UTF-8 length boundary
    "\u{1D518}\u{1D52B}\u{1D526}", // 4-byte sequences
  ];

  it("encodes identically to TextEncoder", () => {
    for (const sample of samples) {
      expect(Array.from(utf8Encode(sample)), sample).toEqual(Array.from(nodeEncoder.encode(sample)));
    }
  });

  it("decodes identically to TextDecoder", () => {
    for (const sample of samples) {
      const bytes = nodeEncoder.encode(sample);
      expect(utf8Decode(bytes), sample).toBe(nodeDecoder.decode(bytes));
      expect(utf8Decode(utf8Encode(sample)), sample).toBe(sample);
    }
  });

  it("replaces lone surrogates the way TextEncoder does", () => {
    const lone = "a\uD800b";
    expect(Array.from(utf8Encode(lone))).toEqual(Array.from(nodeEncoder.encode(lone)));
  });

  it("rejects malformed sequences rather than yielding U+FFFD", () => {
    const malformed = [
      "ff", // invalid lead byte
      "c0af", // overlong '/'
      "e08080", // overlong NUL
      "eda080", // surrogate D800
      "f5808080", // beyond U+10FFFF
      "e282", // truncated 3-byte sequence
      "c3", // truncated 2-byte sequence
      "80", // stray continuation byte
    ];
    for (const hex of malformed) {
      expect(() => utf8Decode(fromHex(hex)), hex).toThrow(CorruptError);
    }
  });

  it("handles a string longer than the fromCharCode chunk size", () => {
    const long = "가".repeat(5000);
    expect(utf8Decode(utf8Encode(long))).toBe(long);
  });
});
