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
}

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
  Gesture: { Pan: () => PanGestureBuilder }
  GestureDetector: (props: { gesture: unknown; children: ReactNode }) => ReactNode
  GestureHandlerRootView: string
} {
  return {
    Gesture: {
      Pan: () => {
        const pan: PanGestureDouble = {
          activeOffsetX: null,
          failOffsetY: null,
          runOnJS: false,
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
  onEnd: (
    handler: (event: { translationX: number; translationY: number }) => void
  ) => PanGestureBuilder
}
