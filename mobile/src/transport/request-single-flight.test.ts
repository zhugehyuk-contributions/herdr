// Not from orca — orca's `request-single-flight.ts` ships without a test, and the coalescing rule
// it encodes ("latest params win") is the kind that is easy to get *almost* right.
//
// X5 matters more here than it did there, and the receipt says so in the units that matter: with
// blocker B8 alive, **one JSON call is one ssh exec is one remote `herdr` process**
// (`src/api/server.rs:139-152`). So the assertion below is not "fewer promises" — it is a count of
// remote processes that would have been spawned on the user's laptop the instant L4's nudge reached
// every mounted screen at once.
import { describe, expect, it } from 'vitest'
import type { JsonApiClient } from '@herdr/client-ts'
import { inFlightRequestCount, sendSingleFlightRequest } from './request-single-flight'

type Call = { method: string; params: Record<string, unknown> }

/** A stand-in for `JsonApiClient` that records every exec it would have spawned. */
function fakeClient() {
  const calls: Call[] = []
  const settlers: { resolve: (v: Record<string, unknown>) => void; reject: (e: unknown) => void }[] =
    []
  const client = {
    request(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      return new Promise<{ type: string } & Record<string, unknown>>((resolve, reject) => {
        settlers.push({
          resolve: (value) => resolve({ type: 'ok', ...value }),
          reject
        })
      })
    }
  } as unknown as JsonApiClient
  return { client, calls, settlers }
}

describe('X5 — (client, host, kind) single-flight with one trailing follow-up', () => {
  it('collapses a resume storm into one exec plus one follow-up', async () => {
    const { client, calls, settlers } = fakeClient()
    // Six screens on the same remote all refresh in the same tick — L4's single nudge reaching six
    // mounted components.
    const waiters = Array.from({ length: 6 }, (_unused, index) =>
      sendSingleFlightRequest(client, 'scratch', 'agent.list', { seq: index })
    )
    expect(calls).toHaveLength(1)
    process.stdout.write(`[X5] 6 triggers -> ${calls.length} ssh exec in flight\n`)

    settlers[0]?.resolve({ agents: ['first'] })
    await waiters[0]
    // Exactly one follow-up, carrying the *latest* params — the earlier five coalesced into it.
    expect(calls).toHaveLength(2)
    expect(calls[1]?.params).toEqual({ seq: 5 })

    settlers[1]?.resolve({ agents: ['second'] })
    const trailing = await Promise.all(waiters.slice(1))
    // Every coalesced caller gets the *fresh* answer, not the stale in-flight one.
    expect(trailing.every((result) => result['agents']?.toString() === 'second')).toBe(true)
    process.stdout.write(`[X5] 6 triggers -> ${calls.length} ssh exec total\n`)
    expect(calls).toHaveLength(2)
  })

  it('different kinds and different hosts do not share a slot', async () => {
    const { client, calls, settlers } = fakeClient()
    void sendSingleFlightRequest(client, 'scratch', 'agent.list')
    void sendSingleFlightRequest(client, 'scratch', 'pane.list')
    void sendSingleFlightRequest(client, 'other', 'agent.list')
    expect(calls.map((c) => c.method)).toEqual(['agent.list', 'pane.list', 'agent.list'])
    expect(inFlightRequestCount(client)).toBe(3)
    for (const settler of settlers) {
      settler.resolve({})
    }
    await Promise.resolve()
  })

  it('releases the slot once everything settles — no leak across reconnects', async () => {
    const { client, settlers } = fakeClient()
    const first = sendSingleFlightRequest(client, 'scratch', 'agent.list')
    settlers[0]?.resolve({})
    await first
    await Promise.resolve()
    expect(inFlightRequestCount(client)).toBe(0)
  })

  it('a failure frees the slot too — a dead channel must not wedge the key forever', async () => {
    const { client, calls, settlers } = fakeClient()
    const first = sendSingleFlightRequest(client, 'scratch', 'agent.list')
    settlers[0]?.reject(new Error('channel closed'))
    await expect(first).rejects.toThrow('channel closed')
    await Promise.resolve()
    expect(inFlightRequestCount(client)).toBe(0)

    // The next trigger dials again rather than being answered by the wreckage.
    void sendSingleFlightRequest(client, 'scratch', 'agent.list')
    expect(calls).toHaveLength(2)
  })

  it('a follow-up that fails rejects only its own waiters', async () => {
    const { client, settlers } = fakeClient()
    const first = sendSingleFlightRequest(client, 'scratch', 'agent.list')
    const second = sendSingleFlightRequest(client, 'scratch', 'agent.list')
    settlers[0]?.resolve({ agents: [] })
    await first
    settlers[1]?.reject(new Error('exec refused'))
    await expect(second).rejects.toThrow('exec refused')
  })

  it('triggers arriving during the follow-up queue the next one — the recursion holds', async () => {
    const { client, calls, settlers } = fakeClient()
    const first = sendSingleFlightRequest(client, 'scratch', 'agent.list', { seq: 0 })
    void sendSingleFlightRequest(client, 'scratch', 'agent.list', { seq: 1 })
    settlers[0]?.resolve({})
    await first
    expect(calls).toHaveLength(2)

    const third = sendSingleFlightRequest(client, 'scratch', 'agent.list', { seq: 2 })
    settlers[1]?.resolve({})
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toHaveLength(3)
    expect(calls[2]?.params).toEqual({ seq: 2 })
    settlers[2]?.resolve({ agents: ['third'] })
    expect((await third)['agents']).toEqual(['third'])
  })
})
