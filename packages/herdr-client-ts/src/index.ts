/**
 * `@herdr/client-ts` — headless wire codec for the herdr client protocol.
 *
 * Scope is deliberately three things (mobile/.prd/02-architecture.md §2.2):
 *   1. the `[u32 LE length][bincode payload]` envelope, incrementally,
 *   2. `ClientMessage::Hello` encode — plus `ClientMessage::ObserveTerminal`, without which the
 *      handshake succeeds and no stream ever starts,
 *   3. `ServerMessage::Welcome` / `ServerMessage::Terminal` decode.
 *
 * Plus `./jsonApi.js` for the *other* socket: herdr's newline-delimited JSON control API, which is
 * how a client discovers the pane it is going to observe. Same rules apply to it.
 *
 * Plus `./transport.js`, the seam by which both of those sockets are reached on a phone: not a
 * unix socket but an ssh exec channel onto `herdr remote-api-bridge` / `herdr remote-client-bridge`
 * (`src/remote/unix.rs:75-76`). The interface only; the ssh2 implementation of it is a separate
 * entry point, `@herdr/client-ts/node`.
 *
 * No Node built-ins are used, so the package runs unchanged under Hermes/React Native.
 */
export {
  CLIENT_LAUNCH_MODE_ORDER,
  CLIENT_SURFACE_MODE_ORDER,
  ClientKeybindings,
  ClientLaunchMode,
  ClientMessageTag,
  ClientSurfaceMode,
  DEFAULT_MAX_FRAME_SIZE,
  LENGTH_PREFIX_BYTES,
  PROTOCOL_VERSION,
  RENDER_ENCODING_ORDER,
  RUST_MAX_FRAME_SIZE,
  RUST_MAX_GRAPHICS_FRAME_SIZE,
  RenderEncoding,
  SERVER_MESSAGE_VARIANT_NAMES,
  ServerMessageTag,
  serverFrameSizeCap,
} from "./constants.js";

export {
  CorruptError,
  EncodingMismatchError,
  FieldRangeError,
  HandshakeRejectedError,
  IncompleteError,
  OversizedFrameError,
  ProtocolVersionMismatchError,
  UnsupportedVariantError,
  WireError,
  type WireErrorCode,
} from "./errors.js";

export { ByteCursor } from "./cursor.js";
export { ByteWriter } from "./writer.js";
export { utf8Decode, utf8Encode } from "./utf8.js";
export {
  decodeVarint,
  encodeVarint,
  encodeVarintInto,
  varintSize,
  type DecodedVarint,
} from "./varint.js";
export { FrameReader, frameMessage, type FrameReaderOptions } from "./framing.js";
export {
  assertWelcomeAccepted,
  decodeServerMessage,
  decodeTerminal,
  decodeWelcome,
  encodeHello,
  encodeHelloFrame,
  encodeObserveTerminal,
  encodeObserveTerminalFrame,
  type HandshakeExpectation,
  type HelloParams,
  type ServerMessage,
  type TerminalMessage,
  type WelcomeMessage,
} from "./messages.js";
export { ServerMessageReader } from "./stream.js";
export {
  JsonApiClient,
  JsonApiError,
  JsonApiProtocolError,
  LineAccumulator,
  encodeJsonApiRequest,
  isJsonApiError,
  parseJsonApiResponse,
  type JsonApiConnect,
  type JsonApiConnection,
  type JsonApiErrorResponse,
  type JsonApiOkResponse,
  type JsonApiResponse,
} from "./jsonApi.js";
export {
  DEFAULT_SESSION_NAME,
  HerdrChannelKind,
  JsonApiEventStream,
  ServerMessageChannel,
  bridgeSubcommand,
  createTransportJsonApiClient,
  describeClose,
  hostTimer,
  isApiChannelKind,
  remoteBridgeCommand,
  shellQuote,
  transportJsonApiConnect,
  type HerdrChannel,
  type HerdrChannelClose,
  type HerdrChannelHandlers,
  type HerdrTransport,
  type RemoteBridgeCommandOptions,
  type ServerMessageChannelHandlers,
  type ServerMessageChannelOptions,
  type TransportJsonApiOptions,
  type TransportTimer,
  type TransportTimerHandle,
} from "./transport.js";
