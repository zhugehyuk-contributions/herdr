// Not from orca — this covers mobile/src/terminal/terminal-frame-sink.ts, which orca has no
// equivalent of (its terminal stream is an application protocol, herdr's is raw ANSI bytes).
import { decodeTerminal } from '@herdr/client-ts'
import { createElement, createRef } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalWebViewHandle } from './terminal-webview-contract'
import {
  createAnsiTextDecoder,
  createTerminalFrameSink,
  splitTrailingPartialUtf8,
  type TerminalFrameSinkTarget
} from './terminal-frame-sink'

const ESC = String.fromCharCode(0x1b)

const nativeWebViewMethods = vi.hoisted(() => ({
  postMessage: vi.fn<(message: string) => void>(),
  reload: vi.fn<() => void>()
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active' },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StyleSheet: {
    absoluteFillObject: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
    create: (styles: unknown) => styles
  },
  Text: 'Text',
  View: 'View'
}))

vi.mock('react-native-webview', async () => {
  const React = await import('react')
  const WebView = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => nativeWebViewMethods)
    return React.createElement('WebView', props)
  })
  return { WebView, default: WebView }
})

vi.mock('lucide-react-native', () => ({ RefreshCw: 'RefreshCw' }))

/**
 * Real bincode payloads, copied from packages/herdr-client-ts/test/vectors.ts:59 and :68 (which
 * documents their provenance: produced by the checked-in Rust generator `tools/gen-vectors.rs`,
 * not hand-typed). 100x30; a `full` frame carrying `ESC[2J ESC[1;1H`, then a diff carrying
 * `ESC[1;1H` + "hi".
 */
const TERMINAL_SMALL_FULL = '0d01641e010a1b5b324a1b5b313b3148'
const TERMINAL_SMALL_DIFF = '0d02641e00081b5b313b31486869'

