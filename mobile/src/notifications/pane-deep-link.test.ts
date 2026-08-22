// Not from orca. The link is a **cross-language contract**: `sender/drain.py`'s `build_payload`
// writes it in Python and this app reads it in TypeScript, and nothing type-checks the pair. So the
// canonical strings below are copied from the producer's own tests
// (`plugins/herdr-blocked-push/receipt/test_drain.py`, "command adapter: url delivered" and the
// expo checks) rather than re-derived here — if the two ever disagree, one of these fails.
import { describe, expect, it } from 'vitest'
import { paneDeepLink, parsePaneDeepLink, paneTargetHref } from './pane-deep-link'

describe('pane deep link', () => {
  it('parses the canonical form the sender emits', () => {
    expect(parsePaneDeepLink('herdr:///h/fable/pane/w1%3Ap1')).toEqual({
      remoteId: 'fable',
      paneId: 'w1:p1'
    })
  })

  it('round-trips a pane id through the encoder the sender mirrors', () => {
    const target = { remoteId: 'oud wood', paneId: 'w1:p1' }
    expect(paneDeepLink(target)).toBe('herdr:///h/oud%20wood/pane/w1%3Ap1')
    expect(parsePaneDeepLink(paneDeepLink(target))).toEqual(target)
  })

  it('also accepts the two-slash spelling, which parses as a host elsewhere', () => {
    // `herdr://h/x/pane/y` is what a hand-written config or an older sender produces, and a strict
    // URL parser reads its `h` as the authority. Refusing it would strand a tap for a reason the
    // user cannot see.
    expect(parsePaneDeepLink('herdr://h/fable/pane/w1%3Ap1')).toEqual({
      remoteId: 'fable',
      paneId: 'w1:p1'
    })
  })

  it('refuses anything that is not a pane', () => {
    for (const url of [
      'https://example.com/h/fable/pane/p1',
      'herdr:///h/fable/pane',
      'herdr:///h/fable/tab/p1',
      'herdr:///settings',
      'herdr:///h//pane/p1',
      // A malformed escape: `decodeURIComponent` throws, and a notification payload is data from
      // outside the program.
      'herdr:///h/fable/pane/%zz',
      '',
      null,
      undefined,
      42
    ]) {
      expect(parsePaneDeepLink(url), String(url)).toBeNull()
    }
  })

  it('lands on the same href the agents list navigates to', () => {
    // One definition of a pane's address, so a tap and a tap on the list cannot drift.
    expect(paneTargetHref({ remoteId: 'fable', paneId: 'w1:p1' })).toBe('/h/fable/pane/w1:p1')
  })
})
