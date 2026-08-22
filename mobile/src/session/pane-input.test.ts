// Not from orca. The phone-free half of the M3 receipt (port map §3 P1): everything about the write
// path that is a *decision* — X2's three-valued delivery and its ban on queuing, B8's merge — proved
// against a scripted `JsonApiClient` before a server is spawned.
//
// The live suite (`test/live/paneInput.live.test.tsx`) proves the other half: that what this sends
// actually moves a real pane.
import { describe, expect, it, vi } from 'vitest'
import { JsonApiClient, JsonApiError, JsonApiProtocolError } from '@herdr/client-ts'
import {
  MAX_PENDING_INPUT_CHUNKS,
  PaneInputSender,
  inputStatusLabel,
  isEmptyChunk,
  mergeChunk,
  type PaneInputState
} from './pane-input'

type Call = { method: string; params: Record<string, unknown> }

/**
 * A `JsonApiClient` whose `request` this test drives, so "one request in flight" is observable
 * rather than argued: each call parks on a promise the test resolves by hand.
 */
function scriptedApi(): {
  api: JsonApiClient
  calls: Call[]
  settle: (index: number, outcome: 'ok' | Error) => void
  pendingCount: () => number
} {
  const calls: Call[] = []
  const resolvers: ((outcome: 'ok' | Error) => void)[] = []
  const api = {
    request: (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        resolvers.push((outcome) => {
          if (outcome === 'ok') {
            resolve({ type: 'ok' })
          } else {
            reject(outcome)
          }
        })
      })
    }
  } as unknown as JsonApiClient
  return {
    api,
    calls,
    settle: (index, outcome) => {
      const resolver = resolvers[index]
      if (resolver === undefined) {
        throw new Error(`no call ${index}; ${resolvers.length} so far`)
      }
      resolver(outcome)
    },
    pendingCount: () => resolvers.length
  }
}

/** An API that answers immediately, for the cases where timing is not the subject. */
function instantApi(outcome: 'ok' | Error = 'ok'): { api: JsonApiClient; calls: Call[] } {
  const calls: Call[] = []
  const api = {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (outcome !== 'ok') {
        throw outcome
      }
      return { type: 'ok' }
    }
  } as unknown as JsonApiClient
  return { api, calls }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('mergeChunk — order is what bounds the merge', () => {
  it('concatenates text onto a keyless chunk', () => {
    expect(mergeChunk({ text: 'ab', keys: [] }, { text: 'c', keys: [] })).toEqual({
      text: 'abc',
      keys: []
    })
  })

  it('appends keys onto anything, because keys are already last on the wire', () => {
    expect(mergeChunk({ text: 'y', keys: [] }, { text: '', keys: ['enter'] })).toEqual({
      text: 'y',
      keys: ['enter']
    })
    expect(mergeChunk({ text: '', keys: ['y'] }, { text: '', keys: ['enter'] })).toEqual({
      text: '',
      keys: ['y', 'enter']
    })
  })

  it('refuses text after keys — the merge that would reorder the user', () => {
    // `encode_api_input` (`src/app/api_helpers.rs:72-84`) writes text then keys. Merging here would
    // send `abc` `\r` when the user typed `ab` `↵` `c`.
    expect(mergeChunk({ text: 'ab', keys: ['enter'] }, { text: 'c', keys: [] })).toBeNull()
  })
})

