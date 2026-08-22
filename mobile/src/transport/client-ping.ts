// Not from orca. orca's liveness probe is "a real RPC" over its WebSocket
// (`rpc-session-liveness-watchdog.ts` calls back into `rpc-client.sendRequest`); herdr's equivalent
// on the resident client stream is `ClientMessage::Ping { nonce }`, which
// 05-orca-transport.md names for L1 — "herdr에 `Ping/Pong{nonce}` 존재".
//
// ⚠️ **mx-only.** `ClientMessage::Ping` is tag 10 in this fork (`src/protocol/wire.rs:457-460`,
// frozen by `client_message_wire_tags_preserve_protocol_15_order` at `:1446`) and
// `ServerMessage::Pong` is tag 10 on the way back (`:863-866`). Upstream's `ClientMessage` has
// neither, so against an upstream server this probe encodes as whatever sits at tag 10 there. That
// is the same hazard `packages/herdr-client-ts/src/constants.ts` opens with and the reason
// 05-orca-transport.md flags L1 and X1 together: **both of this milestone's herdr primitives are
// fork-local**, so shipping the app to upstream users removes the watchdog's probe and the replay's
// re-baseline at once. See mobile/.prd/03-blockers.md B1.
//
// Why the encoder lives here rather than in `packages/herdr-client-ts`: that package's scope is
// stated in its own header as the three messages the M2 read path needs, and this is the first
// message the *transport supervisor* needs. It is four bytes of bincode built from the package's
// own exported primitives (`ByteWriter`, `frameMessage`), so there is no second codec — only a
// second caller.
//
// The reply is deliberately **not** decoded. `ServerMessageChannel` decodes `Welcome` and
// `Terminal`; a `Pong` arrives as an `UnsupportedVariantError` with `variant === 10`. That is
// enough, and it is enough for a reason worth stating rather than shrugging at: L1 asks "is the
// peer still producing bytes", and a frame that reached the variant dispatcher has already passed
// the length prefix and the frame boundary, so it is exactly as strong a liveness signal as a
// decoded one. The nonce buys round-trip *latency*, which is not what the watchdog terminates on.
import { ByteWriter, frameMessage } from '@herdr/client-ts'

/** `src/protocol/wire.rs:1446` — `tag(&ClientMessage::Ping { nonce: 1 }) == 10`. */
export const CLIENT_MESSAGE_PING_TAG = 10

/** `packages/herdr-client-ts/src/constants.ts` `SERVER_MESSAGE_VARIANT_NAMES[10] === 'Pong'`. */
export const SERVER_MESSAGE_PONG_TAG = 10

/**
 * Encodes `ClientMessage::Ping { nonce }` as bincode would: the variant tag, then the `u64` nonce,
 * both as bincode varints — the same encoding `encodeHello` uses for every one of its numeric
 * fields (`packages/herdr-client-ts/src/messages.ts`).
 */
export function encodePing(nonce: number): Uint8Array {
  return new ByteWriter(16).writeVarint(CLIENT_MESSAGE_PING_TAG).writeVarint(nonce).toBytes()
}

/** {@link encodePing} wrapped in the `[u32 LE length][payload]` envelope. */
export function encodePingFrame(nonce: number): Uint8Array {
  return frameMessage(encodePing(nonce))
}

/** True when an undecodable frame was in fact the server's answer to {@link encodePingFrame}. */
export function isPongVariant(variant: number): boolean {
  return variant === SERVER_MESSAGE_PONG_TAG
}
