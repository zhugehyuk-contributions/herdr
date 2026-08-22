// Rewritten for herdr, from orca mobile/src/transport/rpc-client.ts (the reconnect closure: `:754-780`
// `scheduleReconnect`, `:809-817` `closeAndSynthesize`, `:829-840` `redialNow`, `:1166-1200`
// `notifyForeground`, `:1202-1222` `close`) and mobile/src/transport/client-context.tsx:238-260
// (`forceReconnect`)
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// **The M4 state machine.** Every rule in mobile/.prd/05-orca-transport.md that is not a pure
// function lives here, and the pure ones are imported rather than re-stated: L1/L1b
// (`./rpc-session-liveness-watchdog`), L3 (`./reconnect-policy`), L5 (`./rpc-stale-dial`), L6
// (`./connection-health`), X1/X1b (`./observe-subscriptions`).
//
// The property this file exists to hold is milestone M4's zero: **강제종료로만 낫는 상태 0건.** Stated
// as an invariant over the state machine rather than as a hope:
//
//   > From every reachable state, at least one of these is true — the link is connected; a dial is
//   > armed; the supervisor is latched on a failure retrying cannot fix *and* `forceReconnect()`
//   > leaves that latch; or the caller closed it on purpose.
//
// `./connection-supervisor.test.ts` enumerates the states and asserts exactly that. Note which of
// the four is the trap: "a dial is armed". orca #5049 was a client sitting in `reconnecting` with
// **no timer**, which reads identically to a healthy backoff from the outside and is why L3's
// trickle is the table's most important line.
//
// ## What was rewritten rather than ported, and why
//
// orca's version of this is a closure inside a 1,224-line file that owns a `WebSocket`, an E2EE
// handshake and 40 RPC methods. Two things follow from herdr's transport that make it a separate,
// injectable object here instead:
//
//   - **There is no `readyState`.** 05's closing paragraph maps it to "자식 살아있고 파이프 열렸는데
//     바이트가 안 옴", which is not a property anything can read — it is the *absence* of an event.
//     So the half-open detector is not a check, it is the L1 watchdog, and this file's only job on
//     that front is to give the watchdog something to terminate.
//   - **There is no close code.** A channel dies with `{exitCode, signal, stderr, error}`, so the
//     auth/version/binary verdicts come from `./channel-failure.ts` rather than from `4001`.
//
// And `dial` is injected because the thing being dialled is a native module that does not exist yet
// (02-architecture.md §2.4 N1). That is not a testing convenience bolted on afterwards: it is the
// same seam `src/transport/herdr-connection.ts` already draws, and it is what lets the receipt drive
// this machine with a fake clock and a fake link, then drive the *identical* machine against a real
// ssh channel in `test/live/`.
import {
  RpcSessionLivenessWatchdog,
  type RpcSessionIdentity
} from './rpc-session-liveness-watchdog'
import { ReconnectScheduler, type ReconnectDecision } from './reconnect-policy'
import { isStaleForegroundDial } from './rpc-stale-dial'
import { classifyChannelFailure, type ChannelFailure } from './channel-failure'
import { classifyConnection, type ConnectionVerdict } from './connection-health'
import {
  ObserveSubscriptionRegistry,
  type ObserveSubscription,
  type ObserveSubscriptionParams
} from './observe-subscriptions'
import type { ConnectionState } from './connection-state-types'
import type { HerdrChannelClose, TransportTimer } from '@herdr/client-ts'

/**
 * One live connection, as this file needs to see it. Everything else about the transport —
 * channels, framing, the codec — is the caller's.
 */
export type SupervisedLink = {
  /**
   * Writes one `ClientMessage::Ping` on the resident stream. `false` means the write could not even
   * be attempted, which orca treats as instant death (`rpc-session-liveness-watchdog.ts:140-143`)
   * because a transport that cannot accept a 4-byte frame is not going to accept a subscription.
   */
  probe: (nonce: number) => boolean
  /** Kills this link. Must tolerate being called after it has already died. */
  terminate: () => void
}

