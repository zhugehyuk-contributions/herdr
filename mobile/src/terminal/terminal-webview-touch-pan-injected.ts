// Not from orca as a file — the handlers themselves are orca's (ported with the rest of
// terminal-webview-html.ts at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e,
// github.com/stablyai/orca; MIT, Copyright (c) 2026 Lovecast Inc. — see
// mobile/THIRD_PARTY_NOTICES.md). Extracted here to keep that file within its max-lines budget,
// the same reason and the same convention as its sibling `*-injected.ts` modules.
//
// This is the single-finger/two-finger touch half of the terminal surface: pinch-zoom, grid pan,
// and the buffer scroll that routes to the terminal as input. It closes over host-IIFE state and
// functions: ts, term, userScale, panX, panY, smoothScrollOffsetY, getDistance, getTotalScale,
// getContentWidth, getCellHeight, clampUserScale, clampPan, updateTransform,
// updateTouchVelocity, resetSmoothScrollOffset, shouldRouteScrollToTerminalInput,
// dispatcherShouldBlockSurface, and the yield rule injected by
// `./terminal-webview-horizontal-yield-injected.ts`.
//
// The one line here that is *not* orca's is the yield guard at the top of touchmove — see that
// module's header and .prd/09-review-followups.md §HH.

import { TERMINAL_HORIZONTAL_YIELD_JS } from './terminal-webview-horizontal-yield-injected'

export const TERMINAL_TOUCH_PAN_JS = `
    targetSurface.addEventListener('touchstart', function(e) {
      // .prd/09 §JJ's discriminator. The RN-side instrument reported begin 7/7, start 0/7 and
      // finalize dx=0 dy=0 — the pan recognizer never received a touchesMoved. That leaves two
      // stories with opposite consequences, and only this document can tell them apart:
      //   · this fires and the recognizer still sees dx=0 → touches reach the WebView but do not
      //     propagate to the ancestor recognizer. A product defect in the UIKit gesture chain.
      //   · this does not fire either → XCUITest is not producing moves over this surface at all.
      //     A harness limit, and iOS M6a is then unjudgeable on a simulator (real-device gate).
      // Android answered the same question with CDP (§DD); iOS has no CDP, so the page counts.
      // One message per gesture start, one on the first move, one at the end — not per move.
      ts.moveCount = 0;
      notify({ type: 'touch-probe', phase: 'start', blocked: dispatcherShouldBlockSurface() });
      if (dispatcherShouldBlockSurface()) return;
      if (ts.momentumId) {
        cancelAnimationFrame(ts.momentumId);
        ts.momentumId = null;
      }
      if (e.touches.length === 2) {
        ts.isPinching = true;
        smoothScrollOffsetY = 0;
        ts.pinchDist = getDistance(e.touches[0], e.touches[1]);
        ts.pinchScale = userScale;
        var mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        var my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        var total = getTotalScale();
        ts.pinchSurfX = (mx - panX) / total;
        ts.pinchSurfY = (my - panY) / total;
      } else if (e.touches.length === 1) {
        ts.isPinching = false;
        ts.lastX = e.touches[0].clientX;
        ts.lastY = e.touches[0].clientY;
        // Where the finger landed, kept for the whole gesture — lastX/lastY move every frame and
        // cannot answer "how far has this drag travelled". The yield rule below needs the origin.
        ts.startX = ts.lastX;
        ts.startY = ts.lastY;
        ts.yieldedH = false;
        ts.lastTime = Date.now();
        ts.velY = 0;
        ts.accumDelta = 0;
      }
    }, { capture: true, passive: true });

${TERMINAL_HORIZONTAL_YIELD_JS}
    targetSurface.addEventListener('touchmove', function(e) {
      // Counted before every early return below, including the yield guard: "did a touchmove reach
      // this document at all" is the whole question, and a guard that returns first would answer
      // it with silence indistinguishable from never being called.
      ts.moveCount = (ts.moveCount || 0) + 1;
      if (ts.moveCount === 1) {
        notify({ type: 'touch-probe', phase: 'first-move', touches: e.touches.length });
      }
      if (dispatcherShouldBlockSurface()) return;
      if (!term) return;
      if (e.touches.length === 1 && !ts.isPinching && shouldYieldHorizontal(e.touches[0])) {
        ts.yieldedH = true;
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      if (e.touches.length === 2) {
        ts.isPinching = true;
        var dist = getDistance(e.touches[0], e.touches[1]);
        var mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        var my = (e.touches[0].clientY + e.touches[1].clientY) / 2;

        var ratio = dist / ts.pinchDist;
        userScale = clampUserScale(ts.pinchScale * ratio);

        var total = getTotalScale();
        panX = mx - ts.pinchSurfX * total;
        panY = my - ts.pinchSurfY * total;
        clampPan();
        updateTransform();

      } else if (e.touches.length === 1 && !ts.isPinching) {
        var x = e.touches[0].clientX, y = e.touches[0].clientY;
        var now = Date.now(), dt = now - ts.lastTime;

        // Why: pan horizontally only when content overflows the viewport (larger
        // than fit) — same check clampPan() uses. Vertical always drives buffer
        // scroll so scrollback stays reachable at any text size; calling the
        // never-defined contentWiderThanViewport() here threw and killed all
        // single-finger scrolling, scrollback included.
        if (getContentWidth() * getTotalScale() > window.innerWidth + 1) {
          panX += x - ts.lastX;
          clampPan();
          updateTransform();
        }

        var deltaY = ts.lastY - y;
        ts.lastTime = now;
        if (shouldRouteScrollToTerminalInput()) {
          updateTouchVelocity(deltaY, dt);
          resetSmoothScrollOffset();
          var effectiveCellH = getCellHeight() * getTotalScale();
          ts.accumDelta += deltaY;
          var lines = Math.trunc(ts.accumDelta / effectiveCellH);
          if (lines !== 0) {
            ts.accumDelta -= lines * effectiveCellH;
            routeScrollLines(lines, x, y);
          }
        } else {
          if (enqueueNormalBufferScrollDelta(deltaY)) {
            updateTouchVelocity(deltaY, dt);
          } else {
            ts.velY = 0;
          }
        }
        ts.lastX = x;
        ts.lastY = y;
      }
    }, { capture: true, passive: false });

`
