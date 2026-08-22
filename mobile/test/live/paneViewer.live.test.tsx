/**
 * The M2 receipt: **app screen -> client-ts -> ssh -> bridge -> a real herdr server -> real ANSI ->
 * xterm buffer**, in one test.
 *
 * Everything below the React tree is the real thing. The route file
 * (`app/h/[remoteId]/pane/[paneId].tsx`), the snapshot provider, `PaneObserver`, the wire codec, the
 * ssh transport, `herdr remote-{api,client}-bridge` and a herdr server this test spawned are all
 * genuine, and the screen's data comes from that server's own `remote.list` / `workspace.list` /
 * `pane.list` / `agent.list` — not from `src/api/mock/`.
 *
 * **No socket path is dialled here.** Every byte the client sends goes `ssh exec` ->
 * `bridge_stdio_to_socket` (`src/remote/unix.rs:568-590`). `HERDR_SOCKET_PATH` appears once, in the
 * *remote command's* environment, and that is the isolation: without it the bridge would resolve the
 * default paths, i.e. the developer's own daemons. Same construction as
 * `packages/herdr-client-ts/test/live-ssh/sshTransport.live.test.ts`.
 *
 * ⚠️ Process safety. The developer runs long-lived `herdr server` daemons from the same binary
 * name. Nothing here matches processes by name — no `pkill`, no `killall`; `SpawnedServer.stop` and
 * `ScratchSshd.stop` each signal exactly the pid they created, and both get their own `XDG_*` under
 * `/tmp`. `~/.config/herdr` is never touched.
 *
 * The one hop that is *not* real is `WebView.postMessage` crossing into the WebView document; see
 * `./xtermWebViewBridge.ts` for exactly what stands in for it and what that costs.
 * @vitest-environment happy-dom
 */
import { Children, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

import { HerdrChannelKind, type JsonApiClient } from '@herdr/client-ts'
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
import { createXtermWebViewBridge, type XtermWebViewBridge } from './xtermWebViewBridge'
import type { HerdrRemoteConnection } from '../../src/transport/herdr-connection'
import type { RemoteDefinition } from '../../src/api/herdr-api-types'

const MARKER_A = 'PANEVIEWERA'
const MARKER_B = 'PANEVIEWERB'

// A holder, not the bridge itself: `vi.mock` factories are hoisted above every `beforeAll`, so the
// mock has to reach the bridge through a box that is filled later. Copying the object's fields into
// a hoisted literal instead (`Object.assign`) silently splits it in two — the closures keep
// mutating the original while the assertions read a stale copy, which is exactly how a receipt ends
// up asserting nothing.
const held = vi.hoisted(() => ({ current: null as XtermWebViewBridge | null }))

function bridge(): XtermWebViewBridge {
  if (held.current === null) {
    throw new Error('the xterm bridge has not been created yet')
  }
  return held.current
}

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
    React.useImperativeHandle(ref, () => ({
      postMessage: (raw: string) => held.current?.handle(raw),
      reload: () => {}
    }))
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
    // M3: the route now mounts `src/session/PaneInputBar.tsx`, which is a real `TextInput`.
    TextInput: 'TextInput',
    View: 'View'
  }
})

const { SshHerdrTransport } = await import('@herdr/client-ts/node')
const { createTransportConnection } = await import('../../src/transport/herdr-connection')
const { HerdrClientsProvider } = await import('../../src/transport/herdr-clients-context')
const { HerdrDataProvider } = await import('../../src/api/herdr-data-provider')
const { PaneViewerScreen } = await import('../../app/h/[remoteId]/pane/[paneId]')

const REMOTE: RemoteDefinition = {
  // The phone knows which ssh target it dialled; the server does not report itself in `remote.list`
  // (measured — see `src/api/live/live-snapshot-loader.ts`), so this definition is the app's.
  id: 'scratch',
  name: 'scratch-box',
  target: { type: 'ssh', target: '127.0.0.1' }
}

