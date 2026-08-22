// Not from orca. Every state the settings screen can be in, because each one is a different
// *action* for the user and getting the wrong one is worse than saying nothing: "turn it on in
// system settings" for a build with no EAS project id sends someone on a twenty-minute detour.
import { describe, expect, it } from 'vitest'
import { BLOCKED_ONLY_NOTE, summarisePush } from './blocked-push-summary'
import type { BlockedPushStatus } from './use-blocked-push'

function status(overrides: Partial<BlockedPushStatus> = {}): BlockedPushStatus {
  return {
    state: 'registered',
    token: 'ExponentPushToken[abc]',
    registered: ['fable'],
    failures: [],
    error: null,
    available: true,
    ...overrides
  }
}

describe('what settings says about push', () => {
  it('says the blocked-only rule in the working state, not only in a failure', () => {
    // It is the shape of the feature, not an error message. A user who only reads it when something
    // is broken concludes that "no done notification" is the breakage.
    expect(BLOCKED_ONLY_NOTE).toContain('Only blocked is pushed')
    expect(BLOCKED_ONLY_NOTE).toContain('depends on whether the desktop has looked at that pane')
  })

  it('counts the servers that hold the token', () => {
    expect(summarisePush(status({ registered: ['a', 'b'], failures: ['c: nope'] })).headline).toBe(
      'registered on 2 of 3'
    )
  })

  it('shows every remote that refused, by name', () => {
    const summary = summarisePush(
      status({ state: 'failed', registered: [], failures: ['oud: exited 127: herdr: not found'] })
    )
    expect(summary.headline).toContain('no server')
    expect(summary.detail).toEqual(['oud: exited 127: herdr: not found'])
  })

  it('does not blame permissions for a missing project id', () => {
    const summary = summarisePush(
      status({ state: 'no-token', token: null, error: 'No "projectId" found' })
    )
    expect(summary.headline).toBe('no push token')
    expect(summary.detail.join(' ')).toContain('extra.eas.projectId')
    expect(summary.detail.join(' ')).not.toContain('system settings')
  })

  it('sends a denied user to the one place that can undo it', () => {
    const summary = summarisePush(status({ state: 'denied', token: null, registered: [] }))
    expect(summary.detail.join(' ')).toContain('system settings')
    expect(summary.detail.join(' ')).toContain('cannot ask again')
  })

  it('treats "no remote yet" as a next step, not a fault', () => {
    const summary = summarisePush(status({ state: 'no-remotes', token: null, registered: [] }))
    expect(summary.headline).toBe('nothing to register with')
    expect(summary.detail.join(' ')).toContain('Add a remote')
  })

  it('names a build with no notification module as such', () => {
    const summary = summarisePush(status({ available: false }))
    expect(summary.headline).toContain('not in this build')
    expect(summary.detail.join(' ')).toContain('development build')
  })
})
