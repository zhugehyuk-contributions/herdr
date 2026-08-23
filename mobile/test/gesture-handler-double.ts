// Not from orca — orca mounts no gesture in any suite this port took, and `react-native` itself is
// mocked module-by-module in every mount test here, so the moment a screen imports
// `react-native-gesture-handler` the real package (which reaches into RN internals) has to be stood
// in for too. This is that stand-in, shared rather than copy-pasted into five files, because it is
// also the only place a test can *read* how the recognizer was configured: `activeOffsetX` and
// `failOffsetY` are enforced by native code no test in this repo runs, so the assertion that they
// were asked for at all is the closest a unit test gets to M6a's "don't steal the terminal's
// gestures" (`src/session/pane-swipe.ts`).
import type { ReactNode } from 'react'

/** What a screen configured on one `Gesture.Pan()`, in the order the builder was called. */
export type PanGestureDouble = {
  activeOffsetX: readonly [number, number] | null
  failOffsetY: readonly [number, number] | null
  runOnJS: boolean
  /** The `onEnd` handler, invoked by tests with a translation the native recognizer would report. */
  end: ((event: { translationX: number; translationY: number }) => void) | null
  /**
   * The lifecycle callbacks .prd/09 §HH added as an instrument.
   *
   * Recorded rather than dropped for the same reason `activeOffsetX` is: they are the only
   * evidence a future reader has that the instrument is still wired, and a double that silently
   * swallows a builder call turns "the screen stopped logging" into a green test run.
   */
  begin: (() => void) | null
  start: (() => void) | null
  finalize:
    | ((event: { translationX: number; translationY: number }, success: boolean) => void)
    | null
  /** Gestures this pan takes priority over — `Gesture.Native()` objects in practice (§QQ). */
  blocksExternal: unknown[]
}

/** What `Gesture.Native()` returns here: an identity, which is all `blocksExternalGesture` needs. */
export type NativeGestureDouble = { kind: 'native' }

export type GestureHandlerRegistry = {
  pans: PanGestureDouble[]
}

/** A fresh registry; put it in `vi.hoisted` so the mock factory can reach it. */
export function createGestureHandlerRegistry(): GestureHandlerRegistry {
  return { pans: [] }
}

/**
 * The module object to return from `vi.mock('react-native-gesture-handler', ...)`.
 *
 * `GestureDetector` renders its child untouched and `GestureHandlerRootView` is the host `View`
 * string every other RN mock here uses, so the rendered tree is what it would be without the
 * gesture — existing assertions about the pane viewer keep meaning what they meant.
 */
export function createGestureHandlerDouble(registry: GestureHandlerRegistry): {
  Gesture: { Pan: () => PanGestureBuilder; Native: () => NativeGestureDouble }
  GestureDetector: (props: { gesture: unknown; children: ReactNode }) => ReactNode
  GestureHandlerRootView: string
} {
  return {
    Gesture: {
      Native: () => ({ kind: 'native' }) as NativeGestureDouble,
      Pan: () => {
        const pan: PanGestureDouble = {
          activeOffsetX: null,
          failOffsetY: null,
          runOnJS: false,
          begin: null,
          start: null,
          finalize: null,
          blocksExternal: [],
          end: null
        }
        registry.pans.push(pan)
        const builder: PanGestureBuilder = {
          runOnJS(value) {
            pan.runOnJS = value
            return builder
          },
          activeOffsetX(range) {
            pan.activeOffsetX = range
            return builder
          },
          failOffsetY(range) {
            pan.failOffsetY = range
            return builder
          },
          // .prd/09 §QQ: recorded, not swallowed. The arbitration this expresses is the whole of
          // the iOS repair, and a double that quietly accepted the call would let a screen that
          // stopped arbitrating pass every test here.
          blocksExternalGesture(...gestures) {
            pan.blocksExternal.push(...gestures)
            return builder
          },
          onBegin(handler) {
            pan.begin = handler
            return builder
          },
          onStart(handler) {
            pan.start = handler
            return builder
          },
          onFinalize(handler) {
            pan.finalize = handler
            return builder
          },
          onEnd(handler) {
            pan.end = handler
            return builder
          }
        }
        return builder
      }
    },
    GestureDetector: (props) => props.children,
    GestureHandlerRootView: 'View'
  }
}

type PanGestureBuilder = {
  runOnJS: (value: boolean) => PanGestureBuilder
  activeOffsetX: (range: readonly [number, number]) => PanGestureBuilder
  failOffsetY: (range: readonly [number, number]) => PanGestureBuilder
  blocksExternalGesture: (...gestures: unknown[]) => PanGestureBuilder
  onBegin: (handler: () => void) => PanGestureBuilder
  onStart: (handler: () => void) => PanGestureBuilder
  onFinalize: (
    handler: (event: { translationX: number; translationY: number }, success: boolean) => void
  ) => PanGestureBuilder
  onEnd: (
    handler: (event: { translationX: number; translationY: number }) => void
  ) => PanGestureBuilder
}
