// Not from orca. The receipt for mobile/.prd/09-review-followups.md §Q — the one defect a QA agent
// watched happen on a device rather than inferred from the code:
//
//   20:14:43Z  observe client 41 끊김
//   20:15:11Z  FullApp client 81 재연결          ← the transport redialled (M4 works)
//              …2분 넘게 terminal observe 없음…
//   20:17:27Z  terminal observe client connected ← only when the user left the screen and came back
//
// The connection healed and the *picture* did not, because `PaneObserver` opened its own stream and
// nothing ever re-opened it. So the assertions below are about the pane's stream and nothing else:
// it comes back on its own, on L3's ladder, without a remount, without a second `pane.layout`, and
// — the part a user sees — without throwing away the screen they were pinch-zoomed into.
//
// Same fakes as `./pane-observer.test.ts` (the sibling package's transport and its golden wire
// vectors) plus `test/fake-clock.ts`, so "it re-attaches after 500ms" is a deterministic sequence
// rather than a sleep.
import { describe, expect, it } from 'vitest'
import { HerdrChannelKind, PROTOCOL_VERSION, RenderEncoding } from '@herdr/client-ts'
import {
  FakeTransport,
  type FakeChannel
} from '../../../packages/herdr-client-ts/test/fakeTransport'
import { frameHex, fromHex, toHex } from '../../../packages/herdr-client-ts/test/helpers'
import {
  TERMINAL_SMALL_DIFF,
  TERMINAL_SMALL_FULL,
  WELCOME_OK_ANSI_V21
} from '../../../packages/herdr-client-ts/test/vectors'
import { createWireAbiGate } from '../../test/wire-abi-peer'
import { FakeClock } from '../../test/fake-clock'
import { PaneObserver } from './pane-observer'
import { createTransportConnection } from '../transport/herdr-connection'
import type { TerminalFrameSinkTarget } from '../terminal/terminal-frame-sink'
import type { RemoteDefinition } from '../api/herdr-api-types'

const REMOTE: RemoteDefinition = {
  id: 'remote-1',
  name: 'fable-m5max',
  target: { type: 'local' }
}

const LAYOUT = {
  workspace_id: 'w1',
  tab_id: 'w1:t1',
  zoomed: false,
  area: { x: 26, y: 1, width: 54, height: 23 },
  focused_pane_id: 'w1:p1',
  panes: [{ pane_id: 'w1:p1', focused: true, rect: { x: 26, y: 1, width: 54, height: 23 } }],
  splits: []
}

type Recorded = {
  transport: FakeTransport
  /** One entry per client-bridge channel, in open order: that generation's `ClientMessage` hexes. */
  perStream: string[][]
  apiRequests: { id: string; method: string; params?: Record<string, unknown> }[]
}

/**
 * A fake herdr that answers every generation the same way.
 *
 * `dieBeforeWelcome` plays the box that accepts an exec channel and then loses it — the shape L3's
 * ladder is paced against, and the only way to read the backoff sequence off a fake clock.
 */
function scriptedServer(options: { dieBeforeWelcome?: boolean; welcome?: string } = {}): Recorded {
  const transport = new FakeTransport()
  const perStream: string[][] = []
  const apiRequests: Recorded['apiRequests'] = []
  transport.onOpen = (channel: FakeChannel) => {
    const write = channel.write.bind(channel)
    const wireAbi = createWireAbiGate()
    if (channel.kind === HerdrChannelKind.ClientStream) {
      const messages: string[] = []
      perStream.push(messages)
      channel.write = (bytes: Uint8Array) => {
        write(bytes)
        const framed = wireAbi(bytes)
        if (framed === null) {
          return
        }
        const payload = framed.subarray(4)
        messages.push(toHex(payload))
        if (payload[0] === 0x00) {
          if (options.dieBeforeWelcome === true) {
            channel.die({ error: new Error('the bridge exited') })
            return
          }
          channel.emit(fromHex(frameHex(options.welcome ?? WELCOME_OK_ANSI_V21)))
        } else if (payload[0] === 0x0c || payload[0] === 0x0e) {
          channel.emit(fromHex(frameHex(TERMINAL_SMALL_FULL)))
          channel.emit(fromHex(frameHex(TERMINAL_SMALL_DIFF)))
        }
      }
      return
    }
    channel.write = (bytes: Uint8Array) => {
      write(bytes)
      for (const line of new TextDecoder().decode(bytes).split('\n')) {
        if (line.trim().length === 0) {
          continue
        }
        const request = JSON.parse(line) as Recorded['apiRequests'][number]
        apiRequests.push(request)
        channel.emitLine(
          JSON.stringify({ id: request.id, result: { type: 'pane_layout', layout: LAYOUT } })
        )
      }
    }
  }
  return { transport, perStream, apiRequests }
}

