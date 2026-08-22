// Not from orca. orca's supervised link *is* its WebSocket, so its `dial` is `new WebSocket(url)`
// and there is nothing to write. herdr's is a `remote-client-bridge` exec channel plus the herdr
// handshake (02-architecture.md §2.1/§2.2), so somebody has to say `Hello`, check `Welcome`, and
// know which channel `RequestFullFrame` goes out on. This file is that, and only that: the
// {@link SupervisorLinkFactory} the app hands `SupervisedRemote`.
//
// It is the same six steps `src/session/pane-observer.ts` performs, arranged for a different owner,
// and the split is deliberate rather than accidental duplication:
//
//   · `PaneObserver` owns **one pane's picture**. It resolves geometry from `pane.layout`, feeds a
//     `TerminalFrameSink`, and dies when the screen switches panes (B6 — the observe target is fixed
//     at `ObserveTerminal` time).
//   · this owns **the connection's health**. It has no target and no sink; what it produces is a
//     link the watchdog can `probe` (L1, `./client-ping.ts`) and the supervisor can `terminate`
//     (L2), plus the `replay` that re-sends whatever subscriptions the registry still owes (X1).
//
// Folding them together is milestone M6's job, not this one's: the pane's frames would then arrive
// on the supervised link and survive an outage without the screen remounting anything. Today they
// do not — see the residual note at the end of the M4 report and `src/session/use-pane-observer.ts`,
// which is the file that would change.
import {
  ClientLaunchMode,
  RenderEncoding,
  assertWelcomeAccepted,
  describeClose,
  encodeHelloFrame,
  encodeObserveTerminalFrame,
  encodeRequestFullFrameFrame,
  type ServerMessageChannel
} from '@herdr/client-ts'
import { encodePingFrame } from './client-ping'
import { ChannelCloseError } from './channel-failure'
import type { SupervisedLink } from './connection-supervisor'
import type { SupervisorLinkFactory } from './supervised-remote'
import type { HerdrRemoteConnection } from './herdr-connection'

/**
 * The grid the health handshake asks for when no subscription has been registered yet.
 *
 * A `Hello` needs numbers and this link has no pane to measure. 80x24 is the conventional floor and
 * it is never the number a *rendered* pane uses — `PaneObserver` resolves that one from
 * `pane.layout` (`src/session/observer-geometry.ts`). X1b is unaffected either way: the geometry a
 * replay carries comes from the stored subscription, not from here.
 */
export const HEALTH_LINK_COLS = 80
export const HEALTH_LINK_ROWS = 24

/** What a dial's rejection says when the channel died carrying no evidence whatsoever. */
const DIAL_CLOSE_PREFIX = 'the stream closed before Welcome'

/** What a dial's rejection says when a newer dial took its place before it ever came up. */
const SUPERSEDED_MESSAGE = 'the dial was superseded by a newer one'

/** Retirement's reason when the peer answered and the answer was refused. Never rejects a dial. */
const HANDSHAKE_REFUSED_MESSAGE = 'the handshake was refused'

/** What a dial's rejection says when the supervisor aborted its signal. */
const DIAL_CANCELLED_MESSAGE = 'the dial was cancelled by the supervisor'

/**
 * Consecutive dials that must fail before the **ssh connection itself** is replaced.
 *
 * The only number in this file, and it is a ratio rather than a delay: *when* to dial is L3's
 * (`./reconnect-policy.ts`), and this says how many of L3's dials go to the cheap repair before the
 * expensive one is tried. The ssh connection is therefore re-opened at most once per three rungs of
 * the ladder, at whatever pace the ladder is running — every ~3.5s early, every ~4.5 minutes once
 * it has settled into the 90s trickle. Nothing here needs a timer of its own, and adding one would
 * be the second scheduler orca's #10119 is about.
 *
 * Three, because the cheap repair's success cases are short: a `remote-client-bridge` that exited,
 * a remote `herdr` that was restarted, an exec that lost a race with one. Those come back within a
 * rung or two. Past three the evidence is no longer "the bridge is flapping" — it is that nothing
 * this connection carries completes, and the connection is what every attempt had in common.
 */
export const SSH_REDIAL_AFTER_FAILED_DIALS = 3

