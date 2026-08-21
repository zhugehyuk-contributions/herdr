import { RENDER_ENCODING_ORDER, type RenderEncoding } from "./constants.js";

export type WireErrorCode =
  /** The buffer ends before the value does. At the stream layer this means "feed me more". */
  | "incomplete"
  /** The bytes present are structurally wrong. More bytes will not help. */
  | "corrupt"
  /** A frame's declared length exceeds the configured ceiling; the stream cannot be resynced. */
  | "oversized"
  /** A well-formed frame whose variant this codec does not decode. */
  | "unsupported-variant"
  /** A value handed to the encoder does not fit its wire type. */
  | "range"
  /** `Welcome.error` was `Some(_)`: the server refused the handshake. */
  | "handshake-rejected"
  /** `Welcome.version` differs from the version we sent. */
  | "version-mismatch"
  /** `Welcome.encoding` is not the encoding we requested. */
  | "encoding-mismatch";

/**
 * Does losing this frame invalidate the **rendered screen**, as opposed to merely the frame?
 *
 * The single vocabulary both readers share, so their policies cannot drift apart — `stream.ts`
 * and `transport.ts` decide "did the ANSI baseline just become unknowable?" by calling this and
 * nothing else.
 *
 * - `unsupported-variant` -> **no**. `Notify`, `Compressed`, `Pong` and friends are routine traffic
 *   this codec deliberately does not decode (`src/constants.ts` SERVER_MESSAGE_VARIANT_NAMES).
 *   None of them carries terminal cells, so the baseline is untouched; treating them as a desync
 *   would fire a full-repaint request several times a second on a healthy connection.
 * - anything else (`corrupt`, and any future decode failure) -> **yes**. The frame might have been
 *   a `Terminal`, and `TerminalFrame.full` (`src/protocol/wire.rs:771-780`) says a `Terminal` may
 *   be a diff against the baseline the previous one left. Once one is lost the client cannot know
 *   which cells the server believes are on screen, and the length prefix — which kept the *wire*
 *   in sync — says nothing about that.
 *
 * `oversized` never reaches here: `FrameReader` poisons itself on a bad length prefix and the only
 * cure is a new connection.
 */
export function desynchronizesScreen(error: WireError): boolean {
  return error.code !== "unsupported-variant";
}

/** Base class for every error this codec raises. Never thrown directly. */
export class WireError extends Error {
  readonly code: WireErrorCode;

  /**
   * What was successfully read before this error, when it was raised mid-chunk. Lets a caller keep
   * the good frames while surfacing the fatal one. The element type follows the layer that threw:
   * frame payloads (`Uint8Array`) from `FrameReader.push`, decoded messages from
   * `ServerMessageReader.push`, which re-decodes the payloads it was handed. Attached once, on the
   * throw that produced it; a poisoned reader rethrows the same error object unchanged.
   */
  decodedBefore?: unknown[];

  constructor(code: WireErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    // Hermes/ES5 downlevel: restore the prototype chain so `instanceof` works.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Not enough bytes yet. Distinct from {@link CorruptError} on purpose: a truncated *stream* is
 * normal (wait for the next socket chunk), a truncated *frame payload* is not.
 */
export class IncompleteError extends WireError {
  /** How many more bytes the current read needs, when known. */
  readonly needed: number;

  constructor(message: string, needed: number) {
    super("incomplete", message);
    this.needed = needed;
  }
}

/** Structurally invalid bytes: bad varint marker, non-0/1 bool, invalid UTF-8, trailing bytes. */
export class CorruptError extends WireError {
  constructor(message: string) {
    super("corrupt", message);
  }
}

export class OversizedFrameError extends WireError {
  readonly claimed: number;
  readonly max: number;

  constructor(claimed: number, max: number) {
    super(
      "oversized",
      `frame claims ${claimed} bytes, over the ${max}-byte ceiling; the stream cannot be resynced`,
    );
    this.claimed = claimed;
    this.max = max;
  }
}

export class UnsupportedVariantError extends WireError {
  readonly variant: number;
  readonly variantName: string | undefined;

  constructor(variant: number, variantName: string | undefined) {
    super(
      "unsupported-variant",
      variantName === undefined
        ? `ServerMessage variant ${variant} is unknown to this codec`
        : `ServerMessage::${variantName} (variant ${variant}) is not decoded by this codec`,
    );
    this.variant = variant;
    this.variantName = variantName;
  }
}

export class FieldRangeError extends WireError {
  constructor(message: string) {
    super("range", message);
  }
}

export class HandshakeRejectedError extends WireError {
  readonly serverError: string;

  constructor(serverError: string) {
    super("handshake-rejected", `server rejected the handshake: ${serverError}`);
    this.serverError = serverError;
  }
}

export class ProtocolVersionMismatchError extends WireError {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(
      "version-mismatch",
      `server speaks protocol ${actual}, this client sent ${expected}`,
    );
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * The server picked a different `RenderEncoding` than we asked for. Proceeding anyway would make
 * the client read semantic `Frame` payloads as `Terminal` frames, so this is always fatal.
 */
export class EncodingMismatchError extends WireError {
  readonly requested: RenderEncoding;
  readonly selected: number;

  constructor(requested: RenderEncoding, selected: number) {
    const name = (v: number): string => RENDER_ENCODING_ORDER[v] ?? `unknown(${v})`;
    super(
      "encoding-mismatch",
      `server selected RenderEncoding::${name(selected)} but the client requested ` +
        `RenderEncoding::${name(requested)}`,
    );
    this.requested = requested;
    this.selected = selected;
  }
}
