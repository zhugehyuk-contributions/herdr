// Not from orca — there is no orca suite to port, because orca has no server history read (its
// scrollback is the local xterm buffer; `./pane-history.ts` records why herdr's cannot be).
//
// What this suite pins, in the order the failures would hurt:
//   1. the request is the one the server can answer — `pane.read` with `pane_id`, `source`, `lines`;
//   2. **the call is cached** — B8, one exec per pane, and a double-tap is not two remote processes;
//   3. an explicit refresh is the one path that spends a second exec;
//   4. a server error envelope and a dead transport are told apart, because the surface says
//      different things about them.
import { describe, expect, it } from 'vitest'
import { JsonApiError } from '@herdr/client-ts'
import {
  PANE_HISTORY_FORMAT,
  PANE_HISTORY_LINES,
  PANE_HISTORY_SOURCE,
  PaneHistoryError,
  PaneHistoryReader,
  historyLineCount,
  historySummary
} from './pane-history'
import type { JsonApiClient } from '@herdr/client-ts'

type Call = { method: string; params: Record<string, unknown> }

/**
 * A `JsonApiClient` that records what was asked and answers from a script.
 *
 * `JsonApiClient` is a class, so the double is cast rather than extended: the reader only ever calls
 * `request`, and pinning that is the contract worth having.
 */
function fakeApi(reply: (call: Call, index: number) => Promise<Record<string, unknown>>): {
  api: JsonApiClient
  calls: Call[]
} {
  const calls: Call[] = []
  const api = {
    request: (method: string, params: Record<string, unknown> = {}) => {
      const index = calls.push({ method, params }) - 1
      return reply({ method, params }, index)
    }
  } as unknown as JsonApiClient
  return { api, calls }
}

function readResult(text: string, truncated = false): Record<string, unknown> {
  return {
    type: 'pane_read',
    read: {
      pane_id: 'ws-1-p1',
      workspace_id: 'ws-1',
      tab_id: 'ws-1-tab-1',
      source: PANE_HISTORY_SOURCE,
      format: PANE_HISTORY_FORMAT,
      text,
      revision: 0,
      truncated
    }
  }
}

