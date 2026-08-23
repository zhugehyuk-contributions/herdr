// `.prd/11-mockup-conformance.md` 누락 #9 as a test. The mockup's line (`assets/mockup.html:460`)
// is `✓ reachable · herdr 0.34.1 · protocol 12 · 41ms`, and the two halves fail differently: the
// parser eats output whose shape belongs to the *server*, and the renderer has to be able to say
// the failure as legibly as the success — an add-remote form that only ever says "✗" is the state
// this feature exists to leave behind.
import { describe, expect, it } from 'vitest'
import { describeProbe, parseHerdrVersion } from './probe'

describe('parseHerdrVersion', () => {
  it('reads the version herdr actually prints', () => {
    expect(parseHerdrVersion('herdr 0.8.2\n')).toEqual({ version: '0.8.2', protocol: null })
  })

  it('picks up a protocol number when the build prints one', () => {
    expect(parseHerdrVersion('herdr 0.34.1 (protocol 12)')).toEqual({
      version: '0.34.1',
      protocol: '12'
    })
  })

  it('never returns an empty version — the line is worthless without it', () => {
    // A format change must degrade to "something the user can read and report", not to a line that
    // says `herdr  ·` with a hole in it.
    expect(parseHerdrVersion('').version).toBe('unknown')
    expect(parseHerdrVersion('some-other-binary 1.2').version).toBe('some-other-binary')
  })
})

describe('describeProbe', () => {
  it('renders the mockup line on success', () => {
    expect(describeProbe({ ok: true, version: '0.34.1', protocol: '12', elapsedMs: 41 })).toBe(
      '✓ reachable · herdr 0.34.1 · protocol 12 · 41ms'
    )
  })

  it('drops the protocol clause rather than printing an empty one', () => {
    expect(describeProbe({ ok: true, version: '0.8.2', protocol: null, elapsedMs: 7 })).toBe(
      '✓ reachable · herdr 0.8.2 · 7ms'
    )
  })

  it('says the failure, and how long it took to find out', () => {
    // The elapsed time is on the failure branch too on purpose: "refused in 40ms" and "gave up
    // after 8000ms" are a wrong key and an unreachable host, and the user is the one who has to
    // tell them apart.
    expect(describeProbe({ ok: false, reason: 'auth failed', elapsedMs: 40 })).toBe(
      '✗ auth failed · 40ms'
    )
  })
})
