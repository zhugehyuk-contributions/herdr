// Not from orca. orca's `terminal.subscribe` is one RPC on a client it already has; herdr's read
// path is a second socket with its own handshake, so the thing worth testing is the *sequence*.
//
// The fake transport is the sibling package's (`packages/herdr-client-ts/test/fakeTransport.ts`) and
// the golden bytes are its wire vectors, on purpose: a fake written here could agree with this
// file's idea of the protocol and disagree with the codec's. Both are reachable because the port
// map puts the shared TS in a workspace package Metro already watches (02-architecture.md §2.5).
import { describe, expect, it } from 'vitest'
import { HerdrChannelKind, RenderEncoding } from '@herdr/client-ts'
import {
  FakeTransport,
  type FakeChannel
} from '../../../packages/herdr-client-ts/test/fakeTransport'
import { frameHex, fromHex, toHex } from '../../../packages/herdr-client-ts/test/helpers'
import {
  TERMINAL_SMALL_DIFF,
  TERMINAL_SMALL_FULL,
  WELCOME_OK_ANSI,
  WELCOME_OK_SEMANTIC
} from '../../../packages/herdr-client-ts/test/vectors'
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
 * A fake herdr: answers `pane.layout` on the API bridge, and on the client bridge replies to
 * `Hello` with `welcome` and to `ObserveTerminal` with the two golden `Terminal` frames.
 */
function scriptedServer(options: { welcome?: string } = {}): Recorded {
  const transport = new FakeTransport()
  const clientMessages: string[] = []
  const apiRequests: Recorded['apiRequests'] = []
  transport.onOpen = (channel: FakeChannel) => {
    const write = channel.write.bind(channel)
    channel.write = (bytes: Uint8Array) => {
      write(bytes)
      if (channel.kind === HerdrChannelKind.ClientStream) {
        // Strip the `[u32 LE len]` envelope this codec wrote; the payload's first byte is the tag.
        const payload = bytes.subarray(4)
        clientMessages.push(toHex(payload))
        if (payload[0] === 0x00) {
          channel.emit(fromHex(frameHex(options.welcome ?? WELCOME_OK_ANSI)))
        } else if (payload[0] === 0x0c) {
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
        channel.emitLine(
          JSON.stringify({ id: request.id, result: { type: 'pane_layout', layout: LAYOUT } })
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
    // tag 00, version 0x14=20, cols 0x50=80, rows 0x18=24, cell_width_px 00, cell_height_px 00,
    // requested_encoding 01=TerminalAnsi, surface_mode 00=FullApp, keybindings 00=Server,
    // launch_mode 01=TerminalAttach.
    expect(server.clientMessages[0]).toBe('00145018000001000001')
    observer.close()
  })

  it('hard-fails instead of painting when the server picked another encoding', async () => {
    const server = scriptedServer({ welcome: WELCOME_OK_SEMANTIC })
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
