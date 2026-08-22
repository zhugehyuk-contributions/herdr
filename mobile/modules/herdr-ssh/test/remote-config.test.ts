// Not from orca. The injection point is where a typo becomes "the phone shows mock data forever",
// so every rejection has to be reportable rather than silent — that is what these pin.
import { describe, expect, it } from 'vitest'
import { parseConfiguredRemotes } from '../src/remote-config'

const VALID = {
  id: 'box',
  host: 'box.example',
  username: 'z',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n'
}

describe('parseConfiguredRemotes', () => {
  it('treats a missing or non-array `extra.herdrRemotes` as no remotes, not as an error', () => {
    for (const value of [undefined, null, {}, 'box.example', 7]) {
      expect(parseConfiguredRemotes(value)).toEqual({ remotes: [], rejected: [] })
    }
  })

  it('fills the defaults an ssh dial needs', () => {
    const { remotes } = parseConfiguredRemotes([VALID])
    expect(remotes[0]?.port).toBe(22)
    expect(remotes[0]?.connectTimeoutMs).toBe(20_000)
    expect(remotes[0]?.keepaliveIntervalMs).toBe(15_000)
  })

  it('drops one bad entry by index and reason, keeping the rest', () => {
    const parsed = parseConfiguredRemotes([VALID, { ...VALID, id: 'other', port: 70_000 }])
    expect(parsed.remotes.map((remote) => remote.id)).toEqual(['box'])
    expect(parsed.rejected).toHaveLength(1)
    expect(parsed.rejected[0]?.index).toBe(1)
    expect(parsed.rejected[0]?.reason).toContain('port')
  })

  it('keeps the command-shaping fields the transport forwards to remoteBridgeCommand', () => {
    const { remotes } = parseConfiguredRemotes([
      { ...VALID, herdrBinary: '/opt/herdr', session: 'work', env: { HERDR_SOCKET_PATH: '/tmp/s' } }
    ])
    expect(remotes[0]?.herdrBinary).toBe('/opt/herdr')
    expect(remotes[0]?.session).toBe('work')
    expect(remotes[0]?.env).toEqual({ HERDR_SOCKET_PATH: '/tmp/s' })
  })
})
