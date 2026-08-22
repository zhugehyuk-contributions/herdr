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
import type { HerdrRemoteConnection } from '../../transport/herdr-connection'
import type { RemoteDefinition } from '../herdr-api-types'

type Script = Record<string, unknown>

/** A `JsonApiClient` that answers from a table, and records which methods were asked. */
function scriptedApi(script: Script, asked: string[] = []): JsonApiClient {
  return new JsonApiClient(async (): Promise<JsonApiConnection> => {
    let pending: string | null = null
    return {
      write: (line: string) => {
        const request = JSON.parse(line) as { id: string; method: string }
        asked.push(request.method)
        const result = script[request.method]
        pending = JSON.stringify(
          result === undefined
            ? { id: request.id, error: { code: 'invalid_request', message: request.method } }
            : { id: request.id, result }
        )
      },
      readLine: () =>
        pending === null
          ? Promise.reject(new Error('nothing written'))
          : Promise.resolve(pending),
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
  asked: string[] = []
): HerdrRemoteConnection {
  return {
    remote: definition,
    api: scriptedApi(script, asked),
    openTerminalStream: () => Promise.reject(new Error('not used by the snapshot loader'))
  }
}

const HUB_LISTS: Script = {
  'remote.list': { type: 'remote_list', remotes: [remote('remote-2', 'iq-64')] },
  'workspace.list': { type: 'workspace_list', workspaces: [{ workspace_id: 'w1', label: 'herdr' }] },
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

  it('keeps a dead remote in the fleet and out of perRemote, exactly like an undialled one', async () => {
    const hub = connection(remote('remote-1', 'fable-m5max'), HUB_LISTS)
    const dead = connection(remote('remote-2', 'iq-64'), {
      // Answers nothing: every method falls through to an error envelope.
    })
    const snapshot = await createLiveSnapshotLoader([hub, dead])()
    expect(snapshot.remotes.map((entry) => entry.id)).toEqual(['remote-1', 'remote-2'])
    expect(snapshot.perRemote.map((entry) => entry.remote.id)).toEqual(['remote-1'])
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
