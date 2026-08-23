// Not from orca. A one-slot, in-memory handoff between the scan screen and the settings form.
//
// Why not a route param: expo-router puts params in navigation state, in the deep-link history and
// in anything that logs a route (`src/notifications/pane-deep-link.ts` is built on exactly that
// property). A pairing payload can carry a private key — option B′ in `.prd/12-qr-pairing.md` — so
// the one thing it must not do is become part of an address.
//
// Why not context: the two screens are siblings under the router, not parent and child, and a
// provider high enough to hold both would keep the key alive for the whole app instead of for the
// one hop it is needed on. `take()` clears as it reads, so the value exists between exactly two
// renders.
import type { PairingPayload } from './pairing-payload'

let slot: PairingPayload | null = null

export const pendingPairing = {
  set(payload: PairingPayload): void {
    slot = payload
  },
  /** Reads and clears. A second caller gets `null`, which is what makes this a handoff and not a store. */
  take(): PairingPayload | null {
    const value = slot
    slot = null
    return value
  },
  /** Drops anything held, for a screen that is leaving without consuming it. */
  clear(): void {
    slot = null
  }
}
