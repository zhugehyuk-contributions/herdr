/**
 * Wire constants for the herdr client protocol.
 *
 * ⚠️ THESE ORDINALS ARE FORK-LOCAL (herdr-mx). `PROTOCOL_VERSION` is *not* a layout identifier:
 * herdr-mx and upstream/master both reported `PROTOCOL_VERSION = 20` while disagreeing on exactly
 * the tags this codec depends on — `ServerMessage::Terminal` is 13 on mx but 2 upstream, and
 * `ClientLaunchMode::TerminalAttach` is 1 on mx but 2 upstream (`AppDirectGraphics` is inserted in
 * the middle). See `mobile/.prd/03-blockers.md` B1. A version match therefore does NOT prove the
 * peer speaks this layout; talking to an upstream server would silently mis-parse.
 *
 * ✅ **That hole is now closed by `./abi.ts`, not by this file.** Both peers announce
 * `(fork, wire ABI epoch, schema fingerprint)` in a fixed prelude ahead of all bincode, and
 * `ServerMessageChannel` refuses a peer whose announcement is not in the accepted table. The
 * version below is still checked (it is the server's own negotiation rule) but it is the second
 * gate, not the first.
 *
 * Every ordinal in this file is transcribed from the mx tree; keep them all here so a fork bump is
 * a single-file diff.
 *
 * Sources (herdr repo root):
 *   src/protocol/abi.rs       WIRE_ABI_* + WIRE_SCHEMA_FINGERPRINT (transcribed in ./abi.ts)
 *   src/protocol/wire.rs:23   PROTOCOL_VERSION = 21
 *   src/protocol/wire.rs:27   MAX_FRAME_SIZE = 2 MiB
 *   src/protocol/wire.rs:32   MAX_GRAPHICS_FRAME_SIZE = 32 MiB
 *   src/protocol/wire.rs:45   LENGTH_PREFIX_BYTES = 4
 *   src/protocol/wire.rs:53   enum RenderEncoding
 *   src/protocol/wire.rs:62   enum ClientSurfaceMode
 *   src/protocol/wire.rs:71   enum ClientKeybindings
 *   src/protocol/wire.rs:80   enum ClientLaunchMode
 *   src/protocol/wire.rs:366  enum ClientMessage
 *   src/protocol/wire.rs:797  enum ServerMessage
 *   src/protocol/wire.rs:771  struct TerminalFrame
 */

/**
 * `src/protocol/wire.rs` `PROTOCOL_VERSION`. Exact equality is required by the server's
 * negotiation (`check_client_version`).
 *
 * v21: the handshake now opens with the 28-byte wire-ABI prelude (`./abi.ts`,
 * `src/protocol/abi.rs`). The handshake's byte stream changed, so 20 must not name two different
 * handshakes — that is the same "one integer, two layouts" defect this file's header describes.
 */
export const PROTOCOL_VERSION = 21;

/** Length of the `u32` little-endian frame length prefix (`src/protocol/wire.rs:45`). */
export const LENGTH_PREFIX_BYTES = 4;

/** `src/protocol/wire.rs:27` — `MAX_FRAME_SIZE`, the server's cap for a graphics-free frame. */
export const RUST_MAX_FRAME_SIZE = 2 * 1024 * 1024;

/** `src/protocol/wire.rs:32` — `MAX_GRAPHICS_FRAME_SIZE`, the cap for a frame carrying graphics. */
export const RUST_MAX_GRAPHICS_FRAME_SIZE = 32 * 1024 * 1024;

/**
 * The frame ceiling is a RULE, not a number.
 *
 * The server picks a cap per frame: {@link RUST_MAX_FRAME_SIZE} when the frame carries no Kitty
 * graphics, {@link RUST_MAX_GRAPHICS_FRAME_SIZE} when it does
 * (`src/server/headless.rs:4231-4235`). Every Rust reader mirrors that choice through
 * `server_frame_size_cap` (`src/client/mod.rs:6483-6491`), whose own doc comment states the
 * failure mode: *"every reader must use the larger cap when kitty graphics are enabled —
 * otherwise a large graphics frame fails framing and flaps the connection."*
 *
 * This is not a graphics-clients-only concern for the mobile/`TerminalAnsi` path: Kitty graphics
 * are NOT a separate message, they are spliced into the ANSI byte stream by
 * `insert_graphics_before_sync_end` (`src/server/render_stream.rs:109`), so they arrive *inside*
 * `TerminalFrame.bytes` and inflate the very frame this codec has to accept.
 *
 * Picking any value between the two caps is the worst of both worlds: it rejects legal frames
 * while still admitting frames larger than the text-only ceiling. And rejection is not a soft
 * failure — an oversized length prefix desynchronizes the stream irrecoverably
 * ({@link FrameReader} poisons itself), so the client can only drop the connection and reconnect.
 */
