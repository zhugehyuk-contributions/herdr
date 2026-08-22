// Not from orca. orca's equivalent is `src/transport/client-context.tsx` (453 lines, port map §2.3
// grades it `port` and schedules it for stage 6 with the ssh transport): a provider that
// ref-counts one WebSocket client per host and hands it out through `useHostClient`.
//
// This is deliberately NOT that. It is the *smallest* thing the route shell needs to exist before a
// transport does: one snapshot of the four list endpoints, obtained from an injected loader. The
// port map's stage order puts the screens before the transport precisely so the loader can be the
// mock (§5 steps 3-4, "폰·서버 없이"), and keeping the seam an injected function is what makes the
// P1 boundary hold — a screen test never needs a socket, and stage 6 replaces the loader, not this
// file's consumers.
//
// What is intentionally absent, because it belongs to the ported client-context and not here:
// per-remote client lifetimes, acquire/release ref-counting, `forceReconnect`, connection state.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { RemoteDefinition, RemoteSnapshot } from './herdr-api-types'

/**
 * The four list endpoints, as one value — **per remote**.
 *
 * Stage 3 modelled this flat (`{remotes, workspaces, panes, agents}`), which quietly assumed one
 * server. It is not one server: herdr's JSON API is per-box, so `workspace.list`/`pane.list`/
 * `agent.list` only ever describe the box you asked, and only `remote.list` describes the fleet
 * (`./herdr-api-types.ts`, `RemoteSnapshot`). Stage 5's Agents home is the union over every remote
 * — "전 서버의 에이전트" (01-spec.md) — so the flat shape had nowhere to put the answer to "which
 * box is this agent on", which is exactly the fact that makes the row usable.
 *
 * Workspace and pane ids are only unique *within* a remote (`ws-1` exists on every box), so any
 * cross-remote key has to be composite. `../agents/fleet-agents.ts` is where that is done once.
 */
export type HerdrSnapshot = {
  /** `remote.list` from the server the phone reached: the whole fleet, dialled or not. */
  remotes: RemoteDefinition[]
  /** One entry per remote actually queried. A disabled remote is not dialled, so it has none. */
  perRemote: RemoteSnapshot[]
}

export const EMPTY_SNAPSHOT: HerdrSnapshot = {
  remotes: [],
  perRemote: []
}

export type SnapshotLoader = () => Promise<HerdrSnapshot>

export type SnapshotState = {
  status: 'loading' | 'ready' | 'error'
  snapshot: HerdrSnapshot
  error: string | null
  /**
   * Why this is not `error`: `refresh` runs every few seconds while the app is foregrounded, and on
   * a phone one dropped ssh exec is the normal case rather than a broken screen. Reporting it
   * through `error` would drag `status` to `'error'` and the snapshot to `EMPTY_SNAPSHOT` with it,
   * so a single hiccup would blank a fleet view that is still perfectly readable. Screens may show
   * this (a "last update failed" hint) but nothing is required to.
   */
  refreshError: string | null
  /** The visible reload: back to `status: 'loading'`, i.e. the user asked to see a spinner. */
  reload: () => void
  /**
   * The invisible one, for the foreground poller (`./use-foreground-refresh.ts`): re-reads the same
   * loader without ever leaving `ready`, and on failure keeps the last good snapshot on screen.
   * Resolves when the attempt settles — including when it was skipped for one already in flight.
   */
  refresh: () => Promise<void>
}

const SnapshotContext = createContext<SnapshotState>({
  status: 'loading',
  snapshot: EMPTY_SNAPSHOT,
  error: null,
  refreshError: null,
  reload: () => {},
  refresh: () => Promise.resolve()
})

