// Not from orca — orca never needed it, because in orca a drag on the terminal *is* input
// (`mobile/src/terminal/terminal-gesture-input.ts`, a file herdr did not port). Extracted from
// terminal-webview-html.ts to keep that file within its max-lines budget, following the same
// convention as its sibling `*-injected.ts` modules. Closes over host-IIFE state and functions:
// ts and userScale.
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
      // The page *does* own horizontal once the reader has zoomed in — yielding there would take
      // panning away from a magnified pane entirely.
      //
      // The test is \`userScale\`, not "is the grid wider than the viewport", and that correction is
      // .prd/09 §KK. The arithmetic version looked like the pan branch's own guard and was wrong
      // here for one reason: \`commitFitScale\` snaps a fit scale of 0.95..1 up to exactly 1
      // (terminal-webview-html.ts, "snap to 1 to avoid imperceptible shrinkage"). A pane that fits
      // *after* rounding therefore reports content wider than the viewport while the reader has
      // zoomed nothing — the file's own \`suspect\` check names that state, \`currentScale === 1 &&
      // expectedW > vpW + 1\`. On an 80-column pane in a 402pt viewport that is the resting state,
      // so the yield never fired and the repair shipped inert (measured: 3 gestures, page counted
      // 53/98/27 touchmoves, recognizer got dx=0).
      //
      // What is given up by testing \`userScale\` instead: at rest a snapped-to-1 pane can pan by
      // the few pixels the rounding left. That slack is worth less than pane switching, and the
      // design already said so — src/session/pane-swipe.ts: "At fit width — every unzoomed pane —
      // a horizontal drag does nothing today."
      if (userScale > 1) return false;
      var dx = touch.clientX - ts.startX;
      var dy = touch.clientY - ts.startY;
      return Math.abs(dx) >= YIELD_OFFSET_X && Math.abs(dx) >= YIELD_AXIS_RATIO * Math.abs(dy);
    }
`