export function serverFrameSizeCap(kittyGraphicsEnabled: boolean): number {
  return kittyGraphicsEnabled ? RUST_MAX_GRAPHICS_FRAME_SIZE : RUST_MAX_FRAME_SIZE;
}

/**
 * Default ceiling for a single frame payload accepted by {@link FrameReader}: the *larger* arm of
 * {@link serverFrameSizeCap}, i.e. the biggest frame the server is ever permitted to emit.
 *
 * Chosen so the default can never reject a legal frame. The desktop client can afford the tighter
 * cap because it knows its own `kitty_graphics_enabled` setting; this codec is handed a socket and
 * does not, so the only safe default is the ceiling that covers both arms. Cost of the larger
 * default is bounded: {@link FrameReader} buffers the bytes that actually arrive and never
 * preallocates the claimed length, so a bogus prefix costs a comparison, not 32 MiB.
 *
 * A caller that knows graphics are off may tighten it with
 * `new FrameReader({ maxFrameSize: serverFrameSizeCap(false) })`.
 */
export const DEFAULT_MAX_FRAME_SIZE = serverFrameSizeCap(true);

/** `RenderEncoding` (`src/protocol/wire.rs:53`). */
export const RenderEncoding = {
  SemanticFrame: 0,
  TerminalAnsi: 1,
} as const;
export type RenderEncoding = (typeof RenderEncoding)[keyof typeof RenderEncoding];

/** Variant names in ordinal order — used for diagnostics and fixture cross-checks. */
export const RENDER_ENCODING_ORDER = ["SemanticFrame", "TerminalAnsi"] as const;

/** `ClientSurfaceMode` (`src/protocol/wire.rs:62`). */
export const ClientSurfaceMode = {
  FullApp: 0,
  EmbeddedContent: 1,
} as const;
export type ClientSurfaceMode = (typeof ClientSurfaceMode)[keyof typeof ClientSurfaceMode];

export const CLIENT_SURFACE_MODE_ORDER = ["FullApp", "EmbeddedContent"] as const;

/**
 * `ClientKeybindings` (`src/protocol/wire.rs:71`). Only the unit variant `Server` (0) is
 * encodable here; `Local { keys_toml: String }` (1) carries a payload and is out of scope.
 */
export const ClientKeybindings = {
  Server: 0,
} as const;
export type ClientKeybindings = (typeof ClientKeybindings)[keyof typeof ClientKeybindings];

/** `ClientLaunchMode` (`src/protocol/wire.rs:80`). */
export const ClientLaunchMode = {
  App: 0,
  TerminalAttach: 1,
} as const;
export type ClientLaunchMode = (typeof ClientLaunchMode)[keyof typeof ClientLaunchMode];

export const CLIENT_LAUNCH_MODE_ORDER = ["App", "TerminalAttach"] as const;

/**
 * `ClientMessage` wire tags (`src/protocol/wire.rs:366`). `Hello` and `ObserveTerminal` are enough
 * to open a read-only terminal stream; `RequestFullFrame` is what keeps it *correct* after a lost
 * frame.
 */
export const ClientMessageTag = {
  Hello: 0,
  /**
   * `src/protocol/wire.rs:462-467` — a **unit** variant, so the encoded message is the tag byte and
   * nothing else. Frozen at 11 by `client_message_wire_tags_preserve_protocol_15_order`
   * (`src/protocol/wire.rs:1447`).
   *
   * ⚠️ **mx-only.** Upstream's `ClientMessage` has no such variant, so an upstream server decodes
   * tag 11 as whatever sits there in its own enum. That is the same fork-skew hazard this file
   * opens with, and it is why this is a *recovery* path and never part of the handshake.
   */
  RequestFullFrame: 11,
  /**
   * `src/protocol/wire.rs:471`. Frozen by
   * `client_message_wire_tags_preserve_protocol_15_order` (`src/protocol/wire.rs:1448`).
   */
  ObserveTerminal: 12,
} as const;

/** `ServerMessage` wire tags (`src/protocol/wire.rs:797`). Only `Welcome` and `Terminal` decode. */
export const ServerMessageTag = {
  Welcome: 0,
  Terminal: 13,
} as const;

/**
 * Every `ServerMessage` variant name by tag, for diagnostics when an undecodable frame arrives.
 * Transcribed from `src/protocol/wire.rs:797-887`; tags 1-12 are recognized but NOT decoded.
 */
export const SERVER_MESSAGE_VARIANT_NAMES: Readonly<Record<number, string>> = {
  0: "Welcome",
  1: "Frame",
  2: "Graphics",
  3: "ServerShutdown",
  4: "Notify",
  5: "Clipboard",
  6: "WindowTitle",
  7: "ReloadSoundConfig",
  8: "MouseCapture",
  9: "FrameDelta",
  10: "Pong",
  11: "Compressed",
  12: "PrefixInputSource",
  13: "Terminal",
};
