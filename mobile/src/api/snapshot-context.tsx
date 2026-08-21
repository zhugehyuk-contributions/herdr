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
import type { AgentInfo, PaneInfo, RemoteDefinition, WorkspaceInfo } from './herdr-api-types'

/** The four list endpoints, as one value. */
export type HerdrSnapshot = {
  remotes: RemoteDefinition[]
  workspaces: WorkspaceInfo[]
  panes: PaneInfo[]
  agents: AgentInfo[]
}

export const EMPTY_SNAPSHOT: HerdrSnapshot = {
  remotes: [],
  workspaces: [],
  panes: [],
  agents: []
}

export type SnapshotLoader = () => Promise<HerdrSnapshot>

export type SnapshotState = {
  status: 'loading' | 'ready' | 'error'
  snapshot: HerdrSnapshot
  error: string | null
  reload: () => void
}

const SnapshotContext = createContext<SnapshotState>({
  status: 'loading',
  snapshot: EMPTY_SNAPSHOT,
  error: null,
  reload: () => {}
})

export function HerdrSnapshotProvider({
  load,
  children
}: {
  load: SnapshotLoader
  children: ReactNode
}) {
  const [state, setState] = useState<Omit<SnapshotState, 'reload'>>({
    status: 'loading',
    snapshot: EMPTY_SNAPSHOT,
    error: null
  })
  const [generation, setGeneration] = useState(0)
  // Why: a load that resolves after the provider unmounts (or after a reload superseded it) must
  // not write state — the same "stale" guard orca uses around its async preference loads.
  const disposedRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    let superseded = false
    setState((current) => ({ ...current, status: 'loading', error: null }))
    load()
      .then((snapshot) => {
        if (!superseded && !disposedRef.current) {
          setState({ status: 'ready', snapshot, error: null })
        }
      })
      .catch((error: unknown) => {
        if (!superseded && !disposedRef.current) {
          setState({
            status: 'error',
            snapshot: EMPTY_SNAPSHOT,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })
    return () => {
      superseded = true
      disposedRef.current = true
    }
  }, [load, generation])

  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  const value = useMemo<SnapshotState>(() => ({ ...state, reload }), [state, reload])

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

/** How a remote is addressed, for the one line of subtitle every list row shows. */
export function remoteSubtitle(remote: RemoteDefinition): string {
  return remote.target.type === 'ssh' ? remote.target.target : 'local'
}
