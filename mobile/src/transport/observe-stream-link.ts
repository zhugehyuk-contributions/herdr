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
    let channel: ServerMessageChannel | null = null
    /** The generation that finished the handshake — the only one `probe`/`terminate` may act on. */
    let activeToken: object | null = null
    /**
     * The generation currently allowed to *report*. orca's `isStaleRpcSocketEvent`
     * (`rpc-socket-close-evidence.ts:36-48`), which used to be `activeToken`'s second job.
     *
     * Split off because the two claims start at different moments. `activeToken` cannot be claimed
     * before `await handshake` below — a link that has not been accepted must not answer a probe —
     * and a close that arrives *before* `Welcome` is precisely the one carrying the startup
     * evidence the classifier needs (`Permission denied (publickey)` on stderr). One variable meant
     * every such close was silently dropped; see `onClose`.
     */
    let dialToken: object | null = null

    const dial = async (signalHandshaking: () => void): Promise<SupervisedLink> => {
      const token = {}
      // Before the first `await`, so a close delivered on the way up already has a claimant.
      dialToken = token
      let welcomed: (() => void) | null = null
      let failed: ((error: Error) => void) | null = null
      const handshake = new Promise<void>((resolve, reject) => {
        welcomed = resolve
        failed = reject
      })

      const opened = await connection.openTerminalStream({
        onMessage: (message) => {
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
            failed?.(error instanceof Error ? error : new Error(String(error)))
            return
          }
          welcomed?.()
        },
        // L1's answer arrives here, not in `onMessage`: `ServerMessage::Pong` is variant 10 and this
        // codec decodes only `Welcome` and `Terminal`. A frame that reached the variant dispatcher
        // already cleared the length prefix and the frame boundary, which is exactly the evidence
        // the watchdog asks for (`./client-ping.ts`).
        onUndecodable: () => hooks.noteInbound(),
        onError: (error) => failed?.(error),
        onClose: (close) => {
          if (dialToken !== token) {
            // A superseded generation dying late: either L5 abandoned this dial and redialled
            // (`./connection-supervisor.ts` `notifyForeground`), or `terminate` below already
            // handed the supervisor a synthesized close. Reporting now would book a second failure
            // against the generation that replaced it, and the attempt counter is what L3's cap and
            // L6's ladder both key off.
            return
          }
          dialToken = null
          if (activeToken === token) {
            activeToken = null
          }
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
          failed?.(new ChannelCloseError(describeClose(DIAL_CLOSE_PREFIX, close), close))
        }
      })
      channel = opened
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
      await handshake
      activeToken = token
      options.onLog?.(`health link up (${cols}x${rows})`)

      return {
        probe: (nonce: number) => {
          if (activeToken !== token) {
            return false
          }
          // Fire-and-forget: the watchdog terminates on *silence*, not on a rejected write, and an
          // unhandled rejection out of a timer callback is how a codec takes an app down.
          void Promise.resolve(opened.send(encodePingFrame(nonce))).catch(() => {})
          return true
        },
        terminate: () => {
          if (activeToken === token) {
            activeToken = null
          }
          // Renounced *before* `opened.close()`, because the close it provokes is one the supervisor
          // already accounted for: L2 has it synthesize the close on every forced teardown
          // (`./connection-supervisor.ts` `closeAndSynthesize`), so forwarding the real one too
          // would double-book the death. This is the behaviour the old single-token guard had, kept.
          if (dialToken === token) {
            dialToken = null
          }
          if (channel === opened) {
            channel = null
          }
          try {
            opened.close()
          } catch {
            // Already gone is the normal case here, not an error.
          }
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
      const live = channel
      if (live === null) {
        return false
      }
      await live.send(encodeObserveTerminalFrame(subscription.paneId))
      // X1's herdr-specific half: a reconnected client's sink still holds the *previous* stream's
      // baseline, so a diff applied onto it renders wrong cells rather than failing.
      // `RequestFullFrame` (`src/protocol/wire.rs:462-467`, mx-only) makes the server re-baseline.
      await live.send(encodeRequestFullFrameFrame())
      return true
    }

    return { dial, replay }
  }
}