describe('PaneInputSender — X2: never queue, never assert failure', () => {
  it('refuses a tap with no transport on the spot, and does not park it', async () => {
    const sender = new PaneInputSender({ api: null, paneId: 'p1' })
    expect(await sender.sendKeys(['y'])).toEqual({ delivery: 'rejected', reason: 'no_transport' })
    expect(sender.getState().pendingChunks).toBe(0)
  })

  it('refuses a tap with no pane', async () => {
    const { api } = instantApi()
    const sender = new PaneInputSender({ api, paneId: null })
    expect(await sender.sendKeys(['y'])).toEqual({ delivery: 'rejected', reason: 'no_pane' })
  })

  it('refuses an empty chunk rather than sending a no-op request', async () => {
    const { api, calls } = instantApi()
    const sender = new PaneInputSender({ api, paneId: 'p1' })
    expect(await sender.send({ text: '', keys: [] })).toEqual({
      delivery: 'rejected',
      reason: 'empty_input'
    })
    expect(calls).toEqual([])
  })

  it('reports `delivered` when the server answers ok', async () => {
    const { api, calls } = instantApi()
    const sender = new PaneInputSender({ api, paneId: 'p1' })
    expect(await sender.sendKeys(['y'])).toEqual({ delivery: 'delivered', reason: null })
    expect(calls).toEqual([{ method: 'pane.send_input', params: { pane_id: 'p1', keys: ['y'] } }])
  })

  it('reports `rejected` with the server’s code when the server answers an error envelope', async () => {
    // An error envelope is proof the write *arrived*: herdr parsed it and said no.
    const { api } = instantApi(
      new JsonApiError('pane.send_input', 'invalid_key', 'unsupported key foo')
    )
    const sender = new PaneInputSender({ api, paneId: 'p1' })
    expect(await sender.sendKeys(['foo'])).toEqual({ delivery: 'rejected', reason: 'invalid_key' })
  })

  it('reports `unknown` — never `failed` — when the channel dies mid-write', async () => {
    const { api } = instantApi(new Error('ssh channel closed'))
    const sender = new PaneInputSender({ api, paneId: 'p1' })
    const result = await sender.sendKeys(['y'])
    expect(result.delivery).toBe('unknown')
    expect(result.reason).toContain('ssh channel closed')
  })

  it('reports `unknown` for a broken reply too', async () => {
    const { api } = instantApi(new JsonApiProtocolError('API reply is not JSON'))
    const sender = new PaneInputSender({ api, paneId: 'p1' })
    expect((await sender.sendKeys(['y'])).delivery).toBe('unknown')
  })

  it('drops, and never replays, whatever merged behind a chunk that did not land', async () => {
    const scripted = scriptedApi()
    const sender = new PaneInputSender({ api: scripted.api, paneId: 'p1' })
    const first = sender.sendKeys(['y'])
    await flush()
    // Cannot merge (text after keys), so it queues behind the in-flight one.
    const second = sender.sendText('later')
    await flush()
    expect(scripted.calls).toHaveLength(1)

    scripted.settle(0, new Error('ssh channel closed'))
    expect((await first).delivery).toBe('unknown')
    await second
    await flush()

    // The second chunk was never sent — X2's "절대 큐잉하지 않는다" is about exactly this: an
    // approval that lands after the transport recovers answers a prompt that has moved on.
    expect(scripted.calls).toHaveLength(1)
    expect(sender.getState().pendingChunks).toBe(0)
  })

  it('forgets unsent input on close — a pane switch must not fire into the next pane', async () => {
    const scripted = scriptedApi()
    const sender = new PaneInputSender({ api: scripted.api, paneId: 'p1' })
    void sender.sendKeys(['y'])
    await flush()
    void sender.sendText('x')
    await flush()
    sender.close()
    scripted.settle(0, 'ok')
    await flush()
    expect(scripted.calls).toHaveLength(1)
    expect(await sender.sendKeys(['y'])).toEqual({ delivery: 'rejected', reason: 'sender_closed' })
  })
})

describe('PaneInputSender — B8: a tap is an exec, so taps merge', () => {
  it('keeps exactly one request in flight', async () => {
    const scripted = scriptedApi()
    const sender = new PaneInputSender({ api: scripted.api, paneId: 'p1' })
    void sender.sendKeys(['y'])
    await flush()
    void sender.sendText('a')
    await flush()
    void sender.sendKeys(['enter'])
    await flush()
    expect(scripted.calls).toHaveLength(1)
  })

  it('collapses a burst of key taps into one extra exec, in order', async () => {
    const scripted = scriptedApi()
    const sender = new PaneInputSender({ api: scripted.api, paneId: 'p1' })
    void sender.sendKeys(['ctrl+c'])
    await flush()
    // Five more taps while the first is in flight: on a naive client that is five ssh execs and five
    // remote herdr processes (blocker B8, `src/api/server.rs:139-152`).
    for (const key of ['up', 'up', 'down', 'y', 'enter']) {
      void sender.sendKeys([key])
    }
    await flush()
    expect(scripted.calls).toHaveLength(1)

    scripted.settle(0, 'ok')
    await flush()
    expect(scripted.calls).toHaveLength(2)
    expect(scripted.calls[1]).toEqual({
      method: 'pane.send_input',
      params: { pane_id: 'p1', keys: ['up', 'up', 'down', 'y', 'enter'] }
    })
  })

  it('splits rather than reorders when the burst alternates text and keys', async () => {
    const scripted = scriptedApi()
    const sender = new PaneInputSender({ api: scripted.api, paneId: 'p1' })
    void sender.sendKeys(['y'])
    await flush()
    void sender.sendText('ab')
    void sender.sendText('c')
    void sender.sendKeys(['enter'])
    await flush()

    scripted.settle(0, 'ok')
    await flush()
    // `ab` + `c` merged; `enter` appended to them; and none of it hopped in front of the `y`.
    expect(scripted.calls).toHaveLength(2)
    expect(scripted.calls[1]?.params).toEqual({ pane_id: 'p1', text: 'abc', keys: ['enter'] })
    scripted.settle(1, 'ok')
    await flush()
    expect(scripted.calls).toHaveLength(2)
  })

  it('sends text and keys in one request, not two racing ones', async () => {
    const { api, calls } = instantApi()
    const sender = new PaneInputSender({ api, paneId: 'p1' })
    await sender.send({ text: 'yes', keys: ['enter'] })
    expect(calls).toEqual([
      { method: 'pane.send_input', params: { pane_id: 'p1', text: 'yes', keys: ['enter'] } }
    ])
  })

  it('refuses instead of growing once the pending bound is reached', async () => {
    const scripted = scriptedApi()
    const sender = new PaneInputSender({ api: scripted.api, paneId: 'p1' })
    void sender.sendKeys(['y'])
    await flush()
    // A text tap starts a chunk and the keys tap merges into it, so each *pair* is one chunk — the
    // alternation is what makes chunks accumulate at all (see `mergeChunk`).
    const outcomes: string[] = []
    for (let i = 0; i < MAX_PENDING_INPUT_CHUNKS + 1; i += 1) {
      outcomes.push(await raced(sender.sendText('x')))
      outcomes.push(await raced(sender.sendKeys(['enter'])))
    }
    expect(outcomes).toContain('input_backpressure')
    // Bounded, not merely slowed: the pending set never grew past the cap.
    expect(sender.getState().pendingChunks).toBeLessThanOrEqual(MAX_PENDING_INPUT_CHUNKS)
    // …and nothing extra reached the wire while the first call was still in flight.
    expect(scripted.calls).toHaveLength(1)
  })

  it('refuses text past the length cap rather than delivering it late', async () => {
    const scripted = scriptedApi()
    const sender = new PaneInputSender({ api: scripted.api, paneId: 'p1' })
    void sender.sendKeys(['y'])
    await flush()
    void sender.sendText('a'.repeat(4000))
    await flush()
    const result = await raced(sender.sendText('b'.repeat(200)))
    expect(result).toBe('input_backpressure')
  })
})

