// Not from orca. orca had one transport and no fork problem; herdr-mx has both, so every client
// stream now opens with the 28-byte wire-ABI prelude (`packages/herdr-client-ts/src/abi.ts`,
// `src/protocol/abi.rs`) and mobile's scripted fakes have to answer it like the real thing.
//
// Why this is a *gate* and not a `bytes.subarray(28)` in each test: the real server does not skip
// the prelude, it READS it and hangs up on a stranger — `src/server/client_transport.rs:510-546`
// answers a prelude with a prelude and rejects a peer that sent none, and its own RED tests
// (`a_well_formed_hello_without_a_prelude_is_still_rejected`, :1357) exist to keep it that way. A
// fake that quietly ignored those 28 bytes would be a peer that does not exist in production, and
// the doubles in `src/session/`, `src/app-shell/` and `src/transport/` would stop proving that
// mobile's handshake is one a herdr server would actually accept.
//
// The reply half needs no code here: `FakeChannel.emit` prefixes the server's own prelude on the
// first emit (`packages/herdr-client-ts/test/fakeTransport.ts`), which is the same ordering the
// server uses — prelude out before `Welcome`.
import {
  WIRE_ABI_PRELUDE_LEN,
  assertPeerAbiAccepted,
  decodeWirePrelude,
  startsWithWireAbiMagic
} from '@herdr/client-ts'

/**
 * The server's half of the wire-ABI handshake, as a filter over one channel's writes.
 *
 * Feed it every write a fake sees on a `HerdrChannelKind.ClientStream`. The first one is the
 * client's prelude: it is decoded and checked against the accepted table — so a mobile change that
 * announced the wrong fork, epoch or fingerprint fails these suites instead of sailing through —
 * and then swallowed, returning `null`. Every later write is a `ClientMessage` frame and comes back
 * unchanged, so callers index message writes from 0 exactly as they did before the prelude landed.
 *
 * Throws rather than returning a verdict: a client that opens with anything but a prelude is not a
 * case any of these tests are scripting, and the real server's answer to it is to drop the
 * connection.
 */
export function createWireAbiGate(): (bytes: Uint8Array) => Uint8Array | null {
  let preludeConsumed = false
  return (bytes: Uint8Array) => {
    if (preludeConsumed) {
      return bytes
    }
    preludeConsumed = true
    if (!startsWithWireAbiMagic(bytes)) {
      throw new Error(
        `a ClientStream must open with the ${WIRE_ABI_PRELUDE_LEN}-byte wire-ABI prelude; ` +
          `got ${bytes.length} bytes starting ${[...bytes.subarray(0, 4)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')}`
      )
    }
    // Exactly what the server does before it touches bincode: identify the peer, then refuse it if
    // this build cannot decode its layout.
    assertPeerAbiAccepted(decodeWirePrelude(bytes))
    // `ServerMessageChannel.open` writes the prelude on its own (`src/transport.ts:851`), so there
    // are no message bytes riding along with it. Handled anyway rather than asserted away, because
    // a fake that only works when the writes split a particular way is testing the split.
    return bytes.length > WIRE_ABI_PRELUDE_LEN ? bytes.subarray(WIRE_ABI_PRELUDE_LEN) : null
  }
}
