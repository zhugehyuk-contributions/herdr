// Not from orca. orca's `terminal.subscribe` is one RPC on a client it already has; herdr's read
// path is a second socket with its own handshake, so the thing worth testing is the *sequence*.
//
// The fake transport is the sibling package's (`packages/herdr-client-ts/test/fakeTransport.ts`) and
// the golden bytes are its wire vectors, on purpose: a fake written here could agree with this
// file's idea of the protocol and disagree with the codec's. Both are reachable because the port
// map puts the shared TS in a workspace package Metro already watches (02-architecture.md §2.5).
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
  /** Every `ClientMessage` frame the observer wrote to the client bridge, payload hex. */
  clientMessages: string[]
  /** Every JSON API request line, parsed. */
  apiRequests: { id: string; method: string; params?: Record<string, unknown> }[]
}

/**
 * A `Welcome` payload at the version this client actually speaks.
 *
 * `vectors.ts` ships a current-version twin for the TerminalAnsi arm (`WELCOME_OK_ANSI_V21`) but
 * not for SemanticFrame, and the v20 `WELCOME_OK_SEMANTIC` is no longer usable here: the client
 * rejects it on the version before it ever looks at the encoding, which would quietly turn the
 * encoding-mismatch test below into a second version test.
 *
 * Built from the constants rather than hand-typed. `Welcome`'s bincode field order is
 * (version, encoding, error) — `src/protocol/wire.rs:799`, and the generated
 * `docs/next/protocol/fixtures.json` vector `welcome_ok` — the tag, version and encoding are all
 * varints below 251 and so one byte each, and `error: None` is the bare Option tag `00`. The
 * encoding-mismatch test anchors this against the golden ANSI vector before it uses the semantic
 * one, so these bytes are checked against real bincode rather than trusted.
 */
function welcomePayloadHex(encoding: RenderEncoding): string {
  const varint = (value: number) => value.toString(16).padStart(2, '0')
  return `00${varint(PROTOCOL_VERSION)}${varint(encoding)}00`
}

/**
 * A fake herdr: answers `pane.layout` on the API bridge, and on the client bridge replies to
 * `Hello` with `welcome` and to `ObserveTerminal` with the two golden `Terminal` frames.
 */
function scriptedServer(
  options: { welcome?: string; layoutFor?: (paneId: string) => typeof LAYOUT } = {}
): Recorded {
  const transport = new FakeTransport()
  const clientMessages: string[] = []
  const apiRequests: Recorded['apiRequests'] = []
  transport.onOpen = (channel: FakeChannel) => {
    const write = channel.write.bind(channel)
    // The server reads and validates the client's wire-ABI prelude before any bincode; this gate is
    // that step, and it keeps `clientMessages` a list of *messages* rather than of writes.
    const wireAbi = createWireAbiGate()
    channel.write = (bytes: Uint8Array) => {
      write(bytes)
      if (channel.kind === HerdrChannelKind.ClientStream) {
        const framed = wireAbi(bytes)
        if (framed === null) {
          return
        }
        // Strip the `[u32 LE len]` envelope this codec wrote; the payload's first byte is the tag.
        const payload = framed.subarray(4)
        clientMessages.push(toHex(payload))
        if (payload[0] === 0x00) {
          channel.emit(fromHex(frameHex(options.welcome ?? WELCOME_OK_ANSI_V21)))
        } else if (payload[0] === 0x0c || payload[0] === 0x0e) {
          // 0x0c ObserveTerminal, 0x0e RetargetTerminal (M6/B6). A real server answers both the
          // same way: `render_state.reset_baseline()`, so the next frame is a full repaint.
          channel.emit(fromHex(frameHex(TERMINAL_SMALL_FULL)))
          channel.emit(fromHex(frameHex(TERMINAL_SMALL_DIFF)))
        }
        return
      }
      for (const line of new TextDecoder().decode(bytes).split('\n')) {
        if (line.trim().length === 0) {
          continue
        }
        const request = JSON.parse(line) as Recorded['apiRequests'][number]
        apiRequests.push(request)
        const paneId = (request.params?.['pane_id'] as string | undefined) ?? 'w1:p1'
        channel.emitLine(
          JSON.stringify({
            id: request.id,
            result: { type: 'pane_layout', layout: options.layoutFor?.(paneId) ?? LAYOUT }
          })
        )
      }
    }
  }
  return { transport, clientMessages, apiRequests }
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
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve()
  }
}

