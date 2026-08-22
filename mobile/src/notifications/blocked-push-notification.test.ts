// Not from orca. The two decisions the app makes about an arriving payload, and in particular the
// one that encodes a *server* constraint into *app* behaviour: v1 pushes `blocked` and only
// `blocked`, because `done` is `(Idle, seen == false)` and `seen` flips when the desktop looks at
// the pane (`src/app/api_helpers.rs:104-107`, live-reproduced in `.prd/09` §B4 P4).
import { describe, expect, it } from 'vitest'
import {
  foregroundBehavior,
  isBlockedPush,
  pushData,
  resolvePaneTarget
} from './blocked-push-notification'

const BLOCKED = {
  url: 'herdr:///h/fable/pane/w1%3Ap1',
  remote_id: 'fable',
  pane_id: 'w1:p1',
  status: 'blocked'
}

describe('what the app reads off a push', () => {
  it('prefers the explicit fields over the link', () => {
    // Same fact twice on purpose: the fields survive a hop that rewrites the URL.
    expect(resolvePaneTarget({ ...BLOCKED, url: 'herdr:///h/wrong/pane/wrong' })).toEqual({
      remoteId: 'fable',
      paneId: 'w1:p1'
    })
  })

  it('falls back to the link when the fields are missing', () => {
    expect(resolvePaneTarget({ url: BLOCKED.url })).toEqual({
      remoteId: 'fable',
      paneId: 'w1:p1'
    })
  })

  it('resolves nothing from a payload that names no pane', () => {
    expect(resolvePaneTarget({})).toBeNull()
    expect(resolvePaneTarget({ remote_id: 'fable' })).toBeNull()
    expect(resolvePaneTarget({ remote_id: 'fable', pane_id: '   ' })).toBeNull()
  })

  it('survives every shape of missing envelope', () => {
    expect(pushData(null)).toEqual({})
    expect(pushData(undefined)).toEqual({})
    expect(pushData({ notification: { request: { content: { data: null } } } })).toEqual({})
    expect(pushData({ notification: { request: { content: { data: BLOCKED } } } })).toEqual(BLOCKED)
  })
})

describe('blocked is the only status this milestone can vouch for', () => {
  it('raises a banner for blocked', () => {
    expect(isBlockedPush(BLOCKED)).toBe(true)
    expect(foregroundBehavior(BLOCKED)).toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false
    })
  })

  it('never interrupts for a status whose truth depends on the desktop', () => {
    // A `done` push races the desktop: `seen` has already flipped for anything the user watched
    // finish. If a future sender ever emits one, it lands in the tray silently rather than
    // buzzing the phone about something already handled.
    for (const status of ['done', 'idle', 'working', undefined]) {
      const behavior = foregroundBehavior({ ...BLOCKED, status })
      expect(behavior.shouldShowBanner, String(status)).toBe(false)
      expect(behavior.shouldPlaySound, String(status)).toBe(false)
      // Still listed: hidden is not the same as suppressed, and the user can still find it.
      expect(behavior.shouldShowList, String(status)).toBe(true)
    }
  })

  it('never sets a badge, because nothing in this app clears one', () => {
    expect(foregroundBehavior(BLOCKED).shouldSetBadge).toBe(false)
  })
})