/** Resolves with a rejection reason, or `pending` if the call is still waiting on the wire. */
async function raced(promise: Promise<{ reason: string | null }>): Promise<string> {
  const outcome = await Promise.race([
    promise.then((result) => result.reason ?? 'none'),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 0))
  ])
  return outcome
}

describe('the status line', () => {
  const base: PaneInputState = { last: null, inFlight: false, pendingChunks: 0 }

  it('says nothing before the first write', () => {
    expect(inputStatusLabel(base)).toBeNull()
  })

  it('never says "failed" for an unacknowledged write', () => {
    const label = inputStatusLabel({ ...base, last: { delivery: 'unknown', reason: 'EPIPE' } })
    expect(label).toBe('delivery unknown')
    expect(label).not.toContain('fail')
  })

  it('names the server’s refusal', () => {
    expect(
      inputStatusLabel({ ...base, last: { delivery: 'rejected', reason: 'invalid_key' } })
    ).toBe('refused: invalid_key')
  })

  it('prefers in-flight over the previous verdict', () => {
    expect(
      inputStatusLabel({ ...base, inFlight: true, last: { delivery: 'delivered', reason: null } })
    ).toBe('sending')
  })
})

describe('isEmptyChunk', () => {
  it('is true only when there is nothing to send', () => {
    expect(isEmptyChunk({ text: '', keys: [] })).toBe(true)
    expect(isEmptyChunk({ text: '', keys: ['y'] })).toBe(false)
    expect(isEmptyChunk({ text: 'y', keys: [] })).toBe(false)
  })
})

describe('state reporting', () => {
  it('publishes in-flight and pending counts to its subscriber', async () => {
    const scripted = scriptedApi()
    const seen: PaneInputState[] = []
    const sender = new PaneInputSender({
      api: scripted.api,
      paneId: 'p1',
      onState: (state) => seen.push(state)
    })
    void sender.sendKeys(['y'])
    await flush()
    void sender.sendText('x')
    await flush()
    expect(seen.some((state) => state.inFlight)).toBe(true)
    expect(seen.some((state) => state.pendingChunks > 0)).toBe(true)
    scripted.settle(0, 'ok')
    await flush()
    scripted.settle(1, 'ok')
    await flush()
    expect(sender.getState().inFlight).toBe(false)
  })
})

describe('the sender does not touch the wire', () => {
  it('only ever calls `pane.send_input`', async () => {
    const { api, calls } = instantApi()
    const sender = new PaneInputSender({ api, paneId: 'p1' })
    await sender.sendKeys(['y'])
    await sender.sendText('hi')
    await sender.send({ text: 'hi', keys: ['enter'] })
    // Not `ControlTerminal`, not `AttachTerminal`, not `pane.resize`: those resize the shared PTY
    // (`src/server/headless.rs:2665-2675`), which is 02-architecture.md §2.3's whole point.
    expect(new Set(calls.map((call) => call.method))).toEqual(new Set(['pane.send_input']))
  })

  it('omits the empty half of the payload, as the server’s own serializer does', async () => {
    const { api, calls } = instantApi()
    const sender = new PaneInputSender({ api, paneId: 'p1' })
    await sender.sendKeys(['y'])
    await sender.sendText('hi')
    expect(calls[0]?.params).toEqual({ pane_id: 'p1', keys: ['y'] })
    expect(calls[1]?.params).toEqual({ pane_id: 'p1', text: 'hi' })
  })

  it('copies the keys it is handed — a caller’s array must not mutate a queued chunk', async () => {
    const { api, calls } = instantApi()
    const sender = new PaneInputSender({ api, paneId: 'p1' })
    const keys = ['y']
    const sent = sender.sendKeys(keys)
    keys.push('enter')
    await sent
    expect(calls[0]?.params).toEqual({ pane_id: 'p1', keys: ['y'] })
  })
})

describe('vitest sanity', () => {
  it('uses no fake timers here', () => {
    expect(vi.isFakeTimers()).toBe(false)
  })
})
