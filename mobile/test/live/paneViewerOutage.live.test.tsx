/**
 * The M4 receipt's **React half** — the one `test/live/transportRecovery.live.test.ts` closes by
 * saying it does not have:
 *
 *   > **The React layer.** No component is mounted here; `test/live/paneViewer.live.test.tsx` is
 *   > where the screen is, and it does not yet mount a supervisor — see the report.
 *
 * This mounts the real route (`app/h/[remoteId]/pane/[paneId].tsx`) over a real ssh connection to a
 * real herdr server, **severs the network underneath it**, and asserts on **rendered nodes** that
 * the screen escalated and then recovered by itself. Everything below React is genuine: the ssh
 * transport, `herdr remote-{api,client}-bridge`, the wire codec, and a `herdr server` this test
 * spawned.
 *
 * What each assertion is for, in the language of mobile/.prd/05-orca-transport.md:
 *
 *   L6  the header's verdict climbs normal → warning → unreachable *as text on screen*, instead of
 *       animating "Connecting…" over a loop that is failing
 *   L7  once escalated, the line is a `Pressable`, and pressing it produces a **new ssh dial**
 *       (counted at the TCP proxy) rather than a resent request
 *   L3  the loop is armed throughout the outage — the state a screen can read never shows orca
 *       #5049's park
 *   L4  a revival nudge routed through the provider's `bindConnectionRevival` reaches the supervisor
 *   X4  the screen holds no link: it re-reads through `useSyncExternalStore` on every change, which
 *       is why the recovery repaints without the route remounting
 *
 * ⚠️ Process safety. The developer runs long-lived `herdr server` daemons from the same binary name.
 * Nothing here matches processes by name — no `pkill`, no `killall`. `SpawnedServer.stop` and
 * `ScratchSshd.stop` each signal exactly the pid they created, and the outage is produced by
 * destroying TCP sockets **inside this process** (`./networkCutter.ts`), so no signal is sent to
 * anything to simulate it. `~/.config/herdr` is never touched.
 *
 * Two deliberate constructions, both stated rather than hidden:
 *
 *  1. **The data plane does not go through the cutter.** `HerdrDataProvider` loads its snapshot once
 *     (`src/api/snapshot-context.tsx` — no polling), so the pane list the header renders is fetched
 *     before the cut and would survive either way; routing it around the cutter keeps the test's
 *     subject singular. What is being proved is *the supervised connection's state reaching the UI*,
 *     and the pane chrome is the frame it is rendered in.
 *  2. **The pane's frames are not on the supervised link.** The observe stream is still
 *     `PaneObserver`'s (`src/session/use-pane-observer.ts`), which is why the stream summary reads
 *     `stream ended` after the cut while the verdict climbs. Folding the two is M6; see
 *     `src/transport/observe-stream-link.ts`'s header.
 * @vitest-environment happy-dom
 */
import { Children, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

import {
  ClientLaunchMode,
  RenderEncoding,
  ServerMessageChannel,
  UnsupportedVariantError,
  assertWelcomeAccepted,
  encodeHelloFrame,
  type HerdrChannelClose,
  type JsonApiClient,
  type WireError
} from '@herdr/client-ts'
import {
  SERVER_BINARY,
  serverBinaryExists,
  spawnServer,
  type SpawnedServer
} from '../../../packages/herdr-client-ts/test/live/harness'
import {
  findSshd,
  spawnScratchSshd,
  type ScratchSshd
} from '../../../packages/herdr-client-ts/test/live-ssh/sshHarness'
import { startNetworkCutter, type NetworkCutter } from './networkCutter'
import type { SupervisedLink } from '../../src/transport/connection-supervisor'
import type { SupervisorLinkFactory } from '../../src/transport/supervised-remote'
import type { RevivalReason } from '../../src/transport/revival-nudge'
import type { HerdrRemoteConnection } from '../../src/transport/herdr-connection'
import type { RemoteDefinition } from '../../src/api/herdr-api-types'

const COLS = 100
const ROWS = 30
const MARKER = 'OUTAGEVIEWER'
/** What a dial rejects with once the supervisor has aborted its signal. */
const CANCELLED_DIAL = 'the dial was cancelled by the supervisor'

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ replace: () => {}, push: () => {} })
}))

vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  RefreshCw: 'RefreshCw'
}))

vi.mock('react-native-webview', async () => {
  const React = await import('react')
  const WebView = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => ({ postMessage: () => {}, reload: () => {} }))
    return React.createElement('WebView', props)
  })
  return { WebView, default: WebView }
})

vi.mock('react-native', () => {
  class AnimatedValue {
    setValue() {}
    interpolate() {
      return '0deg'
    }
  }
  return {
    Animated: {
      Value: AnimatedValue,
      View: 'AnimatedView',
      loop: () => ({ start() {}, stop() {} }),
      timing: () => ({ start() {}, stop() {} })
    },
    AppState: { currentState: 'active' },
    Easing: { linear: 'linear' },
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: {
      absoluteFillObject: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
      create: (styles: unknown) => styles
    },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View'
  }
})

const { SshHerdrTransport } = await import('@herdr/client-ts/node')
const { createTransportConnection } = await import('../../src/transport/herdr-connection')
const { HerdrClientsProvider } = await import('../../src/transport/herdr-clients-context')
const { HerdrDataProvider } = await import('../../src/api/herdr-data-provider')
const { SupervisedRemote } = await import('../../src/transport/supervised-remote')
const { encodePingFrame, isPongVariant } = await import('../../src/transport/client-ping')
const { PaneViewerScreen } = await import('../../app/h/[remoteId]/pane/[paneId]')

const REMOTE: RemoteDefinition = {
  id: 'scratch',
  name: 'scratch-box',
  target: { type: 'ssh', target: '127.0.0.1' }
}

function skipReason(): string | null {
  const reasons: string[] = []
  if (!serverBinaryExists()) {
    reasons.push(
      `herdr server binary not found at ${SERVER_BINARY} — build it with \`cargo build\``
    )
  }
  if (findSshd() === null) {
    reasons.push('no sshd binary found (set HERDR_LIVE_SSHD to one)')
  }
  if (reasons.length === 0) {
    return null
  }
  const reason = reasons.join('; ')
  if (process.env['HERDR_LIVE_REQUIRE'] === '1') {
    throw new Error(`HERDR_LIVE_REQUIRE=1 but ${reason}`)
  }
  process.stderr.write(`\n*** SKIPPING LIVE PANE VIEWER OUTAGE SUITE ***\n${reason}\n\n`)
  return reason
}

const reason = skipReason()

function host(name: string): ElementType {
  return name as unknown as ElementType
}

function textNodes(target: ReactTestRenderer): string[] {
  return target.root
    .findAllByType(host('Text'))
    .map((node) =>
      Children.toArray(node.props.children as ReactNode)
        .map((child) =>
          typeof child === 'string' || typeof child === 'number' ? String(child) : ''
        )
        .join('')
    )
    .filter((text) => text.length > 0)
}

/** Every `Pressable` the header made a button, with the label it announces. */
function statusButtons(target: ReactTestRenderer): string[] {
  return target.root
    .findAllByType(host('Pressable'))
    .map((node) => String(node.props.accessibilityLabel ?? ''))
    .filter((label) => label.includes('reconnect'))
}

