// Rewritten for herdr, from orca mobile/src/transport/client-context.tsx (453 lines, port map §2.3
// grades it `port` and schedules it for stage 6)
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// Kept from orca: the idea the file exists for — **one client per host, held by a provider, looked
// up by id** (`useHostClient`, `:385-399`) — so a screen never constructs a transport and two
// screens on the same remote cannot end up with two ssh connections.
//
// Dropped, and each is a deliberate deferral rather than a simplification:
//   · acquire/release ref-counting and the lazy open/close it drives (`:120-236`) — herdr's
//     connections are supplied by whoever mounts the provider (Node harness today, a native module
//     later), so there is nothing here to open lazily. Ref-counting arrives with the thing that
//     opens.
//   · `forceReconnect` (`:238-260`) and the `getAllClients()` re-read loop (`:385-399`, X4) — those
//     are reconnection, i.e. M4 / port map stage 8 (L1-L7, X1-X6). A stub now would be a second
//     home for a state machine that gets ported whole.
//   · connection state (`connecting`/`handshaking`/…) — same reason; `src/transport/
//     connection-state-types.ts` already holds the types for when it lands.
//
// So what is left is the lookup, which is exactly what stage 6 needs: the snapshot loader and the
// pane viewer both ask this for "the connection for remote X" and get the same object.
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { HerdrRemoteConnection } from './herdr-connection'

const HerdrClientsContext = createContext<readonly HerdrRemoteConnection[]>([])

export function HerdrClientsProvider({
  connections,
  children
}: {
  connections: readonly HerdrRemoteConnection[]
  children: ReactNode
}) {
  // `react/jsx-no-constructed-context-values`: the array identity has to be stable or every screen
  // reading it re-renders on any parent render.
  const value = useMemo(() => connections, [connections])
  return <HerdrClientsContext.Provider value={value}>{children}</HerdrClientsContext.Provider>
}

/** Every remote the phone can actually reach. Empty means "no transport" — see `herdr-data-provider`. */
export function useHerdrConnections(): readonly HerdrRemoteConnection[] {
  return useContext(HerdrClientsContext)
}

/** The connection for one route segment, or null when that remote is listed but not dialled. */
export function useHerdrConnection(remoteId: string | undefined): HerdrRemoteConnection | null {
  const connections = useHerdrConnections()
  if (!remoteId) {
    return null
  }
  return connections.find((connection) => connection.remote.id === remoteId) ?? null
}
