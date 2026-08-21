import { DEFAULT_MAX_FRAME_SIZE, LENGTH_PREFIX_BYTES } from "./constants.js";
import { OversizedFrameError, type WireError } from "./errors.js";

/** Wraps a bincode payload in the wire envelope: `[u32 LE length][payload]`. */
export function frameMessage(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(LENGTH_PREFIX_BYTES + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, true);
  out.set(payload, LENGTH_PREFIX_BYTES);
  return out;
}

export interface FrameReaderOptions {
  /**
   * Maximum payload length accepted for one frame. Defaults to {@link DEFAULT_MAX_FRAME_SIZE}.
   *
   * Validated at construction: see {@link checkedMaxFrameSize} for why a `NaN` here is not a
   * cosmetic problem.
   */
  maxFrameSize?: number | undefined;
}

/**
 * A ceiling is only a ceiling if `claimed > maxFrameSize` can be true.
 *
 * `NaN` makes every comparison false, so an advertised cap silently becomes no cap at all: a
 * `0xffffffff` prefix is then accepted and the reader buffers for a 4 GiB frame that will never
 * arrive — an OOM reached without a single error, on a phone. `Infinity` has the same effect
 * deliberately, and a negative or fractional ceiling is a caller bug whose only symptom would be
 * frames rejected for reasons nobody can explain. All of them die here, at the call site, rather
 * than as a mystery megabytes later.
 */
function checkedMaxFrameSize(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_FRAME_SIZE;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `FrameReader maxFrameSize must be a non-negative safe integer, got ` +
        `${typeof value} ${String(value)}`,
    );
  }
  return value;
}

/**
 * Incremental de-framer.
 *
 * Sockets do not deliver frame boundaries: a chunk may carry half a length prefix, three frames,
 * or a frame's first byte. `push` returns only the payloads that are fully present and keeps the
 * remainder buffered for the next chunk.
 *
 * An oversized length prefix poisons the reader: the stream is desynchronized at that point and
 * there is no safe place to resume, so every later `push` rethrows until {@link FrameReader.reset}.
 *
 * ## Why the buffer is a list of chunks
 *
 * It used to be one `Uint8Array` rebuilt on every push — `new Uint8Array(pending + chunk)` plus a
 * full copy of everything held so far. For a frame assembled from `n` chunks that is Θ(S²/c): the
 * 32 MiB the default ceiling admits (a legal Kitty-graphics frame, `src/constants.ts:60-77`)
 * arriving in ~64 KiB ssh payloads costs *gigabytes* of memcpy for one frame, which on Hermes is a
 * GC stall or a watchdog kill rather than a slow frame.
 *
 * Chunks are therefore appended to a list and merged exactly once, when a whole payload is
 * present: every byte is copied twice (in, then out) no matter how it was split. Incoming chunks
 * are copied on the way in rather than retained, so a caller may reuse its receive buffer —
 * `test/framing.test.ts` measures the copy volume so this claim is checked, not asserted.
 */
export class FrameReader {
  private readonly maxFrameSize: number;
  /** Unconsumed chunks, oldest first, starting at {@link head}. Never contains an empty chunk. */
  private chunks: Uint8Array[] = [];
  /** Index of the first chunk still holding unconsumed bytes. */
  private head = 0;
  /** Bytes of `chunks[head]` already consumed. */
  private offset = 0;
  /** Unconsumed bytes across `chunks[head..]`, i.e. what `bufferedBytes` reports. */
  private buffered = 0;
  private poison: WireError | null = null;

  constructor(options: FrameReaderOptions = {}) {
    this.maxFrameSize = checkedMaxFrameSize(options.maxFrameSize);
  }

  /** Bytes held back because they do not yet form a complete frame. */
  get bufferedBytes(): number {
    return this.buffered;
  }

  /** True when the stream ended mid-frame (a truncated frame is "incomplete", never "corrupt"). */
  get hasPartialFrame(): boolean {
    return this.buffered > 0;
  }

  reset(): void {
    this.chunks = [];
    this.head = 0;
    this.offset = 0;
    this.buffered = 0;
    this.poison = null;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.poison !== null) {
      throw this.poison;
    }
    if (chunk.length > 0) {
      // Copied, not retained: the caller keeps ownership of its receive buffer. One copy per
      // byte, once — not once per later push, which is the whole point of the list.
      this.chunks.push(chunk.slice());
      this.buffered += chunk.length;
    }

    const frames: Uint8Array[] = [];

    for (;;) {
      if (this.buffered < LENGTH_PREFIX_BYTES) break;

      const claimed = this.peekLengthPrefix();

      if (claimed > this.maxFrameSize) {
        // The buffer is left starting at the bad prefix: the frames before it are already
        // consumed and handed back through `decodedBefore`.
        const error = new OversizedFrameError(claimed, this.maxFrameSize);
        error.decodedBefore = frames;
        this.poison = error;
        throw error;
      }

      if (this.buffered - LENGTH_PREFIX_BYTES < claimed) break;

      this.drop(LENGTH_PREFIX_BYTES);
      frames.push(this.take(claimed));
    }

    return frames;
  }

  /** Reads the length prefix without consuming it. Touches at most two chunks. */
  private peekLengthPrefix(): number {
    const first = this.chunks[this.head] as Uint8Array;
    if (first.length - this.offset >= LENGTH_PREFIX_BYTES) {
      return new DataView(
        first.buffer,
        first.byteOffset + this.offset,
        LENGTH_PREFIX_BYTES,
      ).getUint32(0, true);
    }
    const prefix = new Uint8Array(LENGTH_PREFIX_BYTES);
    this.copyInto(prefix, LENGTH_PREFIX_BYTES);
    return new DataView(prefix.buffer).getUint32(0, true);
  }

  /** Copies the first `count` buffered bytes into `out` without consuming them. */
  private copyInto(out: Uint8Array, count: number): void {
    let written = 0;
    let index = this.head;
    let skip = this.offset;
    while (written < count) {
      const chunk = this.chunks[index] as Uint8Array;
      const available = chunk.length - skip;
      const wanted = count - written;
      const step = available < wanted ? available : wanted;
      out.set(chunk.subarray(skip, skip + step), written);
      written += step;
      skip = 0;
      index += 1;
    }
  }

  /** Consumes the next `count` bytes and returns them as one fresh array. */
  private take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    if (count > 0) {
      this.copyInto(out, count);
      this.drop(count);
    }
    return out;
  }

  /** Consumes `count` bytes, releasing the chunks they came from. */
  private drop(count: number): void {
    this.buffered -= count;
    let remaining = count;
    while (remaining > 0) {
      const chunk = this.chunks[this.head] as Uint8Array;
      const available = chunk.length - this.offset;
      if (available > remaining) {
        this.offset += remaining;
        remaining = 0;
        break;
      }
      remaining -= available;
      this.head += 1;
      this.offset = 0;
    }

    if (this.buffered === 0) {
      this.chunks = [];
      this.head = 0;
      this.offset = 0;
    } else if (this.head > 32 && this.head * 2 >= this.chunks.length) {
      // Drop the dead prefix of the list so a long-lived reader does not grow an array of
      // released chunks. Amortized O(1) per chunk.
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }
}