export function HerdrSnapshotProvider({
  load,
  children
}: {
  load: SnapshotLoader
  children: ReactNode
}) {
  const [state, setState] = useState<Omit<SnapshotState, 'reload' | 'refresh'>>({
    status: 'loading',
    snapshot: EMPTY_SNAPSHOT,
    error: null,
    refreshError: null
  })
  const [generation, setGeneration] = useState(0)
  // Why: a load that resolves after the provider unmounts (or after a reload superseded it) must
  // not write state — the same "stale" guard orca uses around its async preference loads.
  const disposedRef = useRef(false)
  // Why these two replaced the per-effect `superseded` closure flag: `refresh` starts loads from
  // *outside* this effect, so "am I still the current load" has to be answerable by a caller the
  // effect never saw, and a closure flag can only ever see its own load. The token is that answer —
  // whoever bumped it last owns the state writes and owns clearing `inFlight`.
  const loadTokenRef = useRef(0)
  // Why an explicit in-flight flag rather than letting ticks stack: one load is one JSON call per
  // remote and — until blocker B8 is closed — one JSON call is one ssh exec, one remote `herdr`
  // process (.prd/03-blockers.md B8). A 4s poll over a link that answers in 9s would fork-bomb the
  // box it is watching, so a tick that lands on a busy loader evaporates instead of queueing.
  const inFlightRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    const token = ++loadTokenRef.current
    inFlightRef.current = true
    setState((current) => ({ ...current, status: 'loading', error: null, refreshError: null }))
    load()
      .then((snapshot) => {
        if (token === loadTokenRef.current && !disposedRef.current) {
          setState({ status: 'ready', snapshot, error: null, refreshError: null })
        }
      })
      .catch((error: unknown) => {
        if (token === loadTokenRef.current && !disposedRef.current) {
          setState({
            status: 'error',
            snapshot: EMPTY_SNAPSHOT,
            error: error instanceof Error ? error.message : String(error),
            refreshError: null
          })
        }
      })
      .finally(() => {
        if (token === loadTokenRef.current) {
          inFlightRef.current = false
        }
      })
    return () => {
      disposedRef.current = true
    }
  }, [load, generation])

  const reload = useCallback(() => setGeneration((value) => value + 1), [])

  const refresh = useCallback(async () => {
    if (inFlightRef.current || disposedRef.current) {
      return
    }
    const token = ++loadTokenRef.current
    inFlightRef.current = true
    try {
      const snapshot = await load()
      if (token === loadTokenRef.current && !disposedRef.current) {
        setState({ status: 'ready', snapshot, error: null, refreshError: null })
      }
    } catch (error: unknown) {
      if (token === loadTokenRef.current && !disposedRef.current) {
        // Only this field moves: the snapshot on screen is still the last one the server confirmed,
        // and it is a better answer than a blank screen for the seconds until the next tick.
        setState((current) => ({
          ...current,
          refreshError: error instanceof Error ? error.message : String(error)
        }))
      }
    } finally {
      if (token === loadTokenRef.current) {
        inFlightRef.current = false
      }
    }
  }, [load])

  const value = useMemo<SnapshotState>(
    () => ({ ...state, reload, refresh }),
    [state, reload, refresh]
  )

  return <SnapshotContext.Provider value={value}>{children}</SnapshotContext.Provider>
}

export function useHerdrSnapshot(): SnapshotState {
  return useContext(SnapshotContext)
}

/** The remote a route segment names, or null while loading / if the id is unknown. */
export function useRemote(remoteId: string | undefined): RemoteDefinition | null {
  const { snapshot } = useHerdrSnapshot()
  if (!remoteId) {
    return null
  }
  return snapshot.remotes.find((remote) => remote.id === remoteId) ?? null
}

/** The four lists for one remote, or null while loading / if that remote was not dialled. */
export function useRemoteSnapshot(remoteId: string | undefined): RemoteSnapshot | null {
  const { snapshot } = useHerdrSnapshot()
  if (!remoteId) {
    return null
  }
  return snapshot.perRemote.find((entry) => entry.remote.id === remoteId) ?? null
}

/** How a remote is addressed, for the one line of subtitle every list row shows. */
export function remoteSubtitle(remote: RemoteDefinition): string {
  return remote.target.type === 'ssh' ? remote.target.target : 'local'
}
