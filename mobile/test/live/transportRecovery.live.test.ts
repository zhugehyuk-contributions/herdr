/**
 * The M4 receipt: **the survivability layer against a real herdr server, over a real ssh channel,
 * with the network actually taken away.**
 *
 * `src/transport/*.test.ts` proves the policies with an injected clock. This proves the other half —
 * that the policies are wired to something that really dies and really comes back:
 *
 *   L1  a `ClientMessage::Ping` sent while the connection is in `TerminalObserve` mode is answered
 *       by a real mx server (the watchdog's probe is not a hypothesis about the wire)
 *   L2  a severed TCP path produces a channel close the supervisor books as one failure
 *   L3  the loop stays armed while the network is down, however long that is
 *   X1  after the reconnect the observe subscription is replayed and **frames arrive again** —
 *       which is the only assertion that distinguishes "reconnected" from "recovered"
 *   X1b the replayed `Hello` carries the geometry stored in the subscription, not a captured one
 *
 * ⚠️ Process safety. The developer runs long-lived `herdr server` daemons from the same binary
 * name. Nothing here matches processes by name — no `pkill`, no `killall`. `SpawnedServer.stop` and
 * `ScratchSshd.stop` each signal exactly the pid they created; the outage itself is produced by
 * destroying TCP sockets in this process (`./networkCutter.ts`), so **no signal is sent to anything
 * to simulate it.** `~/.config/herdr` is never touched and `HERDR_SOCKET_PATH` is set only in the
 * remote command's environment.
 *
 * The one thing a phone would add and this cannot: the OS suspending JS timers and the radio
 * handing off. Those enter the machine through `notifyForeground`, which is called here directly —
 * see the closing comment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

import {
  ClientLaunchMode,
  RenderEncoding,
  ServerMessageChannel,
  UnsupportedVariantError,
  assertWelcomeAccepted,
  encodeHelloFrame,
  encodeObserveTerminalFrame,
  encodeRequestFullFrameFrame,
  type HerdrChannelClose,
  type JsonApiClient,
  type WireError
} from '@herdr/client-ts'
import { SshHerdrTransport } from '@herdr/client-ts/node'
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
import { ConnectionSupervisor, type SupervisedLink } from '../../src/transport/connection-supervisor'
import { encodePingFrame, isPongVariant } from '../../src/transport/client-ping'
import type { ObserveSubscription } from '../../src/transport/observe-subscriptions'
import type { ConnectionState } from '../../src/transport/connection-state-types'

const COLS = 100
const ROWS = 30

/**
 * **A defect this receipt found, now fixed in the package it belonged to.**
 *
 * `SshHerdrTransport.connect` used to attach `client.once("error", …)` and nothing else. ssh2 emits
 * `error` **twice** when a dial dies before the SSH banner — measured, not inferred:
 *
 *     error #1: read ECONNRESET
 *     error #2: Connection lost before handshake      <- no listener left; escaped as uncaught
 *
 * (`ssh2/lib/client.js:753` via the socket's `close` handler at `:815`.) `once` consumed the first,
 * so the second reached `process.on('uncaughtException')` and took the process down — one crash per
 * failed dial, i.e. every 90 seconds on a phone with no signal, which is precisely what L3 below
 * makes the app do. M4 is what exposed it: before this milestone nothing dialled into a dead
 * network.
 *
 * `packages/herdr-client-ts/src/node/sshTransport.ts` now keeps a listener attached on both exits of
 * the ready/error race and reports the absorbed events through `onSuppressedError`
 * (reproduced against real ssh2 in `packages/herdr-client-ts/test/sshTransportConnect.test.ts`).
 * So this suite no longer quarantines that signature — `uncaughtException` is now expected to be
 * empty, full stop, and the dials-into-a-dead-network evidence comes from the handler instead.
 */

function skipReason(): string | null {
  const reasons: string[] = []
  if (!serverBinaryExists()) {
    reasons.push(`herdr server binary not found at ${SERVER_BINARY} — build it with \`cargo build\``)
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
  process.stderr.write(`\n*** SKIPPING LIVE TRANSPORT RECOVERY SUITE ***\n${reason}\n\n`)
  return reason
}

const reason = skipReason()

async function until(what: string, predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await delay(100)
  }
  throw new Error(`${what} did not happen within ${timeoutMs}ms`)
}