/**
 * Loud, like the sibling package's live suites: a live test that quietly becomes a no-op still
 * reports green. `HERDR_LIVE_REQUIRE=1` turns absence into failure.
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
  process.stderr.write(`\n*** SKIPPING LIVE PANE VIEWER SUITE ***\n${reason}\n\n`)
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
        .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
        .join('')
    )
    .filter((text) => text.length > 0)
}

/**
 * Runs `stty size` inside the pane and reads it back — the only exact measurement of a pane's PTY
 * grid the JSON API allows, because `PaneInfo` carries no width/height
 * (`src/api/schema/panes.rs:398-430`). It is a *write*, which is why the app never does it and this
 * harness does.
 */
async function panePtySize(api: JsonApiClient, paneId: string, tag: string): Promise<string> {
  await api.request('pane.send_input', {
    pane_id: paneId,
    text: `echo ${tag}:$(stty size | tr " " x)`,
    keys: ['Enter']
  })
  const waited = await api.request('pane.wait_for_output', {
    pane_id: paneId,
    source: 'recent',
    lines: 40,
    match: { type: 'regex', value: `${tag}:[0-9]+x[0-9]+` },
    timeout_ms: 20_000
  })
  expect(waited['type'], `pane never reported its size: ${JSON.stringify(waited)}`).toBe(
    'output_matched'
  )
  const line = waited['matched_line'] as string
  const at = line.lastIndexOf(`${tag}:`)
  const size = /^[0-9]+x[0-9]+/.exec(line.slice(at + tag.length + 1))
  expect(size, `malformed size in ${JSON.stringify(line)}`).not.toBeNull()
  return (size as RegExpExecArray)[0]
}

/**
 * The same measurement, but only once two consecutive readings agree — a fresh pane starts at the
 * server's PTY size and is resized to its layout rect on the first virtual render
 * (`src/server/headless.rs:4074`). That drift is client-independent, so the invariance claim has to
 * start from the settled value. (Ported from the sibling package's `observeTerminal.live.test.ts`.)
 */
async function settledPanePtySize(api: JsonApiClient, paneId: string, tag: string): Promise<string> {
  let last = await panePtySize(api, paneId, `${tag}0`)
  for (let round = 1; round < 8; round += 1) {
    await delay(250)
    const next = await panePtySize(api, paneId, `${tag}${round}`)
    if (next === last) {
      return next
    }
    last = next
  }
  throw new Error(`pane PTY size never settled (last reading ${last})`)
}

/**
 * Polls the xterm buffer until `needle` shows up on some row, or the deadline passes.
 *
 * `pollMs` is the measurement granularity, and the M6 timing receipt is the one caller that cares:
 * at the default 120 ms an 8 ms wire event reads as anything up to 128 ms of "latency" that is
 * entirely this loop's sleep. Pass a small value when the elapsed time is the assertion.
 */
