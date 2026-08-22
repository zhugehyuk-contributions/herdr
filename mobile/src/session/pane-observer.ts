// Not from orca. orca's equivalent is `terminal.subscribe` on its RPC client plus the 293-line
// resubscribe/fit loop that the port map drops whole (§6 위험 3); herdr's read path is a *second
// socket* — `remote-client-bridge` carrying the framed client protocol — so the sequence is a
// handshake, not a subscription. This file is that sequence, and nothing else:
//
//   Hello{cols,rows,TerminalAnsi,TerminalAttach} -> Welcome (checked) -> ObserveTerminal{paneId}
//     -> ServerMessage::Terminal … -> TerminalFrameSink -> TerminalWebViewHandle
//
// (02-architecture.md §2.2, verified end to end by `packages/herdr-client-ts/test/live-ssh/`.)
//
// Deliberately framework-free: no React, no `react-native`, so the whole sequence is testable
// against a fake transport and against a real server without mounting anything.
//
// ## Why there is still no scrollback here (blocker B5, judged at M6 and deferred)
//
// M6's plan was "widen `handle_terminal_attach_scroll` to `TerminalObserve`". Two code-level
// findings say that is the wrong change, and the second one also kills the fallback the plan
// named:
//
//  1. `AttachScroll` reaches `apply_terminal_attach_scroll` -> `TerminalRuntime::scroll_up/down`
//     (`src/terminal/runtime.rs`) -> `GhosttyPaneTerminal` -> the ghostty terminal's own viewport
//     offset. That offset lives on the **shared runtime**, and every client's frame is
//     `render_terminal_virtual(runtime, area)` off that same object
//     (`src/server/headless.rs`, the TerminalAttach/TerminalObserve arm of `render_and_stream`).
//     A phone scrolling would move the desktop's view. Fixing that means a per-client viewport
//     offset, which is the same server change B4 asks for — not a match widening.
//  2. The plan's v1 fallback ("let xterm's own 5000-line scrollback do it") does not work on this
//     render path either. `BlitEncoder` paints the visible grid with absolute cursor addressing
//     (`ESC[row;colH` per run, `src/protocol/render_ansi.rs`); it never emits a line feed or a
//     scroll region, so nothing is ever pushed into xterm's scrollback. The buffer is configured
//     (`mobile/src/terminal/terminal-webview-html.ts`, `scrollback: 5000`) and stays empty.
//
// So scrollback is *one* piece of work — a per-client viewport in the server — and M6 ships the
// retarget without it. What M6 does deliver on the reading axis is that a retarget re-declares the
// geometry for the pane it moved to, so the viewer is never cropped to the previous pane's width.
//
// Read-only by construction — M2 sends no `pane.send_input` and never asks for
// `ControlTerminal`. `TerminalObserve` is the mode in which the server *silently drops* input
// (`src/server/headless.rs:2882-2886`) and, more importantly, the mode in which it neither resizes
// the pane nor takes its lock (`:1763-1786`, against `control_terminal_client` at `:1789`). That is
// milestone M2 (c), "30분 시청 동안 데스크톱 레이아웃 무변화", and it is a property of *which
// message this file sends*, not of the UI above it.
import {
  ClientLaunchMode,
  OBSERVE_MODE,
  RenderEncoding,
  assertWelcomeAccepted,
  encodeHelloFrame,
  encodeObserveTerminalFrame,
  encodeRequestFullFrameFrame,
  encodeResizeFrame,
  encodeRetargetTerminalFrame,
  type HerdrChannelClose,
  type ServerMessage,
  type ServerMessageChannel,
  type TerminalMessage,
  type WelcomeMessage
} from '@herdr/client-ts'
import {
  createTerminalFrameSink,
  type TerminalFrameSinkTarget
} from '../terminal/terminal-frame-sink'
import {
  paneLayoutFromResult,
  resolveObserverGeometry,
  type ObserverGeometry,
  type PaneLayoutSnapshot
} from './observer-geometry'
import type { HerdrRemoteConnection } from '../transport/herdr-connection'

export type PaneObserverStatus = 'idle' | 'connecting' | 'observing' | 'closed' | 'failed'

export type PaneObserverEvents = {
  onStatus?: (status: PaneObserverStatus) => void
  onGeometry?: (geometry: ObserverGeometry) => void
  onWelcome?: (welcome: WelcomeMessage) => void
  onFrame?: (frame: TerminalMessage) => void
  onError?: (error: Error) => void
  onClose?: (close: HerdrChannelClose) => void
}

export type PaneObserverOptions = {
  connection: HerdrRemoteConnection
  paneId: string
  /** Renders the frames. In the app this is the `TerminalWebView` handle; in tests, an xterm. */
  target: TerminalFrameSinkTarget
  /** `PaneInfo.scroll.viewport_rows` from the snapshot, when the screen has one. */
  viewportRows?: number | null
  events?: PaneObserverEvents
  /**
   * How long the first `Terminal` may take before the wire-layout probe is allowed to reach a
   * verdict on the frames it has. Opt-in in the codec because a codec should not own a clock
   * (`packages/herdr-client-ts/src/transport.ts`, `firstTerminalTimeoutMs`); an app that renders a
   * terminal *should* set it, and 20s is the value picked here — long enough for a cold server's
   * first virtual render, short enough that a fork-skewed peer names itself instead of showing a
   * black screen forever.
   */
  firstTerminalTimeoutMs?: number
}

