// Not from orca. The defect this file is: **a remote whose dial failed at mount stayed dead for the
// life of the process.**
//
// Measured on Android during M4 QA, twice: the host came back and the app made *zero* TCP dials over
// 380s and 221s respectively (sshd logged one `Connection from`, and it was the QA probe). None of
// the four non-force-quit escapes moved it — background→foreground, tab switch, pull-to-refresh,
// settings and back. `am force-stop` + relaunch recovered in ten seconds. That is milestone M4's
// explicit zero, "강제종료로만 낫는 상태 0건" (`.prd/04-milestones.md:175-177`), failing.
//
// The cause was a shape, not a bug in any line: `./app-connections.ts` dialled from a mount effect
// keyed on the keystore's revision counter, and a remote that failed never entered `connections`.
// Everything downstream that retries — `src/transport/use-supervised-remotes.ts`'s L1 watchdog, L3's
// forever-backoff, L4's revival nudge — is built *per connection*, so the one remote that most
// needed retrying was the one remote nothing was watching. The only re-dial paths left were "the
// user saves a remote" and "the tree remounts", and neither is something a waiting user can cause.
//
// So this is the missing loop, and it is deliberately the *same* loop as everywhere else:
//
//   · **the ladder is L3's, borrowed whole** (`src/transport/foreground-redial-ladder.ts` over
//     `src/transport/reconnect-policy.ts`). No delay, no cap and no trickle interval is restated
//     here. A second policy is orca's #10119 and this file would have been the third copy.
//   · **the foreground gate is the ladder's** — the rung comes due, and while the app is
//     backgrounded the dial does not happen and the rung re-arms. M4's QA measured 30 minutes of
//     background with zero dials as a PASS; the fix must not spend that.
//   · **the retryability verdict is `src/transport/channel-failure.ts`'s**, computed one level down
//     in `./app-connections.ts`. A refused public key answers the next dial identically, and
//     trickling against it is an authentication attempt every 90 seconds — a battery cost for a
//     state only the user can change, and a fail2ban ban on a box that counts them.
//
// And it re-dials **only the remotes that still owe an answer**. A host that is already connected
// keeps its ssh connection, its exec channel and its remote `herdr` process (03-blockers.md B8)
// across every retry round; re-dialling the whole list would spend one of each per rung on hosts
// that were never down.
import { ForegroundRedialLadder } from '../../../src/transport/foreground-redial-ladder'
import type { HerdrRemoteConnection } from '../../../src/transport/herdr-connection'
import type { DialedRemotes, SshDialState } from './app-connections'
import type { PushTokenRegistrar } from './push-token-registrar'
import type { RemoteSource } from './remote-source'
import type { TransportTimer } from '@herdr/client-ts'

const NO_CONNECTIONS: readonly HerdrRemoteConnection[] = Object.freeze([])
const NO_REGISTRARS: readonly PushTokenRegistrar[] = Object.freeze([])
const NO_FAILURES: readonly string[] = Object.freeze([])

/** One dial pass. `only` restricts it to the remote ids that still owe an answer. */
export type DialRound = (only?: readonly string[]) => Promise<DialedRemotes>

export type SshDialLoopOptions = {
  round: DialRound
  /**
   * Every observable change, and only those: the loop compares before it publishes, so a rung that
   * failed exactly as the last one did does not churn `connections`' identity — which
   * `src/transport/use-supervised-remotes.ts` reads as "these are different transports now" and
   * would answer by closing and rebuilding every supervisor in the tree.
   */
  onState: (state: SshDialState) => void
  /** Injected so a receipt reads a deterministic sequence rather than sleeping. */
  timer?: TransportTimer
  /** Defaults to the phone's (`src/transport/app-foreground.ts`, loaded on first failure only). */
  isForeground?: () => boolean
  /** L4's signal source. Same default, same lazy load. */
  subscribeRevival?: (nudge: () => void) => () => void
}

export type SshDialLoop = {
  /** Cancels the ladder, drops the OS subscription, and closes every transport this loop opened. */
  stop: () => void
}

/**
 * Dials the configured remotes and keeps dialling the ones that did not answer.
 *
 * Starts immediately: the first round is the mount-time dial that was here before, unchanged in
 * everything but its ending.
 */