/**
 * One dial's private state. The unit of isolation this file is built around.
 *
 * There used to be three variables here — `channel`, `activeToken`, `dialToken` — shared by every
 * generation the factory ever produced, and a token comparison was what kept the generations apart.
 * That works only where the comparison was actually written: `onClose` had one and `onMessage` did
 * not, so a `Welcome` arriving late on a channel L5 had already walked away from ran the *current*
 * generation's `activeToken = token` line and handed the link's identity to a corpse. `probe` then
 * answered `false` forever for the live link, which the L1 watchdog reads as silence and terminates.
 *
 * A record per dial makes the isolation structural rather than remembered: every callback closes
 * over its own, and there is no shared cell left for a stale generation to write into.
 */
type DialRecord = {
  /**
   * The exec channel this dial opened, while this dial still owns it.
   *
   * Nulled the moment the generation is renounced, because ownership is the whole point: one exec
   * channel is one remote `herdr` process (B8), and exactly one owner may close it.
   */
  channel: ServerMessageChannel | null
  /** Finished the handshake and not yet retired — the only state `probe` may answer in. */
  active: boolean
  /**
   * Retired: superseded by a newer dial, terminated by the supervisor, or dead.
   *
   * It is one flag rather than two because the two rights always move together. A generation that
   * may no longer act may no longer report either: reporting a superseded generation's close books
   * a second failure against the dial that replaced it, and the attempt counter is what L3's cap
   * and L6's ladder both key off (`./connection-supervisor.ts`).
   */
  retired: boolean
  /**
   * This dial's `Welcome` was accepted. Distinct from {@link DialRecord.active}, which `renounce`
   * clears: what the redial rule needs is not "is this generation live" but "did this generation
   * ever prove the ssh connection works", and a live link dying is not evidence against it.
   */
  welcomed: boolean
  /** Already booked as a failed dial. One dial contributes at most one, whichever death finds it. */
  counted: boolean
  /** Rejects this dial's `await handshake`, so retiring it settles the promise instead of parking it. */
  fail: ((error: Error) => void) | null
}

export type ObserveStreamLinkOptions = {
  connection: HerdrRemoteConnection
  /** Read at dial time, so a rotation between generations reaches the next `Hello`. */
  geometry?: () => { cols: number; rows: number }
  onLog?: (line: string) => void
}

/**
 * Builds `dial`/`replay` against one already-dialled {@link HerdrRemoteConnection}.
 *
 * ⚠️ **The two deaths, and why one dial covers both.** A generation normally opens a *new exec
 * channel on the same ssh connection*, which recovers a dead bridge, a killed remote `herdr` and a
 * stalled stream, and costs one round trip. It cannot recover a dead ssh connection — every exec on
 * one of those fails identically forever, and L3 reproduces that failure every few seconds. This
 * file used to say so and stop there; what closes it is `HerdrRemoteConnection.redialTransport`
 * (`./herdr-connection.ts`), supplied by whoever dialled — `modules/herdr-ssh/src/app-connections.ts`
 * on a phone, `test/live/` over `SshHerdrTransport`, absent in every unit fake.
 *
 * So the question this file answers is no longer "can it", it is **"when"**, and the answer is
 * evidence-first because the two repairs differ by three orders of magnitude in cost (one round
 * trip vs. a TCP handshake, a key exchange, a signature and a new remote `herdr` process — B8):
 *
 *   · **the connection refused to open an exec channel** — the ssh session is gone as a fact, not a
 *     suspicion. Redial on the next dial.
 *   · **{@link SSH_REDIAL_AFTER_FAILED_DIALS} consecutive dials never reached `Welcome`** — the
 *     connection may still *accept* channels (a half-open TCP after a Wi-Fi↔LTE switch does, until
 *     something times out) while nothing on it completes. Redial, then go back to the cheap repair.
 *
 * Both counters reset on a `Welcome`, so a connection that works is never suspected, and neither
 * branch has a clock: L3's ladder is what paces them.
 */
