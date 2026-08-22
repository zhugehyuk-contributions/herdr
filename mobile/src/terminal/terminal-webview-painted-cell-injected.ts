// Not from orca. Grid width for the pan/fit maths, injected into the terminal WebView IIFE.
// It closes over term, terminalGeneration and getCellWidth().
//
// Why this exists (`.prd/09-review-followups.md` §P): xterm's `css.cell.width` is a *canvas*
// measurement. `CharSizeService`'s preferred strategy measures 'W' with `OffscreenCanvas
// .measureText`, and the DOM renderer's own correction for the deviation that introduces
// (`DomRenderer.ts:323-328`, `letter-spacing = css.cell.width - widthCache.get('W')`) reads the
// second number off a canvas as well. So when the canvas and the layout engine resolve the same
// font-family list to different faces — the Android case, where none of "SF Mono"/"Menlo"/… is
// installed — the deviation cancels out of the correction and reaches the paint: the grid box is
// sized 1630 CSS wide while the rows advance ~1700, and a pan clamped to 1630 can never bring the
// last ~9 of 213 columns on screen. The vertical axis has no equivalent: `DomRenderer.ts:152-154`
// *writes* height and line-height onto every row element, so the DOM is made to obey the number.
//
// The correction may not be a constant — how far the two disagree is a property of whichever font
// the device resolved, so a phone with different fonts installed would need a different one. Measure
// it instead, in the DOM, on the element that actually paints the rows, with 'W' (the character
// xterm itself measures) so the probe returns *exactly* `css.cell.width` whenever xterm's
// letter-spacing correction did work. And only ever widen: the WebGL renderer paints into a canvas
// it sizes from `css.cell.width`, which makes that metric the paint by construction, and it leaves
// no `.xterm-rows` to measure (the DOM renderer that owns it is disposed, `DomRenderer.ts:119`).
export const TERMINAL_PAINTED_CELL_JS = `
  var PAINTED_CELL_PROBE_RUN = 64;
  var PAINTED_CELL_FONT_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontKerning', 'fontFeatureSettings', 'fontVariationSettings', 'letterSpacing', 'textRendering'];
  var paintedCellProbe = { key: '', value: 0 };

  // Measured off the document body, not the row container: #terminal-surface carries the zoom
  // transform, and getBoundingClientRect() reports transformed pixels.
  function measurePaintedCellWidth(rows) {
    var probe = document.createElement('span');
    probe.setAttribute('data-herdr-cell-probe', '');
    probe.setAttribute('aria-hidden', 'true');
    var computed = window.getComputedStyle(rows);
    for (var i = 0; i < PAINTED_CELL_FONT_PROPS.length; i++) {
      var prop = PAINTED_CELL_FONT_PROPS[i];
      if (computed[prop]) probe.style[prop] = computed[prop];
    }
    probe.style.position = 'absolute';
    probe.style.top = '0';
    probe.style.left = '0';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    probe.textContent = new Array(PAINTED_CELL_PROBE_RUN + 1).join('W');
    document.body.appendChild(probe);
    var width = 0;
    try { width = probe.getBoundingClientRect().width; } catch (e) {}
    if (probe.parentNode) probe.parentNode.removeChild(probe);
    return width > 0 ? width / PAINTED_CELL_PROBE_RUN : 0;
  }

  // Cached against every input that can move the advance, all readable without a style flush:
  // a new terminal, xterm's font options, the letter-spacing correction, the metric itself.
  function getPaintedCellWidth() {
    if (!term || !term.element || !term.element.querySelector) return 0;
    var rows = term.element.querySelector('.xterm-rows');
    if (!rows) return 0;
    var options = term.options || {};
    var key = terminalGeneration + '|' + options.fontSize + '|' + options.fontFamily + '|' +
      options.fontWeight + '|' + rows.style.letterSpacing + '|' + getCellWidth();
    if (paintedCellProbe.key === key) return paintedCellProbe.value;
    paintedCellProbe = { key: key, value: measurePaintedCellWidth(rows) };
    return paintedCellProbe.value;
  }

  // Why the grid and not the DOM: cell width x cols is xterm's own layout width and stays right when
  // the widest painted row is short — term.element.scrollWidth would then clamp the pan before the
  // right-hand columns the cursor lives in. It stays the pre-renderer fallback.
  function getContentWidth() {
    if (!term) return 0;
    var cellW = Math.max(getCellWidth(), getPaintedCellWidth());
    if (cellW > 0 && term.cols > 0) return cellW * term.cols;
    return term.element ? term.element.scrollWidth : 0;
  }
`
