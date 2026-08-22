// Not from orca. The precedence rule between the two places a remote can come from, isolated from
// both of them: `selectRemotes` is a pure function so "the keystore wins" is a fact one assertion
// can hold, rather than something you have to boot a phone to find out.
//
// Why it is worth its own file: before M2b the only source was `app.json`'s `expo.extra.herdrRemotes`
// — a committed file that ships inside the APK — and the whole point of the milestone is that the
// build-time channel becomes a *development* convenience that a real install never reads.
import { describe, expect, it } from 'vitest'
import { selectRemotes } from '../src/remote-source'
import type { HerdrSshRemoteConfig } from '../src/remote-config'

function remote(id: string, host: string): HerdrSshRemoteConfig {
  return {
    id,
    host,
    port: 22,
    username: 'z',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n',
    connectTimeoutMs: 20_000,
    keepaliveIntervalMs: 15_000
  }
}

describe('selectRemotes', () => {
  it('lets the keystore win over app.json, entirely — not per id', () => {
    const selection = selectRemotes({
      stored: [remote('mine', 'my.box')],
      bundled: [remote('lab', 'lab.box'), remote('mine', 'stale.box')],
      allowBundledFallback: true
    })
    expect(selection.source).toBe('stored')
    expect(selection.remotes.map((entry) => entry.host)).toEqual(['my.box'])
    // Not a merge: a bundled entry the user never saw must not become a host the phone dials just
    // because its id happens to be absent from the store.
    expect(selection.ignoredBundled).toBe(2)
  })

  it('falls back to app.json only while the fallback is allowed', () => {
    const bundled = [remote('lab', 'lab.box')]
    expect(selectRemotes({ stored: [], bundled, allowBundledFallback: true })).toMatchObject({
      source: 'bundled',
      ignoredBundled: 0
    })
    const release = selectRemotes({ stored: [], bundled, allowBundledFallback: false })
    expect(release.source).toBe('none')
    expect(release.remotes).toEqual([])
    // Reported rather than dropped silently: a release build that quietly ignores a configured
    // remote is indistinguishable from one that failed to read it.
    expect(release.ignoredBundled).toBe(1)
  })

  it('reports "none" when neither source has anything', () => {
    expect(selectRemotes({ stored: [], bundled: [], allowBundledFallback: true })).toEqual({
      remotes: [],
      source: 'none',
      ignoredBundled: 0
    })
  })
})
