import { FrameReader, type FrameReaderOptions } from "./framing.js";
import { decodeServerMessage, type ServerMessage } from "./messages.js";
import type { WireError } from "./errors.js";

export interface ServerMessageReaderOptions extends FrameReaderOptions {
  /**
   * Called for each frame that could not be decoded, in arrival order, before `push` returns.
   *
   * Optional because it is diagnostics, not control flow: a reader without a handler still counts
   * its skips ({@link ServerMessageReader.undecodableCount}), so a dropped frame is never
   * unobservable.
   *
   * **It may throw and nothing breaks.** That is a guarantee, not an expectation: the call is
   * isolated, the rest of the chunk still decodes, and the failure is counted in
   * {@link ServerMessageReader.callbackFailureCount}. Without the isolation a `console.warn` a
   * bundler replaced, or a logger with a bad format string, would abort the decode loop — and
   * {@link FrameReader} has already consumed the whole batch, so every frame behind the skipped
   * one would be gone for good. That is the exact data loss "skip and continue" exists to
   * prevent, re-entering through the diagnostics door.
   */
  onUndecodable?: ((error: WireError) => void) | undefined;
}

/**
 * {@link FrameReader} plus per-frame decoding: feed it socket chunks, get whole
 * {@link ServerMessage}s.
 *
 * ## Why an undecodable frame costs exactly that frame
 *
 * A frame this codec does not decode is normal traffic, not a broken stream. `Notify`, `Clipboard`,
 * `WindowTitle`, `Pong` and friends all raise `UnsupportedVariantError` here
 * (`src/messages.ts:189-209`) and a real server sends them constantly. Aborting the chunk on the
 * first one threw away every frame *behind* it in that chunk — {@link FrameReader} had already
 * consumed them, so they were gone for good — and a `Notify` sharing a TCP segment with a
 * `Terminal` diff then left the ANSI screen wrong until the next full frame.
 *
 * A corrupt payload is skipped for the same reason: the length prefix already fixed the frame
 * boundary, so the frames behind it are exactly where they should be. Desynchronization comes from
 * a corrupt *prefix*, and that is {@link FrameReader}'s business — an `OversizedFrameError` still
 * poisons the stream and is still thrown, because there is no resync point after it.
 *
 * Skipping is never silent: a skipped frame reaches
 * {@link ServerMessageReaderOptions.onUndecodable} when one is supplied, and is counted in
 * {@link ServerMessageReader.undecodableCount} either way.
 *
 * ## What `push` throws
 *
 * Exactly one thing: the framing error from {@link FrameReader}. Nothing a caller's callback does
 * changes that — callbacks are isolated (see {@link ServerMessageReaderOptions.onUndecodable}).
 */
export class ServerMessageReader {
  private readonly frames: FrameReader;
  private readonly onUndecodable: ((error: WireError) => void) | undefined;
  private skipped = 0;
  private lastSkipped: WireError | undefined;
  private callbackFailures = 0;
  private lastCallbackError: unknown;
  /** Set once a framing error has poisoned {@link FrameReader}; rethrown verbatim after that. */
  private framingFailure: WireError | null = null;

  constructor(options: ServerMessageReaderOptions = {}) {
    this.frames = new FrameReader(options);
    this.onUndecodable = options.onUndecodable;
  }

  get bufferedBytes(): number {
    return this.frames.bufferedBytes;
  }

  get hasPartialFrame(): boolean {
    return this.frames.hasPartialFrame;
  }

  /** How many frames have been skipped since construction, or since the last {@link reset}. */
  get undecodableCount(): number {
    return this.skipped;
  }

  /** The most recent skipped frame's error, for a caller that polls instead of subscribing. */
  get lastUndecodable(): WireError | undefined {
    return this.lastSkipped;
  }

  /**
   * How many times {@link ServerMessageReaderOptions.onUndecodable} threw. Isolating the callback
   * must not mean hiding its failure: a logger that throws on every frame is a real defect, and a
   * counter at zero is what lets a caller prove it is not happening.
   */
  get callbackFailureCount(): number {
    return this.callbackFailures;
  }

  /** Whatever the callback threw most recently. `unknown`, because a throw can be anything. */
  get lastCallbackFailure(): unknown {
    return this.lastCallbackError;
  }

  /** Back to the construction state: buffer, poison and skip bookkeeping all cleared. */
  reset(): void {
    this.frames.reset();
    this.skipped = 0;
    this.lastSkipped = undefined;
    this.callbackFailures = 0;
    this.lastCallbackError = undefined;
    this.framingFailure = null;
  }

  push(chunk: Uint8Array): ServerMessage[] {
    if (this.framingFailure !== null) {
      // The salvage was attached on the first throw and stays attached: later pushes rethrow the
      // same object, so a caller that salvages on every throw must not salvage the same twice.
      throw this.framingFailure;
    }

    const messages: ServerMessage[] = [];
    let payloads: Uint8Array[];
    try {
      payloads = this.frames.push(chunk);
    } catch (error) {
      const wire = error as WireError;
      this.framingFailure = wire;
      // `FrameReader` hands back the payloads it de-framed before the bad prefix; decoding them
      // here is what makes `decodedBefore` hold messages, as its doc promises (`src/errors.ts:25`).
      this.decodeInto(messages, (wire.decodedBefore ?? []) as Uint8Array[]);
      wire.decodedBefore = messages;
      throw wire;
    }

    this.decodeInto(messages, payloads);
    return messages;
  }

  private decodeInto(messages: ServerMessage[], payloads: readonly Uint8Array[]): void {
    for (const payload of payloads) {
      let message: ServerMessage;
      try {
        message = decodeServerMessage(payload);
      } catch (error) {
        const wire = error as WireError;
        this.skipped += 1;
        this.lastSkipped = wire;
        this.notifyUndecodable(wire);
        continue;
      }
      messages.push(message);
    }
  }

  /** Diagnostics must never decide what happens to the frames behind them. */
  private notifyUndecodable(wire: WireError): void {
    if (this.onUndecodable === undefined) {
      return;
    }
    try {
      this.onUndecodable(wire);
    } catch (error) {
      this.callbackFailures += 1;
      this.lastCallbackError = error;
    }
  }
}
