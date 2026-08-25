// Not from orca. The stage-6 counterpart of `../mock/mock-api-handlers.test.ts`: it pins the two
// facts about herdr's JSON API that shape the loader, both of which were measured against a live
// isolated server and neither of which the mock exhibits.
//
// The client under test is the real `JsonApiClient` over a scripted `JsonApiConnect`, not a stub of
// it, so the one-request-one-connection rule (`packages/herdr-client-ts/src/jsonApi.ts`) is part of
// what runs here.
import { describe, expect, it } from 'vitest'
import { JsonApiClient, type JsonApiConnection } from '@herdr/client-ts'
import { createLiveSnapshotLoader } from './live-snapshot-loader'
import { PANE_SUMMARY_RECENT_LINES } from '../../agents/agent-display'
import { nodeDetail, nodeDotState } from '../../nodes/node-list-model'
import type { HerdrRemoteConnection } from '../../transport/herdr-connection'
import type { RemoteDefinition } from '../herdr-api-types'

type Script = Record<string, unknown>

/** One request as it went out on the wire, for the assertions that are about the params. */
type Sent = { method: string; params?: Record<string, unknown> }

/** A `JsonApiClient` that answers from a table, and records which methods were asked. */
function scriptedApi(script: Script, asked: string[] = [], sent: Sent[] = []): JsonApiClient {
  return new JsonApiClient(async (): Promise<JsonApiConnection> => {
    let pending: string | null = null
    return {
      write: (line: string) => {
        const request = JSON.parse(line) as {
          id: string
          method: string
          params?: Record<string, unknown>
        }
        asked.push(request.method)
        sent.push({ method: request.method, params: request.params })
        const result = script[request.method]
        pending = JSON.stringify(
          result === undefined
            ? { id: request.id, error: { code: 'invalid_request', message: request.method } }
            : { id: request.id, result }
        )
      },
      readLine: () =>
        pending === null ? Promise.reject(new Error('nothing written')) : Promise.resolve(pending),
      close: () => {}
    }
  })
}

function remote(id: string, name: string): RemoteDefinition {
  return { id, name, target: { type: 'ssh', target: `z@${name}` } }
}

function connection(
  definition: RemoteDefinition,
  script: Script,
  asked: string[] = [],
  sent: Sent[] = []
): HerdrRemoteConnection {
  return {
    remote: definition,
    api: scriptedApi(script, asked, sent),
    openTerminalStream: () => Promise.reject(new Error('not used by the snapshot loader'))
  }
}

const HUB_LISTS: Script = {
  'remote.list': { type: 'remote_list', remotes: [remote('remote-2', 'iq-64')] },
  'workspace.list': {
    type: 'workspace_list',
    workspaces: [{ workspace_id: 'w1', label: 'herdr' }]
  },
  'pane.list': { type: 'pane_list', panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }] },
  'agent.list': { type: 'agent_list', agents: [{ pane_id: 'w1:p1', tab_label: 'main' }] }
}

