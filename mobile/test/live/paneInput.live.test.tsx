/**
 * The M3 receipt: **a real prompt is waiting on a real pane, a button in the app screen is pressed,
 * and the answer comes back through the observe stream into the xterm buffer** — while that pane's
 * PTY grid does not move.
 *
 * That is milestone M3's "됐다" verbatim (mobile/.prd/04-milestones.md:120): "폰에서 승인 프롬프트에
 * y → observe 스트림에 반영 확인. 그 동안 PTY 크기 불변." Both halves are measured below rather
 * than argued, and the buffers are printed either way, because "no errors" is not evidence.
 *
 * Same construction as its M2 sibling `./paneViewer.live.test.tsx`, which it deliberately mirrors:
 * everything under the React tree is real — the route file, `PaneInputBar`, `PaneInputSender`, the
 * JSON API client, the ssh transport, `herdr remote-{api,client}-bridge`, and a herdr server this
 * test spawned. What is added here is the direction of travel: M2 only read.
 *
 * **The write is a JSON API call and never a wire frame.** `pane.send_input` is an ordinary method
 * (`src/api/schema/panes.rs:243`); `ControlTerminal`/`AttachTerminal` would resize the shared PTY to
 * the phone's grid and lock it (`src/server/headless.rs:2665-2675`), which is why the PTY assertion
 * below is not a formality — it is the thing 02-architecture.md §2.3 buys, checked. Every JSON call
 * the screen makes is recorded on the way past and printed, so "it did not take the wire path" is
 * also a measurement.
 *
 * ⚠️ Process safety, restated because this suite **sends keystrokes**. The developer runs long-lived
 * `herdr server` daemons from the same binary. Nothing here matches processes by name — no `pkill`,
 * no `killall`; `SpawnedServer.stop` and `ScratchSshd.stop` each signal exactly the pid they
 * created. More to the point for *this* file: the only pane ids it ever types into come from a
 * `workspace.create` it issued itself, over a transport whose remote command carries
 * `HERDR_SOCKET_PATH` pointing at this test's own socket — `~/.config/herdr` is unreachable from
 * here, so a stray key cannot land in the developer's own agent session.
 * @vitest-environment happy-dom
 */
import { Children, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

import type { JsonApiClient } from '@herdr/client-ts'
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

/** The prompt the pane will be sitting on when the app presses `y`. */
const PROMPT = 'M3PROMPT'
/** What the shell prints once it has read an answer — i.e. proof the keys arrived. */
const ANSWER = 'M3ANSWER'
/** The marker for the soft-keyboard/IME path (text, not keys). */
const TYPED = 'M3TYPED'

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
  id: 'scratch',
  name: 'scratch-box',
  target: { type: 'ssh', target: '127.0.0.1' }
}

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
  process.stderr.write(`\n*** SKIPPING LIVE PANE INPUT SUITE ***\n${reason}\n\n`)
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

type ApiCall = { method: string; params: Record<string, unknown> }

/**
 * Wraps the screen's `JsonApiClient` so every call it makes is on the record.
 *
 * This is the only way the "no wire writes" claim can be *shown* rather than asserted: the observe
 * channel is a separate socket, so proving the app wrote through the JSON API means proving these
 * are the calls it made — with their exact params, printed below.
 */
function recordingApi(api: JsonApiClient, log: ApiCall[]): JsonApiClient {
  return new Proxy(api, {
    get(target, property, receiver) {
      if (property === 'request' || property === 'call') {
        return (method: string, params: Record<string, unknown> = {}) => {
          log.push({ method, params })
          return (target[property] as (m: string, p: Record<string, unknown>) => unknown)(
            method,
            params
          )
        }
      }
      return Reflect.get(target, property, receiver) as unknown
    }
  })
}