describe('pane observer', () => {
  it('runs Hello -> Welcome -> ObserveTerminal and paints the frames that follow', async () => {
    const server = scriptedServer()
    const applied: Applied[] = []
    const observer = new PaneObserver({
      connection: createTransportConnection(REMOTE, server.transport),
      paneId: 'w1:p1',
      target: recordingTarget(applied)
    })
    await observer.start()
    await settle()

    expect(server.apiRequests.map((request) => request.method)).toEqual(['pane.layout'])
    expect(server.apiRequests[0]!.params).toEqual({ pane_id: 'w1:p1' })
    // Hello first, then ObserveTerminal — never the other way round, and never ControlTerminal
    // (tag 0x0d), which is what would resize the desktop pane.
    expect(server.clientMessages.map((hex) => hex.slice(0, 2))).toEqual(['00', '0c'])
    expect(server.clientMessages[1]).toBe('0c0577313a7031')
    expect(observer.status).toBe('observing')
    expect(observer.frameCount).toBe(2)
    // The full frame opened the screen at the frame's own size, carrying its own ANSI as the
    // initial data; the diff was written on top.
    expect(applied[0]!.call).toBe('init')
    expect(applied[0]!.args.slice(0, 2)).toEqual([100, 30])
    expect(toHex(new TextEncoder().encode(applied[0]!.args[2] as string))).toBe('1b5b324a1b5b313b3148')
    expect(applied[1]!.call).toBe('write')
    observer.close()
  })

  it('asks for the pane geometry, not the device geometry', async () => {
    const server = scriptedServer()
    let geometry: { cols: number; rows: number } | null = null
    const observer = new PaneObserver({
      connection: createTransportConnection(REMOTE, server.transport),
      paneId: 'w1:p1',
      target: recordingTarget([]),
      events: {
        onGeometry: (value) => {
          geometry = value
        }
      }
    })
    await observer.start()
    await settle()
    // 80x24 is the floor the *server* renders at with nothing attached; a phone is ~40 columns, so
    // this number cannot have come from a viewport.
    expect(geometry).toEqual({ cols: 80, rows: 24 })
    // And it is on the wire. `Hello`'s varints are, in order (`src/protocol/wire.rs:368-387`):
    // tag 00, version (0x15=21 today), cols 0x50=80, rows 0x18=24, cell_width_px 00,
    // cell_height_px 00, requested_encoding 01=TerminalAnsi, surface_mode 00=FullApp,
    // keybindings 00=Server, launch_mode 01=TerminalAttach.
    //
    // The version is spliced from `PROTOCOL_VERSION` so the next bump moves it with the client:
    // the field under test here is the GEOMETRY (0x50/0x18 = the pane's 80x24, not the device's),
    // and a literal version would keep re-breaking a geometry assertion for protocol reasons.
    const versionVarint = PROTOCOL_VERSION.toString(16).padStart(2, '0')
    expect(server.clientMessages[0]).toBe(`00${versionVarint}5018000001000001`)
    observer.close()
  })

  it('hard-fails instead of painting when the server picked another encoding', async () => {
    // Anchor first: the same builder, on the arm that DOES have a generated twin, must reproduce
    // it byte for byte. That is what makes the semantic payload below real bincode.
    expect(welcomePayloadHex(RenderEncoding.TerminalAnsi)).toBe(WELCOME_OK_ANSI_V21)
    const server = scriptedServer({ welcome: welcomePayloadHex(RenderEncoding.SemanticFrame) })
    const applied: Applied[] = []
    const errors: string[] = []
    const observer = new PaneObserver({
      connection: createTransportConnection(REMOTE, server.transport),
      paneId: 'w1:p1',
      target: recordingTarget(applied),
      events: { onError: (error) => errors.push(error.message) }
    })
    await observer.start()
    await settle()
    // `Welcome.encoding` is what the server *chose*; ignoring it would feed semantic frames to an
    // ANSI renderer (02-architecture.md §2.2).
    expect(observer.status).toBe('failed')
    expect(errors.join(' ')).toMatch(/encoding/i)
    expect(server.clientMessages.map((hex) => hex.slice(0, 2))).toEqual(['00'])
    expect(applied).toEqual([])
    expect(RenderEncoding.TerminalAnsi).not.toBe(RenderEncoding.SemanticFrame)
    observer.close()
  })

  it('opens one resident client channel and one API channel per request', async () => {
    const server = scriptedServer()
    const observer = new PaneObserver({
      connection: createTransportConnection(REMOTE, server.transport),
      paneId: 'w1:p1',
      target: recordingTarget([])
    })
    await observer.start()
    await settle()
    expect(server.transport.ofKind(HerdrChannelKind.ClientStream)).toHaveLength(1)
    expect(server.transport.ofKind(HerdrChannelKind.ApiRequest)).toHaveLength(1)
    observer.close()
    expect(server.transport.ofKind(HerdrChannelKind.ClientStream)[0]!.closed).toBe(true)
  })

  it('retargets on the SAME channel: no new stream, no second Hello (M6/B6)', async () => {
    const server = scriptedServer()
    const applied: Applied[] = []
    const observer = new PaneObserver({
      connection: createTransportConnection(REMOTE, server.transport),
      paneId: 'w1:p1',
      target: recordingTarget(applied)
    })
    await observer.start()
    await settle()
    const framesBefore = observer.frameCount

    await observer.retarget('w1:p2')
    await settle()

    // One handshake, one observe, one retarget — in that order, on one channel.
    expect(server.clientMessages.map((hex) => hex.slice(0, 2))).toEqual(['00', '0c', '0e'])
    // `0e` <len 05> "w1:p2" <mode 00 = Observe>. Observe is a UNIT variant, so the frame ends
    // there; a trailing `00` would encode `Control{takeover:false}` and resize the desktop's pane.
    expect(server.clientMessages[2]).toBe('0e0577313a703200')
    expect(server.transport.ofKind(HerdrChannelKind.ClientStream)).toHaveLength(1)
    expect(server.transport.ofKind(HerdrChannelKind.ClientStream)[0]!.closed).toBe(false)
    expect(observer.paneId).toBe('w1:p2')
    expect(observer.retargetCount).toBe(1)
    // The new target's frames landed, and the buffer was rebuilt rather than written over: the
    // sink is reset on retarget, so the first frame of the new stream is an `init`, not a `write`.
    expect(observer.frameCount).toBeGreaterThan(framesBefore)
    const afterRetarget = applied.slice(applied.findIndex((entry) => entry.call === 'write') + 1)
    expect(afterRetarget[0]!.call).toBe('init')
  })

  it('re-declares its grid when the new pane is wider, and only then', async () => {
    const wide = {
      ...LAYOUT,
      focused_pane_id: 'w1:p2',
      panes: [{ pane_id: 'w1:p2', focused: true, rect: { x: 0, y: 0, width: 300, height: 50 } }]
    }
    const server = scriptedServer({ layoutFor: (paneId) => (paneId === 'w1:p2' ? wide : LAYOUT) })
    const observer = new PaneObserver({
      connection: createTransportConnection(REMOTE, server.transport),
      paneId: 'w1:p1',
      target: recordingTarget([])
    })
    await observer.start()
    await settle()

    await observer.retarget('w1:p2')
    await settle()
    // Resize (0x03) BEFORE the retarget (0x0e): an observing client's frames are rendered into the
    // rect it declared, and a pane wider than that rect is cropped at the top-left, not reflowed
    // (B4). Declaring after the move would show one cropped frame first.
    expect(server.clientMessages.map((hex) => hex.slice(0, 2))).toEqual(['00', '0c', '03', '0e'])
    // tag 03, then cols/rows/cell_width_px/cell_height_px as varints. 300 crosses bincode's
    // one-byte ceiling (250) so it is `fb 2c 01` — the same encoding the independently generated
    // golden `HELLO_ANSI_ATTACH_300X100` carries for its 300 — while 50 stays a bare `32`.
    expect(server.clientMessages[2]).toBe('03fb2c01320000')

    // Back to the original pane: same width again, so no second Resize.
    await observer.retarget('w1:p1')
    await settle()
    expect(server.clientMessages.map((hex) => hex.slice(0, 2))).toEqual([
      '00',
      '0c',
      '03',
      '0e',
      '03',
      '0e'
    ])

    // A retarget to the pane already being observed is a no-op, not another round trip.
    const before = server.clientMessages.length
    await observer.retarget('w1:p1')
    await settle()
    expect(server.clientMessages).toHaveLength(before)
    observer.close()
  })

  it('reuses the layout snapshot it already has instead of asking again', async () => {
    // Both panes in ONE snapshot, which is what a real `pane.layout` returns: `area` plus a rect
    // per pane of that workspace.
    const both = {
      ...LAYOUT,
      panes: [
        { pane_id: 'w1:p1', focused: true, rect: { x: 0, y: 0, width: 27, height: 23 } },
        { pane_id: 'w1:p2', focused: false, rect: { x: 27, y: 0, width: 27, height: 23 } }
      ]
    }
    const server = scriptedServer({ layoutFor: () => both })
    const observer = new PaneObserver({
      connection: createTransportConnection(REMOTE, server.transport),
      paneId: 'w1:p1',
      target: recordingTarget([])
    })
    await observer.start()
    await settle()
    expect(server.apiRequests.map((request) => request.method)).toEqual(['pane.layout'])

    await observer.retarget('w1:p2')
    await settle()

    // No second `pane.layout`. On the ssh bridge that call is an exec channel and a remote herdr
    // process (B8), and it was the dominant term in the measured swipe latency.
    expect(server.apiRequests.map((request) => request.method)).toEqual(['pane.layout'])
    // …and no Resize either: `resolveObserverGeometry` maxes with the workspace `area`, which both
    // panes share, so the declared grid is unchanged.
    expect(server.clientMessages.map((hex) => hex.slice(0, 2))).toEqual(['00', '0c', '0e'])
    observer.close()
  })

  it('closes the stream even when close() beats the handshake', async () => {
    const server = scriptedServer()
    const observer = new PaneObserver({
      connection: createTransportConnection(REMOTE, server.transport),
      paneId: 'w1:p1',
      target: recordingTarget([])
    })
    const started = observer.start()
    observer.close()
    await started
    await settle()
    const streams = server.transport.ofKind(HerdrChannelKind.ClientStream)
    expect(streams.every((channel) => channel.closed)).toBe(true)
    expect(observer.frameCount).toBe(0)
  })
})
