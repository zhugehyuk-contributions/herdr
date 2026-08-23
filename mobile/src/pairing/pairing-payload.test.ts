import { describe, expect, it } from 'vitest'
import {
  PAIRING_PAYLOAD_VERSION,
  pairingCodeStaleness,
  parsePairingCode,
  remoteConfigFromPairing
} from './pairing-payload'

const GOOD = {
  v: PAIRING_PAYLOAD_VERSION,
  name: 'iq-64',
  host: '10.0.2.2',
  port: 2222,
  user: 'z',
  session: 'work',
  key: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
  issuedAt: 1_700_000_000_000
}

describe('parsePairingCode', () => {
  it('reads a full code', () => {
    const parsed = parsePairingCode(JSON.stringify(GOOD))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.payload.host).toBe('10.0.2.2')
      expect(parsed.payload.port).toBe(2222)
    }
  })

  it('defaults the port, because 22 is what a code that omits it means', () => {
    const { port: _dropped, ...rest } = GOOD
    const parsed = parsePairingCode(JSON.stringify(rest))
    expect(parsed.ok && parsed.payload.port).toBe(22)
  })

  it('accepts a code with no key — that is the mockup prefill form, not an error', () => {
    const { key: _dropped, ...rest } = GOOD
    const parsed = parsePairingCode(JSON.stringify(rest))
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.payload.key).toBeUndefined()
  })

  it('says "not a herdr code" for anything that is not JSON — a wifi QR is the common case', () => {
    const parsed = parsePairingCode('WIFI:S:home;T:WPA;P:hunter2;;')
    expect(parsed).toEqual({ ok: false, reason: 'This is not a herdr pairing code.' })
  })

  it('names the missing field without quoting any value', () => {
    const { host: _dropped, ...rest } = GOOD
    const parsed = parsePairingCode(JSON.stringify(rest))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.reason).toContain('host')
      // The rule this file exists to keep: a reason must never carry the value, because the value
      // may be a private key and the reason is rendered on screen.
      expect(parsed.reason).not.toContain('BEGIN OPENSSH')
      expect(parsed.reason).not.toContain('AAAA')
    }
  })

  it('never lets a key reach the reason, even when the key itself is the bad field', () => {
    const parsed = parsePairingCode(JSON.stringify({ ...GOOD, key: '' }))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.reason).toContain('key')
      expect(parsed.reason).not.toContain('BEGIN OPENSSH')
    }
  })

  it('tells the user which side to update, by version direction', () => {
    const newer = parsePairingCode(JSON.stringify({ ...GOOD, v: PAIRING_PAYLOAD_VERSION + 1 }))
    expect(!newer.ok && newer.reason).toContain('Update the app')
    const older = parsePairingCode(JSON.stringify({ ...GOOD, v: PAIRING_PAYLOAD_VERSION - 1 }))
    expect(!older.ok && older.reason).toContain('Update herdr on the desktop')
  })
})

describe('pairingCodeStaleness', () => {
  it('says nothing about a fresh code', () => {
    expect(pairingCodeStaleness({ issuedAt: 1_000_000 }, 1_000_000 + 60_000)).toBeNull()
  })

  it('says nothing when the code carries no time — it does not guess', () => {
    expect(pairingCodeStaleness({ issuedAt: undefined }, 9_999_999)).toBeNull()
  })

  it('warns in minutes, then hours', () => {
    expect(pairingCodeStaleness({ issuedAt: 0 }, 20 * 60_000)).toBe('This code was made 20m ago.')
    expect(pairingCodeStaleness({ issuedAt: 0 }, 3 * 3_600_000)).toBe('This code was made 3h ago.')
  })
})

describe('remoteConfigFromPairing', () => {
  it('produces a config the store already understands', () => {
    const parsed = parsePairingCode(JSON.stringify(GOOD))
    if (!parsed.ok) {
      throw new Error(parsed.reason)
    }
    const config = remoteConfigFromPairing(parsed.payload)
    expect(config).toMatchObject({
      id: 'z@10.0.2.2:2222',
      name: 'iq-64',
      host: '10.0.2.2',
      port: 2222,
      username: 'z',
      session: 'work'
    })
    expect(config.privateKey).toContain('BEGIN OPENSSH')
  })

  it('leaves the key empty for a prefill-only code, rather than inventing one', () => {
    const { key: _dropped, ...rest } = GOOD
    const parsed = parsePairingCode(JSON.stringify(rest))
    if (!parsed.ok) {
      throw new Error(parsed.reason)
    }
    expect(remoteConfigFromPairing(parsed.payload).privateKey).toBe('')
  })

  it('falls back to the host for a nameless code', () => {
    const { name: _dropped, ...rest } = GOOD
    const parsed = parsePairingCode(JSON.stringify(rest))
    if (!parsed.ok) {
      throw new Error(parsed.reason)
    }
    expect(remoteConfigFromPairing(parsed.payload).name).toBe('10.0.2.2')
  })
})
