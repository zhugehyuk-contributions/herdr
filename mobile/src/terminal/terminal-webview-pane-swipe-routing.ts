// Not from orca — orca has no pane swipe (`../session/pane-swipe.ts` header).
//
// Extracted for the same reason `./terminal-webview-query-reply-routing.ts` was: `TerminalWebView`
// is at its `max-lines` budget, and a message router with a validation rule and a diagnostic is
// exactly the kind of thing that belongs beside it rather than inside it.
import type { PaneSwipeTranslation } from '../session/pane-swipe'

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Forwards a `pane-swipe` report from the document, or drops it and says so.
 *
 * On iOS the page is the only thing that receives a horizontal drag over the terminal
 * (`./terminal-webview-html.ts` touchend, `.prd/09-review-followups.md` §JJ), so it measures the
 * swipe; the decision — which pane is next — stays on the screen. This only forwards.
 *
 * The page is outside the trust boundary: this app serves the document, but what arrives at
 * `onMessage` is JSON the document wrote. A `translationX` of `"120"` or `null` would reach
 * `paneSwipeDirection`, whose own `Number.isFinite` guard rejects it *silently* — a swipe that does
 * nothing, indistinguishable from a swipe the page never sent.
 *
 * Which is why it logs both outcomes. The 9차 device round could confirm this path only through the
 * page's own `[touchProbe]` counters — nothing on the RN side said a word — and asked for the line
 * by name. It carries the numbers, so a `dx` under the commit distance reads as its own state
 * rather than as silence.
 */
export function routePaneSwipeMessage(
  msg: Record<string, unknown>,
  onPaneSwipe: ((translation: PaneSwipeTranslation) => void) | undefined
): void {
  const x = msg['translationX']
  const y = msg['translationY']
  const ok = isFiniteNumber(x) && isFiniteNumber(y)
  console.log(`[paneSwipeMsg] ok=${ok} dx=${String(x)} dy=${String(y)}`)
  if (isFiniteNumber(x) && isFiniteNumber(y)) {
    onPaneSwipe?.({ translationX: x, translationY: y })
  }
}
