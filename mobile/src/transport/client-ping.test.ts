// Not from orca. This pins the bytes of the L1 probe against `src/protocol/wire.rs`, in the same
// spirit as `packages/herdr-client-ts/test/vectors.ts`: a watchdog whose probe encodes wrong does
// not fail loudly — the server ignores the frame, no `Pong` comes back, and the watchdog concludes
// the link is dead and tears down a perfectly healthy connection every 44 seconds. That is a worse
// outcome than no watchdog at all, so the encoding is asserted rather than assumed.
//
// The live half of this proof — that a *real* mx server answers these bytes, and answers them while
// the connection is in `TerminalObserve` mode — is `test/live/transportRecovery.live.test.ts`.
import { describe, expect, it } from 'vitest'
import { ClientMessageTag, SERVER_MESSAGE_VARIANT_NAMES } from '@herdr/client-ts'
import {
  CLIENT_MESSAGE_PING_TAG,
  SERVER_MESSAGE_PONG_TAG,
  encodePing,
  encodePingFrame,
  isPongVariant
} from './client-ping'

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

describe('the L1 probe, on the wire', () => {
  it('sits between OpenKeybindHelp and RequestFullFrame, exactly where wire.rs freezes it', () => {
    // `src/protocol/wire.rs:1446` asserts `tag(&ClientMessage::Ping { nonce: 1 }) == 10`, between
    // `OpenKeybindHelp` (9) and `RequestFullFrame` (11) — and the codec already knows the neighbour.
    expect(CLIENT_MESSAGE_PING_TAG).toBe(10)
    expect(ClientMessageTag.RequestFullFrame).toBe(11)
    expect(CLIENT_MESSAGE_PING_TAG).toBe(ClientMessageTag.RequestFullFrame - 1)
  })

  it('encodes as the tag then the nonce, both bincode varints', () => {
    expect(hex(encodePing(1))).toBe('0a01')
    expect(hex(encodePing(0))).toBe('0a00')
    // 250 is the last single-byte bincode varint; 251 takes the u16 marker. Crossing that boundary
    // is where a hand-rolled encoder usually breaks, so both sides of it are pinned.
    expect(hex(encodePing(250))).toBe('0afa')
    expect(hex(encodePing(251))).toBe('0afbfb00')
  })

  it('the framed form carries the `[u32 LE length]` envelope', () => {
    // Two payload bytes -> `02000000 0a01`. Same shape as `encodeRequestFullFrameFrame`'s documented
    // `01000000 0b`.
    expect(hex(encodePingFrame(1))).toBe('020000000a01')
    expect(encodePingFrame(1)).toHaveLength(6)
  })

  it('recognizes the reply the codec does not decode', () => {
    // `ServerMessage::Pong` is variant 10, and this package decodes only `Welcome` and `Terminal`,
    // so a Pong arrives as `UnsupportedVariantError`. The codec's own table is the source.
    expect(SERVER_MESSAGE_VARIANT_NAMES[SERVER_MESSAGE_PONG_TAG]).toBe('Pong')
    expect(isPongVariant(SERVER_MESSAGE_PONG_TAG)).toBe(true)
    expect(isPongVariant(13)).toBe(false)
  })
})
