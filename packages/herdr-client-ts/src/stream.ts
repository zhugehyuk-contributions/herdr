import { FrameReader, type FrameReaderOptions } from "./framing.js";
import { decodeServerMessage, type ServerMessage } from "./messages.js";
import { desynchronizesScreen, type WireError } from "./errors.js";

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

  /**
   * Withhold `Terminal` diffs (`full === false`) from {@link ServerMessageReader.push} while
   * {@link ServerMessageReader.screenDesynced} is set, resuming at the next `full === true` frame.
   *
   * **Off by default, and that default is the interesting part.** Dropping diffs is only half a
   * recovery: the other half is `ClientMessage::RequestFullFrame` (`src/messages.ts`), which this
   * class cannot send — it is pull-shaped and never sees the socket. With no request on the wire
   * the server has no reason to re-baseline, so a reader that silently swallowed diffs on its own
   * would turn a drifting screen into a permanently frozen one, which is worse and much harder to
   * diagnose. So the default is "report, do not decide" and a caller that owns the write end opts
   * in *together with* sending the request. {@link ServerMessageChannel} does own the write end
   * and therefore applies this policy unconditionally (`src/transport.ts`).
   */
  dropDiffsWhileDesynced?: boolean | undefined;
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
 * ## Why a skipped frame can still leave the SCREEN wrong
 *
 * All of the above is about the *wire*, and it is where the reasoning used to stop. `Terminal` is
 * a diff stream: `TerminalFrame.full` (`src/protocol/wire.rs:771-780`) is false for an incremental
 * frame, which is only correct against the baseline the frame before it left behind. Skip a
 * corrupt `Terminal` and hand the diffs behind it to a renderer, and the framing is flawless while
 * the cells are permanently wrong. {@link ServerMessageReader.screenDesynced} is that fact, made
 * observable; {@link ServerMessageReaderOptions.dropDiffsWhileDesynced} is the policy, made
 * opt-in, because the cure — sending `ClientMessage::RequestFullFrame` — is on a socket this class
 * does not hold.
 *
 * ## What `push` throws
 *
 * Exactly one thing: the framing error from {@link FrameReader}. Nothing a caller's callback does
 * changes that — callbacks are isolated (see {@link ServerMessageReaderOptions.onUndecodable}).
 */
export class ServerMessageReader {
  private readonly frames: FrameReader;
  private readonly onUndecodable: ((error: WireError) => void) | undefined;
  private readonly dropDiffsWhileDesynced: boolean;
  /** Set when a lost frame made the ANSI baseline unknowable; cleared by a `full` `Terminal`. */
  private desynced = false;
  private droppedDiffs = 0;
  private skipped = 0;
  private lastSkipped: WireError | undefined;
  private callbackFailures = 0;
  private lastCallbackError: unknown;
  /** Set once a framing error has poisoned {@link FrameReader}; rethrown verbatim after that. */
  private framingFailure: WireError | null = null;

  constructor(options: ServerMessageReaderOptions = {}) {
    this.frames = new FrameReader(options);
    this.onUndecodable = options.onUndecodable;
    this.dropDiffsWhileDesynced = options.dropDiffsWhileDesynced ?? false;
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

  /**
   * True from the moment a frame was lost in a way that could have been a `Terminal`, until a
   * `Terminal` with `full === true` re-establishes the baseline.
   *
   * The caller's cue to send `ClientMessage::RequestFullFrame` (`encodeRequestFullFrameFrame`,
   * `src/messages.ts`) on whatever socket it owns. Which failures count is
   * `desynchronizesScreen` (`src/errors.ts`) — the same predicate
   * {@link ServerMessageChannel} uses, so the two layers cannot disagree about what a desync is,
   * only about who fixes it.
   */
  get screenDesynced(): boolean {
    return this.desynced;
  }

  /**
   * How many `Terminal` diffs were withheld by
   * {@link ServerMessageReaderOptions.dropDiffsWhileDesynced}. Stays 0 when the option is off,
   * which is what proves the default really is "report, do not decide".
   */
  get droppedDiffCount(): number {
    return this.droppedDiffs;
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
    this.desynced = false;
    this.droppedDiffs = 0;
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
        if (desynchronizesScreen(wire)) {
          this.desynced = true;
        }
        this.notifyUndecodable(wire);
        continue;
      }
      if (message.type === "terminal") {
        if (message.full) {
          // A full redraw is self-contained, so it *is* the resynchronization point.
          this.desynced = false;
        } else if (this.desynced && this.dropDiffsWhileDesynced) {
          this.droppedDiffs += 1;
          continue;
        }
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