function hex(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function recordingTarget() {
  const calls: string[] = []
  const target: TerminalFrameSinkTarget = {
    init: (cols, rows, initialData) =>
      calls.push(`init ${cols}x${rows} ${JSON.stringify(initialData)}`),
    resize: (cols, rows) => calls.push(`resize ${cols}x${rows}`),
    write: (data) => calls.push(`write ${JSON.stringify(data)}`)
  }
  return { calls, target }
}

describe('splitTrailingPartialUtf8', () => {
  it('keeps a complete run whole', () => {
    const bytes = new TextEncoder().encode('hi 한')
    const { complete, partial } = splitTrailingPartialUtf8(bytes)
    expect(complete.length).toBe(bytes.length)
    expect(partial.length).toBe(0)
  })

  it('holds back a truncated multi-byte sequence', () => {
    const full = new TextEncoder().encode('한')
    const { complete, partial } = splitTrailingPartialUtf8(full.subarray(0, 2))
    expect(complete.length).toBe(0)
    expect([...partial]).toEqual([...full.subarray(0, 2)])
  })

  it('splits at the boundary between a complete char and a truncated one', () => {
    const bytes = new TextEncoder().encode('a한')
    const { complete, partial } = splitTrailingPartialUtf8(bytes.subarray(0, 3))
    expect([...complete]).toEqual([0x61])
    expect(partial.length).toBe(2)
  })
})

describe('createAnsiTextDecoder', () => {
  it('rejoins a codepoint split across two frames', () => {
    const bytes = new TextEncoder().encode('한글')
    const decoder = createAnsiTextDecoder()
    expect(decoder.push(bytes.subarray(0, 4))).toBe('한')
    expect(decoder.push(bytes.subarray(4))).toBe('글')
  })

  it('drops the carry on reset so a reconnect does not resume mid-codepoint', () => {
    const bytes = new TextEncoder().encode('한')
    const decoder = createAnsiTextDecoder()
    expect(decoder.push(bytes.subarray(0, 2))).toBe('')
    decoder.reset()
    expect(decoder.push(new TextEncoder().encode('x'))).toBe('x')
  })
})

describe('createTerminalFrameSink', () => {
  it('opens on the first full frame and writes the diffs after it', () => {
    const { calls, target } = recordingTarget()
    const sink = createTerminalFrameSink(target)
    sink.accept(decodeTerminal(hex(TERMINAL_SMALL_FULL)))
    sink.accept(decodeTerminal(hex(TERMINAL_SMALL_DIFF)))
    expect(calls).toEqual([
      `init 100x30 ${JSON.stringify(`${ESC}[2J${ESC}[1;1H`)}`,
      `write ${JSON.stringify(`${ESC}[1;1Hhi`)}`
    ])
  })

  it('refuses a diff with no baseline instead of rendering a wrong screen', () => {
    const { calls, target } = recordingTarget()
    const onNeedsFullFrame = vi.fn()
    const sink = createTerminalFrameSink(target, { onNeedsFullFrame })
    sink.accept(decodeTerminal(hex(TERMINAL_SMALL_DIFF)))
    expect(calls).toEqual([])
    expect(onNeedsFullFrame).toHaveBeenCalledTimes(1)
  })

  it('resizes before writing a frame that changed the grid size', () => {
    const { calls, target } = recordingTarget()
    const sink = createTerminalFrameSink(target)
    sink.accept(decodeTerminal(hex(TERMINAL_SMALL_FULL)))
    sink.accept({ width: 80, height: 24, full: true, bytes: new TextEncoder().encode('x') })
    expect(calls).toEqual([
      `init 100x30 ${JSON.stringify(`${ESC}[2J${ESC}[1;1H`)}`,
      'resize 80x24',
      'write "x"'
    ])
  })

  it('needs a full frame again after reset', () => {
    const { calls, target } = recordingTarget()
    const onNeedsFullFrame = vi.fn()
    const sink = createTerminalFrameSink(target, { onNeedsFullFrame })
    sink.accept(decodeTerminal(hex(TERMINAL_SMALL_FULL)))
    sink.reset()
    sink.accept(decodeTerminal(hex(TERMINAL_SMALL_DIFF)))
    expect(onNeedsFullFrame).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([`init 100x30 ${JSON.stringify(`${ESC}[2J${ESC}[1;1H`)}`])
  })
})

describe('sink -> TerminalWebView bridge', () => {
  it('turns herdr wire frames into the WebView init/write commands', async () => {
    const { TerminalWebView } = await import('./TerminalWebView')
    const ref = createRef<TerminalWebViewHandle>()
    let renderer: ReturnType<typeof create> | null = null
    act(() => {
      renderer = create(createElement(TerminalWebView, { ref, onEngineError: vi.fn() }))
    })
    const tree = renderer as unknown as ReturnType<typeof create>
    const webView = tree.root.findByType('WebView' as never)
    act(() => {
      webView.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'web-ready' }) } })
    })
    nativeWebViewMethods.postMessage.mockClear()

    const handle = ref.current
    expect(handle).not.toBeNull()
    const sink = createTerminalFrameSink({
      init: (cols, rows, initialData) => handle!.init(cols, rows, initialData),
      resize: (cols, rows) => handle!.resize(cols, rows),
      write: (data) => handle!.write(data)
    })
    act(() => {
      sink.accept(decodeTerminal(hex(TERMINAL_SMALL_FULL)))
      sink.accept(decodeTerminal(hex(TERMINAL_SMALL_DIFF)))
    })
    // The write coalescer batches on a timer; let it flush.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    const posted = nativeWebViewMethods.postMessage.mock.calls.map(
      ([message]) => JSON.parse(message) as Record<string, unknown>
    )
    expect(posted.find((command) => command.type === 'init')).toMatchObject({
      cols: 100,
      rows: 30,
      initialData: `${ESC}[2J${ESC}[1;1H`
    })
    const written = posted
      .filter((command) => command.type === 'write')
      .map((command) => command.data)
      .join('')
    expect(written).toBe(`${ESC}[1;1Hhi`)
    act(() => {
      tree.unmount()
    })
  })
})
