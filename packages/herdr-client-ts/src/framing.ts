import { DEFAULT_MAX_FRAME_SIZE, LENGTH_PREFIX_BYTES } from "./constants.js";
import { OversizedFrameError, type WireError } from "./errors.js";

const EMPTY = new Uint8Array(0);

/** Wraps a bincode payload in the wire envelope: `[u32 LE length][payload]`. */
export function frameMessage(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(LENGTH_PREFIX_BYTES + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, true);
  out.set(payload, LENGTH_PREFIX_BYTES);
  return out;
}

export interface FrameReaderOptions {
  /** Maximum payload length accepted for one frame. Defaults to {@link DEFAULT_MAX_FRAME_SIZE}. */
  maxFrameSize?: number;
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
 */
export class FrameReader {
  private readonly maxFrameSize: number;
  private pending: Uint8Array = EMPTY;
  private poison: WireError | null = null;

  constructor(options: FrameReaderOptions = {}) {
    this.maxFrameSize = options.maxFrameSize ?? DEFAULT_MAX_FRAME_SIZE;
  }

  /** Bytes held back because they do not yet form a complete frame. */
  get bufferedBytes(): number {
    return this.pending.length;
  }

  /** True when the stream ended mid-frame (a truncated frame is "incomplete", never "corrupt"). */
  get hasPartialFrame(): boolean {
    return this.pending.length > 0;
  }

  reset(): void {
    this.pending = EMPTY;
    this.poison = null;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.poison !== null) {
      throw this.poison;
    }
    if (chunk.length > 0) {
      const merged = new Uint8Array(this.pending.length + chunk.length);
      merged.set(this.pending, 0);
      merged.set(chunk, this.pending.length);
      this.pending = merged;
    }

    const frames: Uint8Array[] = [];
    let consumed = 0;

    for (;;) {
      const available = this.pending.length - consumed;
      if (available < LENGTH_PREFIX_BYTES) break;

      const view = new DataView(
        this.pending.buffer,
        this.pending.byteOffset + consumed,
        LENGTH_PREFIX_BYTES,
      );
      const claimed = view.getUint32(0, true);

      if (claimed > this.maxFrameSize) {
        this.pending = this.pending.slice(consumed);
        const error = new OversizedFrameError(claimed, this.maxFrameSize);
        error.decodedBefore = frames;
        this.poison = error;
        throw error;
      }

      if (available - LENGTH_PREFIX_BYTES < claimed) break;

      const start = consumed + LENGTH_PREFIX_BYTES;
      frames.push(this.pending.slice(start, start + claimed));
      consumed = start + claimed;
    }

    if (consumed > 0) {
      this.pending = consumed === this.pending.length ? EMPTY : this.pending.slice(consumed);
    }
    return frames;
  }
}