export type ConnectionSupervisorOptions = {
  /**
   * Opens a transport and completes the herdr handshake. `signalHandshaking` marks the moment the
   * dial became a handshake, which is the state L5 treats as "still a dial" — an ssh connection
   * that authenticated but whose remote `herdr` never answered is exactly 05's mapping of orca's
   * handshake timeout ("ssh는 붙었는데 원격 herdr이 말을 안 함").
   */
  dial: (signalHandshaking: () => void) => Promise<SupervisedLink>
  /**
   * Re-establishes one stored subscription on the *current* link. Resolves `true` when the observe
   * request went out. X1: the supervisor decides *that* a replay is owed; only the caller knows how
   * to say `Hello{cols,rows}` + `ObserveTerminal{paneId}` + `RequestFullFrame` on its own channels.
   */
  replay: (subscription: ObserveSubscription) => Promise<boolean>
  timer: TransportTimer
  now?: () => number
  /** Watchdog knobs, for the receipt. Production uses orca's constants. */
  liveness?: { idleProbeMs?: number | null; probeTimeoutMs?: number; missedProbeLimit?: number }
  onState?: (state: ConnectionState) => void
  /** X4: fired on *every* change so a screen re-reads rather than caching a replaced link. */
  onChange?: () => void
  onLog?: (line: string) => void
}

/** Everything a screen needs, recomputed on demand — never cached across a state change (X4). */
export type SupervisorSnapshot = {
  state: ConnectionState
  reconnectAttempt: number
  lastConnectedAt: number | null
  failure: ChannelFailure | null
  verdict: ConnectionVerdict
  /** True while a dial is armed. `state === 'reconnecting' && !armed` is the #5049 park. */
  armed: boolean
  generation: number
}

export class ConnectionSupervisor {
  readonly subscriptions = new ObserveSubscriptionRegistry()
  private readonly options: ConnectionSupervisorOptions
  private readonly now: () => number
  private readonly scheduler: ReconnectScheduler
  private readonly watchdog: RpcSessionLivenessWatchdog
  private state: ConnectionState = 'disconnected'
  private link: SupervisedLink | null = null
  private identity: RpcSessionIdentity | null = null
  private dialStartedAt = 0
  private lastConnectedAt: number | null = null
  private failure: ChannelFailure | null = null
  private intentionallyClosed = false
  private nonce = 0
  /** Bumped whenever the link object is replaced. X4's "the handle you hold may be stale". */
  private generation = 0

  constructor(options: ConnectionSupervisorOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.scheduler = new ReconnectScheduler({
      dial: () => this.openConnection(),
      timer: options.timer,
      onSchedule: (decision) => this.logSchedule(decision)
    })
    this.watchdog = new RpcSessionLivenessWatchdog({
      transport: 'direct',
      sendProbe: (identity) => this.sendProbe(identity),
      terminate: (identity) => this.terminateForLiveness(identity),
      ...options.liveness,
      now: this.now,
      setTimer: ((handler: () => void, ms: number) =>
        options.timer.setTimeout(handler, ms)) as unknown as typeof setTimeout,
      clearTimer: ((handle: unknown) =>
        options.timer.clearTimeout(handle)) as unknown as typeof clearTimeout
    })
  }

  snapshot(): SupervisorSnapshot {
    return {
      state: this.state,
      reconnectAttempt: this.scheduler.reconnectAttempt,
      lastConnectedAt: this.lastConnectedAt,
      failure: this.failure,
      verdict: classifyConnection({
        state: this.state,
        reconnectAttempts: this.scheduler.reconnectAttempt,
        lastConnectedAt: this.lastConnectedAt,
        hint: this.failure?.hint ?? null,
        fatalFailure: this.failure?.fatal === true ? this.failure.kind : null,
        nowMs: this.now()
      }),
      armed: this.scheduler.armed,
      generation: this.generation
    }
  }

  /** The link a caller may write on, or null. Re-read it after every {@link onChange} (X4). */
  get current(): SupervisedLink | null {
    return this.link
  }

  /** Registers a pane to observe. Sent by the caller; replayed by this class after a reconnect. */
  observe(params: ObserveSubscriptionParams): ObserveSubscription {
    return this.subscriptions.add(params)
  }