/**
 * `stty size` inside the pane — the only exact measurement of a pane's PTY grid the JSON API allows,
 * because `PaneInfo` carries no width/height (`src/api/schema/panes.rs:398-430`). Ported from
 * `./paneViewer.live.test.tsx`, which took it from the sibling package's `observeTerminal.live.test.ts`.
 *
 * It writes, which is why the *harness* does it and the app does not.
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

/** The same measurement, but only once two consecutive readings agree (`src/server/headless.rs:4074`). */
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

async function waitForScreen(needle: string, timeoutMs: number): Promise<string[]> {
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
      await delay(120)
    })
  }
}

function dumpScreen(label: string, lines: string[]): void {
  const shown = lines.filter((line) => line.length > 0)
  process.stdout.write(
    `[pane-input] ${label} — xterm ${bridge().terminal?.cols}x${bridge().terminal?.rows}, ` +
      `${shown.length} non-empty rows:\n` +
      shown.map((line, index) => `  [${index}] ${line}`).join('\n') +
      '\n'
  )
}

function pressable(target: ReactTestRenderer, label: string) {
  const node = target.root
    .findAllByType(host('Pressable'))
    .find((candidate) => candidate.props.accessibilityLabel === label)
  if (node === undefined) {
    throw new Error(
      `no pressable labelled ${JSON.stringify(label)}; have ` +
        target.root
          .findAllByType(host('Pressable'))
          .map((candidate) => JSON.stringify(candidate.props.accessibilityLabel))
          .join(', ')
    )
  }
  return node
}

/** Presses a real button in the mounted screen and lets the resulting ssh exec finish. */
async function press(target: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    pressable(target, label).props.onPress()
    // The press is synchronous and the send is not: `PaneInputSender` opens an exec channel, writes
    // one NDJSON line and reads one back (blocker B8). Settling here keeps the receipt's call log in
    // press order instead of merging the next tap into this one.
    await delay(1200)
  })
}

