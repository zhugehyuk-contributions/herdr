// Not from orca — orca's provider *is* the thing that opens its WebSocket, so "turn the configured
// hosts into supervised clients" is a paragraph inside `client-context.tsx:120-236`. herdr's
// connections arrive from outside the transport layer (`modules/herdr-ssh/src/app-connections.ts`
// dials them, the Node harness supplies them), so the equivalent step is this hook: **one
// `SupervisedRemote` per connection, started on mount, closed on unmount.**
//
// It is the app's mount of M4 and it is deliberately thin, because the interesting decisions are one
// level down: the state machine is `./connection-supervisor.ts` and the thing it dials is
// `./observe-stream-link.ts`, whose header states plainly what a connection-level link can and
// cannot recover from.
//
// ⚠️ **Cost, stated up front.** Each supervised remote holds one extra resident `remote-client-bridge`
// exec channel — the health link the L1 watchdog probes. That is a second channel per remote on top
// of the pane's observe stream (blocker B8/B13 territory), and it buys the thing M4 exists for: a
// connection whose death is *detected* rather than inferred from a frozen screen. It is inert today
// — `app.json`'s `expo.extra.herdrRemotes` is `[]`, so there are no connections, so this returns the
// frozen empty array and opens nothing.
import { useEffect, useMemo } from 'react'
import { hostTimer } from '@herdr/client-ts'
import { SupervisedRemote } from './supervised-remote'
import { createObserveStreamLink } from './observe-stream-link'
import type { HerdrRemoteConnection } from './herdr-connection'

const NO_SUPERVISED: readonly SupervisedRemote[] = Object.freeze([])

export type UseSupervisedRemotesOptions = {
  /** Watchdog knobs. Omitted means orca's production constants (`./rpc-session-liveness-watchdog.ts`). */
  liveness?: { idleProbeMs?: number | null; probeTimeoutMs?: number; missedProbeLimit?: number }
  onLog?: (remoteId: string, line: string) => void
}

/**
 * Supervises every connection the provider was handed.
 *
 * Identity is tied to the `connections` array: a new array means new supervisors, and the old ones
 * are closed by the effect's cleanup. That is correct rather than merely convenient — a connection
 * object is a wrapper over one transport, so a replaced array *is* a replaced transport, and a
 * supervisor that outlived it would be probing a channel factory that can no longer produce one.
 */
export function useSupervisedRemotes(
  connections: readonly HerdrRemoteConnection[],
  options: UseSupervisedRemotesOptions = {}
): readonly SupervisedRemote[] {
  const { liveness, onLog } = options
  const supervised = useMemo(() => {
    if (connections.length === 0) {
      // A stable identity for the empty case: the provider memoizes on this array and a fresh `[]`
      // per render would resubscribe L4 on every parent render.
      return NO_SUPERVISED
    }
    return connections.map((connection) => {
      const report = (line: string): void => onLog?.(connection.remote.id, line)
      return new SupervisedRemote({
        remoteId: connection.remote.id,
        // Both halves report into the same log: the supervisor's schedule/latch lines and the
        // link's handshake lines are one story when something goes wrong.
        link: createObserveStreamLink({ connection, onLog: report }),
        timer: hostTimer,
        ...(liveness === undefined ? {} : { liveness }),
        onLog: report
      })
    })
  }, [connections, liveness, onLog])

  useEffect(() => {
    if (supervised.length === 0) {
      return
    }
    for (const remote of supervised) {
      remote.start()
    }
    return () => {
      for (const remote of supervised) {
        remote.close()
      }
    }
  }, [supervised])

  return supervised
}
