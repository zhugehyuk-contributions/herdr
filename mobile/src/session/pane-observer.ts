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
  type TransportTimer,
  type WelcomeMessage
} from '@herdr/client-ts'
import {
  createTerminalFrameSink,
  type TerminalFrameSinkTarget
} from '../terminal/terminal-frame-sink'
import { ObserverGeometryCache, type ObserverGeometry } from './observer-geometry'
import { PaneReattachLadder } from './pane-reattach'
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
  /**
   * L3's clock, for the re-attach ladder below. Injected for the reason
   * `../transport/connection-supervisor.ts` injects it: the receipt drives the sequence off a fake
   * clock, and the identical code runs against the host's in `test/live/`.
   */
  timer?: TransportTimer
  /**
   * Whether the screen this observer paints is on screen. Absent means "assume yes", which is what
   * a headless caller (every unit fake, the Node harness) should assume.
   *
   * A backgrounded phone re-attaching spends an ssh exec and a remote `herdr` process (B8) on a
   * picture nobody is looking at, and the OS's own suspend/resume schedule would deliver those
   * wake-ups as a burst at resume anyway (`../api/use-foreground-refresh.ts` stops its poll for the
   * same reason). So the ladder keeps ticking and the *dial* waits for
   * {@link PaneObserver.notifyForeground}.
   */
  isForeground?: () => boolean
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
 *
 * ## It also re-opens its own stream (`.prd/09-review-followups.md` §Q)
 *
 * Measured on a device: the exec channel died at 20:14:43Z, M4's supervisor redialled the *health*
 * link at 20:15:11Z — and the pane stayed frozen until 20:17:27Z, when the user left the screen and
 * came back. Two streams, one supervisor: the connection healed and the picture did not, because
 * nothing re-sent `Hello`/`ObserveTerminal` on the pane's own channel.
 *
 * So this class owns that repair, and it owns it with borrowed parts rather than new ones:
 *
 *   · **when** is `../transport/reconnect-policy.ts` — the same `ReconnectScheduler`, the same
 *     ladder, the same 90s trickle that never parks (L3). No second policy, no second constant.
 *   · **what** is one `Hello` + one `ObserveTerminal` at the grid this observer *already*
 *     declared. A re-attach is not a new reading: it must not re-ask `pane.layout` (B8) and must
 *     not hand the server a geometry the pane never asked for (M2 (c), "데스크톱 레이아웃 무변화").
 *   · **onto what** is the screen that is still there. The sink is `resync`ed, not `reset`, so the
 *     new stream's full frame repaints the existing xterm instead of building a new one — an
 *     `init` would call `resetZoom()` and throw away the reader's pinch and pan.
 */
export class PaneObserver {
  private readonly options: PaneObserverOptions
  private readonly sink: ReturnType<typeof createTerminalFrameSink>
  /** §Q's when. One per observer; the policy is `./pane-reattach.ts`, restated nowhere. */
  private readonly ladder: PaneReattachLadder
  private channel: ServerMessageChannel | null = null
  private state: PaneObserverStatus = 'idle'
  private disposed = false
  private observing = false
  private frames = 0
  /**
   * Which attach the live callbacks belong to. Bumped by every attach *and* by every teardown, so a
   * channel dying late cannot book a second failure against the generation that replaced it — the
   * same rule `../transport/observe-stream-link.ts` states as `DialRecord.retired`.
   */
  private attachSeq = 0
  /** The pane currently being observed. Moves with `retarget`; `options.paneId` is only the seed. */
  private target: string
  /** The grid this connection last declared, so a retarget only resizes when it has to. */
  private geometry: ObserverGeometry | null = null
  /** Which pane {@link geometry} was resolved for. A re-attach may only reuse it for that pane. */
  private geometryFor: string | null = null
  /** `pane.layout`, asked once per workspace rather than once per attach (B8). */
  private readonly grids: ObserverGeometryCache
  private retargets = 0

  constructor(options: PaneObserverOptions) {
    this.options = options
    this.target = options.paneId
    this.grids = new ObserverGeometryCache(
      (paneId) => options.connection.api.request('pane.layout', { pane_id: paneId }),
      options.viewportRows ?? null
    )
    this.ladder = new PaneReattachLadder({
      attach: () => void this.attach(),
      ...(options.timer === undefined ? {} : { timer: options.timer }),
      ...(options.isForeground === undefined ? {} : { isForeground: options.isForeground })
    })
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

  /** How many streams the ladder opened. `start()`'s first one is not one of them (§Q). */
  get reattachCount(): number {
    return this.ladder.attemptCount
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') {
      return
    }
    await this.attach()
  }

