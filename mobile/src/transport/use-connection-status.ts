// Not from orca as a file — orca reads this inline in its session screen
// (`app/h/[hostId]/session/[worktreeId].tsx:4191`, the tappable status line) off the client it holds
// from `useHostClient`. Pulled out here because herdr's screens must render identically when there
// is **no** supervisor (the mock build, and every build before M4), and "null is a legitimate
// answer" is a rule that survives better as a hook signature than as a comment in a JSX block.
//
// `useSyncExternalStore` rather than `useState` + `useEffect`: X4's requirement is that a screen
// re-reads on *every* change, and the store contract is the version of that React itself enforces —
// a change between render and commit is caught rather than dropped. `SupervisedRemote` holds the
// cached snapshot the contract needs (see its header for why the verdict is cached and what that
// costs).
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  showConnectionRetry,
  verdictDisplayLabel,
  type ConnectionVerdict
} from './connection-health'
import type { SupervisedRemote } from './supervised-remote'
import type { ConnectionState } from './connection-state-types'

/** Everything a status line needs, and nothing it could hold across a reconnect. */
export type ConnectionStatus = {
  state: ConnectionState
  verdict: ConnectionVerdict
  /** L6's escalation ladder, already resolved to display text (label + hint after an em dash). */
  label: string
  /** L7: the line is a button only once the verdict has escalated. */
  canRetry: boolean
  /** L7: revives the transport. Not a request resend — see `ConnectionSupervisor.forceReconnect`. */
  retry: () => void
  /** True while a dial is armed. `state === 'reconnecting' && !armed` is orca #5049's park. */
  armed: boolean
  reconnectAttempt: number
}

const NO_SUBSCRIBE = (): (() => void) => () => {}
const NO_SNAPSHOT = (): null => null

/** The supervised connection's status, or null when that remote has no supervisor. */
export function useConnectionStatus(supervised: SupervisedRemote | null): ConnectionStatus | null {
  // Both arguments must keep a stable identity across renders or the store resubscribes every time.
  // `SupervisedRemote.subscribe`/`getSnapshot` are bound instance fields for exactly this.
  const snapshot = useSyncExternalStore(
    supervised?.subscribe ?? NO_SUBSCRIBE,
    supervised?.getSnapshot ?? NO_SNAPSHOT
  )
  const retry = useCallback(() => supervised?.retry(), [supervised])

  return useMemo(() => {
    if (snapshot === null) {
      return null
    }
    return {
      state: snapshot.state,
      verdict: snapshot.verdict,
      label: verdictDisplayLabel(snapshot.verdict),
      canRetry: showConnectionRetry(snapshot.verdict),
      retry,
      armed: snapshot.armed,
      reconnectAttempt: snapshot.reconnectAttempt
    }
  }, [retry, snapshot])
}
