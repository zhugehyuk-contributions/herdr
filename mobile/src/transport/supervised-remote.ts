// Not from orca as a file — orca keeps this state inside `client-context.tsx` (`:120-236` the store,
// `:238-260` `forceReconnect`, `:385-399` the `getAllClients()` re-read), which the port map grades
// `port` and this repo split in two: the *policy* is `./connection-supervisor.ts` (M4), and this is
// the half a React tree needs, which orca's file mixes into the provider.
//
// It exists because `ConnectionSupervisor` has exactly one `onChange` and a React tree has N
// readers. Two things follow, and they are the whole file:
//
//   1. **A fan-out.** `onChange` is a single callback; `subscribe`/`getSnapshot` here is the
//      `useSyncExternalStore` contract, so any number of screens can read the same supervisor.
//   2. **A stable snapshot.** `ConnectionSupervisor.snapshot()` allocates a new object every call
//      (`verdict` is recomputed against `now()` by design — `./connection-health.ts`), and
//      `useSyncExternalStore` re-renders forever if `getSnapshot` is not referentially stable
//      between changes. So `getSnapshot` takes a fresh one, compares it **field by field** with the
//      one it is holding, and returns the held object when nothing moved.
//
// The first attempt at (2) cached on `onChange` instead, and the receipt below caught why that is
// wrong: `ConnectionSupervisor.onDead` calls `setState('reconnecting')` — which fires `onChange` —
// and *then* `scheduler.schedule()`. A listener snapshotting at notification time therefore records
// `armed: false` for a loop that arms a timer one line later, i.e. it publishes orca #5049's park
// signature for a connection that is retrying perfectly well. Reading on demand and comparing is
// immune to the ordering of the change that woke it, which is the property to want here: this class
// must not encode assumptions about *when* the supervisor is internally consistent.
//
// X4 in one sentence: nothing here hands out the *link*. A screen gets a snapshot and a `retry`,
// re-reads on every change, and never holds an object that `forceReconnect` replaced.
import {
  ConnectionSupervisor,
  type ConnectionSupervisorOptions,
  type SupervisorSnapshot
} from './connection-supervisor'
import type { ObserveSubscription, ObserveSubscriptionParams } from './observe-subscriptions'
import type { RevivalReason } from './revival-nudge'
import type { HerdrChannelClose } from '@herdr/client-ts'

/**
 * What a link implementation is allowed to tell the supervisor.
 *
 * Exposed as two functions rather than as the supervisor itself so the link cannot reach
 * `forceReconnect`/`close` — a transport that decides to restart itself is how a reconnect loop
 * ends up with two schedulers.
 */
export type SupervisorLinkHooks = {
  /** Every inbound frame, decoded or not. L1's evidence that the peer is still producing bytes. */
  noteInbound: () => void
  /** The channel died. Idempotent on the supervisor's side; call it on every close you observe. */
  reportClosed: (close: HerdrChannelClose, handshakeError?: unknown) => void
}

/**
 * Builds the `dial`/`replay` pair for one remote.
 *
 * A factory rather than the pair directly because both need to report *into* the supervisor that is
 * about to be constructed from them. `./observe-stream-link.ts` is the implementation the app uses;
 * `test/live/paneViewerOutage.live.test.tsx` supplies another that redials a whole ssh connection,
 * which is the point of the seam — the same state machine, two transports.
 */
export type SupervisorLinkFactory = (hooks: SupervisorLinkHooks) => {
  dial: ConnectionSupervisorOptions['dial']
  replay: ConnectionSupervisorOptions['replay']
}

export type SupervisedRemoteOptions = Omit<ConnectionSupervisorOptions, 'dial' | 'replay'> & {
  /** `RemoteDefinition.id`. The key screens look this up by. */
  remoteId: string
  link: SupervisorLinkFactory
}

/** One remote's supervised connection, in the shape `useSyncExternalStore` reads. */
export class SupervisedRemote {
  readonly remoteId: string
  readonly supervisor: ConnectionSupervisor
  private readonly listeners = new Set<() => void>()
  private cached: SupervisorSnapshot

  constructor(options: SupervisedRemoteOptions) {
    const { remoteId, link, ...supervisorOptions } = options
    this.remoteId = remoteId
    // The hooks read `this.supervisor` lazily: `link()` only *stores* these closures, and neither
    // `dial` nor `replay` can run before `start()`, which is after the assignment below.
    const { dial, replay } = link({
      noteInbound: () => this.supervisor.noteInbound(),
      reportClosed: (close, handshakeError) =>
        this.supervisor.handleLinkClosed(close, handshakeError)
    })
    this.supervisor = new ConnectionSupervisor({
      ...supervisorOptions,
      dial,
      replay,
      onChange: () => this.publish()
    })
    this.cached = this.supervisor.snapshot()
  }

  /** Bound, so `useSyncExternalStore` sees a stable identity for the life of the instance. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): SupervisorSnapshot => {
    const next = this.supervisor.snapshot()
    // The identity is only replaced when something a reader can see actually moved. `verdict` is
    // compared by its rendered fields rather than by reference because it is rebuilt on every call.
    if (
      next.state === this.cached.state &&
      next.reconnectAttempt === this.cached.reconnectAttempt &&
      next.lastConnectedAt === this.cached.lastConnectedAt &&
      next.armed === this.cached.armed &&
      next.generation === this.cached.generation &&
      next.failure?.kind === this.cached.failure?.kind &&
      next.failure?.detail === this.cached.failure?.detail &&
      next.verdict.kind === this.cached.verdict.kind &&
      next.verdict.label === this.cached.verdict.label &&
      verdictHint(next.verdict) === verdictHint(this.cached.verdict)
    ) {
      return this.cached
    }
    this.cached = next
    return next
  }

  start(): void {
    this.supervisor.start()
  }

  close(): void {
    this.supervisor.close()
  }

  /** L7. The status line's Retry — revives the transport, never resends a request. */
  readonly retry = (): void => {
    this.supervisor.forceReconnect()
  }

  /** L4. {@link SupervisedRemote} is the {@link import('./revival-nudge').Nudgeable} the app fans to. */
  notifyForeground(reason: RevivalReason = 'app-resume'): void {
    this.supervisor.notifyForeground(reason)
  }

  /** X1. Registers a pane so a reconnect replays it. See `./observe-subscriptions.ts`. */
  observe(params: ObserveSubscriptionParams): ObserveSubscription {
    return this.supervisor.observe(params)
  }

  /** X1b. The phone rotated; the *next* `Hello` must carry this, not the size at subscribe time. */
  updateObserveViewport(paneId: string, viewport: { cols: number; rows: number }): number {
    return this.supervisor.updateObserveViewport(paneId, viewport)
  }

  private publish(): void {
    // Deliberately does **not** snapshot. The reader does, on demand — see the header for the
    // ordering bug that discipline exists to survive.
    //
    // A copy of the set: a listener that unsubscribes itself while being notified (React does
    // exactly this on unmount) would otherwise mutate it mid-iteration. `oxlint`'s
    // `unicorn/no-useless-spread` reads this as a redundant array; it is the point of the line, so
    // the snapshot is taken with `Array.from` — same copy, no lint suppression comment.
    for (const listener of Array.from(this.listeners)) {
      listener()
    }
  }
}

/** `ConnectionVerdict`'s hint lives on every member except `normal`, which has no failure to hint at. */
function verdictHint(verdict: SupervisorSnapshot['verdict']): string | undefined {
  return verdict.kind === 'normal' ? undefined : verdict.hint
}
