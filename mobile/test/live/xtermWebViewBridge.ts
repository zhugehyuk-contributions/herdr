// Not from orca. Test-only: it stands in for the one hop this repo cannot execute off a device —
// `WebView.postMessage` crossing into the WKWebView/Android WebView document.
//
// It is a *faithful* stand-in rather than a convenient one. The document's own dispatcher is
// `handleMsg` in `src/terminal/terminal-webview-html.ts:929-975`, and for the three commands a
// read-only viewer produces it does exactly this:
//
//   `init`   -> `init(msg.cols, msg.rows, msg.initialData, …)`   (`:937`)
//   `resize` -> `resize(msg.cols, msg.rows)`                      (`:948`)
//   `write`  -> `write(msg.data)`                                 (`:951`)
//
// and the terminal it drives is a real `@xterm/xterm` built with the same caret options and the
// same `scrollback: 5000` the document uses (`:736-748`). So what this replaces is the IPC, not the
// renderer: the bytes below are applied by the same library, in the same order, at the same size.
//
// What it therefore does NOT cover, and must not be read as covering: the native bridge itself
// (serialization, `handledMessageIds` de-duplication, the `web-ready` handshake's real timing), the
// injected gesture/selection scripts, WebGL, and every paint. Those are device-only.
import { Terminal } from '@xterm/xterm'
import { MOBILE_TERMINAL_CARET_OPTIONS } from '../../src/terminal/terminal-webview-html'
import type { TerminalWebViewCommand } from '../../src/terminal/terminal-webview-messages'

export type XtermWebViewBridge = {
  /** The live terminal, once an `init` command has created one. */
  terminal: Terminal | null
  /** Every command the RN side posted, in order. */
  commands: TerminalWebViewCommand[]
  /** `write` commands only — how much ANSI actually crossed the bridge. */
  writes: number
  handle: (raw: string) => void
  /** Waits for xterm's parser to drain, then returns the screen as trimmed lines. */
  screen: () => Promise<string[]>
  reset: () => void
  dispose: () => void
}

export function createXtermWebViewBridge(): XtermWebViewBridge {
  const bridge: XtermWebViewBridge = {
    terminal: null,
    commands: [],
    writes: 0,
    handle: (raw: string) => {
      const message = JSON.parse(raw) as TerminalWebViewCommand
      bridge.commands.push(message)
      if (message.type === 'init') {
        bridge.terminal?.dispose()
        bridge.terminal = new Terminal({
          ...MOBILE_TERMINAL_CARET_OPTIONS,
          scrollback: 5000,
          cols: message.cols,
          rows: message.rows
        })
        if (message.initialData) {
          bridge.terminal.write(message.initialData)
        }
        return
      }
      if (message.type === 'resize') {
        bridge.terminal?.resize(message.cols, message.rows)
        return
      }
      if (message.type === 'write') {
        bridge.writes += 1
        bridge.terminal?.write(message.data)
      }
    },
    screen: async () => {
      const terminal = bridge.terminal
      if (terminal === null) {
        return []
      }
      await new Promise<void>((resolve) => terminal.write('', resolve))
      const lines: string[] = []
      for (let row = 0; row < terminal.rows; row += 1) {
        lines.push((terminal.buffer.active.getLine(row)?.translateToString(true) ?? '').trimEnd())
      }
      return lines
    },
    reset: () => {
      bridge.commands = []
      bridge.writes = 0
    },
    dispose: () => {
      bridge.terminal?.dispose()
      bridge.terminal = null
    }
  }
  return bridge
}
