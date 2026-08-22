/**
 * `@herdr/client-ts` — headless wire codec for the herdr client protocol.
 *
 * Scope is deliberately three things (mobile/.prd/02-architecture.md §2.2):
 *   1. the `[u32 LE length][bincode payload]` envelope, incrementally,
 *   2. `ClientMessage::Hello` encode — plus `ClientMessage::ObserveTerminal`, without which the
 *      handshake succeeds and no stream ever starts, plus `ClientMessage::RequestFullFrame`,
 *      without which a single lost `Terminal` diff leaves the screen wrong forever,
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
  TerminalSessionModeTag,
  serverFrameSizeCap,
} from "./constants.js";

export {
  ACCEPTED_WIRE_ABIS,
  LOCAL_WIRE_ABI,
  WIRE_ABI_EPOCH,
  WIRE_ABI_FORK,
  WIRE_ABI_MAGIC,
  WIRE_ABI_PRELUDE_LEN,
  WIRE_SCHEMA_FINGERPRINT,
  assertPeerAbiAccepted,
  decodeWirePrelude,
  describeWireAbi,
  encodeWirePrelude,
  startsWithWireAbiMagic,
  type WireAbi,
  type WirePrelude,
} from "./abi.js";

export {
  AbiMismatchError,
  CorruptError,
  EncodingMismatchError,
  FieldRangeError,
  HandshakeRejectedError,
  IncompleteError,
  LayoutMismatchError,
  OversizedFrameError,
  ProtocolVersionMismatchError,
  UnsupportedVariantError,
  WireError,
  desynchronizesScreen,
  type ObservedTag,
  type WireErrorCode,
  type WirePreludeSummary,
} from "./errors.js";

export {
  DEFAULT_LAYOUT_PROBE_REPEATS,
  WireLayoutProbe,
  type WireLayoutProbeOptions,
} from "./layoutProbe.js";

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
  encodeRequestFullFrame,
  encodeRequestFullFrameFrame,
  encodeResize,
  encodeResizeFrame,
  encodeRetargetTerminal,
  encodeRetargetTerminalFrame,
  OBSERVE_MODE,
  type HandshakeExpectation,
  type HelloParams,
  type ServerMessage,
  type TerminalMessage,
  type TerminalSessionMode,
  type WelcomeMessage,
} from "./messages.js";
export { ServerMessageReader, type ServerMessageReaderOptions } from "./stream.js";
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
  BRIDGE_EXEC_OPTIONS,
  DEFAULT_SESSION_NAME,
  HerdrChannelKind,
  JsonApiEventStream,
  ServerMessageChannel,
  bridgeSubcommand,
  createHostTimer,
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
  type HostTimers,
  type JsonApiEventStreamHandlers,
  type JsonApiEventStreamListener,
  type RemoteBridgeCommandOptions,
  type ServerMessageChannelHandlers,
  type ServerMessageChannelOptions,
  type TransportJsonApiOptions,
  type TransportTimer,
  type TransportTimerHandle,
} from "./transport.js";