describe('live snapshot loader', () => {
  it('puts the remotes the app dialled in the fleet, because remote.list does not', async () => {
    // Measured 2026-08-22 on a fresh isolated server: `remote.list` -> `{"remotes":[]}`. It returns
    // the remote *registry* (`src/app/api/remotes.rs:10-17`) and never a self entry, so a loader
    // that trusted it alone would render an empty fleet while streaming that box's panes.
    const hub = connection(remote('remote-1', 'fable-m5max'), {
      ...HUB_LISTS,
      'remote.list': { type: 'remote_list', remotes: [] }
    })
    const snapshot = await createLiveSnapshotLoader([hub])()
    expect(snapshot.remotes.map((entry) => entry.id)).toEqual(['remote-1'])
    expect(snapshot.perRemote).toHaveLength(1)
  })

  it('appends what the box it reached knows about, without duplicating a dialled remote', async () => {
    const hub = connection(remote('remote-1', 'fable-m5max'), HUB_LISTS)
    const second = connection(remote('remote-2', 'iq-64'), HUB_LISTS)
    const snapshot = await createLiveSnapshotLoader([hub, second])()
    // remote-2 is both dialled and listed by the hub; it appears once, in dialled order.
    expect(snapshot.remotes.map((entry) => entry.id)).toEqual(['remote-1', 'remote-2'])
    expect(snapshot.perRemote.map((entry) => entry.remote.id)).toEqual(['remote-1', 'remote-2'])
  })

  it('asks each box for its own three lists — the API is per-server', async () => {
    const asked: string[] = []
    const hub = connection(remote('remote-1', 'fable-m5max'), HUB_LISTS, asked)
    const snapshot = await createLiveSnapshotLoader([hub])()
    expect(asked).toEqual(['remote.list', 'workspace.list', 'pane.list', 'agent.list'])
    expect(snapshot.perRemote[0]!.workspaces[0]!.label).toBe('herdr')
    expect(snapshot.perRemote[0]!.panes[0]!.pane_id).toBe('w1:p1')
    expect(snapshot.perRemote[0]!.agents[0]!.tab_label).toBe('main')
  })

  it('asks pane.list to batch each pane summary line, instead of one pane.read per pane', async () => {
    // `.prd/06-open-decisions.md` 결정 9: the mockup's summary source is the pane's last output
    // line, and reading it per pane is one ssh exec per pane (blocker B8). The server grew
    // `pane.list {recent_lines}` for exactly this, so the whole list costs one request — and this
    // is the assertion that the client actually asks, since a missing param degrades silently into
    // the old `terminal_title_stripped` line rather than into an error.
    const sent: Sent[] = []
    const hub = connection(remote('remote-1', 'fable-m5max'), HUB_LISTS, [], sent)
    await createLiveSnapshotLoader([hub])()
    const paneList = sent.filter((request) => request.method === 'pane.list')
    expect(paneList).toHaveLength(1)
    expect(paneList[0]!.params).toEqual({ recent_lines: PANE_SUMMARY_RECENT_LINES })
    // Nothing else grew a param, and no `pane.read` was issued at all.
    expect(sent.filter((request) => request.method === 'pane.read')).toHaveLength(0)
    expect(sent.find((request) => request.method === 'agent.list')!.params).toEqual({})
  })

  it('keeps a dead remote in the fleet and out of perRemote, exactly like an undialled one', async () => {
    const hub = connection(remote('remote-1', 'fable-m5max'), HUB_LISTS)
    const dead = connection(remote('remote-2', 'iq-64'), {
      // Answers nothing: every method falls through to an error envelope.
    })
    const snapshot = await createLiveSnapshotLoader([hub, dead])()
    expect(snapshot.remotes.map((entry) => entry.id)).toEqual(['remote-1', 'remote-2'])
    expect(snapshot.perRemote.map((entry) => entry.remote.id)).toEqual(['remote-1'])
  })

  it('keeps a remote that never dialled at all — the row the fleet used to lose', async () => {
    // Measured on the QA phone (2026-08-23): one reachable remote plus a deliberately unreachable
    // one (`10.0.2.2:2399`, no listener). The header said `1 nodes` and no row, error or message
    // named the second remote — a failed dial produces no connection, and `remote.list` is the
    // *reached box's* registry, which knows nothing about what this phone was configured with. So
    // the fleet was built from two sources that both structurally exclude it.
    const hub = connection(remote('remote-1', 'fable-m5max'), {
      ...HUB_LISTS,
      'remote.list': { type: 'remote_list', remotes: [] }
    })
    const configured = [remote('remote-1', 'fable-m5max'), remote('remote-2', 'blade-4090')]
    const snapshot = await createLiveSnapshotLoader([hub], configured)()
    // Two rows, and the dialled one first: the remotes that answered belong at the top of the list.
    expect(snapshot.remotes.map((entry) => entry.id)).toEqual(['remote-1', 'remote-2'])
    // ...and exactly one of them has data, which is what makes the second row say `reconnecting…`
    // rather than pretend.
    expect(snapshot.perRemote.map((entry) => entry.remote.id)).toEqual(['remote-1'])
  })

  it('orders the fleet dialled, then listed, then merely configured — deduplicated by id', async () => {
    const hub = connection(remote('remote-1', 'fable-m5max'), HUB_LISTS)
    // `HUB_LISTS`'s `remote.list` knows `remote-2`; the configuration adds `remote-3` and repeats
    // the two that are already there.
    const configured = [
      remote('remote-2', 'iq-64'),
      remote('remote-3', 'blade-4090'),
      remote('remote-1', 'fable-m5max')
    ]
    const snapshot = await createLiveSnapshotLoader([hub], configured)()
    expect(snapshot.remotes.map((entry) => entry.id)).toEqual(['remote-1', 'remote-2', 'remote-3'])
  })

  it('throws when nothing answered, because an empty snapshot reads as an empty herdr', async () => {
    const dead = connection(remote('remote-1', 'fable-m5max'), {})
    await expect(createLiveSnapshotLoader([dead])()).rejects.toThrow(/workspace\.list/)
    await expect(createLiveSnapshotLoader([])()).rejects.toThrow(/no herdr connections/)
  })

  it('names the endpoint when a list comes back without its array', async () => {
    const broken = connection(remote('remote-1', 'fable-m5max'), {
      'remote.list': { type: 'remote_list', remotes: [] },
      'workspace.list': { type: 'workspace_list' }
    })
    await expect(createLiveSnapshotLoader([broken])()).rejects.toThrow(
      /workspace\.list returned no `workspaces` array/
    )
  })
})

