// Not from orca. The receipt for the half of §Q that `ce61f10e` named on its way out: the *setting*
// side of the pane header, and the teardown that rides with it.
//
// `PaneObserver.attach()` awaits three things — `pane.layout`, the exec channel, the `Hello` write
// — and until now its `catch` was the one callback in that file with no `generation` check (the
// other five gate on `generation === this.attachSeq`). A rejection that arrived after the observer
// had already moved on therefore ran the full failure path *on the generation that replaced it*:
//
//   1. `setStatus('failed')` on a stream that is observing,
//   2. `onError` — the stale string the QA agent photographed over live frames,
//   3. `streamDown()`, which is the one that costs something real: it bumps `attachSeq`, closes the
//      **live** channel and arms the ladder. A working picture torn down by a corpse.
//
// It is not a narrow race either, since `b411ef04` put a `connectTimeoutMs` (20s) deadline on
// `openChannel`: an exec channel that never gets approved is *guaranteed* to reject, twenty seconds
// after the dial, and any re-attach inside that window opens this door. `8f794748` made re-attaches
// more frequent in the same release.
//
// The sequence below is that door, driven entirely through the observer's own API — no generation
// is poked, nothing is reached into. What it needs that `./pane-observer-reattach.test.ts` does not
// is a *write* whose promise the test settles by hand, because the late rejection is the whole
// subject; `FakeTransport`'s writes are synchronous and can never be late. Time is
// `test/fake-clock.ts`, so "the ladder fired a rung" is a deterministic step rather than a sleep.
import { describe, expect, it } from 'vitest'
import {
  decodeServerMessage,
  type JsonApiClient,
  type ServerMessage,
  type ServerMessageChannel,
  type ServerMessageChannelHandlers
} from '@herdr/client-ts'
import { fromHex } from '../../../packages/herdr-client-ts/test/helpers'
import { WELCOME_OK_ANSI_V21 } from '../../../packages/herdr-client-ts/test/vectors'
import { FakeClock, flushMicrotasks } from '../../test/fake-clock'
import { PaneObserver, type PaneObserverStatus } from './pane-observer'
import type { RemoteDefinition } from '../api/herdr-api-types'

const REMOTE: RemoteDefinition = {
  id: 'remote-1',
  name: 'fable-m5max',
  target: { type: 'local' }
}

const LAYOUT = {
  workspace_id: 'w1',
  tab_id: 'w1:t1',
  zoomed: false,
  area: { x: 26, y: 1, width: 54, height: 23 },
  focused_pane_id: 'w1:p1',
  panes: [{ pane_id: 'w1:p1', focused: true, rect: { x: 26, y: 1, width: 54, height: 23 } }],
  splits: []
}

/** The golden `Welcome`, decoded once — the same bytes the wire tests hand the codec. */
const WELCOME: ServerMessage = decodeServerMessage(fromHex(WELCOME_OK_ANSI_V21))

/** What the Android ssh module throws once the session under the exec channel is gone. */
const DIAL_FAILURE = 'IllegalStateException: Not connected'
/** …and what `redialable-transport.ts` throws for a write on a channel that has already died. */
const WRITE_FAILURE = 'the transport is closed'

type HeldStream = {
  handlers: ServerMessageChannelHandlers
  sent: Uint8Array[]
  closed: boolean
  /**
   * Settles this stream's writes. `null` means "resolve at once" (a healthy channel); a function
   * parks the write until the test rejects it, which is the late rejection under test.
   */
  rejectWrite: ((error: Error) => void) | null
}

/**
 * A connection whose streams the test holds, so a write can be answered *later*.
 *
 * Nothing about the observer is faked: this is `HerdrRemoteConnection`'s two methods and no more,
 * the same seam `./pane-observer-stale-error.test.tsx` uses for the property the wire cannot reach.
 */
function heldConnection(options: { parkFirstWrite?: boolean } = {}) {
  const streams: HeldStream[] = []
  const state = { offline: false }
  const connection = {
    remote: REMOTE,
    api: {
      request: () => Promise.resolve({ type: 'pane_layout', layout: LAYOUT })
    } as unknown as JsonApiClient,
    openTerminalStream: (handlers: ServerMessageChannelHandlers) => {
      if (state.offline) {
        return Promise.reject(new Error(DIAL_FAILURE))
      }
      const park = options.parkFirstWrite === true && streams.length === 0
      const stream: HeldStream = { handlers, sent: [], closed: false, rejectWrite: null }
      streams.push(stream)
      return Promise.resolve({
        send: (bytes: Uint8Array) => {
          stream.sent.push(bytes)
          if (!park) {
            return undefined
          }
          return new Promise<void>((_resolve, reject) => {
            stream.rejectWrite = reject
          })
        },
        close: () => {
          stream.closed = true
        }
      } as unknown as ServerMessageChannel)
    }
  }
  return {
    connection,
    streams,
    get offline() {
      return state.offline
    },
    set offline(next: boolean) {
      state.offline = next
    }
  }
}