export function createObserveStreamLink(options: ObserveStreamLinkOptions): SupervisorLinkFactory {
  const { connection } = options
  return (hooks) => {
    /**
     * The newest dial. Only it may report, and starting a new one retires whatever it replaces.
     *
     * The pointer exists so supersession has an owner: L5 abandons a dial by *redialling*
     * (`./connection-supervisor.ts` `notifyForeground`), and at that moment the supervisor's
     * `this.link` is still null — a pending dial is a promise, not an object it can close
     * (`connection-supervisor.ts:218-224`). Left alone, the abandoned generation's exec channel and
     * its remote `herdr` are still alive with nobody holding a handle to either.
     */
    let latest: DialRecord | null = null
    /** The generation that completed the handshake — the one `replay` writes on (X1). */
    let live: DialRecord | null = null
    /** Dials that never reached `Welcome`, since the last one that did. Zeroed by a `Welcome`. */
    let failedDials = 0
    /** {@link failedDials}'s value when the ssh connection was last replaced. The rate limiter. */
    let redialledAtFailure = 0
    /** The connection refused to open an exec channel: the ssh session is gone, not suspected. */
    let execOpenRefused = false

    /**
     * Books one failed dial, at most once per generation.
     *
     * Placed on the retirement path rather than on the throw path because of *when* the number is
     * read: the decision below runs in the prologue of the next dial, synchronously, and a dial's
     * own rejection reaches its `catch` a microtask later than that. L5's abandonment — the phone
     * suspended mid-handshake, which is the case where the ssh connection is most likely to be the
     * problem — is exactly the shape that would arrive too late to count.
     */
    const noteDialFailed = (record: DialRecord): void => {
      if (record.welcomed || record.counted) {
        return
      }
      record.counted = true
      failedDials += 1
    }

    /** Takes a generation's rights away and hands back whatever channel it still owns. */
    const renounce = (record: DialRecord): ServerMessageChannel | null => {
      noteDialFailed(record)
      const channel = record.channel
      record.retired = true
      record.active = false
      record.channel = null
      if (live === record) {
        live = null
      }
      return channel
    }

    /**
     * `renounce` plus the close, for the two deaths this file owns: `terminate` and supersession.
     *
     * Renouncing happens *before* `channel.close()` on purpose, and the ordering is the behaviour
     * the old single-token guard had: L2 has the supervisor synthesize a close on every forced
     * teardown (`./connection-supervisor.ts` `closeAndSynthesize`), so forwarding the real one that
     * this call provokes would double-book the death.
     */
    const retire = (record: DialRecord, reason: string): void => {
      if (record.retired) {
        return
      }
      const channel = renounce(record)
      if (channel !== null) {
        try {
          channel.close()
        } catch {
          // Already gone is the normal case here, not an error.
        }
      }
      // Settles the dial rather than leaving it pending forever. The supervisor drops a rejection
      // whose generation has moved on (`connection-supervisor.ts:307-319`), and a promise nobody
      // will ever settle is the one shape that cannot release this closure — or its channel.
      record.fail?.(new Error(reason))
    }

    /**
     * Replaces the ssh connection when — and only when — it is the suspect. See the file header.
     *
     * Both counters are advanced *before* the dial rather than after it, so a redial that itself
     * fails does not immediately license another one: the rejection travels up as a failed dial and
     * L3 backs off, which is the pacing the whole design leans on.
     */
    const redialSshIfOwed = async (signal: AbortSignal | undefined): Promise<void> => {
      const redial = connection.redialTransport
      const reason = execOpenRefused
        ? 'the connection refused an exec channel'
        : `${failedDials} dial(s) since the last Welcome`
      const owed =
        execOpenRefused || failedDials - redialledAtFailure >= SSH_REDIAL_AFTER_FAILED_DIALS
      if (redial === undefined || !owed) {
        return
      }
      redialledAtFailure = failedDials
      execOpenRefused = false
      options.onLog?.(`redialling ssh — ${reason}`)
      // An absent signal means a caller that is not the supervisor (a receipt driving the factory
      // directly); a controller nobody aborts is the honest stand-in for "this dial is never
      // cancelled" and keeps the redial contract single-shaped.
      await redial(signal ?? new AbortController().signal)
    }

    const dial = async (
      signalHandshaking: () => void,
      signal?: AbortSignal
    ): Promise<SupervisedLink> => {
      const record: DialRecord = {
        channel: null,
        active: false,
        retired: false,
        welcomed: false,
        counted: false,
        fail: null
      }
      // Before the first `await`, so a close delivered on the way up already has a claimant, and so
      // the generation this one replaces stops being able to speak the moment it is replaced.
      const superseded = latest
      latest = record
      if (superseded !== null) {
        retire(superseded, SUPERSEDED_MESSAGE)
      }
      let welcomed: (() => void) | null = null
      const handshake = new Promise<void>((resolve, reject) => {
        welcomed = resolve
        record.fail = reject
      })
      // A rejection can land before this function reaches `await handshake` — a channel that dies
      // while `openTerminalStream` is still resolving, or a supersession in that same window. The
      // no-op handler exists only so that window is not graded an unhandled rejection; `await
      // handshake` below still sees the rejection.
      void handshake.catch(() => {})

      // The supervisor's cancellation contract (`./connection-supervisor.ts`). It names the same
      // deaths `latest` already covers *plus* the ones this file cannot see — `close()`, a fatal
      // latch, L7's Retry — and every one of them means the same thing here, so one `retire`
      // serves all of them. Registered after `record.fail` exists so the abort settles the dial
      // instead of leaving it pending, and `{ once: true }` because a signal aborts once.
      if (signal?.aborted === true) {
        retire(record, DIAL_CANCELLED_MESSAGE)
        throw new Error(DIAL_CANCELLED_MESSAGE)
      }
      signal?.addEventListener('abort', () => retire(record, DIAL_CANCELLED_MESSAGE), {
        once: true
      })

      // Before the exec channel, because it decides *which connection* the exec channel is opened
      // on. A no-op on a healthy connection, and on every caller that supplied no dialer.
      await redialSshIfOwed(signal)

      let opened: ServerMessageChannel
      try {
        opened = await connection.openTerminalStream({
          onMessage: (message) => {
            if (record.retired) {
              // Not this generation's link any more. Counting these frames as liveness would credit
              // the live connection for bytes a dead one produced, which is exactly the evidence L1
              // exists to require.
              return
            }
            hooks.noteInbound()
            if (message.type !== 'welcome') {
              return
            }
            try {
              // The same check `PaneObserver` makes, for the same reason: the server answers with the
              // encoding it *actually* chose, and a protocol mismatch has to surface as a failed dial
              // rather than as a link the supervisor believes is healthy.
              assertWelcomeAccepted(message, { encoding: RenderEncoding.TerminalAnsi })
            } catch (error: unknown) {
              record.fail?.(error instanceof Error ? error : new Error(String(error)))
              return
            }
            welcomed?.()
          },
          // L1's answer arrives here, not in `onMessage`: `ServerMessage::Pong` is variant 10 and this
          // codec decodes only `Welcome` and `Terminal`. A frame that reached the variant dispatcher
          // already cleared the length prefix and the frame boundary, which is exactly the evidence
          // the watchdog asks for (`./client-ping.ts`).
          onUndecodable: () => {
            if (record.retired) {
              return
            }
            hooks.noteInbound()
          },
          onError: (error) => {
            if (record.retired) {
              return
            }
            record.fail?.(error)
          },
          onClose: (close) => {
            if (record.retired) {
              // A superseded generation dying late: either L5 abandoned this dial and redialled
              // (`./connection-supervisor.ts` `notifyForeground`), or `terminate`/`retire` above
              // already handed the supervisor a synthesized close. Reporting now would book a second
              // failure against the generation that replaced it, and the attempt counter is what
              // L3's cap and L6's ladder both key off.
              return
            }
            // The peer closed it, so there is nothing left for anyone to close — renounce and drop
            // the handle rather than routing it through `retire`.
            renounce(record)
            // The close goes to the supervisor as the *struct*, before the dial is settled and
            // whether or not the handshake ever completed. `classifyChannelFailure`
            // (`./channel-failure.ts:142-181`) reads `stderr`/`exitCode`/`error` off a
            // `HerdrChannelClose` to decide `fatal`, and a pre-`Welcome` close is exactly where the
            // fatal evidence lives — ssh writes `Permission denied (publickey)` to stderr and the
            // channel then dies with a generic `error`. Rejecting the dial with a rendered string was
            // the only escape route, and the supervisor's dial-rejection path re-wraps that string as
            // `{ error }`, so a refused key graded `transport` and L3 retried it forever.
            hooks.reportClosed(close)
            // A close before `Welcome` must also settle the dial, or the supervisor sits in
            // `handshaking` with no timer — which is L5's park wearing a different hat. It rejects
            // with a `ChannelCloseError` rather than a bare `Error` so this is a second complete
            // route for the same evidence and not a fallback that quietly loses half of it: a promise
            // can only reject with an error, and the supervisor's rejection path would otherwise
            // rebuild the close from the message alone (`./connection-supervisor.ts`), where
            // `exitCode` no longer exists as a field for the `missing-binary` verdict to read.
            record.fail?.(new ChannelCloseError(describeClose(DIAL_CLOSE_PREFIX, close), close))
          }
        })
      } catch (error: unknown) {
        // The whole of the first redial criterion, and it is a fact rather than an inference: the
        // transport could not multiplex an exec channel onto its ssh connection, which is the one
        // thing a *live* session always can (`packages/herdr-client-ts/src/transport.ts`,
        // obligation 5). `NativeSshHerdrTransport.openChannel` rejects here after sshj/libssh2 has
        // already given up on the session, and `RedialableTransport` rejects here once the
        // connection has been closed. Neither improves by being asked again on the same connection.
        //
        // The flag is read by the *next* dial rather than acted on now, deliberately: this dial has
        // already failed, L3 owns the interval before the next one, and repairing inside a dial
        // would put a second retry loop inside the one that exists.
        execOpenRefused = true
        throw error
      }
      if (record.retired) {
        // Superseded while the exec channel was still opening. This is the only line that can close
        // it: `record.channel` was still null when `retire` ran, and the caller never sees a
        // `SupervisedLink` for a dial that does not resolve.
        try {
          opened.close()
        } catch {
          // Already gone is the normal case here, not an error.
        }
        throw new Error(SUPERSEDED_MESSAGE)
      }
      record.channel = opened
      // The exec channel is up and the herdr handshake has not answered yet: L5 treats this as
      // "still a dial", which is 05's mapping of "ssh는 붙었는데 원격 herdr이 말을 안 함".
      signalHandshaking()

      const { cols, rows } = options.geometry?.() ?? {
        cols: HEALTH_LINK_COLS,
        rows: HEALTH_LINK_ROWS
      }
      await opened.send(
        encodeHelloFrame({
          cols,
          rows,
          requestedEncoding: RenderEncoding.TerminalAnsi,
          launchMode: ClientLaunchMode.TerminalAttach
        })
      )
      try {
        await handshake
      } catch (error: unknown) {
        // The handshake was refused — a `Welcome` this client will not accept, or a wire-ABI
        // verdict delivered on `onError` (`packages/herdr-client-ts/src/transport.ts`), neither of
        // which closes the channel. No `SupervisedLink` will ever exist for this dial, so this is
        // the last frame that can close the exec channel, and B8 makes that mandatory rather than
        // tidy: one exec channel is one remote `herdr` process. A dial that died on its *own*
        // close, or one already superseded, is a no-op here — `retire` returns on a retired record.
        retire(record, HANDSHAKE_REFUSED_MESSAGE)
        throw error
      }
      if (record.retired) {
        // A supersession that raced the `Welcome`: the resolve won, so `handshake` did not reject,
        // but this generation was retired (and its channel closed) in between. Latching it now
        // would hand the link's identity to a channel nobody can write on.
        throw new Error(SUPERSEDED_MESSAGE)
      }
      record.active = true
      record.welcomed = true
      live = record
      // The connection just carried an exec request, a wire-ABI prelude, a `Hello` and a `Welcome`.
      // Nothing that happens to a *bridge* after this is evidence against it, so the suspicion
      // starts again from zero — a link that flaps once an hour must never accumulate its way into
      // re-dialling ssh.
      failedDials = 0
      redialledAtFailure = 0
      execOpenRefused = false
      options.onLog?.(`health link up (${cols}x${rows})`)

      return {
        probe: (nonce: number) => {
          if (!record.active) {
            return false
          }
          // Fire-and-forget: the watchdog terminates on *silence*, not on a rejected write, and an
          // unhandled rejection out of a timer callback is how a codec takes an app down.
          void Promise.resolve(opened.send(encodePingFrame(nonce))).catch(() => {})
          return true
        },
        terminate: () => {
          retire(record, 'the link was terminated')
        }
      }
    }

    // X1. The supervisor decides *that* a replay is owed; this knows how to say it — `Hello` already
    // went out above with the stored geometry, so what is left is the target and the re-baseline.
    const replay = async (subscription: {
      paneId: string
      cols: number
      rows: number
    }): Promise<boolean> => {
      const channel = live?.channel ?? null
      if (channel === null) {
        return false
      }
      await channel.send(encodeObserveTerminalFrame(subscription.paneId))
      // X1's herdr-specific half: a reconnected client's sink still holds the *previous* stream's
      // baseline, so a diff applied onto it renders wrong cells rather than failing.
      // `RequestFullFrame` (`src/protocol/wire.rs:462-467`, mx-only) makes the server re-baseline.
      await channel.send(encodeRequestFullFrameFrame())
      return true
    }

    return { dial, replay }
  }
}