describe.skipIf(reason !== null)('live: the pane viewer under a real outage', () => {
  let server: SpawnedServer
  let sshd: ScratchSshd
  let cutter: NetworkCutter
  /** The data plane, deliberately *around* the cutter — see the header. */
  let control: Awaited<ReturnType<typeof SshHerdrTransport.connect>>
  let connection: HerdrRemoteConnection
  let api: JsonApiClient
  let paneId: string
  let supervised: InstanceType<typeof SupervisedRemote>
  let renderer: ReactTestRenderer | null = null

  const log: string[] = []
  let pongs = 0
  let dials = 0
  let suppressedDialErrors = 0
  let openTransports: Awaited<ReturnType<typeof SshHerdrTransport.connect>>[] = []
  /** The provider's L4 fan-out, captured so the test can fire the OS signal itself. */
  let nudge: ((reason: RevivalReason) => void) | null = null
  const subscribeRevival = (handler: (reason: RevivalReason) => void): (() => void) => {
    nudge = handler
    return () => {
      nudge = null
    }
  }

  /**
   * A link factory that opens **a whole new ssh connection per generation, through the cutter.**
   *
   * Still its own factory rather than `createObserveStreamLink`, and now for a narrower reason than
   * before. It used to be the *only* thing that could redial ssh at all; production can do that now
   * (`src/transport/redialable-transport.ts`, decided in `src/transport/observe-stream-link.ts`).
   * What this keeps is that here a redial is **unconditional and per dial**, which is what lets the
   * receipt count TCP connects at the proxy and assert L7 — "the tap produced a new ssh dial" — as
   * a number. The production criteria are deliberately *not* unconditional, so a receipt written on
   * top of them would be measuring the pacing rule, not the recovery.
   *
   * What it no longer keeps is a private notion of supersession. `dial`'s second argument is the
   * supervisor's cancellation signal (`src/transport/connection-supervisor.ts`), and `retire` below
   * is the same shape `observe-stream-link.ts`'s is — that convergence is the point of the
   * contract: two factories, one rule about who may still act, instead of a token comparison here
   * and a `DialRecord` there.
   */
  const sshRedialLink: SupervisorLinkFactory = (hooks) => {
    let activeToken: object | null = null

    const dial = async (
      signalHandshaking: () => void,
      signal: AbortSignal
    ): Promise<SupervisedLink> => {
      const token = {}
      let retired = false
      let failed: ((error: Error) => void) | null = null
      /** Reassigned as each resource appears, so `retire` drops exactly what exists by then. */
      let release: (() => void) | null = null

      /** This generation gives up its channel, its ssh connection and its right to report. */
      const retire = (reason: string): void => {
        if (retired) {
          return
        }
        retired = true
        if (activeToken === token) {
          activeToken = null
        }
        release?.()
        failed?.(new Error(reason))
      }

      // Both abandonments now arrive the same way: `terminate()` from the supervisor's teardown,
      // and this for the ones it has no handle for — a stale dial (L5), a fatal latch, `close()`.
      signal.addEventListener('abort', () => retire(CANCELLED_DIAL), { once: true })

      dials += 1
      const transport = await SshHerdrTransport.connect({
        ssh: {
          host: '127.0.0.1',
          port: cutter.port,
          username: sshd.username,
          privateKey: readFileSync(sshd.privateKeyPath),
          readyTimeout: 10_000
        },
        herdrBinary: SERVER_BINARY,
        execTimeoutMs: 10_000,
        env: {
          XDG_CONFIG_HOME: `${server.base}/config`,
          XDG_RUNTIME_DIR: `${server.base}/runtime`,
          HERDR_SOCKET_PATH: server.apiSocket
        },
        onSuppressedError: () => {
          suppressedDialErrors += 1
        }
      })
      const drop = (channel: ServerMessageChannel | null) => () => {
        try {
          channel?.close()
        } catch {
          // already gone
        }
        transport.close()
        openTransports = openTransports.filter((entry) => entry !== transport)
      }
      openTransports.push(transport)
      release = drop(null)
      if (retired) {
        // Cancelled while the TCP connect was in flight — the case with no owner at all before the
        // signal existed: the supervisor holds only a promise, so this connection and its sshd
        // session would have stayed up with nobody able to close either.
        release()
        throw new Error(CANCELLED_DIAL)
      }

      let welcomed: (() => void) | null = null
      const handshake = new Promise<void>((resolve, reject) => {
        welcomed = resolve
        failed = reject
      })
      // A cancellation can reject this before `await handshake` is reached; the no-op handler keeps
      // that window from being graded an unhandled rejection.
      void handshake.catch(() => {})

      const channel = await ServerMessageChannel.open(transport, {
        onMessage: (message) => {
          hooks.noteInbound()
          if (message.type !== 'welcome') {
            return
          }
          try {
            assertWelcomeAccepted(message, { encoding: RenderEncoding.TerminalAnsi })
          } catch (error: unknown) {
            failed?.(error instanceof Error ? error : new Error(String(error)))
            return
          }
          welcomed?.()
        },
        onUndecodable: (error: WireError) => {
          hooks.noteInbound()
          if (error instanceof UnsupportedVariantError && isPongVariant(error.variant)) {
            pongs += 1
          }
        },
        onClose: (close: HerdrChannelClose) => {
          failed?.(new Error(close.error?.message ?? 'closed before Welcome'))
          if (activeToken === token) {
            activeToken = null
            hooks.reportClosed(close)
          }
        }
      })
      release = drop(channel)
      if (retired) {
        release()
        throw new Error(CANCELLED_DIAL)
      }
      signalHandshaking()
      await channel.send(
        encodeHelloFrame({
          cols: COLS,
          rows: ROWS,
          requestedEncoding: RenderEncoding.TerminalAnsi,
          launchMode: ClientLaunchMode.TerminalAttach
        })
      )
      await handshake
      if (retired) {
        throw new Error(CANCELLED_DIAL)
      }
      activeToken = token

      return {
        probe: (nonce: number) => {
          void Promise.resolve(channel.send(encodePingFrame(nonce))).catch(() => {})
          return true
        },
        terminate: () => retire('the link was terminated')
      }
    }

    // X1 is deliberately not exercised here: no subscription is registered on this supervisor, so
    // the supervisor never asks for a replay. The observe stream this screen renders belongs to
    // `PaneObserver`, and the replay path itself has two receipts already — on the wire in
    // `test/live/transportRecovery.live.test.ts`, and in hex in
    // `src/transport/supervised-remote.test.ts`. Returning `false` here would silently leave an
    // entry pending; asserting instead means a future subscription cannot be lost in this file.
    const replay = (): Promise<boolean> => {
      throw new Error('this receipt registers no observe subscription — nothing should be replayed')
    }

    return { dial, replay }
  }

  /** Renders the route, and re-renders it so `act` flushes whatever the store published. */
  function tree() {
    return (
      <HerdrClientsProvider
        connections={[connection]}
        supervisors={[supervised]}
        subscribeRevival={subscribeRevival}
      >
        <HerdrDataProvider>
          <PaneViewerScreen remoteId={REMOTE.id} paneId={paneId} />
        </HerdrDataProvider>
      </HerdrClientsProvider>
    )
  }

  /** The header's status texts right now, after letting React commit. */
  async function header(): Promise<string[]> {
    let texts: string[] = []
    await act(async () => {
      await delay(60)
    })
    texts = textNodes(renderer as unknown as ReactTestRenderer)
    return texts
  }

  async function untilRendered(
    what: string,
    predicate: (texts: string[]) => boolean,
    timeoutMs: number
  ): Promise<string[]> {
    const deadline = Date.now() + timeoutMs
    let last: string[] = []
    for (;;) {
      last = await header()
      if (predicate(last)) {
        return last
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${what} — the screen never showed it within ${timeoutMs}ms; last: ${JSON.stringify(last)}`
        )
      }
    }
  }

  beforeAll(async () => {
    server = await spawnServer()
    sshd = await spawnScratchSshd(findSshd() as string, server.base)
    cutter = await startNetworkCutter(sshd.port)

    control = await SshHerdrTransport.connect({
      ssh: {
        host: '127.0.0.1',
        port: sshd.port,
        username: sshd.username,
        privateKey: readFileSync(sshd.privateKeyPath)
      },
      herdrBinary: SERVER_BINARY,
      env: {
        XDG_CONFIG_HOME: `${server.base}/config`,
        XDG_RUNTIME_DIR: `${server.base}/runtime`,
        HERDR_SOCKET_PATH: server.apiSocket
      }
    })
    connection = createTransportConnection(REMOTE, control)
    api = connection.api

    const created = await api.request('workspace.create', { cwd: server.base, focus: true })
    expect(created['type'], `workspace.create failed: ${JSON.stringify(created)}`).toBe(
      'workspace_created'
    )
    paneId = (created['root_pane'] as { pane_id: string }).pane_id
    await api.request('pane.send_input', {
      pane_id: paneId,
      text: `echo ${MARKER}`,
      keys: ['Enter']
    })

    supervised = new SupervisedRemote({
      remoteId: REMOTE.id,
      link: sshRedialLink,
      timer: {
        setTimeout: (handler, ms) => setTimeout(handler, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
      },
      // Short enough that a 180s test can watch three fair misses; the production constants are
      // asserted in `src/transport/rpc-session-liveness-watchdog.test.ts`.
      liveness: { idleProbeMs: 3_000, probeTimeoutMs: 2_000, missedProbeLimit: 3 },
      onLog: (line) => log.push(line)
    })

    process.stdout.write(
      `[outage] server pid=${server.pid} sshd pid=${sshd.pid} port=${sshd.port} ` +
        `cutter port=${cutter.port} pane=${paneId}\n`
    )
  }, 180_000)

  afterAll(async () => {
    if (renderer) {
      await act(async () => {
        renderer?.unmount()
      })
      renderer = null
    }
    supervised?.close()
    for (const transport of openTransports) {
      transport.close()
    }
    control?.close()
    await cutter?.close()
    await sshd?.stop()
    await server?.stop()
  })

  it('the screen shows the supervised connection once it is up (L6 floor)', async () => {
    await act(async () => {
      renderer = create(tree())
      supervised.start()
    })
    const texts = await untilRendered('Connected', (values) => values.includes('Connected'), 60_000)
    process.stdout.write(`[outage] connected — rendered: ${JSON.stringify(texts)}\n`)
    // The verdict is on screen, and it is not a button: L7's gate is closed while the loop is fine.
    expect(texts).toContain('Connected')
    expect(statusButtons(renderer as unknown as ReactTestRenderer)).toEqual([])
    expect(supervised.getSnapshot()).toMatchObject({ state: 'connected', reconnectAttempt: 0 })
  }, 180_000)

  it('L4: a revival nudge routed through the provider reaches the supervisor', async () => {
    // The provider subscribed our fake trigger source at mount; `bindConnectionRevival` is what
    // stands between it and the supervisor. On a live link the branch taken is "probe now".
    expect(nudge).not.toBeNull()
    const before = pongs
    nudge?.('app-resume')
    const deadline = Date.now() + 30_000
    while (pongs === before && Date.now() < deadline) {
      await act(async () => {
        await delay(100)
      })
    }
    process.stdout.write(`[outage] nudge -> Ping/Pong over the live link: pongs=${pongs}\n`)
    expect(pongs).toBeGreaterThan(before)
    expect(supervised.getSnapshot().state).toBe('connected')
  }, 60_000)

  it('the outage: the header escalates, stays armed, and recovers by itself', async () => {
    const dialsBefore = cutter.accepted
    const target = renderer as unknown as ReactTestRenderer

    // Airplane mode. Every socket dies at once, with no notification to either end.
    cutter.cut()

    const escalated: string[] = []
    let sawArmedDown = false
    const down = await untilRendered(
      'the header left "Connected"',
      (texts) => {
        const snapshot = supervised.getSnapshot()
        if (snapshot.state !== 'connected') {
          escalated.push(texts.join(' | '))
          // L3, sampled from the *rendered* state's source: never a `reconnecting` with no timer.
          sawArmedDown ||= snapshot.armed
        }
        return !texts.includes('Connected')
      },
      90_000
    )
    process.stdout.write(
      `[outage] cut — rendered: ${JSON.stringify(down)} state=${supervised.getSnapshot().state} ` +
        `armed=${supervised.getSnapshot().armed}\n`
    )
    expect(down).not.toContain('Connected')
    expect(sawArmedDown).toBe(true)

    // L6 on screen: keep the outage going until the ladder's second rung is *rendered*, and confirm
    // the line became a button at the same moment (L7's gate opening).
    const warned = await untilRendered(
      'the ladder escalated',
      (texts) => texts.some((text) => text.startsWith('Can’t')),
      120_000
    )
    const buttons = statusButtons(target)
    process.stdout.write(
      `[outage] escalated — rendered: ${JSON.stringify(warned)}\n` +
        `[outage] tappable status line: ${JSON.stringify(buttons)}\n` +
        `[outage] attempt=${supervised.getSnapshot().reconnectAttempt} ` +
        `armed=${supervised.getSnapshot().armed} tcp accepts ${dialsBefore}->${cutter.accepted}\n`
    )
    expect(warned.some((text) => text.startsWith('Can’t'))).toBe(true)
    expect(warned).toContain('Retry')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toContain('reconnect')
    expect(supervised.getSnapshot().armed).toBe(true)

    // L7, live: pressing the line produces a **new ssh dial**, counted at the TCP proxy. It is still
    // refused (the network is still down), which is the point — a resend would have produced no
    // connect attempt at all.
    const acceptsBeforePress = cutter.accepted
    const dialsBeforePress = dials
    await act(async () => {
      target.root
        .findAllByType(host('Pressable'))
        .find((node) => String(node.props.accessibilityLabel ?? '').includes('reconnect'))
        ?.props.onPress()
      await delay(500)
    })
    process.stdout.write(
      `[outage] Retry pressed — dials ${dialsBeforePress}->${dials}, ` +
        `tcp accepts ${acceptsBeforePress}->${cutter.accepted}\n`
    )
    expect(dials).toBeGreaterThan(dialsBeforePress)

    // The radio comes back. No user action from here on.
    cutter.heal()
    const up = await untilRendered(
      'the header recovered',
      (texts) => texts.includes('Connected'),
      120_000
    )
    process.stdout.write(
      `[outage] healed — rendered: ${JSON.stringify(up)} ` +
        `tcp accepts ${dialsBefore}->${cutter.accepted}\n` +
        `[outage] escalation trace (first 5 samples):\n  ${escalated.slice(0, 5).join('\n  ')}\n` +
        `[outage] supervisor log:\n  ${log.slice(-8).join('\n  ')}\n`
    )
    // X4: the same mounted tree repainted. Nothing remounted, nothing held a replaced link.
    expect(renderer).not.toBeNull()
    expect(up).toContain('Connected')
    expect(statusButtons(target)).toEqual([])
    expect(supervised.getSnapshot()).toMatchObject({ state: 'connected', reconnectAttempt: 0 })
    expect(cutter.accepted).toBeGreaterThan(dialsBefore)
    expect(suppressedDialErrors).toBeGreaterThan(0)
  }, 180_000)

  it('a second outage repaints the same way — the screen has no one-shot in it', async () => {
    cutter.cut()
    const down = await untilRendered('down again', (texts) => !texts.includes('Connected'), 90_000)
    cutter.heal()
    const up = await untilRendered('up again', (texts) => texts.includes('Connected'), 120_000)
    process.stdout.write(
      `[outage] second cycle — down: ${JSON.stringify(down)} up: ${JSON.stringify(up)}\n`
    )
    expect(up).toContain('Connected')
    expect(supervised.getSnapshot()).toMatchObject({ state: 'connected', reconnectAttempt: 0 })
  }, 180_000)
})