describe.skipIf(reason !== null)('live: sending input from the app screen to a real pane', () => {
  let server: SpawnedServer
  let sshd: ScratchSshd
  let transport: Awaited<ReturnType<typeof SshHerdrTransport.connect>>
  let connection: HerdrRemoteConnection
  /** The harness's own client — used for setup and for `stty size`, never by the screen. */
  let api: JsonApiClient
  let paneId: string
  let renderer: ReactTestRenderer | null = null
  const screenCalls: ApiCall[] = []

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
    const raw = createTransportConnection(REMOTE, transport)
    api = raw.api
    // The screen gets the recorded face; the harness keeps the plain one, so the call log below is
    // exactly what the app did and contains none of this file's own setup.
    connection = { ...raw, api: recordingApi(raw.api, screenCalls) }

    const created = await api.request('workspace.create', { cwd: server.base, focus: true })
    expect(created['type'], `workspace.create failed: ${JSON.stringify(created)}`).toBe(
      'workspace_created'
    )
    paneId = (created['root_pane'] as { pane_id: string }).pane_id
    process.stdout.write(
      `[pane-input] server pid=${server.pid} sshd pid=${sshd.pid} port=${sshd.port} pane=${paneId}\n`
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

  it('answers a real prompt from the app’s buttons; the pane’s PTY never moves', async () => {
    // ── 1. the pane's grid, before anything is typed ────────────────────────────────────────────
    const ptyBefore = await settledPanePtySize(api, paneId, 'SZBEFORE')
    process.stdout.write(`[pane-input] pane ${paneId} PTY before = ${ptyBefore}\n`)

    // ── 2. put a prompt up, from the harness side ───────────────────────────────────────────────
    // `read` blocks on the tty until it gets a line, so after this the pane is genuinely waiting for
    // a human — which is the state milestone M3 exists for.
    await api.request('pane.send_input', {
      pane_id: paneId,
      text: `printf '${PROMPT} approve? '; read ans; printf '${ANSWER}:%s\\n' "$ans"`,
      keys: ['Enter']
    })

    // ── 3. mount the real screen on the real connection ─────────────────────────────────────────
    await act(async () => {
      renderer = create(
        <HerdrClientsProvider connections={[connection]}>
          <HerdrDataProvider>
            <PaneViewerScreen remoteId={REMOTE.id} paneId={paneId} />
          </HerdrDataProvider>
        </HerdrClientsProvider>
      )
    })
    const target = renderer as unknown as ReactTestRenderer
    await act(async () => {
      target.root
        .findByType(host('WebView'))
        .props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'web-ready' }) } })
    })

    const before = await waitForScreen(`${PROMPT} approve?`, 60_000)
    dumpScreen('BEFORE input — the pane is sitting on the prompt', before)
    // `${ANSWER}:y` (the printf OUTPUT), not `${ANSWER}:` — the echoed command line itself contains
    // `${ANSWER}:%s`, and whether that substring survives the PTY's line wrap depends on the
    // server's terminal width. Upstream v0.8.2 moved the headless default from 80x24 to 120x40
    // (#2828), which changed the wrap column and made the looser predicate self-trip before a
    // single key was pressed. This form mirrors the AFTER assertion below and cannot alias.
    expect(before.some((line) => line.includes(`${ANSWER}:y`))).toBe(false)

    const writesBefore = bridge().writes
    const sendsBefore = screenCalls.filter((call) => call.method === 'pane.send_input').length
    expect(sendsBefore, 'the screen must not have written anything yet').toBe(0)

    // ── 4. press the app's own buttons ──────────────────────────────────────────────────────────
    // The quick command — M3's headline, "blocked 에이전트에 한 탭으로 y". This is a real
    // `Pressable` inside the mounted route, found by the accessibility label a screen reader uses.
    await press(target, 'Answer yes')
    // …and an accessory key, round-tripped for real: `read` wants a line, so the answer is only
    // committed by Enter. Its `keys[]` entry is `enter`, not orca's `\r`
    // (`src/session/../terminal/terminal-accessory-herdr-keys.ts`).
    await press(target, 'Enter')

    // ── 5. the answer comes back through the observe stream ─────────────────────────────────────
    const after = await waitForScreen(`${ANSWER}:y`, 60_000)
    dumpScreen('AFTER input — the shell read the answer the phone sent', after)

    const sends = screenCalls.filter((call) => call.method === 'pane.send_input')
    process.stdout.write(
      `[pane-input] the screen's JSON API calls: ${JSON.stringify(screenCalls.map((c) => c.method))}\n` +
        `[pane-input] its pane.send_input params: ${JSON.stringify(sends.map((c) => c.params))}\n` +
        `[pane-input] xterm writes ${writesBefore} -> ${bridge().writes}\n`
    )
    process.stdout.write(`[pane-input] rendered nodes: ${JSON.stringify(textNodes(target))}\n`)

    // The screen answered the prompt: `M3ANSWER:y` can only exist because `read ans` completed, and
    // `read ans` can only complete because a `y` and a newline reached that PTY.
    expect(after.some((line) => line.includes(`${ANSWER}:y`))).toBe(true)
    // The output is *new*: it arrived as `Terminal` diff frames after the handshake, not in `init`.
    expect(bridge().writes).toBeGreaterThan(writesBefore)

    // What went out, exactly. Keys, never bytes — a `\x1b[A`-style payload would be answered
    // `invalid_key` (`src/app/api/panes.rs:1552`), and `y` sent as `text` would be bracketed-paste
    // wrapped (`src/app/api_helpers.rs:24-33`).
    expect(sends).toHaveLength(2)
    expect(sends[0]?.params).toEqual({ pane_id: paneId, keys: ['y'] })
    expect(sends[1]?.params).toEqual({ pane_id: paneId, keys: ['enter'] })

    // And it went out over the JSON API only. `ControlTerminal`/`AttachTerminal` are wire messages,
    // so their absence is shown by the PTY assertion below; these are the JSON methods that could
    // have moved the pane and did not get called.
    const methods = new Set(screenCalls.map((call) => call.method))
    expect(methods.has('pane.send_input')).toBe(true)
    for (const forbidden of ['pane.resize', 'pane.send_text', 'pane.send_keys']) {
      expect(methods.has(forbidden), `${forbidden} was called`).toBe(false)
    }

    // ── 6. the second half of M3's "됐다": the desktop is untouched ──────────────────────────────
    const ptyAfter = await settledPanePtySize(api, paneId, 'SZAFTER')
    process.stdout.write(
      `[pane-input] pane ${paneId} PTY after = ${ptyAfter} (before ${ptyBefore})\n` +
        `[pane-input] xterm grid = ${bridge().terminal?.cols}x${bridge().terminal?.rows}\n`
    )
    expect(ptyAfter).toBe(ptyBefore)
  }, 180_000)

  it('sends what the soft keyboard typed as `text`, with Enter, in one request', async () => {
    const target = renderer as unknown as ReactTestRenderer
    const ptyBefore = await settledPanePtySize(api, paneId, 'SZTEXT')
    const sendsBefore = screenCalls.filter((call) => call.method === 'pane.send_input').length

    // The IME path. On a device this is the soft keyboard filling the bar's `TextInput`; here it is
    // the same `onChangeText` the platform would call, on the real component.
    const command = `printf '${TYPED}:%s\\n' ok`
    await act(async () => {
      target.root.findByType(host('TextInput')).props.onChangeText(command)
    })
    expect(target.root.findByType(host('TextInput')).props.value).toBe(command)

    await press(target, 'Send input')

    const lines = await waitForScreen(`${TYPED}:ok`, 60_000)
    dumpScreen('AFTER typed text — the shell ran what the field sent', lines)

    const sends = screenCalls.filter((call) => call.method === 'pane.send_input')
    process.stdout.write(
      `[pane-input] typed-path params: ${JSON.stringify(sends.slice(sendsBefore).map((c) => c.params))}\n`
    )
    expect(lines.some((line) => line.includes(`${TYPED}:ok`))).toBe(true)

    // One request, not a text call racing an Enter call: `encode_api_input` emits `text` then every
    // key (`src/app/api_helpers.rs:72-84`), so this shape is also the ordering guarantee.
    expect(sends).toHaveLength(sendsBefore + 1)
    expect(sends[sendsBefore]?.params).toEqual({
      pane_id: paneId,
      text: command,
      keys: ['enter']
    })
    // The field cleared itself, so the next prompt starts empty.
    expect(target.root.findByType(host('TextInput')).props.value).toBe('')

    const ptyAfter = await settledPanePtySize(api, paneId, 'SZTEXT2')
    process.stdout.write(`[pane-input] pane ${paneId} PTY ${ptyBefore} -> ${ptyAfter}\n`)
    expect(ptyAfter).toBe(ptyBefore)
  }, 180_000)

  it('refuses a key when there is no transport, instead of parking it (X2)', async () => {
    // The same screen with an empty provider: `useHerdrConnection` returns null, so the sender has
    // no api. X2 — "끊긴 상태의 키 입력은 즉시 거절" — and the visible half of it is that the buttons
    // are disabled rather than hopeful.
    let offline: ReactTestRenderer | null = null
    await act(async () => {
      offline = create(
        <HerdrClientsProvider connections={[]}>
          <HerdrDataProvider>
            <PaneViewerScreen remoteId={REMOTE.id} paneId={paneId} />
          </HerdrDataProvider>
        </HerdrClientsProvider>
      )
    })
    const target = offline as unknown as ReactTestRenderer
    const before = screenCalls.length
    expect(pressable(target, 'Answer yes').props.disabled).toBe(true)
    await act(async () => {
      pressable(target, 'Answer yes').props.onPress()
      await delay(200)
    })
    process.stdout.write(
      `[pane-input] offline screen said: ${JSON.stringify(textNodes(target))}\n`
    )
    // Nothing was sent, and — the part that matters — nothing was held for later either.
    expect(screenCalls).toHaveLength(before)
    expect(textNodes(target)).toContain('no transport')
    act(() => target.unmount())
  }, 180_000)
})
