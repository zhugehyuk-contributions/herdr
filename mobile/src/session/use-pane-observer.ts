// Not from orca. The React half of `./pane-observer.ts`, kept separate so the sequence it drives
// (Hello -> Welcome -> ObserveTerminal -> frames) is testable without mounting anything, which is
// the P1 boundary the port map insists on (§3 P1: if the phone-less reproduction fails, do not
// touch the UI).
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { PaneObserver, type PaneObserverStatus } from './pane-observer'
import type { ObserverGeometry } from './observer-geometry'
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
}

const IDLE: PaneObserverView = { status: 'idle', geometry: null, error: null }

export function usePaneObserver({
  connection,
  paneId,
  viewportRows,
  handleRef
}: UsePaneObserverOptions): PaneObserverView {
  const [view, setView] = useState<PaneObserverView>(IDLE)
  // Why a ref and not the prop: `viewportRows` is a hint that arrives with each snapshot poll, and
  // re-observing a pane because a *row count* changed would tear down a live ssh channel for
  // nothing. It is read once, when the observer starts.
  const viewportRowsRef = useRef(viewportRows)
  viewportRowsRef.current = viewportRows

  useEffect(() => {
    if (!connection || !paneId) {
      setView(IDLE)
      return
    }
    let live = true
    setView(IDLE)
    const observer = new PaneObserver({
      connection,
      paneId,
      viewportRows: viewportRowsRef.current,
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
    void observer.start()
    return () => {
      live = false
      // The observe target is fixed at `ObserveTerminal` time and herdr has no message to move it
      // (blocker B6, milestone M6), so switching panes *is* closing this channel and opening
      // another one.
      observer.close()
    }
  }, [connection, handleRef, paneId])

  return view
}