  start(): void {
    if (this.intentionallyClosed || this.state !== 'disconnected') {
      return
    }
    this.openConnection()
  }

  /**
   * L7. The status line's Retry — and the *only* thing that leaves a fatal latch, which is why L7
   * insists the tap revive the transport rather than resend a request: resending against a refused
   * key changes nothing, and orca's #5049 users had no third option but the app switcher.
   *
   * X4: the link object is replaced, not reused, and {@link onChange} fires so every screen re-reads.
   */
  forceReconnect(): void {
    this.intentionallyClosed = false
    this.failure = null
    this.teardownLink()
    this.scheduler.cancel()
    this.scheduler.redialNow(true)
  }

  /**
   * L4's single nudge, and L5's stale-dial rule. orca `rpc-client.ts:1166-1200`, structure intact.
   */
  notifyForeground(reason: 'app-resume' | 'network-change' = 'app-resume'): void {
    if (this.intentionallyClosed) {
      return
    }
    if (this.state === 'connected') {
      // Why: resume probes now; three fair misses detect a half-open channel within 24s.
      this.log(`foreground(${reason}) — probing live connection`)
      if (this.identity) {
        this.watchdog.probeNow(this.identity)
      }
      return
    }
    let abandoned = false
    // orca guards this with `const dialing = ws` — it constructs the `WebSocket` synchronously, so
    // "a dial is in flight" is an object it can hold. Here a dial in flight is a *pending promise*,
    // and the whole point of L5 is the case where that promise never settles, so there is nothing to
    // hold and `this.link` is still null. The state is the evidence, and `isStaleForegroundDial`
    // already demands `connecting`/`handshaking` — checking for a link object as well made this
    // branch unreachable in exactly the scenario it exists for.
    if (isStaleForegroundDial(this.state, this.now() - this.dialStartedAt)) {
      this.log(`foreground(${reason}) — abandoning stale dial in ${this.state}`)
      // L2: a forced teardown must synthesize the close it may never be handed. An ssh exec that is
      // killed while its TCP path is already dead delivers nothing at all.
      this.closeAndSynthesize({ error: new Error('stale foreground dial abandoned') })
      abandoned = true
    }
    if (this.state === 'reconnecting') {
      this.log(`foreground(${reason}) — restarting reconnect loop at attempt ${this.scheduler.reconnectAttempt}`)
      // L5: an abandoned dial keeps the failure it already represents — we skip the wait, we do not
      // pardon it. A redial with no dial to abandon is a genuinely fresh start.
      this.scheduler.redialNow(!abandoned)
    }
  }

  /**
   * The caller reports a channel death it observed.
   *
   * Idempotent by construction, which orca achieves with `isStaleRpcSocketEvent`
   * (`rpc-socket-close-evidence.ts:36-48`) and this achieves by asking whether there was anything
   * left to lose: after `onDead` the link is null and the state has moved off the dial, so a late
   * close from the channel that just died is dropped instead of booking a second failure. Counting
   * one death twice would double the attempt counter, which is the number L3's cap and L6's ladder
   * both key off.
   */
  handleLinkClosed(close: HerdrChannelClose, handshakeError?: unknown): void {
    if (this.intentionallyClosed) {
      return
    }
    const live =
      this.link !== null || this.state === 'connecting' || this.state === 'handshaking'
    if (!live) {
      return
    }
    this.onDead(classifyChannelFailure(close, handshakeError))
  }

  /** Every inbound frame — decoded or not. L1's evidence that the peer is still producing bytes. */
  noteInbound(): void {
    if (this.identity) {
      this.watchdog.noteAuthenticatedInbound(this.identity)
    }
  }

  /** X1b, forwarded so callers never reach into the registry mid-flight. */
  updateObserveViewport(paneId: string, viewport: { cols: number; rows: number }): number {
    return this.subscriptions.updateObserveViewport(paneId, viewport)
  }

  close(): void {
    this.intentionallyClosed = true
    this.scheduler.cancel()
    this.teardownLink()
    this.subscriptions.markStreamsForReplay()
    this.setState('disconnected')
  }

  // -------------------------------------------------------------------------

