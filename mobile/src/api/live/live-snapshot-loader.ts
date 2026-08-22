// Not from orca. The stage-6 counterpart of `../mock/mock-snapshot-loader.ts`: same
// `SnapshotLoader` contract, same four requests, but against a real herdr server through
// `packages/herdr-client-ts` instead of the fixture. The mock is kept, not replaced — it is the P1
// boundary (port map §3 P1: if the phone-less reproduction fails, do not touch the UI).
//
// Two facts about herdr's JSON API shape this file, and both were measured, not assumed
// (2026-08-22, isolated server, `remote.list` before anything else was created):
//
//   1. **`remote.list` does not include the server answering it.** It returns
//      `state.remote_registry.remotes` verbatim (`src/app/api/remotes.rs:10-17`), which on a fresh
//      box is `{"type":"remote_list","remotes":[]}`. So the fleet is *the remotes the app dialled*
//      plus whatever the box it reached knows about; the dialled ones have to be contributed by the
//      caller, because only the caller knows which ssh target it used. That is the opposite of the
//      mock, whose fixture puts a synthetic `local` entry at index 0.
//   2. **The three per-box lists only describe the box you asked** (`../snapshot-context.tsx`), so
//      there is one fan-out per connection and no way to ask one server about another's panes.
import type {
  AgentInfo,
  PaneInfo,
  RemoteDefinition,
  RemoteSnapshot,
  WorkspaceInfo
} from '../herdr-api-types'
import type { HerdrSnapshot, SnapshotLoader } from '../snapshot-context'
import type { HerdrRemoteConnection } from '../../transport/herdr-connection'

/**
 * Reads one array field out of a JSON API result.
 *
 * `JsonApiClient.request` is untyped on purpose (`packages/herdr-client-ts/src/jsonApi.ts:185-189`)
 * and the mock loader simply casts. Here the payload comes off a socket from a server that may be a
 * different build, so the cast is guarded: a missing or non-array field becomes a named error, not
 * a list screen quietly rendering `undefined`.
 */
function arrayField<T>(
  result: Record<string, unknown>,
  method: string,
  key: string
): T[] {
  const value = result[key]
  if (!Array.isArray(value)) {
    throw new Error(`${method} returned no \`${key}\` array (got ${JSON.stringify(result['type'])})`)
  }
  return value as T[]
}

/** The three per-box lists, as one remote's `remote-api-bridge` answers them. */
async function snapshotOf(connection: HerdrRemoteConnection): Promise<RemoteSnapshot> {
  // Sequential, not `Promise.all`: blocker B8 means one request is one ssh exec channel, and three
  // concurrent execs per remote multiplies channel churn on an LTE link for no latency the user can
  // see. X5 (`request-single-flight`) is the M4 answer to the same pressure.
  const workspaces = arrayField<WorkspaceInfo>(
    await connection.api.request('workspace.list'),
    'workspace.list',
    'workspaces'
  )
  const panes = arrayField<PaneInfo>(await connection.api.paneList(), 'pane.list', 'panes')
  const agents = arrayField<AgentInfo>(await connection.api.agentList(), 'agent.list', 'agents')
  return { remote: connection.remote, workspaces, panes, agents }
}

/** `remote.list` from the box the phone reached, merged behind the remotes it actually dialled. */
async function fleetOf(
  connections: readonly HerdrRemoteConnection[]
): Promise<RemoteDefinition[]> {
  const dialled = connections.map((connection) => connection.remote)
  const first = connections[0]
  if (!first) {
    return dialled
  }
  let listed: RemoteDefinition[]
  try {
    listed = arrayField<RemoteDefinition>(
      await first.api.request('remote.list'),
      'remote.list',
      'remotes'
    )
  } catch {
    // A box that cannot answer `remote.list` still has workspaces worth showing, and the fleet it
    // knows about is the *least* load-bearing of the four lists: losing it costs rows the phone
    // could not have dialled anyway.
    return dialled
  }
  const known = new Set(dialled.map((remote) => remote.id))
  return [...dialled, ...listed.filter((remote) => !known.has(remote.id))]
}

/**
 * A {@link SnapshotLoader} over live connections.
 *
 * Partial failure is a *result*, not an error: a remote whose bridge is down is left out of
 * `perRemote` and stays in `remotes`, which is the same shape the snapshot already uses for a
 * remote that was never dialled (`../snapshot-context.tsx`) — so the fleet list keeps its row and
 * the screens keep working for the boxes that answered. Only a total failure throws, because a
 * snapshot with nothing in it is indistinguishable from an empty herdr and the user has to be told.
 */
export function createLiveSnapshotLoader(
  connections: readonly HerdrRemoteConnection[]
): SnapshotLoader {
  return async (): Promise<HerdrSnapshot> => {
    if (connections.length === 0) {
      throw new Error('no herdr connections: nothing to load a snapshot from')
    }
    const remotes = await fleetOf(connections)
    const settled = await Promise.all(
      connections.map(async (connection) => {
        try {
          return { ok: true as const, value: await snapshotOf(connection) }
        } catch (error: unknown) {
          return { ok: false as const, error: error instanceof Error ? error : new Error(String(error)) }
        }
      })
    )
    const perRemote = settled.flatMap((entry) => (entry.ok ? [entry.value] : []))
    if (perRemote.length === 0) {
      const first = settled.find((entry) => !entry.ok)
      throw (first && !first.ok ? first.error : new Error('no remote answered'))
    }
    return { remotes, perRemote }
  }
}
