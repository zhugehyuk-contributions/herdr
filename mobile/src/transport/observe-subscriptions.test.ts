// Not from orca. orca tests `updateTerminalSubscriptionViewport` only through the 293-line
// resubscribe/fit loop this port drops whole (08-orca-port-map.md §6 위험 3), so X1b arrives here
// without a test to bring with it.
//
// X1 and X1b are the two failure modes that *look like success*: the dot goes green and the pane
// stays frozen (X1), or the pane comes back at the size the phone had ten minutes ago (X1b). Both
// are invisible to an "no errors thrown" check, which is why these assertions are about the
// registry's contents rather than about the absence of exceptions.
import { describe, expect, it } from 'vitest'
import { ObserveSubscriptionRegistry } from './observe-subscriptions'

function registry() {
  const it = new ObserveSubscriptionRegistry()
  const a = it.add({ paneId: 'w1:p1', cols: 120, rows: 40 })
  const b = it.add({ paneId: 'w1:p2', cols: 120, rows: 40 })
  it.markSent(a.id)
  it.markSent(b.id)
  return { registry: it, a, b }
}

describe('X1 — every subscription survives the connection that carried it', () => {
  it('a dead channel owes a replay for each live subscription', () => {
    const { registry: reg } = registry()
    expect(reg.pendingReplay()).toHaveLength(0)

    const marked = reg.markStreamsForReplay()
    expect(marked).toBe(2)
    expect(reg.pendingReplay().map((s) => s.paneId)).toEqual(['w1:p1', 'w1:p2'])
    process.stdout.write(
      `[X1] after link death: ${reg
        .list()
        .map((s) => `${s.paneId}{${s.cols}x${s.rows} sent=${s.sent}}`)
        .join(' ')}\n`
    )
  })

  it('the replay debt shrinks only as sends actually go out', () => {
    const { registry: reg, a } = registry()
    reg.markStreamsForReplay()
    reg.markSent(a.id)
    // A partial replay is the realistic case: one channel opened, the second exec was refused.
    expect(reg.pendingReplay().map((s) => s.paneId)).toEqual(['w1:p2'])
  })

  it('marking twice is idempotent — a second close does not invent extra debt', () => {
    const { registry: reg } = registry()
    expect(reg.markStreamsForReplay()).toBe(2)
    // Nothing was `sent` any more, so the second death has nothing to un-send.
    expect(reg.markStreamsForReplay()).toBe(0)
    expect(reg.pendingReplay()).toHaveLength(2)
  })

  it('an unsubscribed pane is not replayed — a closed viewer must not reopen on reconnect', () => {
    const { registry: reg, a } = registry()
    reg.remove(a.id)
    reg.markStreamsForReplay()
    expect(reg.pendingReplay().map((s) => s.paneId)).toEqual(['w1:p2'])
    expect(reg.size).toBe(1)
  })
})

describe('X1b — the replay carries the newest viewport, not the one it was born with', () => {
  it('updates the stored params in place, so the next Hello is current', () => {
    const { registry: reg, a } = registry()
    // The phone rotated while the link was up. herdr's observe mode never resizes the pane
    // (02-architecture.md §2.3), so this is only ever a note for the *next* handshake.
    expect(reg.updateObserveViewport('w1:p1', { cols: 80, rows: 24 })).toBe(1)
    reg.markStreamsForReplay()
    const replayed = reg.pendingReplay().find((s) => s.id === a.id)
    expect(replayed).toMatchObject({ paneId: 'w1:p1', cols: 80, rows: 24 })
    // Untouched panes keep theirs.
    expect(reg.get(reg.list()[1]?.id ?? '')).toMatchObject({ cols: 120, rows: 40 })
  })

  it('a viewport change while disconnected still reaches the replay', () => {
    const { registry: reg, a } = registry()
    reg.markStreamsForReplay()
    reg.updateObserveViewport('w1:p1', { cols: 200, rows: 60 })
    expect(reg.pendingReplay().find((s) => s.id === a.id)).toMatchObject({ cols: 200, rows: 60 })
  })

  it('geometry and target live in one record — the half that reintroduces X1b cannot happen', () => {
    // 05-orca-transport.md: "재연결 `Hello`의 cols/rows + observe 타깃을 함께 저장". A `Hello` from one
    // generation paired with an `ObserveTerminal` from another *is* "예전 크기로 붙음", so the type
    // itself has to make them inseparable.
    const { registry: reg, a } = registry()
    const entry = reg.get(a.id)
    expect(Object.keys(entry ?? {}).sort()).toEqual(['cols', 'id', 'paneId', 'rows', 'sent'])
  })

  it('updating a pane nobody observes changes nothing and says so', () => {
    const { registry: reg } = registry()
    expect(reg.updateObserveViewport('w9:p9', { cols: 1, rows: 1 })).toBe(0)
  })
})