export function startSshDialLoop(options: SshDialLoopOptions): SshDialLoop {
  let live = true
  let dialling = false
  let settled = false
  let nativeModuleMissing = false
  let source: RemoteSource = 'none'
  let failures: readonly string[] = NO_FAILURES
  /**
   * The ids the next round dials. `null` means "everything", which is the first round and the round
   * after a dial that failed before it could name a single remote.
   */
  let pending: readonly string[] | null = null

  // The accumulated result. Held as a growing array plus a frozen view so the view's identity moves
  // only when a remote actually joined — see `onState` above for what depends on that.
  const opened: { close(): void | Promise<void> }[] = []
  const connected: HerdrRemoteConnection[] = []
  const registrars: PushTokenRegistrar[] = []
  let connectionsView: readonly HerdrRemoteConnection[] = NO_CONNECTIONS
  let registrarsView: readonly PushTokenRegistrar[] = NO_REGISTRARS
  let published: SshDialState | null = null

  let osHooks: Promise<void> | null = null
  let unsubscribeRevival: (() => void) | null = null
  let foregroundProbe: (() => boolean) | undefined = options.isForeground

  const ladder = new ForegroundRedialLadder({
    dial: () => void runRound(),
    ...(options.timer === undefined ? {} : { timer: options.timer }),
    // Read through the closure rather than captured: the real probe arrives from a dynamic import
    // a microtask or two after the first failure, and "assume the screen is on" is the right answer
    // until it does — a mount happens in the foreground.
    isForeground: () => foregroundProbe?.() ?? true
  })

  /**
   * Loads the OS half — the foreground gate and L4's nudge — the first time a remote fails.
   *
   * Deferred, and that is not micro-optimisation: `src/transport/app-foreground.ts` imports
   * `react-native` and `expo-network`, and every build with no configured remote (and every mount
   * suite) reaches neither this function nor those packages.
   */
  function ensureOsHooks(): void {
    if (osHooks !== null) {
      return
    }
    const injected = options.subscribeRevival
    if (injected !== undefined && options.isForeground !== undefined) {
      unsubscribeRevival = injected(() => nudge())
      osHooks = Promise.resolve()
      return
    }
    osHooks = import('../../../src/transport/app-foreground')
      .then((module) => {
        if (!live) {
          return
        }
        foregroundProbe = options.isForeground ?? module.isAppForeground
        unsubscribeRevival = (injected ?? module.subscribeAppRevival)(() => nudge())
      })
      .catch(() => {
        // A host without those modules keeps its ladder; it only loses the "the radio came back"
        // shortcut and the gate that would have paused it. Failing the dial over that is worse.
      })
  }

  /**
   * L4 reached the remotes that never connected — QA's escape hatch ①, which used to reach nothing
   * because `src/transport/herdr-clients-context.tsx` fans its nudge over *supervisors*, and a
   * remote that never answered has none.
   */
  function nudge(): void {
    if (!live || pendingCount() === 0) {
      return
    }
    ladder.reviveNow()
  }

  function pendingCount(): number {
    return pending === null ? 1 : pending.length
  }

  function publish(): void {
    const next: SshDialState = {
      connections: connectionsView,
      failures,
      nativeModuleMissing,
      settled,
      source,
      pushTokenRegistrars: registrarsView,
      // Only after the first dial resolved: before that the honest word is "dialling", and
      // `src/api/herdr-data-provider.tsx` already renders that from `settled` alone.
      retrying: settled && pendingCount() > 0 && !ladder.latched
    }
    if (published !== null && unchanged(published, next)) {
      return
    }
    published = next
    options.onState(next)
  }

  function absorb(dialed: DialedRemotes): void {
    if (dialed.connections.length > 0) {
      connected.push(...dialed.connections)
      registrars.push(...dialed.pushTokenRegistrars)
      connectionsView = Object.freeze([...connected])
      registrarsView = Object.freeze([...registrars])
    }
    opened.push(...dialed.transports)
    failures = dialed.failures
    source = dialed.source
    nativeModuleMissing = dialed.nativeModuleMissing
    settled = true
    pending = dialed.retryableIds
    if (dialed.failures.length > 0 && dialed.retryableIds.length === 0) {
      // Nothing left that a dial can change: a refused key, a `herdr` that is not on the far side's
      // PATH, or a build with no native ssh module at all. L6/L7's terminal state, one layer up.
      ladder.latch()
    }
  }

  async function runRound(): Promise<void> {
    if (!live || dialling) {
      // A round already in flight ends by arming or latching the ladder, so returning here cannot
      // park it — which is the one thing this early return must not be able to do.
      return
    }
    dialling = true
    try {
      const dialed = await options.round(pending ?? undefined)
      if (!live) {
        closeAll(dialed.transports)
        return
      }
      absorb(dialed)
    } catch (reason) {
      if (!live) {
        return
      }
      // `options.round` settles per remote, so a rejection here is the step *before* any remote was
      // named — the keystore refusing to answer, or the native module loader throwing. Reported as
      // a failure rather than swallowed: swallowing left `settled: false`, and
      // `src/api/herdr-data-provider.tsx` renders that as a spinner that never ends, which is the
      // same force-quit state this file exists to remove.
      settled = true
      failures = Object.freeze([`configured remotes: ${errorText(reason)}`])
      pending = null
    } finally {
      dialling = false
    }
    if (!live) {
      return
    }
    publish()
    if (pendingCount() > 0) {
      ensureOsHooks()
      ladder.arm()
    } else {
      ladder.noteConnected()
    }
    // Published after the ladder moved, because `retrying` reads `ladder.latched` and `absorb` may
    // have latched it. Cheap: `publish` is a no-op when nothing changed.
    publish()
  }

  void runRound()

  return {
    stop(): void {
      live = false
      ladder.cancel()
      unsubscribeRevival?.()
      unsubscribeRevival = null
      closeAll(opened)
    }
  }
}

function unchanged(a: SshDialState, b: SshDialState): boolean {
  return (
    a.connections === b.connections &&
    a.pushTokenRegistrars === b.pushTokenRegistrars &&
    a.settled === b.settled &&
    a.nativeModuleMissing === b.nativeModuleMissing &&
    a.source === b.source &&
    a.retrying === b.retrying &&
    a.failures.length === b.failures.length &&
    a.failures.every((entry, index) => entry === b.failures[index])
  )
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function closeAll(transports: readonly { close(): void | Promise<void> }[]): void {
  for (const transport of transports) {
    void transport.close()
  }
}
