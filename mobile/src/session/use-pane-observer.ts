// Not from orca. The React half of `./pane-observer.ts`, kept separate so the sequence it drives
// (Hello -> Welcome -> ObserveTerminal -> frames) is testable without mounting anything, which is
// the P1 boundary the port map insists on (§3 P1: if the phone-less reproduction fails, do not
// touch the UI).
//
// M6 changed the lifetime rule here, and that is the whole diff: the observer now lives as long as
// the *connection*, not as long as the pane. A chip tap calls `PaneObserver.retarget`, which moves
// the target on the open ssh channel; only a lost transport or an unmounted screen tears it down.
//
// §Q (`.prd/09-review-followups.md`) added the two *revival* signals this file is the only place to
// hold, because both are properties of the screen rather than of the stream: whether the app is in
// the foreground at all, and whether the connection underneath just came back. `PaneObserver` owns
// the ladder; this owns the OS.
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { AppState } from 'react-native'
import { PaneObserver, type PaneObserverStatus } from './pane-observer'
import type { ObserverGeometry } from './observer-geometry'
import type { ConnectionState } from '../transport/connection-state-types'
import type { HerdrRemoteConnection } from '../transport/herdr-connection'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'

export type PaneObserverView = {
  status: PaneObserverStatus
  /** The cols/rows this client asked for — from the pane, never the device. Null until resolved. */
  geometry: ObserverGeometry | null
  error: string | null
}

export type UsePaneObserverOptions = {
  /** Null when the remote is listed but not dialled — there is no transport on a phone yet. */
  connection: HerdrRemoteConnection | null
  paneId: string | null
  viewportRows?: number | null
  /** Filled by `TerminalPaneView`'s `onRef`; read at call time so a late attach still renders. */
  handleRef: MutableRefObject<TerminalWebViewHandle | null>
  /**
   * M4's state for this remote, or null when the remote has no supervisor (the mock build, and
   * every build before that milestone).
   *
   * §Q's timeline is why it is a parameter: the health link redialled 28 seconds after the pane's
   * stream died, and the pane went on waiting. A transport that just completed a handshake is the
   * strongest available evidence that the *next* exec channel will succeed, so it is worth a rung
   * skipped — never a rung added.
   */
  connectionState?: ConnectionState | null
}

const IDLE: PaneObserverView = { status: 'idle', geometry: null, error: null }

export function usePaneObserver({
  connection,
  paneId,
  viewportRows,
  handleRef,
  connectionState = null
}: UsePaneObserverOptions): PaneObserverView {
  const [view, setView] = useState<PaneObserverView>(IDLE)
  // Why a ref and not the prop: `viewportRows` is a hint that arrives with each snapshot poll, and
  // re-observing a pane because a *row count* changed would tear down a live ssh channel for
  // nothing. It is read once, when the observer starts.
  const viewportRowsRef = useRef(viewportRows)
  viewportRowsRef.current = viewportRows
  // Same reason, one step further: the observer is created once per *connection*, so the pane it
  // starts on has to be read at construction time rather than captured by the effect's closure.
  const paneIdRef = useRef(paneId)
  paneIdRef.current = paneId
  // Whether there is a pane at all, as opposed to *which* pane. This is the create effect's
  // dependency: the observer must be built when the first pane id arrives (the snapshot loads
  // asynchronously, so the first commit routinely has none) and torn down when the last one goes,
  // but a change from one pane to another must NOT rebuild it — that is the retarget.
  const hasPane = paneId !== null && paneId !== undefined

  // The live observer, so a pane change can *move* it instead of replacing it (M6/B6). Keyed by
  // connection: a new transport is a new socket and there is nothing to retarget on it.
  const observerRef = useRef<PaneObserver | null>(null)

  // Retarget, not remount. This effect deliberately does NOT list `connection`/`handleRef`: it runs
  // on a pane change only, and the effect below owns the observer's lifetime. Ordering inside one
  // commit is by declaration, so on the commit that also creates the observer this runs first and
  // finds `null` — which is correct, because that observer is about to be constructed with the new
  // `paneId` anyway.
  useEffect(() => {
    const observer = observerRef.current
    if (!observer || !paneId || observer.paneId === paneId) {
      return
    }
    void observer.retarget(paneId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId])

  useEffect(() => {
    const startingPaneId = paneIdRef.current
    if (!connection || !hasPane || !startingPaneId) {
      observerRef.current = null
      setView(IDLE)
      return
    }
    let live = true
    setView(IDLE)
    const observer = new PaneObserver({
      connection,
      paneId: startingPaneId,
      viewportRows: viewportRowsRef.current,
      // §Q. The observer re-opens its own stream on L3's ladder, and this is the half of that rule
      // it cannot know by itself: a backgrounded screen must not spend an ssh exec (B8) on a
      // picture nobody is looking at.
      isForeground: () => AppState.currentState === 'active',
      target: {
        // Read through the ref every call: the WebView's own handle is attached during commit and
        // `TerminalWebView` queues anything posted before the document says `web-ready`
        // (`src/terminal/terminal-webview-pending-messages.ts`), so an early write is not lost.
        init: (cols, rows, initialData) => handleRef.current?.init(cols, rows, initialData),
        resize: (cols, rows) => handleRef.current?.resize(cols, rows),
        write: (data) => handleRef.current?.write(data)
      },
      events: {
        onStatus: (status) => {
          if (live) {
            setView((current) => ({ ...current, status }))
          }
        },
        onGeometry: (geometry) => {
          if (live) {
            setView((current) => ({ ...current, geometry }))
          }
        },
        onError: (error) => {
          if (live) {
            setView((current) => ({ ...current, error: error.message }))
          }
        }
      }
    })
    observerRef.current = observer
    void observer.start()
    // The resume half of the same rule. `AppState` rather than a navigation focus event because the
    // failure §Q recorded is the phone being put down, not the screen being covered — and because
    // an unfocused screen in this app is an unmounted one (exactly one pane is ever mounted).
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        observer.notifyForeground()
      }
    })
    return () => {
      live = false
      appState.remove()
      observerRef.current = null
      // Only a lost transport or an unmounted screen gets here now. A pane change is handled by
      // the retarget effect above, on the same ssh channel — closing here would be the reconnect
      // milestone M6 exists to remove.
      observer.close()
    }
  }, [connection, handleRef, hasPane])

  // Declared after the effect that builds the observer, so the first commit finds one. On that
  // commit the observer is already `connecting` and the nudge is a no-op — it only bites when a
  // reconnect lands on a pane whose own stream is still down.
  useEffect(() => {
    if (connectionState === 'connected') {
      observerRef.current?.notifyForeground()
    }
  }, [connectionState])

  return view
}
