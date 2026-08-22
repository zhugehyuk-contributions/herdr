// Rewritten for herdr, from orca mobile/src/transport/client-context.tsx (453 lines, port map §2.3
// grades it `port` and schedules it for stage 6)
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// Kept from orca: the idea the file exists for — **one client per host, held by a provider, looked
// up by id** (`useHostClient`, `:385-399`) — so a screen never constructs a transport and two
// screens on the same remote cannot end up with two ssh connections.
//
// Dropped at stage 6, and **restored here at M4** now that the state machine they belong to exists:
//   · `forceReconnect` (`:238-260`) and the `getAllClients()` re-read loop (`:385-399`, X4) — both
//     live on `./supervised-remote.ts`, which this provider now carries alongside the connections.
//     A screen gets them through `useHerdrSupervisor`, and never by holding a link.
//   · connection state (`connecting`/`handshaking`/…) — same object; `./connection-state-types.ts`
//     held the types for exactly this.
//   · the effect that fans OS revival signals out to every live client (`:299-313`) — that is L4,
//     and `./revival-nudge.ts` names this file as its two-line mount. It is below.
//
// Still dropped, and still a deliberate deferral: acquire/release ref-counting and the lazy
// open/close it drives (`:120-236`). herdr's connections are supplied by whoever mounts the provider
// (Node harness today, `modules/herdr-ssh` on a phone), so there is nothing here to open lazily.
//
// Two lists, not one, and the reason is worth stating: a `HerdrRemoteConnection` is the *data* face
// of a remote (`api` + `openTerminalStream`, read by the snapshot loader and the pane observer)
// while a `SupervisedRemote` is its *health* — and they can legitimately disagree. A remote with a
// connection and no supervisor is every build before M4; a remote whose supervisor says
// `auth-failed` while its last snapshot still renders is precisely the state L6's ladder exists to
// describe. Keying both by `remote.id` is what lets a screen ask the two questions separately.
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { bindConnectionRevival, type RevivalSubscribe } from './revival-nudge'
import type { HerdrRemoteConnection } from './herdr-connection'
import type { SupervisedRemote } from './supervised-remote'

const HerdrClientsContext = createContext<readonly HerdrRemoteConnection[]>([])
const HerdrSupervisorsContext = createContext<readonly SupervisedRemote[]>([])

const NO_SUPERVISORS: readonly SupervisedRemote[] = Object.freeze([])

export function HerdrClientsProvider({
  connections,
  supervisors = NO_SUPERVISORS,
  subscribeRevival,
  children
}: {
  connections: readonly HerdrRemoteConnection[]
  /** M4. Absent means "no transport supervision", which is every build before this milestone. */
  supervisors?: readonly SupervisedRemote[]
  /**
   * L4's trigger source. Injected for the reason `./revival-nudge.ts` takes it as a parameter:
   * `./connection-revival-triggers.ts` imports `react-native`'s `AppState` and `expo-network`, and
   * this file is mounted by suites whose environment has neither. Omitted, the real one is loaded by
   * a **dynamic** import so it never enters this module's static graph — and a host without those
   * modules gets no nudges instead of a crashed mount.
   */
  subscribeRevival?: RevivalSubscribe
  children: ReactNode
}) {
  // `react/jsx-no-constructed-context-values`: the array identity has to be stable or every screen
  // reading it re-renders on any parent render.
  const value = useMemo(() => connections, [connections])
  const supervisorValue = useMemo(() => supervisors, [supervisors])

  // X4 in the trigger layer: `bindConnectionRevival` takes a *function* so a remote added or removed
  // between subscribing and the nudge is included or excluded as of the nudge. Capturing the array
  // in the closure would be the same staleness bug one level up.
  const liveSupervisors = useRef(supervisorValue)
  liveSupervisors.current = supervisorValue

  useEffect(() => {
    if (supervisorValue.length === 0) {
      // Nothing to nudge, and — the part that matters — no reason to import the OS modules at all.
      // Every existing mount suite lands here, and lands with no state update.
      return
    }
    let live = true
    let unsubscribe: (() => void) | null = null
    const source: Promise<RevivalSubscribe> =
      subscribeRevival === undefined
        ? import('./connection-revival-triggers').then(
            (module) => module.subscribeConnectionRevivalTriggers
          )
        : Promise.resolve(subscribeRevival)
    void source
      .then((subscribe) => {
        if (live) {
          unsubscribe = bindConnectionRevival(() => liveSupervisors.current, subscribe)
        }
      })
      .catch(() => {
        // A host with no `expo-network`/`AppState` keeps its reconnect loop; it only loses the "the
        // radio came back" shortcut. Failing the mount over that would be the worse trade.
      })
    return () => {
      live = false
      unsubscribe?.()
    }
  }, [subscribeRevival, supervisorValue])

  return (
    <HerdrClientsContext.Provider value={value}>
      <HerdrSupervisorsContext.Provider value={supervisorValue}>
        {children}
      </HerdrSupervisorsContext.Provider>
    </HerdrClientsContext.Provider>
  )
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

/** Every supervised remote. Empty in a build with no transport supervision. */
export function useHerdrSupervisors(): readonly SupervisedRemote[] {
  return useContext(HerdrSupervisorsContext)
}

/**
 * The supervisor for one route segment, or null when that remote is not supervised.
 *
 * Null is a real answer, not a hole: the mock build and every pre-M4 build have connections and no
 * supervisors, and the screens are required to keep working there (`src/components/
 * ConnectionStatusLine.tsx` renders nothing rather than a fake "Connected").
 */
export function useHerdrSupervisor(remoteId: string | undefined): SupervisedRemote | null {
  const supervisors = useHerdrSupervisors()
  if (!remoteId) {
    return null
  }
  return supervisors.find((supervised) => supervised.remoteId === remoteId) ?? null
}
