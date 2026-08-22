// Not from orca. The receipt for stage 1 of mobile/.prd/08-orca-port-map.md §5: "ANSI 바이트를
// 던지면 화면이 나온다". It drives the real xterm build that ships inside the WebView document with
// real herdr wire bytes and reads the resulting screen.
//
// What this does NOT prove: that the same happens *inside a WebView on a device*. The hop from
// `postMessage` to the in-document `write()` is covered structurally by the ported orca tests and
// is only observable for real on a device build, which is out of scope for this unit.
// @vitest-environment happy-dom
import { decodeTerminal } from '@herdr/client-ts'
import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { createTerminalFrameSink } from './terminal-frame-sink'
import { MOBILE_TERMINAL_CARET_OPTIONS } from './terminal-webview-html'

// packages/herdr-client-ts/test/vectors.ts:59 / :68 — see terminal-frame-sink.test.ts for provenance.
const TERMINAL_SMALL_FULL = '0d01641e010a1b5b324a1b5b313b3148'
const TERMINAL_SMALL_DIFF = '0d02641e00081b5b313b31486869'

function hex(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function screenLine(terminal: Terminal, row: number): string {
  return (terminal.buffer.active.getLine(row)?.translateToString(true) ?? '').trimEnd()
}

async function flush(terminal: Terminal): Promise<void> {
  await new Promise<void>((resolve) => terminal.write('', resolve))
}

describe('herdr Terminal frames -> xterm screen', () => {
  it('renders the bytes of a full frame followed by a diff', async () => {
    let terminal: Terminal | null = null
    const sink = createTerminalFrameSink({
      init: (cols, rows, initialData) => {
        terminal = new Terminal({ ...MOBILE_TERMINAL_CARET_OPTIONS, cols, rows })
        if (initialData) {
          terminal.write(initialData)
        }
      },
      resize: (cols, rows) => terminal?.resize(cols, rows),
      write: (data) => terminal?.write(data)
    })

    sink.accept(decodeTerminal(hex(TERMINAL_SMALL_FULL)))
    sink.accept(decodeTerminal(hex(TERMINAL_SMALL_DIFF)))

    expect(terminal).not.toBeNull()
    const term = terminal as unknown as Terminal
    await flush(term)

    expect(term.cols).toBe(100)
    expect(term.rows).toBe(30)
    expect(screenLine(term, 0)).toBe('hi')
    expect(screenLine(term, 1)).toBe('')
    term.dispose()
  })

  it('renders multi-byte text that arrived split across two frames', async () => {
    const bytes = new TextEncoder().encode('한글')
    let terminal: Terminal | null = null
    const sink = createTerminalFrameSink({
      init: (cols, rows, initialData) => {
        terminal = new Terminal({ ...MOBILE_TERMINAL_CARET_OPTIONS, cols, rows })
        if (initialData) {
          terminal.write(initialData)
        }
      },
      resize: (cols, rows) => terminal?.resize(cols, rows),
      write: (data) => terminal?.write(data)
    })

    sink.accept({ width: 20, height: 3, full: true, bytes: bytes.subarray(0, 4) })
    sink.accept({ width: 20, height: 3, full: false, bytes: bytes.subarray(4) })

    const term = terminal as unknown as Terminal
    await flush(term)
    expect(screenLine(term, 0)).toBe('한글')
    term.dispose()
  })
})
