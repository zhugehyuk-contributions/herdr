// Not from orca. The settings form's whole non-visual half: a screenful of strings becomes either a
// `HerdrSshRemoteConfig` the dialler can use or a per-field reason the user can act on.
//
// Kept out of the screen because the interesting cases (a port typo, an id that cannot be a keystore
// key, an edit that must not carry the key through React state) are decisions, not pixels — and a
// decision that only a mounted renderer can reach is a decision nobody re-checks.
import { describe, expect, it } from 'vitest'
import { draftFromRemote, emptyDraft, parseRemoteDraft } from './remote-form'
import type { StoredRemoteSummary } from '../../modules/herdr-ssh'

const KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----\n'

function filled(): ReturnType<typeof emptyDraft> {
  return { ...emptyDraft(), id: 'fable', host: '192.168.50.10', username: 'z', privateKey: KEY }
}

describe('parseRemoteDraft', () => {
  it('turns a filled draft into a config the dialler accepts, defaults included', () => {
    const result = parseRemoteDraft(filled(), { mode: 'create' })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.kind).toBe('full')
    expect(result.config).toMatchObject({
      id: 'fable',
      host: '192.168.50.10',
      username: 'z',
      port: 22,
      connectTimeoutMs: 20_000,
      keepaliveIntervalMs: 15_000
    })
  })

  it('reports every empty required field at once, by field', () => {
    const result = parseRemoteDraft(emptyDraft(), { mode: 'create' })
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(Object.keys(result.errors).sort()).toEqual(['host', 'id', 'privateKey', 'username'])
  })

  it('rejects an id the keystore cannot hold, at the field the user typed it in', () => {
    const result = parseRemoteDraft({ ...filled(), id: 'my box' }, { mode: 'create' })
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.errors.id).toContain('letters')
  })

  it('rejects a port that is not a port', () => {
    for (const port of ['0', '70000', 'ssh', '22.5']) {
      const result = parseRemoteDraft({ ...filled(), port }, { mode: 'create' })
      expect(result.ok, `port ${port} was accepted`).toBe(false)
    }
    expect(parseRemoteDraft({ ...filled(), port: '2222' }, { mode: 'create' }).ok).toBe(true)
  })

  it('demands a key when creating and keeps the stored one when editing', () => {
    const withoutKey = { ...filled(), privateKey: '' }
    expect(parseRemoteDraft(withoutKey, { mode: 'create' }).ok).toBe(false)

    const edit = parseRemoteDraft(withoutKey, { mode: 'edit' })
    expect(edit.ok).toBe(true)
    if (!edit.ok) {
      return
    }
    // `keepKey` is what lets the edit screen hold no secret at all: the key is never read out of
    // the keystore into React state, so it cannot leak through a screenshot, a redux-style dump or
    // a crash report.
    expect(edit.kind).toBe('keepKey')
    expect(Object.hasOwn(edit.config, 'privateKey')).toBe(false)
  })

  it('normalises a pasted key to what the iOS parser can read', () => {
    // Citadel strips `\n` and then requires the text to END with the footer
    // (`modules/herdr-ssh/typecheck/ios/.build/checkouts/Citadel/Sources/Citadel/OpenSSHKey.swift:307-313`)
    // — it does not strip `\r`, so a CRLF paste fails there and nowhere else.
    const crlf = KEY.replaceAll('\n', '\r\n')
    const result = parseRemoteDraft({ ...filled(), privateKey: `  ${crlf}  ` }, { mode: 'create' })
    expect(result.ok && result.kind === 'full' && result.config.privateKey).toBe(KEY)
  })

  it('drops the optional fields the user left blank instead of storing empty strings', () => {
    const result = parseRemoteDraft(filled(), { mode: 'create' })
    expect(result.ok).toBe(true)
    if (!result.ok || result.kind !== 'full') {
      return
    }
    for (const key of ['name', 'passphrase', 'hostKeySha256', 'herdrBinary', 'session']) {
      expect(Object.hasOwn(result.config, key), `${key} was stored empty`).toBe(false)
    }
  })

  it('keeps the optional fields the user did fill', () => {
    const result = parseRemoteDraft(
      {
        ...filled(),
        name: 'fable-m5max',
        port: '2222',
        hostKeySha256: 'abc+def/123',
        herdrBinary: '/opt/herdr',
        session: 'work',
        allowUnknownHostKey: true
      },
      { mode: 'create' }
    )
    expect(result.ok && result.kind === 'full' && result.config).toMatchObject({
      name: 'fable-m5max',
      port: 2222,
      hostKeySha256: 'abc+def/123',
      herdrBinary: '/opt/herdr',
      session: 'work',
      allowUnknownHostKey: true
    })
  })
})

describe('draftFromRemote', () => {
  it('fills the form from a summary that has no key in it to begin with', () => {
    const summary: StoredRemoteSummary = {
      id: 'fable',
      name: 'fable-m5max',
      host: '192.168.50.10',
      port: 2222,
      username: 'z',
      hostKeySha256: 'abc+def/123',
      allowUnknownHostKey: false,
      herdrBinary: null,
      session: null,
      hasPassphrase: true,
      key: { container: 'openssh-v1', algorithm: 'ssh-ed25519', encrypted: false }
    }
    const draft = draftFromRemote(summary)

    expect(draft.privateKey).toBe('')
    expect(draft.passphrase).toBe('')
    // Everything that is not a secret round-trips, or an edit would silently reset it.
    expect(draft).toMatchObject({
      id: 'fable',
      name: 'fable-m5max',
      port: '2222',
      username: 'z',
      hostKeySha256: 'abc+def/123'
    })
  })

  it('copies fields by name, so a key smuggled onto the summary cannot ride along', () => {
    const contaminated = {
      id: 'fable',
      name: '',
      host: 'box',
      port: 22,
      username: 'z',
      hostKeySha256: null,
      allowUnknownHostKey: false,
      herdrBinary: null,
      session: null,
      hasPassphrase: false,
      key: { container: 'unknown', algorithm: null, encrypted: false },
      privateKey: KEY
    } as unknown as StoredRemoteSummary

    expect(JSON.stringify(draftFromRemote(contaminated))).not.toContain('OPENSSH')
  })
})