export const DEFAULT_FIRST_TERMINAL_TIMEOUT_MS = 20_000

/**
 * One pane, observed. Construct, `start()`, then `retarget(otherPaneId)` for every chip tap and
 * `close()` at the end.
 *
 * `retarget` is milestone M6 and it is the whole reason `ClientMessage::RetargetTerminal` exists
 * (blocker B6). Before it, the observe target was fixed at `ObserveTerminal` time, so switching
 * panes meant closing this channel and opening another: on the ssh bridge a new exec channel, a new
 * `Hello`/`Welcome`, and a fresh ~56 KB uncompressed ANSI baseline (B13) per tap. Measured
 * retarget-to-first-frame against a real server on a unix socket: **21 ms**
 * (`tests/observe_terminal_ansi.rs`).
 */
export class PaneObserver {
  private readonly options: PaneObserverOptions
  private readonly sink: ReturnType<typeof createTerminalFrameSink>
  private channel: ServerMessageChannel | null = null
  private state: PaneObserverStatus = 'idle'
  private disposed = false
  private observing = false
  private frames = 0
  /** The pane currently being observed. Moves with `retarget`; `options.paneId` is only the seed. */
  private target: string
  /** The grid this connection last declared, so a retarget only resizes when it has to. */
  private geometry: ObserverGeometry | null = null
  /** The last `pane.layout` snapshot. Covers every pane of that workspace, not just the one asked for. */
  private layout: PaneLayoutSnapshot | null = null
  private retargets = 0

  constructor(options: PaneObserverOptions) {
    this.options = options
    this.target = options.paneId
    this.sink = createTerminalFrameSink(options.target, {
      // The sink refuses a diff it has no baseline for; the cure is the server's, and this class
      // holds the write end. `ServerMessageChannel` sends the same message for *decode* losses —
      // this covers the other cause, a stream whose first frame was a diff (a repaint that raced
      // the handshake), which the channel cannot see because that frame decoded fine.
      onNeedsFullFrame: () => this.requestFullFrame()
    })
  }

  get status(): PaneObserverStatus {
    return this.state
  }

  /** How many `Terminal` frames were applied to the target. Zero is a diagnosis, not an absence. */
  get frameCount(): number {
    return this.frames
  }

  /** The observed target, for a caller that wants to assert it changed. */
  get paneId(): string {
    return this.target
  }