describe.skipIf(reason !== null)('live: M4 transport survivability', () => {
  let server: SpawnedServer
  let sshd: ScratchSshd
  let cutter: NetworkCutter
  /** The *harness's* control channel — deliberately NOT through the cutter, so the test can drive
   *  the pane while the app's network is down. */
  let control: SshHerdrTransport
  let api: JsonApiClient
  let paneId: string
  let supervisor: ConnectionSupervisor

  const states: ConnectionState[] = []
  const log: string[] = []
  let frames = 0
  let pongs = 0
  let closes = 0
  /** The `Hello` geometry each generation actually sent — X1b's evidence. */
  const handshakes: { cols: number; rows: number; paneId: string }[] = []
  /** orca's `isStaleRpcSocketEvent` in one variable: only the current generation may report a close. */
  let activeToken: object | null = null
  let openTransports: SshHerdrTransport[] = []
  let currentChannel: ServerMessageChannel | null = null
  /** ssh2 `error` events the transport absorbed — the repeat emits described above, plus any
   *  failure of an established connection, which has no request left to reject. */
  let suppressedDialErrors = 0
  const unexpected: string[] = []
  const onUncaught = (error: Error): void => {
    unexpected.push(`${error.name}: ${error.message}`)
  }

  async function dial(signalHandshaking: () => void): Promise<SupervisedLink> {
    const token = {}
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
    openTransports.push(transport)

    let welcomed: (() => void) | null = null
    let failed: ((error: Error) => void) | null = null
    const handshake = new Promise<void>((resolveHandshake, rejectHandshake) => {
      welcomed = resolveHandshake
      failed = rejectHandshake
    })

    const channel = await ServerMessageChannel.open(transport, {
      onMessage: (message) => {
        supervisor.noteInbound()
        if (message.type === 'welcome') {
          try {
            assertWelcomeAccepted(message, { encoding: RenderEncoding.TerminalAnsi })
          } catch (error: unknown) {
            failed?.(error instanceof Error ? error : new Error(String(error)))
            return
          }
          welcomed?.()
          return
        }
        if (message.type === 'terminal') {
          frames += 1
        }
      },
      onUndecodable: (error: WireError) => {
        // L1's answer. `ServerMessage::Pong` is variant 10 and this codec decodes only `Welcome`
        // and `Terminal`, so the probe's reply lands here — and it is still proof the peer produced
        // a complete frame, which is all the watchdog asks.
        supervisor.noteInbound()
        if (error instanceof UnsupportedVariantError && isPongVariant(error.variant)) {
          pongs += 1
        }
      },
      onClose: (close: HerdrChannelClose) => {
        closes += 1
        if (activeToken === token) {
          activeToken = null
          supervisor.handleLinkClosed(close)
        }
      }
    })
    currentChannel = channel
    signalHandshaking()

    // X1b, live: the geometry comes out of the stored subscription, so a viewport change made while
    // the link was down reaches the wire on the very next `Hello`. Reading it from a variable
    // captured at first subscribe is exactly the bug ("재연결했더니 예전 크기로 붙음").
    const stored = supervisor.subscriptions.list()[0]
    const cols = stored?.cols ?? COLS
    const rows = stored?.rows ?? ROWS
    handshakes.push({ cols, rows, paneId: stored?.paneId ?? '' })
    await channel.send(
      encodeHelloFrame({
        cols,
        rows,
        requestedEncoding: RenderEncoding.TerminalAnsi,
        launchMode: ClientLaunchMode.TerminalAttach
      })
    )
    await handshake
    activeToken = token

    return {
      probe: (nonce: number) => {
        void Promise.resolve(channel.send(encodePingFrame(nonce))).catch(() => {})
        return true
      },
      terminate: () => {
        if (activeToken === token) {
          activeToken = null
        }
        try {
          channel.close()
        } catch {
          // already gone
        }
        transport.close()
        openTransports = openTransports.filter((entry) => entry !== transport)
      }
    }
  }

  async function replay(subscription: ObserveSubscription): Promise<boolean> {
    const channel = currentChannel
    if (channel === null) {
      return false
    }
    await channel.send(encodeObserveTerminalFrame(subscription.paneId))
    // X1's herdr-specific half: a reconnected client's sink still holds the *previous* connection's
    // baseline, so a diff applied onto it renders wrong cells rather than failing. `RequestFullFrame`
    // (`src/protocol/wire.rs:462-467`, mx-only) makes the server re-baseline instead.
    await channel.send(encodeRequestFullFrameFrame())
    return true
  }

  beforeAll(async () => {
    process.on('uncaughtException', onUncaught)
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
    const { createTransportJsonApiClient } = await import('@herdr/client-ts')
    api = createTransportJsonApiClient(control, {})

    const created = await api.request('workspace.create', { cwd: server.base, focus: true })
    expect(created['type'], `workspace.create failed: ${JSON.stringify(created)}`).toBe(
      'workspace_created'
    )
    paneId = (created['root_pane'] as { pane_id: string }).pane_id

    supervisor = new ConnectionSupervisor({
      dial,
      replay,
      timer: {
        setTimeout: (handler, ms) => setTimeout(handler, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
      },
      // Short enough that a 180s test can watch three fair misses, long enough that a loaded CI box
      // does not produce them by accident. The production constants are asserted in
      // `src/transport/rpc-session-liveness-watchdog.test.ts`.
      liveness: { idleProbeMs: 3_000, probeTimeoutMs: 2_000, missedProbeLimit: 3 },
      onState: (state) => states.push(state),
      onLog: (line) => log.push(line)
    })
    supervisor.observe({ paneId, cols: COLS, rows: ROWS })

    process.stdout.write(
      `[m4-live] server pid=${server.pid} sshd pid=${sshd.pid} port=${sshd.port} ` +
        `cutter port=${cutter.port} pane=${paneId}\n`
    )
  }, 180_000)

  afterAll(async () => {
    process.removeListener('uncaughtException', onUncaught)
    supervisor?.close()
    for (const transport of openTransports) {
      transport.close()
    }
    control?.close()
    await cutter?.close()
    await sshd?.stop()
    await server?.stop()
  })

  it('connects through ssh, observes a real pane, and receives real frames', async () => {
    supervisor.start()
    await until('the supervisor connected', () => supervisor.snapshot().state === 'connected', 60_000)
    await api.request('pane.send_input', { pane_id: paneId, text: 'echo M4ALIVE', keys: ['Enter'] })
    await until('frames arrived', () => frames > 0, 60_000)

    const snapshot = supervisor.snapshot()
    process.stdout.write(
      `[m4-live] connected: states=${states.join('->')} frames=${frames} ` +
        `verdict=${snapshot.verdict.kind} attempt=${snapshot.reconnectAttempt}\n`
    )
    expect(snapshot).toMatchObject({ state: 'connected', reconnectAttempt: 0 })
    expect(supervisor.subscriptions.pendingReplay()).toHaveLength(0)
    expect(handshakes[0]).toEqual({ cols: COLS, rows: ROWS, paneId })
  }, 180_000)

  it('L1: a real mx server answers ClientMessage::Ping while in TerminalObserve mode', async () => {
    const before = pongs
    // The exact call `subscribeConnectionRevivalTriggers` makes on `AppState 'active'`, and the
    // branch that runs when the link is up: probe now rather than assume.
    supervisor.notifyForeground('app-resume')
    await until('a Pong came back', () => pongs > before, 30_000)
    process.stdout.write(
      `[m4-live] Ping->Pong over the observe stream: pongs=${pongs} (tag 10, undecoded by design)\n`
    )
    expect(pongs).toBeGreaterThan(before)
    expect(supervisor.snapshot().state).toBe('connected')
  }, 60_000)

  it('the outage: severing the path is detected, stays armed, and recovers by itself', async () => {
    const framesBeforeOutage = frames
    const dialsBefore = cutter.accepted
    states.length = 0

    // Airplane mode. Every socket dies at once with no notification to either end.
    cutter.cut()
    await until(
      'the supervisor noticed the outage',
      () => supervisor.snapshot().state !== 'connected',
      60_000
    )
    const down = supervisor.snapshot()
    process.stdout.write(
      `[m4-live] outage: state=${down.state} armed=${down.armed} attempt=${down.reconnectAttempt} ` +
        `closes=${closes} verdict=${down.verdict.kind}\n`
    )
    // L3's property, live: not "it will retry" — a timer exists right now.
    expect(down.state).toBe('reconnecting')
    expect(down.armed).toBe(true)
    // X1: the subscription is owed again the moment the link died, not when the next one succeeds.
    expect(supervisor.subscriptions.pendingReplay()).toHaveLength(1)

    // Stay down long enough to climb the backoff. Nothing here touches the supervisor.
    await delay(6_000)
    const stillDown = supervisor.snapshot()
    process.stdout.write(
      `[m4-live] 6s into the outage: state=${stillDown.state} armed=${stillDown.armed} ` +
        `attempt=${stillDown.reconnectAttempt} verdict=${stillDown.verdict.kind}\n`
    )
    expect(stillDown.armed).toBe(true)
    expect(stillDown.reconnectAttempt).toBeGreaterThan(down.reconnectAttempt)

    // X1b: the phone rotated while it was offline. The next `Hello` must carry this, not 100x30.
    supervisor.updateObserveViewport(paneId, { cols: 80, rows: 24 })

    // The radio comes back. No user action, no forceReconnect, no restart.
    cutter.heal()
    await until(
      'the supervisor reconnected',
      () => supervisor.snapshot().state === 'connected',
      120_000
    )
    const up = supervisor.snapshot()
    process.stdout.write(
      `[m4-live] recovered: states=${states.join('->')} attempt=${up.reconnectAttempt} ` +
        `tcp accepts ${dialsBefore}->${cutter.accepted}\n`
    )
    expect(up).toMatchObject({ state: 'connected', reconnectAttempt: 0 })
    expect(cutter.accepted).toBeGreaterThan(dialsBefore)

    // X1b, on the wire: the replayed handshake used the geometry stored while offline.
    const last = handshakes[handshakes.length - 1]
    process.stdout.write(`[m4-live] handshakes: ${JSON.stringify(handshakes)}\n`)
    expect(last).toEqual({ cols: 80, rows: 24, paneId })

    // X1, and the only assertion that separates "reconnected" from "recovered": the observe stream
    // is live again, proved by output produced *after* the outage reaching the client as frames.
    await api.request('pane.send_input', {
      pane_id: paneId,
      text: 'echo M4RECOVERED',
      keys: ['Enter']
    })
    await until('frames resumed after the outage', () => frames > framesBeforeOutage + 1, 60_000)
    process.stdout.write(
      `[m4-live] frames ${framesBeforeOutage} -> ${frames} after replay; ` +
        `pendingReplay=${supervisor.subscriptions.pendingReplay().length}\n` +
        `[m4-live] supervisor log:\n  ${log.slice(-8).join('\n  ')}\n`
    )
    expect(supervisor.subscriptions.pendingReplay()).toHaveLength(0)
  }, 180_000)

  it('a second outage recovers the same way — the machine has no one-shot in it', async () => {
    const framesBefore = frames
    cutter.cut()
    await until('down again', () => supervisor.snapshot().state !== 'connected', 60_000)
    expect(supervisor.snapshot().armed).toBe(true)
    cutter.heal()
    await until('up again', () => supervisor.snapshot().state === 'connected', 120_000)
    await api.request('pane.send_input', { pane_id: paneId, text: 'echo M4AGAIN', keys: ['Enter'] })
    await until('frames resumed again', () => frames > framesBefore + 1, 60_000)
    process.stdout.write(
      `[m4-live] second outage healed; frames ${framesBefore} -> ${frames}, ` +
        `handshakes=${handshakes.length}\n`
    )
    expect(supervisor.snapshot()).toMatchObject({ state: 'connected', reconnectAttempt: 0 })
  }, 180_000)

  it('the reconnect loop produced no uncaught errors at all', () => {
    process.stdout.write(
      `[m4-live] suppressed ssh2 dial errors: ${suppressedDialErrors}\n`
    )
    // Nothing is filtered out of `unexpected`: an exec that threw into an EventEmitter, a codec
    // callback escaping, or a regression of the pre-handshake double-emit all land here and fail.
    expect(unexpected).toEqual([])
    // Absorbed errors come from both halves of the transport's guard: the repeat emit of a dial
    // that died before the banner, and the failure of an already-established connection when the
    // cutter severs it. Zero means neither happened — i.e. the outage never reached ssh2 and this
    // suite proved less than it claims. Same guard the quarantine counter used to provide, now
    // sourced from the transport rather than from `uncaughtException`.
    expect(suppressedDialErrors).toBeGreaterThan(0)
  })

  /**
   * What this file does **not** prove, stated rather than implied:
   *
   *  - **The OS suspending JS.** `notifyForeground` is called here directly, exactly as
   *    `subscribeConnectionRevivalTriggers` would call it, but nothing suspends this process's
   *    timers. The rule that survives a suspension is L1b, and it is proved deterministically in
   *    `src/transport/rpc-session-liveness-watchdog.test.ts` by moving the clock without running the
   *    queue — which is a *stronger* test than a real 30-minute background, because it can assert
   *    the exact number of misses booked.
   *  - **A real radio handoff.** The cutter destroys sockets; iOS/Android also change the source
   *    address and can leave a socket half-open rather than reset. The half-open case is L1's, and
   *    the live half of L1 (a real `Pong` from a real mx server) is proved above.
   *  - **The React layer.** No component is mounted here; `test/live/paneViewer.live.test.tsx` is
   *    where the screen is, and it does not yet mount a supervisor — see the report.
   */
})
