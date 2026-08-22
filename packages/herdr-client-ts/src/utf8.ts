import { CorruptError } from "./errors.js";

/**
 * UTF-8 codec hand-rolled on `Uint8Array`.
 *
 * `TextEncoder`/`TextDecoder` are NOT used: this package must run unchanged on Hermes/React
 * Native, where their presence depends on the RN version and on which polyfills Expo installs.
 * The tests cross-check both directions against Node's `TextEncoder`/`TextDecoder`.
 */

const REPLACEMENT_CHARACTER = 0xfffd;
const MIN_CODE_POINT_BY_SIZE = [0, 0, 0x80, 0x800, 0x10000] as const;

/** Encodes a JS string to UTF-8. Lone surrogates become U+FFFD, matching `TextEncoder`. */
export function utf8Encode(text: string): Uint8Array {
  // 3 bytes per UTF-16 code unit is the worst case (a surrogate pair is 2 units -> 4 bytes).
  const out = new Uint8Array(text.length * 3);
  let n = 0;

  for (let i = 0; i < text.length; i += 1) {
    let codePoint = text.charCodeAt(i);

    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const low = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      } else {
        codePoint = REPLACEMENT_CHARACTER;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = REPLACEMENT_CHARACTER;
    }

    if (codePoint < 0x80) {
      out[n++] = codePoint;
    } else if (codePoint < 0x800) {
      out[n++] = 0xc0 | (codePoint >> 6);
      out[n++] = 0x80 | (codePoint & 0x3f);
    } else if (codePoint < 0x10000) {
      out[n++] = 0xe0 | (codePoint >> 12);
      out[n++] = 0x80 | ((codePoint >> 6) & 0x3f);
      out[n++] = 0x80 | (codePoint & 0x3f);
    } else {
      out[n++] = 0xf0 | (codePoint >> 18);
      out[n++] = 0x80 | ((codePoint >> 12) & 0x3f);
      out[n++] = 0x80 | ((codePoint >> 6) & 0x3f);
      out[n++] = 0x80 | (codePoint & 0x3f);
    }
  }

  return out.subarray(0, n);
}

/**
 * Decodes UTF-8 strictly: overlong forms, surrogate code points, out-of-range code points and
 * truncated sequences all throw {@link CorruptError} rather than yielding U+FFFD. A malformed
 * string inside a frame means the frame is not what we think it is.
 */
export function utf8Decode(bytes: Uint8Array): string {
  const units: number[] = [];
  let i = 0;

  while (i < bytes.length) {
    const first = bytes[i]!;
    let codePoint: number;
    let size: number;

    if (first < 0x80) {
      codePoint = first;
      size = 1;
    } else if ((first & 0xe0) === 0xc0) {
      codePoint = first & 0x1f;
      size = 2;
    } else if ((first & 0xf0) === 0xe0) {
      codePoint = first & 0x0f;
      size = 3;
    } else if ((first & 0xf8) === 0xf0) {
      codePoint = first & 0x07;
      size = 4;
    } else {
      throw new CorruptError(`invalid UTF-8 lead byte 0x${first.toString(16)} at offset ${i}`);
    }

    if (i + size > bytes.length) {
      throw new CorruptError(`truncated UTF-8 sequence at offset ${i}`);
    }

    for (let k = 1; k < size; k += 1) {
      const cont = bytes[i + k]!;
      if ((cont & 0xc0) !== 0x80) {
        throw new CorruptError(`invalid UTF-8 continuation byte at offset ${i + k}`);
      }
      codePoint = (codePoint << 6) | (cont & 0x3f);
    }

    if (codePoint < MIN_CODE_POINT_BY_SIZE[size]!) {
      throw new CorruptError(`overlong UTF-8 encoding at offset ${i}`);
    }
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new CorruptError(`UTF-8 encodes a surrogate code point at offset ${i}`);
    }
    if (codePoint > 0x10ffff) {
      throw new CorruptError(`UTF-8 code point out of range at offset ${i}`);
    }

    if (codePoint < 0x10000) {
      units.push(codePoint);
    } else {
      const shifted = codePoint - 0x10000;
      units.push(0xd800 + (shifted >> 10), 0xdc00 + (shifted & 0x3ff));
    }

    i += size;
  }

  // Chunked so a large string does not blow the argument limit of `apply`.
  let out = "";
  for (let start = 0; start < units.length; start += 2048) {
    out += String.fromCharCode(...units.slice(start, start + 2048));
  }
  return out;
}
