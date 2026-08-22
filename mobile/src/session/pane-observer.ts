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
// Read-only by construction — M2 sends no `pane.send_input` and never asks for
// `ControlTerminal`. `TerminalObserve` is the mode in which the server *silently drops* input
// (`src/server/headless.rs:2882-2886`) and, more importantly, the mode in which it neither resizes
// the pane nor takes its lock (`:1763-1786`, against `control_terminal_client` at `:1789`). That is
// milestone M2 (c), "30분 시청 동안 데스크톱 레이아웃 무변화", and it is a property of *which
// message this file sends*, not of the UI above it.
import {
  ClientLaunchMode,
  RenderEncoding,
  assertWelcomeAccepted,
  encodeHelloFrame,
  encodeObserveTerminalFrame,
  encodeRequestFullFrameFrame,
  type HerdrChannelClose,
  type ServerMessage,
  type ServerMessageChannel,
  type TerminalMessage,
  type WelcomeMessage
} from '@herdr/client-ts'
import { createTerminalFrameSink, type TerminalFrameSinkTarget } from '../terminal/terminal-frame-sink'
import {
  paneLayoutFromResult,
  resolveObserverGeometry,
  type ObserverGeometry
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
 * One pane, observed. Construct, `start()`, `close()` — and construct a new one to retarget, which
 * is what a chip tap does: the observe target is fixed at `ObserveTerminal` time and herdr has no
 * message to move it (B6, milestone M6).
 */
export class PaneObserver {
  private readonly options: PaneObserverOptions
  private readonly sink: ReturnType<typeof createTerminalFrameSink>
  private channel: ServerMessageChannel | null = null
  private state: PaneObserverStatus = 'idle'
  private disposed = false
  private observing = false
  private frames = 0

  constructor(options: PaneObserverOptions) {
    this.options = options
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
    return this.options.paneId
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') {
      return
    }
    this.setStatus('connecting')
    try {
      const geometry = await this.resolveGeometry()
      if (this.disposed) {
        return
      }
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

  /** Ends the stream. Idempotent; safe before `start()` has resolved. */
  close(): void {
    this.disposed = true
    this.channel?.close()
    this.channel = null
  }

  private async resolveGeometry(): Promise<ObserverGeometry> {
    let layout = null
    try {
      layout = paneLayoutFromResult(
        await this.options.connection.api.request('pane.layout', { pane_id: this.options.paneId })
      )
    } catch {
      // A box that cannot answer `pane.layout` still has a pane worth reading; the fallback is the
      // server's own no-client size (see `./observer-geometry.ts`), which is never *narrower* than
      // what that server renders at.
      layout = null
    }
    return resolveObserverGeometry({
      paneId: this.options.paneId,
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
    const written = this.channel.send(encodeObserveTerminalFrame(this.options.paneId))
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
