import { beforeEach, describe, expect, it } from 'vitest'
import { pendingPairing } from './pairing-handoff'
import { PAIRING_PAYLOAD_VERSION, type PairingPayload } from './pairing-payload'

const PAYLOAD: PairingPayload = {
  v: PAIRING_PAYLOAD_VERSION,
  host: 'box',
  port: 22,
  user: 'z',
  key: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----'
}

beforeEach(() => {
  pendingPairing.clear()
})

describe('pendingPairing', () => {
  it('hands the payload over exactly once', () => {
    pendingPairing.set(PAYLOAD)
    expect(pendingPairing.take()).toEqual(PAYLOAD)
    // The property that makes this a handoff and not a store: a private key must not sit in a
    // module slot for the rest of the session because a screen re-rendered.
    expect(pendingPairing.take()).toBeNull()
  })

  it('is empty until something is put in it', () => {
    expect(pendingPairing.take()).toBeNull()
  })

  it('can be dropped by a screen that leaves without consuming it', () => {
    pendingPairing.set(PAYLOAD)
    pendingPairing.clear()
    expect(pendingPairing.take()).toBeNull()
  })
})
