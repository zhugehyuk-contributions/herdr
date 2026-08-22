// Not from orca. Reads what an ssh private key *is* without keeping any of it — the one question a
// settings screen has to answer about a secret it is forbidden to display.
//
// Why the app needs this at all: the two platforms do not accept the same keys, and the gap is not
// symmetric (`mobile/.prd/06-open-decisions.md` 결정 7).
//   · Android (sshj 0.40.0, `client.loadKeys` — `android/.../HerdrSshSession.kt:134`) sniffs the
//     header and takes all four shapes `ssh-keygen` emits, encrypted ones included.
//   · iOS (Citadel 0.12.1) takes an *unencrypted openssh-key-v1* key and nothing else: the classic
//     PEM container is refused before parsing (`Citadel/Sources/Citadel/OpenSSHKey.swift:307-313`),
//     a passphrase is refused by our own code (`ios/HerdrSshSession.swift:68-72`), and an RSA key
//     that parses still signs with the SHA-1 `ssh-rsa` prefix
//     (`Citadel/Sources/Citadel/Algorithms/RSA.swift:141`), which OpenSSH ≥ 8.8 rejects by default
//     (<https://www.openssh.com/txt/release-8.8>).
// So "this key works" is a per-platform fact, and a user who is told nothing finds out as
// `Exhausted available authentication methods` on a phone with no logs.
//
// The parse is deliberately shallow: the container line, then the first ~120 bytes of the
// openssh-key-v1 blob (OpenSSH `PROTOCOL.key`: magic, ciphername, kdfname, kdfoptions, count, then
// the public key, whose first field is the algorithm). Nothing past the public key is read, so the
// private half never enters a variable this file returns.

/** The wrapper `-----BEGIN …-----` names, which is the part every tool agrees on. */
export type PrivateKeyContainer = 'openssh-v1' | 'pem' | 'unknown'

export interface PrivateKeyDescriptor {
  container: PrivateKeyContainer
  /** `ssh-ed25519` / `ssh-rsa` / … as the blob spells it; `null` when it could not be read. */
  algorithm: string | null
  /** openssh-key-v1 `ciphername` is anything but `none`, i.e. the key needs a passphrase. */
  encrypted: boolean
}

const OPENSSH_MAGIC = 'openssh-key-v1'

export function describePrivateKey(text: string): PrivateKeyDescriptor {
  if (text.includes('BEGIN OPENSSH PRIVATE KEY')) {
    return describeOpensshV1(text)
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    // `BEGIN RSA/DSA/EC/ENCRYPTED PRIVATE KEY`: the classic PEM family. Nothing further is read —
    // the algorithm is in the DER body and no consumer here needs it, since iOS refuses the
    // container outright and Android accepts all of them.
    return { container: 'pem', algorithm: null, encrypted: false }
  }
  return { container: 'unknown', algorithm: null, encrypted: false }
}

function describeOpensshV1(text: string): PrivateKeyDescriptor {
  const body = text
    .split('\n')
    .filter((line) => !line.startsWith('-----') && line.trim().length > 0)
    .join('')
  // 160 bytes covers magic + ciphername + kdfname + kdfoptions + count + the public key's algorithm
  // for every key `ssh-keygen` produces; a longer read would only decode key material.
  const bytes = decodeBase64(body, 160)
  const reader = { bytes, offset: 0 }
  if (readAscii(reader, OPENSSH_MAGIC.length + 1) !== `${OPENSSH_MAGIC}\0`) {
    return { container: 'openssh-v1', algorithm: null, encrypted: false }
  }
  const cipher = readField(reader)
  readField(reader) // kdfname
  readField(reader) // kdfoptions
  readUint32(reader) // number of keys
  const publicKeyLength = readUint32(reader)
  const algorithm = publicKeyLength === null ? null : readField(reader)
  return {
    container: 'openssh-v1',
    algorithm: algorithm === null || algorithm.length === 0 ? null : algorithm,
    encrypted: cipher !== null && cipher !== 'none'
  }
}

interface Reader {
  bytes: number[]
  offset: number
}

function readUint32(reader: Reader): number | null {
  if (reader.offset + 4 > reader.bytes.length) {
    return null
  }
  const value =
    ((reader.bytes[reader.offset] as number) << 24) |
    ((reader.bytes[reader.offset + 1] as number) << 16) |
    ((reader.bytes[reader.offset + 2] as number) << 8) |
    (reader.bytes[reader.offset + 3] as number)
  reader.offset += 4
  return value >>> 0
}

function readAscii(reader: Reader, length: number): string | null {
  if (reader.offset + length > reader.bytes.length) {
    return null
  }
  const slice = reader.bytes.slice(reader.offset, reader.offset + length)
  reader.offset += length
  return String.fromCodePoint(...slice)
}

/** One `uint32`-prefixed string, or `null` if the blob ends inside it. */
function readField(reader: Reader): string | null {
  const length = readUint32(reader)
  // A length that cannot be a name is a truncated or malformed blob, not a field to trust.
  if (length === null || length > 64) {
    return null
  }
  return readAscii(reader, length)
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Base64 -> bytes, hand-rolled and bounded.
 *
 * Hand-rolled for the same reason `packages/herdr-client-ts` hand-writes its UTF-8: Hermes is not
 * Node, `Buffer` does not exist, and `atob` is a browser global this bundle must not assume.
 * Bounded because the caller only ever wants the header — decoding the rest would materialise the
 * private half of the key as an array of numbers for no reason at all.
 */
function decodeBase64(text: string, maxBytes: number): number[] {
  const out: number[] = []
  let accumulator = 0
  let bits = 0
  for (const char of text) {
    const value = BASE64_ALPHABET.indexOf(char)
    if (value === -1) {
      // `=` padding, whitespace, anything else: stop rather than guess.
      break
    }
    accumulator = (accumulator << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((accumulator >> bits) & 0xff)
      if (out.length >= maxBytes) {
        break
      }
    }
  }
  return out
}

/**
 * What to tell the user about a key, in the words of the platform that will refuse it.
 *
 * Advisories, not errors: every shape below authenticates on Android, so refusing to store one
 * would break the platform that works to protect the one that does not. The screen shows them; the
 * store takes the key either way.
 */
export function privateKeyAdvisories(
  descriptor: PrivateKeyDescriptor,
  options: { hasPassphrase: boolean }
): string[] {
  const advisories: string[] = []
  if (descriptor.container === 'pem') {
    advisories.push(
      'iOS reads openssh-key-v1 keys only — this is a classic PEM key. `ssh-keygen -p -f <key>` rewrites it in place. Android accepts it as is.'
    )
  }
  if (descriptor.algorithm === 'ssh-rsa') {
    advisories.push(
      'iOS signs RSA keys with ssh-rsa (SHA-1), which OpenSSH 8.8+ refuses — this key will not authenticate on iOS. Android accepts it; `ssh-keygen -t ed25519` works on both.'
    )
  }
  if (descriptor.encrypted || options.hasPassphrase) {
    advisories.push(
      'iOS refuses passphrase-protected keys (they are untested there, and a wrong decryption reads as an auth failure). Android accepts them with the passphrase below.'
    )
  }
  return advisories
}
