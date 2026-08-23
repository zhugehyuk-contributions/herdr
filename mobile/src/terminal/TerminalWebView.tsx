// Ported from orca mobile/src/terminal/TerminalWebView.tsx
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
import { useRef, useCallback, forwardRef, useImperativeHandle, useEffect, useMemo } from 'react'
import { Platform, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import type { TerminalOscLinkRange } from '../shared/terminal-osc-link-ranges'
import type { PaneSwipeTranslation } from '../session/pane-swipe'
import type { TerminalWebViewHandle, TerminalWebViewProps } from './terminal-webview-contract'
import {
  TerminalWebViewEngineErrorOverlay,
  useTerminalWebViewEngineErrorState
} from './terminal-webview-engine-error-state'
import { TERMINAL_WEBVIEW_FRAME_STYLES } from './terminal-webview-frame-styles'
import { useTerminalWebReadyWatchdog } from './terminal-webview-ready-watchdog'
import { XTERM_WEBVIEW_SOURCE } from './terminal-webview-html'
import type { TerminalWebViewCommand } from './terminal-webview-messages'
import { createTerminalWebViewPendingMessages } from './terminal-webview-pending-messages'
import { dispatchTerminalWebViewNotification } from './terminal-webview-notification-dispatch'
import { routeTerminalQueryReply } from './terminal-webview-query-reply-routing'
import { createTerminalWriteCoalescer } from './terminal-write-coalescer'

// Not orca's, and deliberately not in `terminal-webview-contract.ts` either: that file is the
// ported prop surface and this prop exists only because iOS gesture arbitration hands the whole
// drag to the document (`terminal-webview-html.ts` touchend, `.prd/09-review-followups.md` §JJ).
// The page measures the swipe with the recognizer's own thresholds and posts the total; the
// decision — which pane, or none — stays with `resolvePaneSwipeTarget` on the screen.
type Props = TerminalWebViewProps & {
  onPaneSwipe?: (translation: PaneSwipeTranslation) => void
}

// The page is outside the trust boundary — this app serves the document, but everything arriving at
// `handleMessage` is JSON that document wrote — so a reported translation is narrowed, never cast.
// `Number.isFinite` already rejects non-numbers; the `typeof` is what narrows the type.
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export type { TerminalWebViewHandle } from './terminal-webview-contract'

export const TerminalWebView = forwardRef<TerminalWebViewHandle, Props>(function TerminalWebView(
  {
    style,
    terminalTheme,
    textScale = 1,
    onWebReady,
    onEngineError,
    onSelectionMode,
    onSelectionCopy,
    onSelectionEvicted,
    onModesChanged,
    onKeyboardAvoidanceMetrics,
    onHaptic,
    onTerminalInput,
    onTerminalQueryReply,
    onTerminalTap,
    onFileTap,
    onOpenUrl,
    onTextScaleChange,
    onPaneSwipe
  },
  ref
) {
  const webViewRef = useRef<WebView>(null)
  const isWebReadyRef = useRef(false)
  // Why these two exist, and why `init` is deliberately NOT carried by `pendingMessages`:
  //
  // `handleLoadStart` clears that queue, because after a *reload* its `write`s are diffs against a
  // buffer that no longer exists. But an `init` queued before the document ever started loading is
  // not stale — it has never been delivered to any document — and dropping it is unrecoverable:
  // `TerminalFrameSink` marks the stream `opened` before it calls `init` and never issues a second
  // one (`./terminal-frame-sink.ts`), so the pane stays blank for the life of the screen with no
  // error anywhere. Measured on the iOS simulator, 2026-08-23 (`.prd/10-mobile-qa.md` iOS lab, cold
  // launch, 80x40 fixture): `pm.queue init` at t+396ms, `wv.loadStart` + `pm.clear-dropping
  // ["set-theme","set-font-scale","init"]` at t+466ms, `web-ready` + `pm.flush []` at t+501ms —
  // 2,033,316 background pixels and not one `[fit]renderer` line for the rest of the session.
  //
  // So the snapshot is held here instead and (re)sent by `confirmWebReady`, exactly like the theme
  // one line below it: every fresh document owes the reader a terminal, whether it is the first one
  // or a replacement after a WebKit content-process loss.
  const lastInitRef = useRef<TerminalWebViewCommand | null>(null)
  const initDeliveredRef = useRef(false)
  const pendingMessages = useMemo(() => createTerminalWebViewPendingMessages(), [])
  const messageIdRef = useRef(0)
  const pendingPingIdRef = useRef<number | null>(null)
  const terminalThemeKey = useMemo(() => JSON.stringify(terminalTheme ?? null), [terminalTheme])
  const measureResolveRef = useRef<
    ((result: { cols: number; rows: number } | null) => void) | null
  >(null)
  // Why: each init() call posts 'init' to the WebView and arms a fresh
  // ready promise. WebView's init() rAF chain ends with a 'ready' notify
  // that resolves it. measureFitDimensions awaits this so it doesn't
  // race ahead of term.open() / renderService population.
  const readyPromiseRef = useRef<Promise<void> | null>(null)
  const readyResolveRef = useRef<(() => void) | null>(null)
  const { clearEngineError, engineError, reportEngineError, reportNativeEngineError } =
    useTerminalWebViewEngineErrorState(onEngineError)
  const { armWebReadyWatchdog, clearWebReadyWatchdog } = useTerminalWebReadyWatchdog(
    isWebReadyRef,
    reportEngineError
  )

  const sendToWebView = useCallback((msg: TerminalWebViewCommand) => {
    messageIdRef.current += 1
    const id = messageIdRef.current
    webViewRef.current?.postMessage(JSON.stringify({ ...msg, id }))
    return id
  }, [])

  const flushPendingMessages = useCallback(() => {
    pendingMessages.flush(sendToWebView)
  }, [pendingMessages, sendToWebView])

  const postMessage = useCallback(
    (msg: TerminalWebViewCommand) => {
      if (!isWebReadyRef.current) {
        pendingMessages.queue(msg)
        return
      }
      sendToWebView(msg)
    },
    [pendingMessages, sendToWebView]
  )

  // Why: a busy PTY delivers ~200 stream frames/s; coalescing here collapses the
  // per-frame bridge + WebKit IPC + paint cost that runs the phone hot (#9302).
  const writeCoalescer = useMemo(
    () => createTerminalWriteCoalescer((data) => postMessage({ type: 'write', data })),
    [postMessage]
  )

  useEffect(() => {
    return () => {
      writeCoalescer.clear()
    }
  }, [writeCoalescer])

  const confirmWebReady = useCallback(
    (notifyParent: boolean) => {
      pendingPingIdRef.current = null
      isWebReadyRef.current = true
      clearWebReadyWatchdog()
      clearEngineError()
      if (notifyParent) {
        onWebReady?.()
      }
      // Why: reload clears queued commands, so readiness must always restore the
      // native-selected theme even when its value did not change in React.
      sendToWebView({ type: 'set-theme', terminalTheme })
      // Before the queue, never after: everything in it is a diff that only means anything against
      // the buffer this snapshot builds.
      const lastInit = lastInitRef.current
      if (!initDeliveredRef.current && lastInit !== null) {
        initDeliveredRef.current = true
        sendToWebView(lastInit)
      }
      flushPendingMessages()
    },
    [
      clearEngineError,
      clearWebReadyWatchdog,
      flushPendingMessages,
      onWebReady,
      sendToWebView,
      terminalTheme
    ]
  )

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(event.nativeEvent.data) as Record<string, unknown>
      } catch {
        return
      }
      routeTerminalQueryReply(msg, onTerminalQueryReply)

      if (msg.type === 'touch-probe') {
        // §JJ's discriminator, logged rather than handled: it exists to sit next to `[paneSwipe]`
        // in the same Metro stream so one run answers "did the document see the touches the
        // recognizer did not". Removed once iOS M6a closes either way.
        console.log(`[touchProbe] ${JSON.stringify(msg)}`)
      } else if (msg.type === 'pane-swipe') {
        // iOS M6a. The document measures the swipe because on iOS it is the only thing that
        // receives one (`./terminal-webview-html.ts` touchend, `.prd/09-review-followups.md` §JJ);
        // the decision stays on the screen, which is why this only forwards.
        //
        // A malformed pair is dropped here rather than passed on, and that is worth a line: a
        // `translationX` of `"120"` or `null` would flow into `paneSwipeDirection`, whose own
        // `Number.isFinite` guard rejects it *silently* — leaving a swipe that does nothing and no
        // way to tell that from a swipe the page never sent, which is the reading §JJ spent eight
        // rounds on.
        const x = msg.translationX
        const y = msg.translationY
        if (isFiniteNumber(x) && isFiniteNumber(y)) {
          onPaneSwipe?.({ translationX: x, translationY: y })
        }
      } else if (msg.type === 'web-ready') {
        confirmWebReady(true)
      } else if (
        msg.type === 'pong' &&
        typeof msg.pingId === 'number' &&
        msg.pingId === pendingPingIdRef.current
      ) {
        confirmWebReady(false)
      } else if (msg.type === 'ready') {
        // Why: the WebView's init() rAF chain has run — term is open,
        // renderService is populated, first paint has happened. Resolve
        // any pending awaitReady() so a queued measure can now safely
        // read cell dims.
        const resolve = readyResolveRef.current
        readyResolveRef.current = null
        readyPromiseRef.current = null
        resolve?.()
      } else if (msg.type === 'measure-result') {
        const resolve = measureResolveRef.current
        measureResolveRef.current = null
        if (resolve) {
          const cols = typeof msg.cols === 'number' ? msg.cols : null
          const rows = typeof msg.rows === 'number' ? msg.rows : null
          resolve(cols && rows && cols >= 20 && rows >= 8 ? { cols, rows } : null)
        }
      } else {
        dispatchTerminalWebViewNotification(msg, {
          reportEngineError,
          onSelectionMode,
          onSelectionCopy,
          onSelectionEvicted,
          onModesChanged,
          onKeyboardAvoidanceMetrics,
          onHaptic,
          onTerminalInput,
          onTerminalTap,
          onFileTap,
          onOpenUrl,
          onTextScaleChange
        })
      }
    },
    [
      confirmWebReady,
      reportEngineError,
      onSelectionMode,
      onSelectionCopy,
      onSelectionEvicted,
      onModesChanged,
      onKeyboardAvoidanceMetrics,
      onHaptic,
      onTerminalInput,
      onTerminalQueryReply,
      onTerminalTap,
      onFileTap,
      onOpenUrl,
      onTextScaleChange,
      onPaneSwipe
    ]
  )

  const handleLoadStart = useCallback(() => {
    isWebReadyRef.current = false
    // A new document has no terminal in it, whatever the last one was told.
    initDeliveredRef.current = false
    pendingPingIdRef.current = null
    armWebReadyWatchdog()
    // Why: messages queued for a previous WebView generation are stale after a reload;
    // dropping them avoids replaying terminal chunks before the next init snapshot.
    //
    // Only when there is no snapshot to restore, though. `init` clears this queue and
    // `confirmWebReady` sends the held snapshot ahead of whatever refilled it, so once a snapshot
    // exists the queue is by construction the diffs that come *after* it — the chunks the reader
    // loses if they are dropped here, with nothing upstream that would ever resend them.
    if (lastInitRef.current === null) {
      pendingMessages.clear()
      writeCoalescer.clear()
    }
  }, [armWebReadyWatchdog, pendingMessages, writeCoalescer])

  const handleReload = useCallback(() => {
    clearEngineError()
    webViewRef.current?.reload()
  }, [clearEngineError])

  const handleContentProcessDidTerminate = useCallback(() => {
    // Why: WKWebView content-process loss is recoverable; stale commands belong
    // to the dead document and the replacement must prove readiness before replay.
    isWebReadyRef.current = false
    initDeliveredRef.current = false
    pendingPingIdRef.current = null
    pendingMessages.clear()
    writeCoalescer.clear()
    clearEngineError()
    armWebReadyWatchdog()
    webViewRef.current?.reload()
  }, [armWebReadyWatchdog, clearEngineError, pendingMessages, writeCoalescer])

  useEffect(() => {
    postMessage({ type: 'set-theme', terminalTheme })
  }, [postMessage, terminalThemeKey, terminalTheme])

  // Why: live-apply text-size changes to an already-mounted terminal (the pane
  // stays alive while the user visits Settings), so no terminal reload is needed.
  useEffect(() => {
    postMessage({ type: 'set-font-scale', fontScale: textScale })
  }, [postMessage, textScale])

  useImperativeHandle(
    ref,
    () => ({
      prepareForForegroundRecovery() {
        if (Platform.OS !== 'ios') {
          return
        }
        // Why: direct ping is the only command allowed through while readiness is
        // invalid; init/write commands queue until this exact document answers.
        isWebReadyRef.current = false
        armWebReadyWatchdog()
        pendingPingIdRef.current = sendToWebView({ type: 'ping' })
      },
      write(data: string) {
        writeCoalescer.write(data)
      },
      init(
        cols: number,
        rows: number,
        initialData?: string,
        preserveScroll?: boolean,
        oscLinks?: TerminalOscLinkRange[]
      ) {
        // Why: arm a fresh ready promise BEFORE posting init. The WebView
        // resolves it via the 'ready' notify at the end of its rAF chain.
        // Resolve any prior in-flight ready first so awaiters from the
        // previous generation don't sit on the 3s setTimeout fallback —
        // each leaked timer + closure pinned an awaiting measure caller
        // for the full 3s under rapid re-init (orientation change,
        // multiple resubscribes), delaying cold-start fit chains.
        const priorResolve = readyResolveRef.current
        if (priorResolve) {
          readyResolveRef.current = null
          readyPromiseRef.current = null
          priorResolve()
        }
        readyPromiseRef.current = new Promise<void>((resolve) => {
          readyResolveRef.current = resolve
        })
        // Why: pending chunks are pre-snapshot data; the init snapshot supersedes
        // them, and writing them after init would corrupt the fresh buffer. The queue is
        // emptied for the same reason the coalescer is — with the snapshot now sent ahead of
        // the queue by `confirmWebReady`, a chunk left in it would replay *after* the buffer
        // it predates.
        writeCoalescer.clear()
        pendingMessages.clear()
        const message: TerminalWebViewCommand = {
          type: 'init',
          cols,
          rows,
          initialData,
          oscLinks,
          terminalTheme,
          fontScale: textScale,
          preserveScroll
        }
        lastInitRef.current = message
        initDeliveredRef.current = isWebReadyRef.current
        if (isWebReadyRef.current) {
          sendToWebView(message)
        }
      },
      resize(cols: number, rows: number) {
        // Why: resize/reflow must observe all prior writes or bytes reorder.
        writeCoalescer.flushNow()
        postMessage({ type: 'resize', cols, rows })
      },
      reflow(cols: number, rows: number) {
        writeCoalescer.flushNow()
        postMessage({ type: 'reflow', cols, rows })
      },
      clear() {
        writeCoalescer.clear()
        postMessage({ type: 'clear' })
      },
      measureFitDimensions(
        containerHeight?: number
      ): Promise<{ cols: number; rows: number } | null> {
        if (!isWebReadyRef.current) {
          return Promise.resolve(null)
        }
        return new Promise((resolve) => {
          measureResolveRef.current?.(null)
          let timeout: ReturnType<typeof setTimeout> | null = null
          const finish = (result: { cols: number; rows: number } | null) => {
            if (timeout) {
              clearTimeout(timeout)
              timeout = null
            }
            if (measureResolveRef.current === finish) {
              measureResolveRef.current = null
            }
            resolve(result)
          }
          measureResolveRef.current = finish
          sendToWebView({ type: 'measure', containerHeight })
          // Why: if the WebView doesn't respond within 2s (e.g., xterm
          // failed to load), resolve null so the caller can disable
          // Fit to Phone rather than hanging indefinitely.
          timeout = setTimeout(() => {
            if (measureResolveRef.current === finish) {
              finish(null)
            }
          }, 2000)
        })
      },
      resetZoom() {
        postMessage({ type: 'reset-zoom' })
      },
      cancelSelect() {
        postMessage({ type: 'cancel-select' })
      },
      doSelectAll() {
        postMessage({ type: 'do-select-all' })
      },
      async awaitReady(): Promise<void> {
        // Why: returns the in-flight ready promise (set by init); resolves
        // immediately if no init is pending. Capped at 3s so a stuck
        // WebView doesn't hang the caller.
        const p = readyPromiseRef.current
        if (!p) {
          return
        }
        await new Promise<void>((resolve) => {
          let settled = false
          const timeout = setTimeout(() => {
            settled = true
            resolve()
          }, 3000)
          void p.finally(() => {
            if (!settled) {
              clearTimeout(timeout)
              settled = true
              resolve()
            }
          })
        })
      }
    }),
    [
      armWebReadyWatchdog,
      pendingMessages,
      postMessage,
      sendToWebView,
      terminalTheme,
      textScale,
      writeCoalescer
    ]
  )

  return (
    <View style={[TERMINAL_WEBVIEW_FRAME_STYLES.container, style]}>
      <WebView
        ref={webViewRef}
        source={XTERM_WEBVIEW_SOURCE}
        style={TERMINAL_WEBVIEW_FRAME_STYLES.webview}
        originWhitelist={['*']}
        javaScriptEnabled
        scrollEnabled={false}
        // `nestedScrollEnabled` used to be set here, ported from orca with the note "Android parent
        // gesture containers can intercept vertical drags before the injected xterm scroll router
        // sees them". It is removed, and the removal is the fix for M6a's swipe never firing on
        // Android (.prd/09 §CC).
        //
        // The prop is Android-only (`react-native-webview/lib/WebViewTypes.d.ts:926-930`) and its
        // entire implementation is one line —
        // `RNCWebView.onTouchEvent` (`node_modules/react-native-webview/android/src/main/java/
        // com/reactnativecommunity/webview/RNCWebView.java:125-131`) calls
        // `requestDisallowInterceptTouchEvent(true)` on **every** MotionEvent, starting with
        // ACTION_DOWN. That call walks the parent chain into
        // `RNGestureHandlerRootView.requestDisallowInterceptTouchEvent`
        // (`node_modules/react-native-gesture-handler/android/src/main/java/com/swmansion/
        // gesturehandler/react/RNGestureHandlerRootView.kt:52-57`) →
        // `RNGestureHandlerRootHelper.requestDisallowInterceptTouchEvent` (`…RootHelper.kt:104-112`)
        // → `tryCancelAllHandlers()`, which cancels every handler under that root. The root view has
        // already returned from `orchestrator.onTouchEvent` by then (`…RootHelper.kt:114-123` clears
        // `passingTouch` before delivering to children), so the guard that exists for exactly this
        // case does not apply and the cancel goes through. Measured on emulator-5554: with the prop,
        // the pane's `Gesture.Pan()` reaches BEGAN and is CANCELLED in the same millisecond as
        // ACTION_DOWN — it never sees a single move, so `activeOffsetX` can never be crossed.
        //
        // Nothing here needs it. `scrollEnabled={false}` two lines up means the native WebView never
        // scrolls — the injected script owns both axes — and the pane viewer has no scrolling
        // ancestor. The one ancestor that *does* hold a recognizer is M6a's pan, and it already
        // yields the vertical axis by configuration rather than by this prop: `failOffsetY(±12)`
        // kills it the moment a drag goes vertical (`src/session/pane-swipe.ts`). Measured on the
        // same device: a vertical drag now leaves the pan FAILED and delivers the WebView the whole
        // sequence (touchstart 1 / touchmove 24 / touchend 1), which is what the old note was
        // defending and what the prop was not needed for.
        scalesPageToFit={false}
        // Why: Android WebView defaults textZoom to the system font scale, inflating
        // xterm's DOM glyphs past its canvas-measured cell grid (#4579). iOS ignores it.
        textZoom={100}
        onLoadStart={handleLoadStart}
        onMessage={handleMessage}
        onError={(event) => reportNativeEngineError('Terminal WebView load failed', event)}
        onHttpError={(event) => reportNativeEngineError('Terminal WebView HTTP error', event)}
        onRenderProcessGone={(event) =>
          reportNativeEngineError('Terminal WebView render process ended', event)
        }
        onContentProcessDidTerminate={handleContentProcessDidTerminate}
      />
      {engineError ? (
        <TerminalWebViewEngineErrorOverlay message={engineError} onReload={handleReload} />
      ) : null}
    </View>
  )
})
