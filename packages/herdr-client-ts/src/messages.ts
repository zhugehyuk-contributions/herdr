import {
  ClientKeybindings,
  ClientLaunchMode,
  ClientMessageTag,
  ClientSurfaceMode,
  PROTOCOL_VERSION,
  RenderEncoding,
  SERVER_MESSAGE_VARIANT_NAMES,
  ServerMessageTag,
} from "./constants.js";
import { ByteCursor } from "./cursor.js";
import {
  CorruptError,
  EncodingMismatchError,
  FieldRangeError,
  HandshakeRejectedError,
  IncompleteError,
  ProtocolVersionMismatchError,
  UnsupportedVariantError,
} from "./errors.js";
import { frameMessage } from "./framing.js";
import { ByteWriter } from "./writer.js";

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

function requireUint(value: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new FieldRangeError(`${field} must be an integer in 0..=${max}, got ${value}`);
  }
  return value;
}

/**
 * A frame arrived whole (its length prefix said so) but the message inside ran off the end.
 * That is corruption, not backpressure — converting here is what keeps the two states distinct.
 */
function insideFrame<T>(what: string, decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof IncompleteError) {
      throw new CorruptError(
        `${what}: frame ended mid-value (${error.needed} more byte(s) needed); ` +
          "the frame length prefix and its payload disagree",
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Client -> Server: Hello
// ---------------------------------------------------------------------------

export interface HelloParams {
  /** Defaults to {@link PROTOCOL_VERSION}. The server requires exact equality. */
  version?: number;
  cols: number;
  rows: number;
  /** 0 when client-side Kitty graphics are disabled (the mobile default). */
  cellWidthPx?: number;
  cellHeightPx?: number;
  /** A *request*: the server answers with what it actually selected in `Welcome.encoding`. */
  requestedEncoding: RenderEncoding;
  launchMode: ClientLaunchMode;
  /** Defaults to `FullApp`. */
  surfaceMode?: ClientSurfaceMode;
  /** Defaults to `Server`; `ClientKeybindings::Local` is not encodable here. */
  keybindings?: ClientKeybindings;
}

/**
 * Encodes `ClientMessage::Hello` (variant 0) exactly as bincode would.
 *
 * Field order is `src/protocol/wire.rs:368-387`:
 * `version, cols, rows, cell_width_px, cell_height_px, requested_encoding, surface_mode,
 * keybindings, launch_mode` — every one of them a varint.
 */
export function encodeHello(params: HelloParams): Uint8Array {
  const version = requireUint(params.version ?? PROTOCOL_VERSION, U32_MAX, "version");
  const cols = requireUint(params.cols, U16_MAX, "cols");
  const rows = requireUint(params.rows, U16_MAX, "rows");
  const cellWidthPx = requireUint(params.cellWidthPx ?? 0, U32_MAX, "cellWidthPx");
  const cellHeightPx = requireUint(params.cellHeightPx ?? 0, U32_MAX, "cellHeightPx");
  const surfaceMode = params.surfaceMode ?? ClientSurfaceMode.FullApp;
  const keybindings = params.keybindings ?? ClientKeybindings.Server;

  return new ByteWriter(24)
    .writeVarint(ClientMessageTag.Hello)
    .writeVarint(version)
    .writeVarint(cols)
    .writeVarint(rows)
    .writeVarint(cellWidthPx)
    .writeVarint(cellHeightPx)
    .writeVarint(params.requestedEncoding)
    .writeVarint(surfaceMode)
    .writeVarint(keybindings)
    .writeVarint(params.launchMode)
    .toBytes();
}

/** {@link encodeHello} wrapped in the `[u32 LE length][payload]` envelope, ready for the socket. */
export function encodeHelloFrame(params: HelloParams): Uint8Array {
  return frameMessage(encodeHello(params));
}

// ---------------------------------------------------------------------------
// Server -> Client: Welcome, Terminal
// ---------------------------------------------------------------------------

export interface WelcomeMessage {
  type: "welcome";
  version: number;
  /** What the server *selected*, which may differ from what `Hello.requested_encoding` asked for. */
  encoding: number;
  /** `Some(_)` means the handshake failed and the client must exit. */
  error: string | null;
}

export interface TerminalMessage {
  type: "terminal";
  /** `u64`, so a `bigint`: a long-lived stream outruns `Number.MAX_SAFE_INTEGER`'s guarantees. */
  seq: bigint;
  width: number;
  height: number;
  /** True when `bytes` is a full redraw rather than a diff. */
  full: boolean;
  /** Terminal escape bytes, ready to hand to xterm. Kitty graphics are inlined here. */
  bytes: Uint8Array;
}

export type ServerMessage = WelcomeMessage | TerminalMessage;

function readWelcomeBody(cursor: ByteCursor): WelcomeMessage {
  const version = cursor.readVarintAsNumber("Welcome.version", U32_MAX);
  const encoding = cursor.readVarintAsNumber("Welcome.encoding", U32_MAX);
  const error = cursor.readOption((c) => c.readString());
  return { type: "welcome", version, encoding, error };
}

function readTerminalBody(cursor: ByteCursor): TerminalMessage {
  const seq = cursor.readVarint();
  const width = cursor.readVarintAsNumber("TerminalFrame.width", U16_MAX);
  const height = cursor.readVarintAsNumber("TerminalFrame.height", U16_MAX);
  const full = cursor.readBool();
  const bytes = cursor.readByteVec();
  return { type: "terminal", seq, width, height, full, bytes };
}

/**
 * Decodes one complete frame payload into a {@link ServerMessage}.
 *
 * Only `Welcome` (0) and `Terminal` (13) are decoded; every other variant raises
 * {@link UnsupportedVariantError} naming the variant, because silently ignoring e.g.
 * `Compressed` or `Frame` would leave the UI showing a stale screen with no explanation.
 */
export function decodeServerMessage(payload: Uint8Array): ServerMessage {
  const cursor = new ByteCursor(payload);
  const variant = insideFrame("ServerMessage variant", () =>
    cursor.readVarintAsNumber("ServerMessage variant", U32_MAX),
  );

  switch (variant) {
    case ServerMessageTag.Welcome: {
      const message = insideFrame("ServerMessage::Welcome", () => readWelcomeBody(cursor));
      cursor.assertConsumed("ServerMessage::Welcome");
      return message;
    }
    case ServerMessageTag.Terminal: {
      const message = insideFrame("ServerMessage::Terminal", () => readTerminalBody(cursor));
      cursor.assertConsumed("ServerMessage::Terminal");
      return message;
    }
    default:
      throw new UnsupportedVariantError(variant, SERVER_MESSAGE_VARIANT_NAMES[variant]);
  }
}

/** {@link decodeServerMessage} constrained to `Welcome`. */
export function decodeWelcome(payload: Uint8Array): WelcomeMessage {
  const message = decodeServerMessage(payload);
  if (message.type !== "welcome") {
    throw new CorruptError(`expected ServerMessage::Welcome, got ${message.type}`);
  }
  return message;
}

/** {@link decodeServerMessage} constrained to `Terminal`. */
export function decodeTerminal(payload: Uint8Array): TerminalMessage {
  const message = decodeServerMessage(payload);
  if (message.type !== "terminal") {
    throw new CorruptError(`expected ServerMessage::Terminal, got ${message.type}`);
  }
  return message;
}

// ---------------------------------------------------------------------------
// Handshake validation
// ---------------------------------------------------------------------------

export interface HandshakeExpectation {
  /** The encoding the client put in `Hello.requested_encoding`. */
  encoding: RenderEncoding;
  /** The version the client put in `Hello.version`. Defaults to {@link PROTOCOL_VERSION}. */
  version?: number;
}

/**
 * Fails loudly unless the server accepted the handshake on our terms.
 *
 * The encoding check is the load-bearing one: `Hello.requested_encoding` is a *request*, and a
 * client that assumes `TerminalAnsi` while the server chose `SemanticFrame` will read `Frame`
 * payloads as `Terminal` frames and render garbage. Version equality is checked too because
 * `PROTOCOL_VERSION` equality is the server's own negotiation rule (`src/protocol/wire.rs:1225`)
 * — note it does NOT prove layout compatibility across forks (see constants.ts).
 */
export function assertWelcomeAccepted(
  welcome: WelcomeMessage,
  expected: HandshakeExpectation,
): void {
  if (welcome.error !== null) {
    throw new HandshakeRejectedError(welcome.error);
  }
  const expectedVersion = expected.version ?? PROTOCOL_VERSION;
  if (welcome.version !== expectedVersion) {
    throw new ProtocolVersionMismatchError(expectedVersion, welcome.version);
  }
  if (welcome.encoding !== expected.encoding) {
    throw new EncodingMismatchError(expected.encoding, welcome.encoding);
  }
}