  /** How many times this observer moved target without reconnecting. */
  get retargetCount(): number {
    return this.retargets
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') {
      return
    }
    this.setStatus('connecting')
    try {
      const geometry = await this.resolveGeometry(this.target)
      if (this.disposed) {
        return
      }
      this.geometry = geometry
      this.options.events?.onGeometry?.(geometry)
      const channel = await this.options.connection.openTerminalStream(
        {
          onMessage: (message) => this.onMessage(message),
          onError: (error) => this.fail(error),
          onClose: (close) => {
            if (this.state !== 'failed') {
              this.setStatus('closed')
            }
            this.options.events?.onClose?.(close)
          }
        },
        {
          firstTerminalTimeoutMs:
            this.options.firstTerminalTimeoutMs ?? DEFAULT_FIRST_TERMINAL_TIMEOUT_MS
        }
      )
      if (this.disposed) {
        channel.close()
        return
      }
      this.channel = channel
      await channel.send(
        encodeHelloFrame({
          cols: geometry.cols,
          rows: geometry.rows,
          requestedEncoding: RenderEncoding.TerminalAnsi,
          // `TerminalAttach` is the launch mode; the *connection mode* the server puts this client
          // in is decided by `ObserveTerminal` below, and that is the one that decides whether the
          // pane gets resized (02-architecture.md §2.2, §2.3).
          launchMode: ClientLaunchMode.TerminalAttach
        })
      )
    } catch (error: unknown) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Points this **open** stream at another pane — M6's swipe, and the reason `RetargetTerminal`
   * was added to the wire (B6).
   *
   * Three messages, in this order, and the order is the design:
   *
   *  1. `pane.layout` for the new pane, because geometry does not travel with the target. An
   *     observing client's frame is rendered into the rect it declared in `Hello`, and a pane wider
   *     than that rect is **cropped at the top-left**, not reflowed (B4). Moving to a wider pane
   *     without re-declaring would silently drop its right-hand columns.
   *  2. `Resize`, but only when the grid actually changed. Safe here and *only* here: the
   *     `TerminalObserve` arm of the server's resize handler updates the render rect and repaints,
   *     while the `TerminalAttach` arm one branch above resizes the pane's PTY. This class never
   *     holds control, so it always takes the first arm.
   *  3. `RetargetTerminal{target, Observe}`.
   *
   * The sink is reset before any of it: the server resets this client's render baseline on a
   * retarget (`retarget_terminal_client` -> `render_state.reset_baseline`), so the next frame is a
   * full repaint, and a reset sink turns that frame into a fresh `init` at the new geometry instead
   * of writing another pane's cells over this one's buffer. If the server ever failed to reset, the
   * sink refuses the diff and asks for a full frame rather than painting a hybrid screen.
   *
   * A refused retarget (stale pane id, a controller holding the lock) does **not** close the
   * connection — the server keeps the current session and answers with a `Notify` this codec does
   * not decode. So a caller that must know whether the move landed reads the frames, not the
   * socket.
   */
  async retarget(paneId: string): Promise<void> {
    if (this.disposed || this.channel === null || !this.observing) {
      // Not open yet: the caller is switching panes before the first stream came up. Move the seed
      // so `onWelcome` observes the pane the user actually wants.
      this.target = paneId
      return
    }
    if (paneId === this.target) {
      return
    }
    const channel = this.channel
    const geometry = await this.resolveGeometry(paneId)
    if (this.disposed || this.channel !== channel) {
      return
    }
    this.target = paneId
    this.retargets += 1
    this.sink.reset()
    try {
      if (geometry.cols !== this.geometry?.cols || geometry.rows !== this.geometry?.rows) {
        this.geometry = geometry
        this.options.events?.onGeometry?.(geometry)
        await channel.send(encodeResizeFrame({ cols: geometry.cols, rows: geometry.rows }))
      }
      await channel.send(encodeRetargetTerminalFrame(paneId, OBSERVE_MODE))
    } catch (error: unknown) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Ends the stream. Idempotent; safe before `start()` has resolved. */
  close(): void {
    this.disposed = true
    this.channel?.close()
    this.channel = null
  }

  private async resolveGeometry(paneId: string): Promise<ObserverGeometry> {
    // `pane.layout` answers with the whole workspace snapshot — `area` plus a `rect` for EVERY pane
    // in it — and `resolveObserverGeometry` takes the max of `area` and the pane's own rect. So a
    // retarget inside a snapshot we already hold needs no round trip and, in the common case,
    // computes the identical grid. That matters more than it sounds: the JSON API answers one
    // request per connection (`src/api/server.rs`), so on the ssh bridge each call is an exec
    // channel and a remote `herdr` process (blocker B8), and it was the dominant term in the
    // measured swipe latency.
    const cached = this.layout
    if (cached?.panes.some((pane) => pane.pane_id === paneId)) {
      return resolveObserverGeometry({
        paneId,
        layout: cached,
        viewportRows: this.options.viewportRows ?? null
      })
    }
    let layout = null
    try {
      layout = paneLayoutFromResult(
        await this.options.connection.api.request('pane.layout', { pane_id: paneId })
      )
    } catch {
      // A box that cannot answer `pane.layout` still has a pane worth reading; the fallback is the
      // server's own no-client size (see `./observer-geometry.ts`), which is never *narrower* than
      // what that server renders at.
      layout = null
    }
    this.layout = layout
    return resolveObserverGeometry({
      paneId,
      layout,
      viewportRows: this.options.viewportRows ?? null
    })
  }

  private onMessage(message: ServerMessage): void {
    if (this.disposed) {
      return
    }
    if (message.type === 'welcome') {
      this.onWelcome(message)
      return
    }
    if (message.type === 'terminal') {
      this.frames += 1
      this.sink.accept(message)
      this.options.events?.onFrame?.(message)
    }
    // Every other decoded variant is traffic this viewer has no use for; `ServerMessageChannel`
    // already counts the ones that did not decode (`undecodableCount`).
  }

  private onWelcome(welcome: WelcomeMessage): void {
    this.options.events?.onWelcome?.(welcome)
    try {
      // Not a formality: the server answers with the encoding it *actually* chose, and a client
      // that skips this reads semantic `Frame` payloads as ANSI and paints garbage
      // (02-architecture.md §2.2 — `Hello`'s field is named `requested_encoding` for this reason).
      assertWelcomeAccepted(welcome, { encoding: RenderEncoding.TerminalAnsi })
    } catch (error: unknown) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (this.observing || this.channel === null) {
      return
    }
    this.observing = true
    this.setStatus('observing')
    const written = this.channel.send(encodeObserveTerminalFrame(this.target))
    if (written !== undefined) {
      void written.catch((error: unknown) =>
        this.fail(error instanceof Error ? error : new Error(String(error)))
      )
    }
  }

  private requestFullFrame(): void {
    if (this.channel === null || this.disposed) {
      return
    }
    const written = this.channel.send(encodeRequestFullFrameFrame())
    if (written !== undefined) {
      // Losing the request is not worse than never sending it, and it must not surface as an
      // unhandled rejection out of a render-path callback.
      void written.catch(() => {})
    }
  }

  private fail(error: Error): void {
    if (this.state === 'failed') {
      return
    }
    this.setStatus('failed')
    this.options.events?.onError?.(error)
  }

  private setStatus(status: PaneObserverStatus): void {
    if (this.state === status) {
      return
    }
    this.state = status
    this.options.events?.onStatus?.(status)
  }
}