/**
 * The other half of the same defect: the branch existed, its input did not.
 *
 * `../../nodes/node-list-model.ts` has drawn the mockup's `blade-4090` row since stage 4 — inverted
 * ring, `reconnecting… · last seen 2m ago` (`assets/mockup.html:409-412`) — and both branches have
 * had unit tests since then. What was missing is that nothing on the *live* path could ever produce
 * a remote that is in `remotes` and not in `perRemote`, so the row was unreachable outside the
 * fixture. This asserts the join, not either half.
 */
describe('live snapshot → node row', () => {
  it('renders an unreachable configured remote as blocked · reconnecting…', async () => {
    const hub = connection(remote('remote-1', 'fable-m5max'), {
      ...HUB_LISTS,
      'remote.list': { type: 'remote_list', remotes: [] }
    })
    const dead = remote('remote-2', 'blade-4090')
    const snapshot = await createLiveSnapshotLoader(
      [hub],
      [remote('remote-1', 'fable-m5max'), dead]
    )()

    const row = snapshot.remotes.find((entry) => entry.id === 'remote-2')
    expect(row).toBeDefined()
    const entry = snapshot.perRemote.find((item) => item.remote.id === 'remote-2')
    expect(entry).toBeUndefined()

    expect(nodeDotState({ entry })).toBe('blocked')
    const nowMs = 1_700_000_000_000
    expect(
      nodeDetail({
        remote: row as RemoteDefinition,
        subtitle: 'z@blade-4090',
        entry,
        rollup: '',
        lastSeenAt: nowMs - 120_000,
        nowMs
      })
    ).toBe('reconnecting… · last seen 2m ago')
  })

  it('leaves the remote that answered on its ordinary line', async () => {
    const hub = connection(remote('remote-1', 'fable-m5max'), {
      ...HUB_LISTS,
      'remote.list': { type: 'remote_list', remotes: [] }
    })
    const snapshot = await createLiveSnapshotLoader(
      [hub],
      [remote('remote-1', 'fable-m5max'), remote('remote-2', 'blade-4090')]
    )()
    const entry = snapshot.perRemote.find((item) => item.remote.id === 'remote-1')
    expect(nodeDotState({ entry })).toBe('ok')
    expect(
      nodeDetail({
        remote: snapshot.remotes[0] as RemoteDefinition,
        subtitle: 'z@fable-m5max',
        entry,
        rollup: 'idle',
        lastSeenAt: null,
        nowMs: 0
      })
    ).toBe('z@fable-m5max · 1 spaces · 1 panes · idle')
  })
})
