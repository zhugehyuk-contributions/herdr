import { FrameReader, type FrameReaderOptions } from "./framing.js";
import { decodeServerMessage, type ServerMessage } from "./messages.js";
import type { WireError } from "./errors.js";

/**
 * {@link FrameReader} plus per-frame decoding: feed it socket chunks, get whole
 * {@link ServerMessage}s.
 *
 * A frame that fails to decode throws. The offending frame has already been consumed, so a caller
 * that chooses to continue stays in sync; messages decoded earlier in the same chunk are attached
 * to the error as `decodedBefore` so nothing is silently lost.
 */
export class ServerMessageReader {
  private readonly frames: FrameReader;

  constructor(options: FrameReaderOptions = {}) {
    this.frames = new FrameReader(options);
  }

  get bufferedBytes(): number {
    return this.frames.bufferedBytes;
  }

  get hasPartialFrame(): boolean {
    return this.frames.hasPartialFrame;
  }

  reset(): void {
    this.frames.reset();
  }

  push(chunk: Uint8Array): ServerMessage[] {
    const payloads = this.frames.push(chunk);
    const messages: ServerMessage[] = [];
    for (const payload of payloads) {
      try {
        messages.push(decodeServerMessage(payload));
      } catch (error) {
        (error as WireError).decodedBefore = messages;
        throw error;
      }
    }
    return messages;
  }
}
