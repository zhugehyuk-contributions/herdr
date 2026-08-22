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
  | "encoding-mismatch"
  /** The peer's traffic does not look like this codec's wire layout. Inferred, never proven. */
  | "layout-mismatch"
  /** The peer's ANNOUNCED wire ABI is not one this codec decodes. Proven, not inferred. */
  | "abi-mismatch";

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
 * `oversized`, `layout-mismatch` and `abi-mismatch` never reach here: all three are terminal for
 * the connection — `FrameReader` poisons itself on a bad length prefix, a layout verdict means
 * nothing on this stream will ever decode, and an ABI mismatch is raised on the prelude, before a
 * `ServerMessage` exists at all — so there is no baseline left to repair.
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

/**
 * The peer announced a wire ABI this codec does not decode — or announced none at all.
 *
 * The **proven** counterpart to {@link LayoutMismatchError}'s inference: the peer's own prelude
 * says which byte layout it was built from (`src/abi.ts`), so this is read off the wire rather than
 * guessed from traffic shape, and it is raised **before any bincode is parsed** — nothing of the
 * peer's stream is ever interpreted.
 *
 * `peer` is `undefined` in exactly one case: a server that sent no prelude at all. That is a
 * pre-prelude herdr (protocol <= 20) or a foreign fork, and it is refused rather than accepted on
 * its version, because a version match is precisely the evidence that turned out to be worthless.
 */
export class AbiMismatchError extends WireError {
  /** What the peer announced, or `undefined` when it announced nothing. */
  readonly peer: WirePreludeSummary | undefined;

  constructor(peer: WirePreludeSummary | undefined, message: string) {
    super("abi-mismatch", message);
    this.peer = peer;
  }
}

/**
 * The peer identity fields {@link AbiMismatchError} carries.
 *
 * Structurally identical to `WirePrelude` in `src/abi.ts` and declared here instead of imported
 * to keep `errors.ts` free of an import cycle (`abi.ts` throws this class).
 */
export interface WirePreludeSummary {
  fork: string;
  abiEpoch: number;
  protocolVersion: number;
  schemaFingerprint: string;
}

/** One `ServerMessage` tag this codec could not decode, and how often it arrived. */
export interface ObservedTag {
  /** The wire tag as it arrived. */
  tag: number;
  /** What *this codec's* table calls it (`src/constants.ts`), or `undefined` if it has no name. */
  name: string | undefined;
  count: number;
}

/**
 * The peer's stream does not look like this wire layout — a fork-skew alarm, not a proof.
 *
 * ## What it is for
 *
 * `src/constants.ts:4-9` records the trap: herdr-mx and upstream/master both report
 * `PROTOCOL_VERSION = 20` and both put `Welcome` at tag 0, so `assertWelcomeAccepted`
 * (`src/messages.ts`) accepts either — while `ServerMessage::Terminal` is 13 here and 2 upstream.
 * Against an upstream server the handshake is green and every terminal frame then arrives as a
 * variant this codec's table calls `Graphics`, is skipped, and — `onUndecodable` being optional and
 * documented as *not* an error — produces a black screen with zero errors. This error is that state
 * given a name, once, instead of N undecodable-variant shrugs the caller has to add up.
 *
 * ## ⚠️ What it cannot do
 *
 * **It infers; it does not prove.** This codec cannot read the peer's tag table — nothing on the
 * wire carries one — so all it has is the *shape* of the traffic: frames this codec cannot decode,
 * repeating on one tag, with no `Terminal` behind them. That shape is also what a server speaking a
 * third layout, or a future mx that moved `Terminal` again, would produce; the error names the tags
 * it saw precisely so a human can finish the diagnosis (a repeat of tag 2 is strong evidence of
 * upstream, because that is where upstream's `Terminal` lives). It can also stay silent on a
 * skewed peer that never sends enough frames to reach the threshold — an alarm, not a gate.
 *
 * ## The real fix landed; this is now a backstop
 *
 * When this class was written the note here read "the real fix is not in this package: the server
 * must put an ABI/layout fingerprint in `Welcome`". **That fix exists now** — and it is not in
 * `Welcome`, because `Welcome` is a *reply* and the first divergent value (`ClientLaunchMode`) is
 * a field of `Hello` that the *server* decodes. It is a fixed prelude ahead of all bincode, in
 * both directions: `src/abi.ts` here, `src/protocol/abi.rs` there. {@link AbiMismatchError} is the
 * *proven* form of what this class infers, and `ServerMessageChannel` raises it before a single
 * frame is read.
 *
 * This class stays because the two answer different questions: the prelude checks what the peer
 * **claims**, this checks how the peer **behaves**. A peer that announces this exact ABI and then
 * streams tags this codec cannot decode is a case the prelude cannot see, and the one it was
 * always weakest at (a same-fingerprint build with a patched enum) is exactly the one left.
 */
export class LayoutMismatchError extends WireError {
  /** Every undecodable tag seen while the probe was armed, most frequent first. */
  readonly observedTags: ReadonlyArray<ObservedTag>;
  /** The most repeated tag — the one that carries the accusation. */
  readonly dominantTag: number;
  /** How many `Terminal` frames decoded while the probe was armed. Always 0 when this is thrown. */
  readonly terminalsSeen: number;

  constructor(observedTags: ReadonlyArray<ObservedTag>, terminalsSeen: number) {
    const dominant = observedTags[0];
    if (dominant === undefined) {
      throw new Error("LayoutMismatchError requires at least one observed tag");
    }
    const seen = observedTags
      .map(({ tag, name, count }) => `${tag} (this codec: ${name ?? "unknown"}) x${count}`)
      .join(", ");
    super(
      "layout-mismatch",
      `this peer does not appear to speak this wire layout: ${dominant.count} frame(s) tagged ` +
        `${dominant.tag} arrived after ObserveTerminal and no ServerMessage::Terminal did. ` +
        `Tags seen: ${seen}. herdr-mx sends Terminal as tag 13, upstream/master as tag 2 ` +
        `(src/constants.ts:4-9). INFERRED from the traffic's shape, not proven — this codec ` +
        `cannot read the peer's tag table; only a layout fingerprint in Welcome could.`,
    );
    this.observedTags = observedTags;
    this.dominantTag = dominant.tag;
    this.terminalsSeen = terminalsSeen;
  }
}