describe('pane history reader (M6c)', () => {
  it('asks pane.read for this pane, the recent-unwrapped source and the server ceiling of lines', async () => {
    const { api, calls } = fakeApi(async () => readResult('one\ntwo\n'))
    const reader = new PaneHistoryReader({ api, now: () => 1_000 })

    const snapshot = await reader.read('ws-1-p1')

    expect(calls).toEqual([
      {
        method: 'pane.read',
        params: {
          pane_id: 'ws-1-p1',
          source: 'recent_unwrapped',
          lines: 1000,
          format: 'text'
        }
      }
    ])
    // The constants are the contract, so they are asserted as such rather than only via the literals
    // above: `lines` is the server's own clamp (`src/app/api_helpers.rs:118`), and a value above it
    // would be silently reduced while a value below it would buy less history for the same exec.
    expect(PANE_HISTORY_LINES).toBe(1000)
    expect(PANE_HISTORY_SOURCE).toBe('recent_unwrapped')
    expect(snapshot).toEqual({
      paneId: 'ws-1-p1',
      text: 'one\ntwo\n',
      truncated: false,
      fetchedAt: 1_000
    })
  })

  it('caches per pane — reading the same pane again spends no second exec (B8)', async () => {
    const { api, calls } = fakeApi(async () => readResult('cached\n'))
    const reader = new PaneHistoryReader({ api })

    const first = await reader.read('ws-1-p1')
    const second = await reader.read('ws-1-p1')
    const third = await reader.read('ws-1-p1')

    expect(calls).toHaveLength(1)
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(reader.peek('ws-1-p1')).toBe(first)
  })

  it('keeps a cache per pane, so a switch away and back is still free', async () => {
    const { api, calls } = fakeApi(async (call) =>
      readResult(`${String(call.params['pane_id'])} history\n`)
    )
    const reader = new PaneHistoryReader({ api })

    const one = await reader.read('ws-1-p1')
    const two = await reader.read('ws-1-p2')
    await reader.read('ws-1-p1')

    expect(calls.map((call) => call.params['pane_id'])).toEqual(['ws-1-p1', 'ws-1-p2'])
    expect(one.text).toBe('ws-1-p1 history\n')
    expect(two.text).toBe('ws-1-p2 history\n')
  })

  it('shares one exec between overlapping reads of the same pane', async () => {
    let release: ((value: Record<string, unknown>) => void) | null = null
    const { api, calls } = fakeApi(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          release = resolve
        })
    )
    const reader = new PaneHistoryReader({ api })

    const a = reader.read('ws-1-p1')
    const b = reader.read('ws-1-p1')
    expect(calls).toHaveLength(1)

    release?.(readResult('shared\n'))
    expect((await a).text).toBe('shared\n')
    expect((await b).text).toBe('shared\n')
    expect(calls).toHaveLength(1)
  })

  it('re-reads only on an explicit refresh, and replaces the cache with it', async () => {
    let generation = 0
    const { api, calls } = fakeApi(async () => {
      generation += 1
      return readResult(`generation ${generation}\n`)
    })
    const reader = new PaneHistoryReader({ api })

    await reader.read('ws-1-p1')
    const refreshed = await reader.read('ws-1-p1', { refresh: true })
    const afterwards = await reader.read('ws-1-p1')

    expect(calls).toHaveLength(2)
    expect(refreshed.text).toBe('generation 2\n')
    expect(afterwards).toBe(refreshed)
  })

  it('reports the server error envelope by its own code — it reached herdr and herdr said no', async () => {
    const { api } = fakeApi(async () => {
      throw new JsonApiError('pane.read', 'pane_not_found', 'no such pane: ws-1-p9')
    })
    const reader = new PaneHistoryReader({ api })

    await expect(reader.read('ws-1-p9')).rejects.toMatchObject({
      code: 'pane_not_found',
      // `JsonApiError` composes method + code into its message (`jsonApi.ts:55`) and that whole
      // string is kept: the surface prints one line, and "which method" is half the diagnosis.
      message: 'pane.read failed [pane_not_found]: no such pane: ws-1-p9'
    })
    // A failed read is not cached: the next open must be allowed to try again.
    expect(reader.peek('ws-1-p9')).toBeNull()
  })

  it('separates a dead transport from a server answer, and refuses to read without one', async () => {
    const dead = new PaneHistoryReader({ api: null })
    await expect(dead.read('ws-1-p1')).rejects.toMatchObject({ code: 'no_transport' })
    await expect(dead.read(null)).rejects.toMatchObject({ code: 'no_pane' })

    const { api } = fakeApi(async () => {
      throw new Error('ssh channel closed')
    })
    const broken = new PaneHistoryReader({ api })
    await expect(broken.read('ws-1-p1')).rejects.toMatchObject({ code: 'transport' })
  })

  it('rejects a reply that is not a pane read rather than rendering an empty screen', async () => {
    const { api } = fakeApi(async () => ({ type: 'pane_layout', layout: {} }))
    const reader = new PaneHistoryReader({ api })
    const failure = await reader.read('ws-1-p1').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PaneHistoryError)
    expect((failure as PaneHistoryError).code).toBe('malformed')
  })

  it('drops a pane from the cache on invalidate', async () => {
    const { api, calls } = fakeApi(async () => readResult('x\n'))
    const reader = new PaneHistoryReader({ api })
    await reader.read('ws-1-p1')
    reader.invalidate('ws-1-p1')
    await reader.read('ws-1-p1')
    expect(calls).toHaveLength(2)
  })

  it('summarises the read itself — line count, omission and an absolute clock', () => {
    const at = new Date(2026, 7, 23, 9, 4, 5).getTime()
    expect(
      historySummary({ paneId: 'ws-1-p1', text: 'a\nb\nc\n', truncated: false, fetchedAt: at })
    ).toBe('3 lines · read 09:04:05')
    expect(
      historySummary({ paneId: 'ws-1-p1', text: 'a\nb\n', truncated: true, fetchedAt: at })
    ).toBe('2 lines (older lines omitted) · read 09:04:05')
    expect(historyLineCount({ paneId: 'p', text: '', truncated: false, fetchedAt: at })).toBe(0)
    expect(historyLineCount({ paneId: 'p', text: 'only', truncated: false, fetchedAt: at })).toBe(1)
  })
})
