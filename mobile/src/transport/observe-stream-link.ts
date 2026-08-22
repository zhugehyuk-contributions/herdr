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
 * ⚠️ **What this can and cannot recover from.** Every generation opens a *new exec channel on the
 * same ssh connection*, because `HerdrRemoteConnection` exposes no redial — it is a wrapper over a
 * transport somebody else opened (`./herdr-connection.ts`). So this recovers a dead bridge, a killed
 * remote `herdr`, a stalled stream; it cannot recover a dead ssh connection, which needs a dialer
 * one level down (`modules/herdr-ssh/src/app-connections.ts` holds the only object that could
 * supply one). That is stated here rather than discovered on a phone, and it is why the live receipt
 * supplies its own factory: a supervisor whose `dial` really redials ssh proves the state machine
 * end to end, and this one proves the app is wired to it.
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

    /** Takes a generation's rights away and hands back whatever channel it still owns. */
    const renounce = (record: DialRecord): ServerMessageChannel | null => {
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

    const dial = async (signalHandshaking: () => void): Promise<SupervisedLink> => {
      const record: DialRecord = { channel: null, active: false, retired: false, fail: null }
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

      const opened = await connection.openTerminalStream({
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
      live = record
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