type Probe = {
  observer: PaneObserver
  clock: FakeClock
  statuses: PaneObserverStatus[]
  errors: string[]
}

function observe(connection: ReturnType<typeof heldConnection>): Probe {
  const clock = new FakeClock()
  const statuses: PaneObserverStatus[] = []
  const errors: string[] = []
  const observer = new PaneObserver({
    connection: connection.connection,
    paneId: 'w1:p1',
    target: { init: () => {}, resize: () => {}, write: () => {} },
    timer: clock.timer,
    events: {
      onStatus: (status) => statuses.push(status),
      onError: (error) => errors.push(error.message)
    }
  })
  return { observer, clock, statuses, errors }
}

describe('a late failure belongs to the generation that suffered it', () => {
  it('does not let a dead generation’s rejected write fail, blank or tear down the live stream', async () => {
    const held = heldConnection({ parkFirstWrite: true })
    const { observer, clock, statuses, errors } = observe(held)

    // Generation 1 takes a channel and parks on its `Hello` write — the shape of an exec channel
    // that was accepted and then stopped moving (`connectTimeoutMs`'s subject).
    void observer.start()
    await flushMicrotasks()
    expect(held.streams).toHaveLength(1)
    expect(observer.status).toBe('connecting')

    // The same channel dies. That is generation 1's failure and it is reported, as it should be —
    // and `streamDown` arms the ladder.
    held.streams[0]?.handlers.onError?.(new Error(DIAL_FAILURE))
    expect(observer.status).toBe('failed')
    expect(errors).toEqual([DIAL_FAILURE])

    // The ladder re-attaches. Generation 2 gets a healthy channel and a `Welcome`, and the screen
    // is live again — this is the stream the stale rejection is about to arrive next to.
    clock.advance(1000)
    await flushMicrotasks()
    expect(held.streams).toHaveLength(2)
    held.streams[1]?.handlers.onMessage?.(WELCOME)
    expect(observer.status).toBe('observing')
    const publishedStatuses = statuses.length

    // Now generation 1's write finally rejects. Twenty seconds late, on a channel that has been
    // closed since it died, against an observer that has moved on twice.
    held.streams[0]?.rejectWrite?.(new Error(WRITE_FAILURE))
    await flushMicrotasks()

    // Nothing. Not the status…
    expect(observer.status).toBe('observing')
    expect(statuses).toHaveLength(publishedStatuses)
    // …not the header (this string is what the QA agent read over live frames)…
    expect(errors).toEqual([DIAL_FAILURE])
    // …and above all not `streamDown`: the live channel is still open and the ladder did not fire
    // a rung against a stream that never went down.
    expect(held.streams[1]?.closed).toBe(false)
    const attached = observer.reattachCount
    clock.advance(120_000)
    await flushMicrotasks()
    expect(held.streams).toHaveLength(2)
    expect(observer.reattachCount).toBe(attached)

    observer.close()
  })

  it('still reports the current generation’s failure — failed, onError, and a rung armed', async () => {
    const held = heldConnection()
    held.offline = true
    const { observer, clock, statuses, errors } = observe(held)

    await observer.start()
    await flushMicrotasks()
    expect(observer.status).toBe('failed')
    expect(statuses).toEqual(['connecting', 'failed'])
    expect(errors).toEqual([DIAL_FAILURE])

    // The ladder is armed, which is the third thing `fail` does and the one a guard could silently
    // remove: a failure freezes the picture exactly as a close does and earns the same repair.
    expect(observer.reattachCount).toBe(0)
    clock.advance(1000)
    await flushMicrotasks()
    expect(observer.reattachCount).toBe(1)

    observer.close()
  })

  it('says nothing when the rejection lands after the screen is gone', async () => {
    const held = heldConnection({ parkFirstWrite: true })
    const { observer, clock, statuses, errors } = observe(held)

    void observer.start()
    await flushMicrotasks()
    expect(held.streams).toHaveLength(1)

    // The screen unmounted. `close()` does not move `attachSeq`, so this case is guarded by
    // `disposed` and by nothing else — and `streamDown`'s own `disposed` check is too late, since
    // `setStatus` and `onError` fire before it.
    observer.close()
    const publishedStatuses = statuses.length

    held.streams[0]?.rejectWrite?.(new Error(WRITE_FAILURE))
    await flushMicrotasks()

    expect(statuses).toHaveLength(publishedStatuses)
    expect(statuses).not.toContain('failed')
    expect(errors).toEqual([])
    // …and no rung armed behind an unmounted screen: that is an ssh exec and a remote `herdr`
    // process (B8) spent on a picture with no reader.
    clock.advance(120_000)
    await flushMicrotasks()
    expect(held.streams).toHaveLength(1)
  })
})