  /**
   * The screen came back to the foreground. Dials now instead of waiting out the armed rung — L4's
   * nudge, applied to the pane's stream (`../transport/connection-supervisor.ts` `notifyForeground`
   * is the connection's).
   *
   * The counter is reset because a resume is the one moment the *reason* for the failures may have
   * changed under the app (a new radio, a new network), which is `redialNow(true)`'s "a genuinely
   * fresh start" in `../transport/reconnect-policy.ts`.
   */
  notifyForeground(): void {
    if (this.disposed || this.state === 'idle' || this.observing || this.state === 'connecting') {
      return
    }
    this.ladder.reviveNow()
  }

  private async attach(): Promise<void> {
    if (this.disposed || this.ladder.latched) {
      return
    }
    this.attachSeq += 1
    const generation = this.attachSeq
    this.setStatus('connecting')
    try {
      // A re-attach re-declares the grid it already had rather than re-deriving it: `pane.layout` is
      // an exec channel and a remote `herdr` process on the ssh bridge (B8), and a *different*
      // answer arriving mid-outage would resize the reader's screen for a pane that never moved
      // (M2 (c)). Only a target change invalidates it — see `retarget`.
      const geometry =
        this.geometryFor === this.target && this.geometry !== null
          ? this.geometry
          : await this.grids.resolve(this.target)
      if (this.disposed || generation !== this.attachSeq) {
        return
      }
      this.geometry = geometry
      this.geometryFor = this.target
      this.options.events?.onGeometry?.(geometry)
      const channel = await this.options.connection.openTerminalStream(
        {
          // Every callback is this generation's. A channel that dies after the ladder replaced it
          // must not book a second failure, or the attempt counter L3's cap keys off doubles.
          onMessage: (message) => {
            if (generation === this.attachSeq) {
              this.onMessage(message, generation)
            }
          },
          onError: (error) => {
            if (generation === this.attachSeq) {
              this.fail(generation, error)
            }
          },
          onClose: (close) => {
            if (generation !== this.attachSeq) {
              return
            }
            if (this.state !== 'failed') {
              this.setStatus('closed')
            }
            this.streamDown()
            this.options.events?.onClose?.(close)
          }
        },
        {
          firstTerminalTimeoutMs:
            this.options.firstTerminalTimeoutMs ?? DEFAULT_FIRST_TERMINAL_TIMEOUT_MS
        }
      )
      if (this.disposed || generation !== this.attachSeq) {
        // Superseded while the exec channel was opening — nobody else holds this one, and an exec
        // channel nobody closes is a remote `herdr` process nobody closes (B8).
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
      // `generation`, not the live one: everything above this line is awaited — `pane.layout`, the
      // exec channel, the `Hello` write — so a rejection can land after this observer was replaced
      // (a retarget, a re-attach; both run `streamDown`, which bumps `attachSeq`). Since
      // `b411ef04` that is not a rare race but a clock: `openChannel` rejects every channel that
      // has not been approved within `connectTimeoutMs` (20s), so any retarget or re-attach inside
      // that window produces exactly this late rejection.
      this.fail(generation, error instanceof Error ? error : new Error(String(error)))
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
      // Not open yet, or down and waiting on a re-attach (§Q). Move the seed so the next
      // `Hello`/`ObserveTerminal` names the pane the user actually wants — and drop the cached grid
      // with it, because it belongs to the pane being left and a re-attach would otherwise declare
      // it (B4: a pane wider than the declared rect is cropped, not reflowed). The screen goes too:
      // the next stream paints a different pane, which is exactly what `reset` is for.
      if (paneId !== this.target) {
        this.target = paneId
        this.geometry = null
        this.geometryFor = null
        this.sink.reset()
      }
      return
    }
    if (paneId === this.target) {
      return
    }
    const channel = this.channel
    // Captured before the first await for the same reason `attach` captures one: `grids.resolve`
    // and the two `channel.send`s below can all reject after this stream was retired, and a
    // retarget that lost its race is not a failure of the stream that replaced it.
    const generation = this.attachSeq
    const geometry = await this.grids.resolve(paneId)
    if (this.disposed || this.channel !== channel) {
      return
    }
    const regrid = geometry.cols !== this.geometry?.cols || geometry.rows !== this.geometry?.rows
    this.target = paneId
    this.geometry = geometry
    this.geometryFor = paneId
    this.retargets += 1
    this.sink.reset()
    try {
      if (regrid) {
        this.options.events?.onGeometry?.(geometry)
        await channel.send(encodeResizeFrame({ cols: geometry.cols, rows: geometry.rows }))
      }
      await channel.send(encodeRetargetTerminalFrame(paneId, OBSERVE_MODE))
    } catch (error: unknown) {
      this.fail(generation, error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Ends the stream. Idempotent; safe before `start()` has resolved. */
  close(): void {
    this.disposed = true
    // Before the channel: an unmounted screen must not leave a rung armed, or the ladder keeps
    // spending exec channels on a picture that has no reader (B8).
    this.ladder.cancel()
    this.channel?.close()
    this.channel = null
  }

  /**
   * This generation is over. §Q's repair, and the only place that arms the ladder.
   *
   * The sequence number moves first: `channel.close()` below provokes the close callback that may
   * have brought us here, and a second pass would book a second failure against a generation that
   * is already gone — L3's cap and the trickle both key off that counter.
   */
  private streamDown(): void {
    this.attachSeq += 1
    const channel = this.channel
    this.channel = null
    this.observing = false
    if (channel !== null) {
      try {
        channel.close()
      } catch {
        // Already gone is the normal case here, not an error.
      }
    }
    if (this.disposed) {
      return
    }
    // `resync`, never `reset`: the pane did not change, so the screen the reader is zoomed into
    // stays and the next stream's full frame repaints it in place.
    this.sink.resync()
    this.ladder.arm()
  }

  private onMessage(message: ServerMessage, generation: number): void {
    if (this.disposed) {
      return
    }
    if (message.type === 'welcome') {
      this.onWelcome(message, generation)
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

  private onWelcome(welcome: WelcomeMessage, generation: number): void {
    this.options.events?.onWelcome?.(welcome)
    try {
      // Not a formality: the server answers with the encoding it *actually* chose, and a client
      // that skips this reads semantic `Frame` payloads as ANSI and paints garbage
      // (02-architecture.md §2.2 — `Hello`'s field is named `requested_encoding` for this reason).
      assertWelcomeAccepted(welcome, { encoding: RenderEncoding.TerminalAnsi })
    } catch (error: unknown) {
      // Latched, not retried: the peer will answer the next `Hello` with the same `Welcome`, so a
      // ladder here would be an ssh exec every 90s forever against a verdict that cannot move.
      this.ladder.latch()
      this.fail(generation, error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (this.observing || this.channel === null) {
      return
    }
    this.observing = true
    // The handshake landed, so the failures before it are spent — the counter returns to zero here
    // and nowhere else (`../transport/reconnect-policy.ts`, `noteConnected`).
    this.ladder.noteAttached()
    this.setStatus('observing')
    const written = this.channel.send(encodeObserveTerminalFrame(this.target))
    if (written !== undefined) {
      // Reached from inside `onMessage`'s gate, but resolved outside it — the write can reject
      // after this generation is gone, so it hands `fail` the generation it was armed for.
      void written.catch((error: unknown) =>
        this.fail(generation, error instanceof Error ? error : new Error(String(error)))
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

  /**
   * Books a failure against the generation that suffered it.
   *
   * The generation is a parameter rather than a re-read of `attachSeq` because three of the five
   * ways into this method resolve *after* the gate that let them start: `attach`'s catch (an
   * awaited dial and an awaited `Hello`), `retarget`'s catch (an awaited `pane.layout` and two
   * awaited sends) and the `ObserveTerminal` write's `catch` in `onWelcome`. The other two —
   * `openTerminalStream`'s `onError` and the refused-`Welcome` latch — are synchronous inside
   * `generation === this.attachSeq`, so for them this check is the one they already pass, restated
   * where it cannot be forgotten.
   *
   * The gate lives here rather than at each catch because what it protects is not the reporting but
   * `streamDown` below: a dead generation reaching it bumps `attachSeq`, closes the *live*
   * channel and arms the ladder — a working stream torn down by a corpse. One place that can do
   * that is one place to guard, and the signature makes a future caller name its generation instead
   * of inheriting the bug. This is the same expression `attach` uses at its two await boundaries;
   * `disposed` rides along because `close()` does not move the sequence, and a closed screen must
   * not be told anything at all (`streamDown` already checks it, but `setStatus`/`onError` fire
   * first).
   */
  private fail(generation: number, error: Error): void {
    if (this.disposed || generation !== this.attachSeq) {
      return
    }
    if (this.state === 'failed') {
      return
    }
    this.setStatus('failed')
    this.options.events?.onError?.(error)
    // A failure freezes the picture exactly as a close does, so it earns the same repair. The latch
    // above is what keeps a refused handshake out of this.
    this.streamDown()
  }

  private setStatus(status: PaneObserverStatus): void {
    if (this.state === status) {
      return
    }
    this.state = status
    this.options.events?.onStatus?.(status)
  }
}
