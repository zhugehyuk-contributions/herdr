/**
 * Wire constants for the herdr client protocol.
 *
 * ⚠️ THESE ORDINALS ARE FORK-LOCAL (herdr-mx). `PROTOCOL_VERSION` is *not* a layout identifier:
 * herdr-mx and upstream/master both report `PROTOCOL_VERSION = 20` while disagreeing on exactly
 * the tags this codec depends on — `ServerMessage::Terminal` is 13 on mx but 2 upstream, and
 * `ClientLaunchMode::TerminalAttach` is 1 on mx but 2 upstream (`AppDirectGraphics` is inserted in
 * the middle). See `mobile/.prd/03-blockers.md` B1. A version match therefore does NOT prove the
 * peer speaks this layout; talking to an upstream server will silently mis-parse.
 *
 * Every ordinal in this file is transcribed from the mx tree; keep them all here so a fork bump is
 * a single-file diff.
 *
 * Sources (herdr repo root):
 *   src/protocol/wire.rs:23   PROTOCOL_VERSION = 20
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

/** `src/protocol/wire.rs:23`. Exact equality is required by the server's negotiation (`:1225`). */
export const PROTOCOL_VERSION = 20;

/** Length of the `u32` little-endian frame length prefix (`src/protocol/wire.rs:45`). */
export const LENGTH_PREFIX_BYTES = 4;

/**
 * Default ceiling for a single frame payload accepted by {@link FrameReader}.
 *
 * The Rust client's policy is a hard switch — {@link RUST_MAX_FRAME_SIZE} (2 MiB) with Kitty
 * graphics off, {@link RUST_MAX_GRAPHICS_FRAME_SIZE} (32 MiB) with it on
 * (`src/client/mod.rs:6485-6491`), matching the server's per-frame choice
 * (`src/server/headless.rs:4231-4235`). This codec defaults to 8 MiB: comfortably above real
 * terminal-ANSI traffic (a 100x30 full repaint measured ~56 KB) and far below "allocate whatever
 * the peer claims". A client that enables Kitty graphics — whose bytes are inlined into
 * `TerminalFrame.bytes` — should pass `maxFrameSize: RUST_MAX_GRAPHICS_FRAME_SIZE` for parity
 * with the desktop client.
 */
export const DEFAULT_MAX_FRAME_SIZE = 8 * 1024 * 1024;

/** `src/protocol/wire.rs:27` — the server's own cap for ordinary frames. */
export const RUST_MAX_FRAME_SIZE = 2 * 1024 * 1024;

/** `src/protocol/wire.rs:32` — the server's cap when Kitty graphics are enabled. */
export const RUST_MAX_GRAPHICS_FRAME_SIZE = 32 * 1024 * 1024;

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

/** `ClientMessage` wire tags (`src/protocol/wire.rs:366`). Only `Hello` is encoded by this package. */
export const ClientMessageTag = {
  Hello: 0,
  /**
   * Not encoded here (see README "Not covered"); kept so the tag lives with its siblings.
   * Frozen by `client_message_wire_tags_preserve_protocol_15_order` (`src/protocol/wire.rs:1448`).
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