  private openConnection(): void {
    if (this.intentionallyClosed) {
      return
    }
    this.teardownLink()
    this.dialStartedAt = this.now()
    this.setState('connecting')
    const generation = this.generation
    void this.options
      .dial(() => {
        if (generation === this.generation && this.state === 'connecting') {
          this.setState('handshaking')
        }
      })
      .then(
        (link) => {
          if (generation !== this.generation || this.intentionallyClosed) {
            link.terminate()
            return
          }
          this.onConnected(link)
        },
        (error: unknown) => {
          if (generation !== this.generation || this.intentionallyClosed) {
            return
          }
          this.onDead(
            classifyChannelFailure(
              { error: error instanceof Error ? error : new Error(String(error)) },
              error
            )
          )
        }
      )
  }

  private onConnected(link: SupervisedLink): void {
    this.link = link
    this.identity = {}
    this.failure = null
    this.lastConnectedAt = this.now()
    this.scheduler.noteConnected()
    this.setState('connected')
    this.watchdog.start(this.identity)
    void this.replayAll()
  }

  /** X1: everything the registry still owes the server, sent on the generation that just came up. */
  private async replayAll(): Promise<void> {
    const generation = this.generation
    for (const subscription of this.subscriptions.pendingReplay()) {
      let sent = false
      try {
        sent = await this.options.replay(subscription)
      } catch {
        sent = false
      }
      if (generation !== this.generation) {
        return
      }
      if (sent) {
        this.subscriptions.markSent(subscription.id)
      }
    }
    this.log(`replayed ${this.subscriptions.list().filter((s) => s.sent).length} subscription(s)`)
  }

  private onDead(failure: ChannelFailure): void {
    this.failure = failure
    this.teardownLink()
    // X1: mark now, not on the next successful connect. An entry left `sent` across a dead channel
    // is a subscription the app believes is live and the server has never heard of.
    this.subscriptions.markStreamsForReplay()
    if (failure.fatal) {
      // Latched: dialling again produces the identical result. `forceReconnect()` is the way out,
      // and L6/L7 make it reachable — the status line says which failure and becomes a button.
      //
      // All three fatal kinds land in `auth-failed`, and that is orca's meaning of the state rather
      // than a loss of detail: `connection-health` reads it as "retrying can't fix it, only a
      // different action can". Which action is `failure.kind`'s job, and `FATAL_LABELS` says it.
      // Using `disconnected` instead would make the parked state indistinguishable from the
      // never-started one, and M4's invariant is checked *on the state*.
      this.log(`latched ${failure.kind}: ${failure.detail}`)
      this.setState('auth-failed')
      return
    }
    this.setState('reconnecting')
    this.scheduler.schedule()
  }

  /** L2. Kill the link and *synthesize* the close, because none may ever be delivered. */
  private closeAndSynthesize(close: HerdrChannelClose): void {
    this.onDead(classifyChannelFailure(close))
  }

  private sendProbe(identity: RpcSessionIdentity): boolean {
    if (this.identity !== identity || this.link === null) {
      return false
    }
    this.nonce += 1
    try {
      return this.link.probe(this.nonce)
    } catch {
      return false
    }
  }

  private terminateForLiveness(identity: RpcSessionIdentity): void {
    if (this.identity !== identity) {
      return
    }
    this.log('liveness watchdog terminated the link')
    this.closeAndSynthesize({ error: new Error('liveness watchdog: no inbound frames') })
  }

  private teardownLink(): void {
    if (this.identity) {
      this.watchdog.stop(this.identity)
      this.identity = null
    }
    if (this.link !== null) {
      const link = this.link
      this.link = null
      try {
        link.terminate()
      } catch {
        // A link that is already gone is the normal case here, not an error.
      }
    }
    this.generation += 1
  }

  private setState(next: ConnectionState): void {
    const changed = this.state !== next
    this.state = next
    if (changed) {
      this.options.onState?.(next)
    }
    this.options.onChange?.()
  }

  private logSchedule(decision: ReconnectDecision): void {
    this.log(
      `scheduleReconnect delayMs=${decision.delayMs} attempt=${decision.attempt} trickle=${decision.trickle}`
    )
  }

  private log(line: string): void {
    this.options.onLog?.(line)
  }
}
