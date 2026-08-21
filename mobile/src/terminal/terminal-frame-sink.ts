// Not from orca. This file is the seam orca does not have: orca's terminal stream is an
// application-level protocol (`TerminalStreamOpcode`, snapshots, `decodeTerminalStreamText`,
// `mobile/src/transport/rpc-client-terminal-binary-frame.ts`), and the port map grades that file
// `rewrite` because herdr's read path is `ServerMessage::Terminal` carrying raw ANSI bytes
// (mobile/.prd/08-orca-port-map.md §2.3, §2.4). Everything downstream of here is orca's, unchanged.
//
// Scope: turn a decoded herdr `Terminal` frame into the `TerminalWebViewHandle` calls that make it
// appear. Nothing about transport, subscription or reconnection lives here.

import { utf8Decode } from '@herdr/client-ts'

/** The part of `TerminalMessage` (`packages/herdr-client-ts/src/messages.ts`) that rendering needs. */
export type TerminalFrame = {
  width: number
  height: number
  /** True when `bytes` repaints every cell rather than diffing against the previous frame. */
  full: boolean
  bytes: Uint8Array
}

/**
 * The slice of `TerminalWebViewHandle` (orca `src/terminal/terminal-webview-contract.ts`) this
 * sink drives. Narrowed on purpose so the sink is testable without a WebView.
 */
export type TerminalFrameSinkTarget = {
  init: (cols: number, rows: number, initialData?: string) => void
  resize: (cols: number, rows: number) => void
  write: (data: string) => void
}

export type TerminalFrameSinkOptions = {
  /**
   * Called instead of writing when a diff frame arrives with no baseline to diff against.
   * `src/protocol/render_ansi.rs:88-91` only emits `full` on the first frame after a baseline
   * reset, on a repaint request, or on a size change; every other frame is meaningful *only*
   * against the frame before it. Applying one without its baseline does not produce a slightly
   * stale screen, it produces a wrong one, so the sink refuses and the caller is expected to send
   * `ClientMessage::RequestFullFrame`.
   */
  onNeedsFullFrame?: () => void
}

export type TerminalFrameSink = {
  accept: (frame: TerminalFrame) => void
  /** Forget the baseline — after a reconnect, before any frame of the new stream is applied. */
  reset: () => void
}

/**
 * Splits a UTF-8 byte run at the last codepoint boundary, returning the complete prefix and the
 * trailing bytes of a sequence that has not arrived yet.
 *
 * herdr chunks its ANSI stream by frame, not by codepoint, so a multi-byte character can straddle
 * two `Terminal` frames. (orca decodes each chunk with a fresh `new TextDecoder().decode(...)`,
 * `mobile/src/transport/terminal-stream-protocol.ts:67-69`, which silently turns such a split into
 * two U+FFFD.) Only the truncation case is handled here; genuinely malformed UTF-8 is left to
 * `utf8Decode`, which throws, per that package's stated posture.
 */
export function splitTrailingPartialUtf8(bytes: Uint8Array): {
  complete: Uint8Array
  partial: Uint8Array
} {
  // A UTF-8 sequence is at most 4 bytes, so at most the last 3 can be an incomplete tail.
  for (let back = 1; back <= 3 && back <= bytes.length; back += 1) {
    const lead = bytes[bytes.length - back] as number
    if ((lead & 0xc0) === 0x80) {
      // A continuation byte: keep walking back for the lead byte.
      continue
    }
    const needed =
      (lead & 0x80) === 0 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 0
    if (needed === 0 || needed <= back) {
      // Either not a lead byte at all (leave it to utf8Decode to reject) or the sequence is
      // complete inside this run.
      return { complete: bytes, partial: bytes.subarray(bytes.length, bytes.length) }
    }
    const cut = bytes.length - back
    return { complete: bytes.subarray(0, cut), partial: bytes.subarray(cut) }
  }
  return { complete: bytes, partial: bytes.subarray(bytes.length, bytes.length) }
}

function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (head.length === 0) {
    return tail
  }
  const out = new Uint8Array(head.length + tail.length)
  out.set(head, 0)
  out.set(tail, head.length)
  return out
}

/** A stateful UTF-8 decoder that carries an unfinished sequence across `push` calls. */
export function createAnsiTextDecoder(): { push: (bytes: Uint8Array) => string; reset: () => void } {
  let carry = new Uint8Array(0)
  return {
    push(bytes) {
      const { complete, partial } = splitTrailingPartialUtf8(concat(carry, bytes))
      carry = partial.length === 0 ? new Uint8Array(0) : Uint8Array.from(partial)
      return complete.length === 0 ? '' : utf8Decode(complete)
    },
    reset() {
      carry = new Uint8Array(0)
    }
  }
}

export function createTerminalFrameSink(
  target: TerminalFrameSinkTarget,
  options: TerminalFrameSinkOptions = {}
): TerminalFrameSink {
  const decoder = createAnsiTextDecoder()
  let opened = false
  let cols = 0
  let rows = 0

  return {
    accept(frame) {
      if (!opened) {
        if (!frame.full) {
          options.onNeedsFullFrame?.()
          return
        }
        opened = true
        cols = frame.width
        rows = frame.height
        target.init(frame.width, frame.height, decoder.push(frame.bytes))
        return
      }
      // Why size first: a `full` frame that is full *because* the grid changed size
      // (`src/protocol/render_ansi.rs:88-91`) addresses cells outside the current xterm buffer, so
      // the buffer has to be the new size before its bytes are written.
      if (frame.width !== cols || frame.height !== rows) {
        cols = frame.width
        rows = frame.height
        target.resize(frame.width, frame.height)
      }
      target.write(decoder.push(frame.bytes))
    },
    reset() {
      decoder.reset()
      opened = false
      cols = 0
      rows = 0
    }
  }
}