type Applied = { call: 'init' | 'resize' | 'write'; args: unknown[] }

function recordingTarget(applied: Applied[]): TerminalFrameSinkTarget {
  return {
    init: (...args) => applied.push({ call: 'init', args }),
    resize: (...args) => applied.push({ call: 'resize', args }),
    write: (...args) => applied.push({ call: 'write', args })
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 24; i += 1) {
    await Promise.resolve()
  }
}

/** The live client-bridge channel — the one a test kills to play "the stream died". */
function liveStream(server: Recorded): FakeChannel {
  const streams = server.transport.ofKind(HerdrChannelKind.ClientStream)
  const open = streams.filter((channel) => !channel.closed)
  const last = open[open.length - 1]
  if (last === undefined) {
    throw new Error('no live client stream')
  }
  return last
}

function welcomePayloadHex(encoding: RenderEncoding): string {
  const varint = (value: number) => value.toString(16).padStart(2, '0')
  return `00${varint(PROTOCOL_VERSION)}${varint(encoding)}00`
}

describe('pane observer re-attach (§Q)', () => {
  it('re-opens the observe stream on its own after it dies, with the screen still mounted', async () => {
    const clock = new FakeClock()
    const server = scriptedServer()
    const applied: Applied[] = []
    const observer = new PaneObserver({
      connection: createTransportConnection(REMOTE, server.transport),
      paneId: 'w1:p1',
      target: recordingTarget(applied),
      timer: clock.timer
    })
    await observer.start()
    await settle()
    expect(observer.status).toBe('observing')

    // 20:14:43Z. Nothing else changes: the screen stays mounted, nobody calls close().
    liveStream(server).die({ error: new Error('the bridge exited') })
    await settle()
    expect(server.transport.ofKind(HerdrChannelKind.ClientStream)).toHaveLength(1)

    // L3's first rung.
    expect(clock.armedDelays).toEqual([500])
    clock.advance(500)
    await settle()

    // A second generation of the *pane's* stream, not of the health link: one more client bridge,
    // Hello then ObserveTerminal on it, and the observer observing again — no remount involved.
    expect(server.transport.ofKind(HerdrChannelKind.ClientStream)).toHaveLength(2)
    expect(server.perStream[1]?.map((hex) => hex.slice(0, 2))).toEqual(['00', '0c'])
    expect(server.perStream[1]?.[1]).toBe('0c0577313a7031')
    expect(observer.status).toBe('observing')
    expect(observer.reattachCount).toBe(1)
    expect(observer.frameCount).toBe(4)
    observer.close()
  })

  it('keeps the painted screen across the re-attach — no second init, so no zoom reset', async () => {
    const clock = new FakeClock()
    const server = scriptedServer()
    const applied: Applied[] = []
    const observer = new PaneObserver({
      connection: createTransportConnection(REMOTE, server.transport),
      paneId: 'w1:p1',
      target: recordingTarget(applied),
      timer: clock.timer
    })
    await observer.start()
    await settle()
    expect(applied.map((entry) => entry.call)).toEqual(['init', 'write'])

    liveStream(server).die({ error: new Error('the bridge exited') })
    clock.advance(500)
    await settle()

    // `TerminalWebView.init` throws the xterm away and calls `resetZoom()`
    // (`src/terminal/terminal-webview-html.ts`), so an `init` here is the user's pinch and pan
    // deleted by a network blip. The new generation's first frame is a `full` one carrying its own
    // `ESC[2J` (`src/protocol/render_ansi.rs`, `clear_before_full_redraw` on a client with no
    // previous frame), so writing it repaints every cell without a new terminal.
    expect(applied.map((entry) => entry.call)).toEqual(['init', 'write', 'write', 'write'])
    // The same grid, so no `resize` either — `resize` also calls `resetZoom()`, deliberately, for
    // the case this is not: the desktop layout genuinely changing under the observer.
    expect(applied.some((entry) => entry.call === 'resize')).toBe(false)
    observer.close()
  })

  it('re-declares the grid it already had: same Hello, no second pane.layout (B8)', async () => {
    const clock = new FakeClock()
    const server = scriptedServer()
    const observer = new PaneObserver({
      connection: createTransportConnection(REMOTE, server.transport),
      paneId: 'w1:p1',
      target: recordingTarget([]),
      timer: clock.timer
    })
    await observer.start()
    await settle()

    liveStream(server).die({})
    clock.advance(500)
    await settle()

    // M2 (c) — "30분 시청 동안 데스크톱 레이아웃 무변화" — is a property of the bytes: the same
    // `Hello{cols,rows}` and an `ObserveTerminal`, never a `ControlTerminal` (0x0d) and never a
    // `Resize` (0x03) the pane did not ask for.
    expect(server.perStream[1]?.[0]).toBe(server.perStream[0]?.[0])
    expect(server.perStream[1]?.map((hex) => hex.slice(0, 2))).toEqual(['00', '0c'])
    // And it costs no JSON call: one `pane.layout` for the whole outage. On the ssh bridge that
    // call is an exec channel and a remote herdr process (B8).
    expect(server.apiRequests.map((request) => request.method)).toEqual(['pane.layout'])
    observer.close()
  })

  it('does not re-attach while the screen is backgrounded, and does the moment it is not', async () => {
    const clock = new FakeClock()
    const server = scriptedServer()
    let foreground = false
    const observer = new PaneObserver({
      connection: createTransportConnection(REMOTE, server.transport),
      paneId: 'w1:p1',
      target: recordingTarget([]),
      timer: clock.timer,
      isForeground: () => foreground
    })
    await observer.start()
    await settle()

    liveStream(server).die({})
    // Ten minutes of a backgrounded phone: not one exec channel, because an ssh exec is a remote
    // herdr process (B8) and nobody is looking at the picture it would carry.
    clock.advance(600_000)
    await settle()
    expect(server.transport.ofKind(HerdrChannelKind.ClientStream)).toHaveLength(1)
    // …and it is not parked either. A timer is armed the whole time, which is M4's invariant
    // ("강제종료로만 낫는 상태 0건") applied one layer up.
    expect(clock.pending).toBe(1)

    foreground = true
    observer.notifyForeground()
    await settle()
    expect(server.transport.ofKind(HerdrChannelKind.ClientStream)).toHaveLength(2)
    expect(observer.status).toBe('observing')
    observer.close()
  })

  it('paces the retries on L3s ladder and never parks', async () => {
    const clock = new FakeClock()
    // A box that takes the exec channel and then drops it: every attempt fails the same way, which
    // is what makes the delay sequence readable.
    const server = scriptedServer({ dieBeforeWelcome: true })
    const observer = new PaneObserver({
      connection: createTransportConnection(REMOTE, server.transport),
      paneId: 'w1:p1',
      target: recordingTarget([]),
      timer: clock.timer
    })
    await observer.start()
    await settle()
    expect(observer.status).not.toBe('observing')

    for (let i = 0; i < 16; i += 1) {
      clock.advance(120_000)
      await settle()
    }
    // RECONNECT_DELAYS then the 90s trickle — `./transport/reconnect-policy.ts`, unchanged and
    // un-duplicated. The tail is the load-bearing half: a pane that gave up would need the app
    // switcher, which is the state M4 exists to make unreachable.
    expect(clock.armedDelays.slice(0, 8)).toEqual([
      500, 1000, 2000, 4000, 8000, 15_000, 30_000, 60_000
    ])
    expect(clock.armedDelays[clock.armedDelays.length - 1]).toBe(90_000)
    expect(clock.pending).toBe(1)
    observer.close()
    expect(clock.pending).toBe(0)
  })

  it('latches instead of re-attaching when the peer refused the handshake', async () => {
    const clock = new FakeClock()
    // A `Welcome` that chose another encoding: dialling again produces the identical answer, so
    // this is `ConnectionSupervisor`'s fatal latch, not a blip.
    const server = scriptedServer({ welcome: welcomePayloadHex(RenderEncoding.SemanticFrame) })
    const observer = new PaneObserver({
      connection: createTransportConnection(REMOTE, server.transport),
      paneId: 'w1:p1',
      target: recordingTarget([]),
      timer: clock.timer
    })
    await observer.start()
    await settle()
    expect(observer.status).toBe('failed')

    clock.advance(600_000)
    await settle()
    expect(server.transport.ofKind(HerdrChannelKind.ClientStream)).toHaveLength(1)
    expect(observer.reattachCount).toBe(0)
    observer.close()
  })

  it('stops re-attaching once the screen is gone', async () => {
    const clock = new FakeClock()
    const server = scriptedServer()
    const observer = new PaneObserver({
      connection: createTransportConnection(REMOTE, server.transport),
      paneId: 'w1:p1',
      target: recordingTarget([]),
      timer: clock.timer
    })
    await observer.start()
    await settle()

    observer.close()
    await settle()
    clock.advance(600_000)
    await settle()
    // One channel, and no armed timer: an unmounted screen must not keep a remote herdr process
    // alive on a ladder nobody reads.
    expect(server.transport.ofKind(HerdrChannelKind.ClientStream)).toHaveLength(1)
    expect(clock.pending).toBe(0)
  })
})
