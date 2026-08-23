import { describe, expect, it } from 'vitest'
import { draftFromPairing, parseRemoteDraft } from './remote-form'

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----'

describe('draftFromPairing (목표 조건 5)', () => {
  it('fills the form a scan can fill, and nothing else', () => {
    const draft = draftFromPairing({
      name: 'iq-64',
      host: '10.0.2.2',
      port: 2222,
      user: 'z',
      session: 'work',
      key: KEY
    })
    expect(draft).toMatchObject({
      id: 'z-10.0.2.2-2222',
      name: 'iq-64',
      host: '10.0.2.2',
      port: '2222',
      username: 'z',
      session: 'work',
      privateKey: KEY
    })
    // A code carries a target and a key. It does not carry the user's decision to dial a host whose
    // identity nothing has pinned — defaulting this to true because the transport was a photograph
    // would be the app answering a security question on the user's behalf.
    expect(draft.allowUnknownHostKey).toBe(false)
    expect(draft.hostKeySha256).toBe('')
    expect(draft.passphrase).toBe('')
  })

  it('produces a draft the existing validator accepts — the scan path saves through the same gate', () => {
    const draft = draftFromPairing({ host: 'box', port: 22, user: 'z', key: KEY })
    const parsed = parseRemoteDraft({ ...draft, allowUnknownHostKey: true }, { mode: 'create' })
    expect(parsed.ok).toBe(true)
  })

  it('leaves the key field empty for a prefill-only code, so the form asks for it', () => {
    const draft = draftFromPairing({ host: 'box', port: 22, user: 'z' })
    expect(draft.privateKey).toBe('')
    expect(draft.name).toBe('box')
  })
})
