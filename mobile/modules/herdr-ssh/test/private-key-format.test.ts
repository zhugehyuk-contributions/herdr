// Not from orca. What the settings screen is allowed to say about a key the user just pasted —
// and it is allowed to say it only because this file reads the key's own header bytes rather than
// guessing from the `-----BEGIN` line.
//
// The stakes are `.prd/06-open-decisions.md` 결정 7: Android's sshj `loadKeys` takes all four shapes
// `ssh-keygen` emits, and iOS takes exactly one — an unencrypted ed25519 in the openssh-key-v1
// container. A user who pastes an RSA key gets a working Android app and a silent auth failure on
// iOS, and "silent" is the part this turns into a sentence on screen.
//
// Fixtures are *synthesised* here, byte by byte, instead of pasted from `ssh-keygen`: a real private
// key in a committed test file is the exact thing M2b exists to stop, and a hand-built blob proves
// more anyway — it says which field the parser read.
import { describe, expect, it } from 'vitest'
import { describePrivateKey, privateKeyAdvisories } from '../src/private-key-format'

/** `string` -> the openssh wire form: a big-endian u32 length followed by the bytes. */
function field(text: string): number[] {
  const bytes = [...text].map((char) => char.codePointAt(0) as number)
  return [0, 0, (bytes.length >> 8) & 0xff, bytes.length & 0xff, ...bytes]
}

function base64(bytes: number[]): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const chunk = [bytes[index] ?? 0, bytes[index + 1] ?? 0, bytes[index + 2] ?? 0]
    const bits = (chunk[0] << 16) | (chunk[1] << 8) | chunk[2]
    const taken = Math.min(3, bytes.length - index)
    out += alphabet[(bits >> 18) & 63]
    out += alphabet[(bits >> 12) & 63]
    out += taken > 1 ? alphabet[(bits >> 6) & 63] : '='
    out += taken > 2 ? alphabet[bits & 63] : '='
  }
  return out
}

/**
 * The openssh-key-v1 prologue exactly as `ssh-keygen` writes it — OpenSSH `PROTOCOL.key`:
 * `"openssh-key-v1\0"`, ciphername, kdfname, kdfoptions, number-of-keys, then each public key as a
 * length-prefixed blob whose own first field is the algorithm name.
 */
function opensshKey(options: { cipher: string; algorithm: string }): string {
  const magic = [...'openssh-key-v1'].map((char) => char.codePointAt(0) as number).concat(0)
  // Padding stands in for the rest of the public key; nothing reads past the algorithm name.
  const publicKey = [...field(options.algorithm), ...Array.from({ length: 32 }, () => 7)]
  const bytes = [
    ...magic,
    ...field(options.cipher),
    ...field(options.cipher === 'none' ? 'none' : 'bcrypt'),
    ...field(''),
    0,
    0,
    0,
    1,
    0,
    0,
    (publicKey.length >> 8) & 0xff,
    publicKey.length & 0xff,
    ...publicKey
  ]
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${base64(bytes)}\n-----END OPENSSH PRIVATE KEY-----\n`
}

describe('describePrivateKey', () => {
  it('reads the algorithm out of an openssh-key-v1 blob', () => {
    expect(describePrivateKey(opensshKey({ cipher: 'none', algorithm: 'ssh-ed25519' }))).toEqual({
      container: 'openssh-v1',
      algorithm: 'ssh-ed25519',
      encrypted: false
    })
    expect(describePrivateKey(opensshKey({ cipher: 'none', algorithm: 'ssh-rsa' }))).toMatchObject({
      algorithm: 'ssh-rsa'
    })
  })

  it('reads the cipher, which is the only thing that says a key is passphrase-protected', () => {
    expect(
      describePrivateKey(opensshKey({ cipher: 'aes256-ctr', algorithm: 'ssh-ed25519' }))
    ).toMatchObject({ encrypted: true, algorithm: 'ssh-ed25519' })
  })

  it('recognises the classic PEM container without pretending to read its contents', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----\n'
    expect(describePrivateKey(pem)).toEqual({ container: 'pem', algorithm: null, encrypted: false })
  })

  it('says "unknown" rather than guessing at anything else', () => {
    expect(describePrivateKey('ssh-ed25519 AAAAC3Nz z@fable')).toEqual({
      container: 'unknown',
      algorithm: null,
      encrypted: false
    })
    expect(describePrivateKey('')).toMatchObject({ container: 'unknown' })
  })

  it('survives a truncated blob instead of throwing into the form', () => {
    const truncated = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----'
    expect(describePrivateKey(truncated)).toMatchObject({
      container: 'openssh-v1',
      algorithm: null
    })
  })
})

describe('privateKeyAdvisories', () => {
  it('says nothing about the one shape both platforms accept', () => {
    expect(
      privateKeyAdvisories(
        { container: 'openssh-v1', algorithm: 'ssh-ed25519', encrypted: false },
        { hasPassphrase: false }
      )
    ).toEqual([])
  })

  it('names iOS, not "your key", for every shape iOS refuses', () => {
    const pem = privateKeyAdvisories(
      { container: 'pem', algorithm: null, encrypted: false },
      { hasPassphrase: false }
    )
    expect(pem).toHaveLength(1)
    expect(pem[0]).toContain('iOS')
    expect(pem[0]).toContain('openssh-key-v1')

    const rsa = privateKeyAdvisories(
      { container: 'openssh-v1', algorithm: 'ssh-rsa', encrypted: false },
      { hasPassphrase: false }
    )
    expect(rsa[0]).toContain('iOS')
    expect(rsa[0]).toContain('ssh-rsa')

    const encrypted = privateKeyAdvisories(
      { container: 'openssh-v1', algorithm: 'ssh-ed25519', encrypted: true },
      { hasPassphrase: true }
    )
    expect(encrypted[0]).toContain('iOS')
  })

  it('warns about a passphrase even when the key blob cannot be read', () => {
    const advisories = privateKeyAdvisories(
      { container: 'unknown', algorithm: null, encrypted: false },
      { hasPassphrase: true }
    )
    expect(advisories.some((line) => line.includes('passphrase'))).toBe(true)
  })
})