async function waitForScreen(needle: string, timeoutMs: number, pollMs = 120): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  let lines: string[] = []
  for (;;) {
    lines = await bridge().screen()
    if (lines.some((line) => line.includes(needle))) {
      return lines
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${needle} never reached the xterm buffer within ${timeoutMs}ms; ` +
          `writes=${bridge().writes} commands=${bridge().commands.map((c) => c.type).join(',')}\n` +
          lines.filter((line) => line.length > 0).join('\n')
      )
    }
    await act(async () => {
      await delay(pollMs)
    })
  }
}

/** The commands that actually change the buffer, as opposed to theme/scale bookkeeping. */
function isScreenCommand(type: string): boolean {
  return type === 'init' || type === 'write' || type === 'resize'
}

function dumpScreen(label: string, lines: string[]): void {
  const shown = lines.filter((line) => line.length > 0)
  process.stdout.write(
    `[pane-viewer] ${label} — xterm ${bridge().terminal?.cols}x${bridge().terminal?.rows}, ` +
      `${shown.length} non-empty rows:\n` +
      shown.map((line, index) => `  [${index}] ${line}`).join('\n') +
      '\n'
  )
}

describe.skipIf(reason !== null)('live: the pane viewer against a real herdr server', () => {
  let server: SpawnedServer
  let sshd: ScratchSshd
  let transport: Awaited<ReturnType<typeof SshHerdrTransport.connect>>
  let connection: HerdrRemoteConnection
  let api: JsonApiClient
  let paneA: string
  let paneB: string
  let renderer: ReactTestRenderer | null = null

  beforeAll(async () => {
    held.current = createXtermWebViewBridge()
    server = await spawnServer()
    sshd = await spawnScratchSshd(findSshd() as string, server.base)
    transport = await SshHerdrTransport.connect({
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
    connection = createTransportConnection(REMOTE, transport)
    api = connection.api

    const created = await api.request('workspace.create', { cwd: server.base, focus: true })
    expect(created['type'], `workspace.create failed: ${JSON.stringify(created)}`).toBe(
      'workspace_created'
    )
    paneA = (created['root_pane'] as { pane_id: string }).pane_id
    const split = await api.request('pane.split', { pane_id: paneA, direction: 'right' })
    paneB = (split['pane'] as { pane_id: string }).pane_id
    await api.request('pane.send_input', { pane_id: paneA, text: `echo ${MARKER_A}`, keys: ['Enter'] })
    await api.request('pane.send_input', { pane_id: paneB, text: `echo ${MARKER_B}`, keys: ['Enter'] })
    process.stdout.write(
      `[pane-viewer] server pid=${server.pid} sshd pid=${sshd.pid} port=${sshd.port} ` +
        `panes=${paneA},${paneB}\n`
    )
  }, 180_000)

  afterAll(async () => {
    if (renderer) {
      act(() => renderer?.unmount())
      renderer = null
    }
    held.current?.dispose()
    transport?.close()
    await sshd?.stop()
    await server?.stop()
  })

  it('renders a real pane: the server’s own ANSI reaches the xterm buffer, PTY unchanged', async () => {
    const before = await settledPanePtySize(api, paneA, 'SZBEFORE')
    process.stdout.write(`[pane-viewer] pane ${paneA} PTY before = ${before}\n`)

    await act(async () => {
      renderer = create(
        <HerdrClientsProvider connections={[connection]}>
          <HerdrDataProvider>
            <PaneViewerScreen remoteId={REMOTE.id} paneId={paneA} />
          </HerdrDataProvider>
        </HerdrClientsProvider>
      )
    })
    const target = renderer as unknown as ReactTestRenderer

    // The document reports itself loaded; until then every command is queued, not posted
    // (`src/terminal/terminal-webview-pending-messages.ts`).
    await act(async () => {
      target.root
        .findByType(host('WebView'))
        .props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'web-ready' }) } })
    })

    const lines = await waitForScreen(MARKER_A, 60_000)
    dumpScreen(`pane ${paneA}`, lines)
    process.stdout.write(
      `[pane-viewer] rendered nodes: ${JSON.stringify(textNodes(target))}\n` +
        `[pane-viewer] WebViews=${target.root.findAllByType(host('WebView')).length} ` +
        `commands=${bridge().commands.map((command) => command.type).join(',')} ` +
        `writes=${bridge().writes}\n`
    )

    // The screen is real: bytes the server rendered, parsed by a real xterm.
    expect(lines.some((line) => line.includes(MARKER_A))).toBe(true)
    expect(lines.some((line) => line.includes(MARKER_B))).toBe(false)
    // …and it is the *route's* screen: the chips came from this server's `pane.list`, the header
    // from its `remote.list`/`workspace.list`, all through the live loader.
    const texts = textNodes(target)
    expect(texts).toContain('observing')
    expect(texts.filter((text) => text.startsWith('tab '))).toHaveLength(2)
    expect(target.root.findAllByType(host('WebView'))).toHaveLength(1)
    // The first *screen-bearing* command is `init`, never a bare `write`: the theme/font-scale
    // commands `TerminalWebView` posts on mount carry no bytes, and a `write` before `init` would
    // mean the sink applied a diff to a buffer that does not exist.
    expect(bridge().commands.map((command) => command.type).find(isScreenCommand)).toBe('init')

    // Observing did not resize the pane: milestone M2 (c), measured rather than argued. The same
    // round also produces *new* output, which is the second thing this asserts — the stream is
    // live, not a snapshot: those lines can only reach the buffer as `Terminal` diff frames
    // arriving after the handshake, i.e. as `write` commands rather than the opening `init`.
    const after = await settledPanePtySize(api, paneA, 'SZAFTER')
    const streamed = await waitForScreen('SZAFTER1', 60_000)
    dumpScreen(`pane ${paneA} after live output`, streamed)
    process.stdout.write(
      `[pane-viewer] pane ${paneA} PTY after = ${after}; writes=${bridge().writes}\n`
    )
    expect(bridge().writes).toBeGreaterThan(0)
    expect(after).toBe(before)

    // The observer asked for the *pane's* geometry, not the device's. A phone is ~40 columns wide;
    // the grid xterm was opened at is the frame width the server chose from our `Hello`.
    const cols = bridge().terminal?.cols ?? 0
    const rows = bridge().terminal?.rows ?? 0
    process.stdout.write(`[pane-viewer] xterm grid = ${cols}x${rows} (pane PTY ${before})\n`)
    // `stty size` prints rows then columns.
    const [ptyRows, ptyCols] = before.split('x').map(Number) as [number, number]
    expect(cols).toBeGreaterThanOrEqual(ptyCols)
    expect(rows).toBeGreaterThanOrEqual(ptyRows)
  }, 180_000)

  it('switches target on a chip tap: the other pane’s output replaces the screen', async () => {
    const target = renderer as unknown as ReactTestRenderer
    const beforeB = await settledPanePtySize(api, paneB, 'SZB')
    bridge().reset()
    // M6/B6. Counted per KIND, not in total: the snapshot poller opens `api-request` channels
    // continuously (the JSON API answers one line per connection), so a total would drown the
    // claim. `client-stream` is the resident bridge — a remote `herdr remote-client-bridge`
    // process plus a handshake plus a fresh full ANSI baseline — and the switch below must cost
    // none of them.
    const clientStreamsBefore = transport.channelCountOfKind(HerdrChannelKind.ClientStream)
    const channelsBefore = transport.channelCount
    const startedAt = Date.now()

    await act(async () => {
      target.update(
        <HerdrClientsProvider connections={[connection]}>
          <HerdrDataProvider>
            <PaneViewerScreen remoteId={REMOTE.id} paneId={paneB} />
          </HerdrDataProvider>
        </HerdrClientsProvider>
      )
    })
    await act(async () => {
      target.root
        .findByType(host('WebView'))
        .props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'web-ready' }) } })
    })

    const lines = await waitForScreen(MARKER_B, 60_000, 10)
    const elapsed = Date.now() - startedAt
    dumpScreen(`pane ${paneB}`, lines)
    process.stdout.write(
      `[pane-viewer] chip swap ${paneA} -> ${paneB} in ${elapsed}ms; ` +
        `client-stream channels ${clientStreamsBefore} -> ` +
        `${transport.channelCountOfKind(HerdrChannelKind.ClientStream)}; ` +
        `all channels ${channelsBefore} -> ${transport.channelCount} ` +
        `connections=${transport.connectionCount}\n`
    )
    // The target really moved: the new pane's marker is on screen and the old one's is gone,
    // because `init` rebuilt the buffer from the new stream's first full frame.
    expect(lines.some((line) => line.includes(MARKER_B))).toBe(true)
    expect(lines.some((line) => line.includes(MARKER_A))).toBe(false)
    // The buffer was rebuilt rather than written over: `PaneObserver.retarget` resets the sink, so
    // the server's post-retarget full frame arrives as an `init` at the (possibly new) geometry.
    expect(bridge().commands.map((command) => command.type).find(isScreenCommand)).toBe('init')
    // The receipt this milestone is measured on: the swap opened **no** new ssh channel, on a
    // transport that would otherwise have spawned a bridge process per pane tap.
    // M6's "됐다" is a pane switch under 200 ms. Asserted loosely (an ssh round trip plus a React
    // commit on a loaded box is not a 200 ms guarantee) but PRINTED exactly, and the tight number
    // lives one layer down where there is no React and no xterm:
    // `packages/herdr-client-ts/test/live-ssh` measures retarget-to-frame at 8 ms over this same
    // ssh transport, and `tests/observe_terminal_ansi.rs` at 21 ms over a unix socket.
    expect(elapsed).toBeLessThan(5_000)
    expect(transport.channelCountOfKind(HerdrChannelKind.ClientStream)).toBe(clientStreamsBefore)
    expect(clientStreamsBefore).toBe(1)
    expect(transport.connectionCount).toBe(1)

    const afterB = await settledPanePtySize(api, paneB, 'SZB2')
    process.stdout.write(`[pane-viewer] pane ${paneB} PTY ${beforeB} -> ${afterB}\n`)
    expect(afterB).toBe(beforeB)
  }, 180_000)
})
