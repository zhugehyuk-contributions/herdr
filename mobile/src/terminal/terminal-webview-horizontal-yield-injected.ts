// Not from orca — orca never needed it, because in orca a drag on the terminal *is* input
// (`mobile/src/terminal/terminal-gesture-input.ts`, a file herdr did not port). Extracted from
// terminal-webview-html.ts to keep that file within its max-lines budget, following the same
// convention as its sibling `*-injected.ts` modules. Closes over host-IIFE state and functions:
// ts, getContentWidth, getTotalScale.
//
// What it decides: whether this document should let a horizontal drag through to the native
// recognizer above the WebView instead of declaring it consumed.
//
// The problem it answers (.prd/09-review-followups.md §HH): the touchmove handler called
// preventDefault unconditionally, which tells the platform "the page consumed this touch". But the
// branch that would actually *use* a horizontal drag is guarded by "content wider than the
// viewport", so on every unzoomed pane a sideways finger did nothing here — the page was claiming
// a gesture it then threw away. On iOS that claim is apparently enough to keep the pane-swipe
// recognizer from ever activating: the same synthetic drag that scrolled an RN ScrollView 425pt on
// the same screen produced no pane switch inside the GestureDetector. Android is unaffected in
// either direction — its RNGH root view intercepts at the native layer, above anything this
// document says (§DD, measured on emulator-5554).
//
// The thresholds are injected by the caller rather than written here, because
// `src/session/pane-swipe.ts` owns them and its header explains why a constant living in two files
// is not one constant: the recognizer's window and the page's yield window have to be the same
// window, or there is a band of gestures the page keeps and the recognizer wants.
import { PANE_SWIPE_ACTIVATE_OFFSET_X, PANE_SWIPE_AXIS_RATIO } from '../session/pane-swipe'

export const TERMINAL_HORIZONTAL_YIELD_JS = `
    var YIELD_OFFSET_X = ${PANE_SWIPE_ACTIVATE_OFFSET_X};
    var YIELD_AXIS_RATIO = ${PANE_SWIPE_AXIS_RATIO};
    function shouldYieldHorizontal(touch) {
      // Latched: once a gesture is the recognizer's, the rest of it stays the recognizer's.
      // Without this a drag that curves back under the ratio would be re-claimed mid-flight and
      // the page would start scrolling under a finger that is switching panes.
      if (ts.yieldedH) return true;
      // The page *does* own horizontal when the grid overflows — the same test the pan branch
      // uses. Yielding there would take panning away from a zoomed-in pane entirely.
      if (getContentWidth() * getTotalScale() > window.innerWidth + 1) return false;
      var dx = touch.clientX - ts.startX;
      var dy = touch.clientY - ts.startY;
      return Math.abs(dx) >= YIELD_OFFSET_X && Math.abs(dx) >= YIELD_AXIS_RATIO * Math.abs(dy);
    }
`
