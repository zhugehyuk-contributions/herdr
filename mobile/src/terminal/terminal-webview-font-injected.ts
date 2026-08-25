// Not from orca — orca's terminal document keeps the system monospace stack, and this file is the
// one place herdr departs from it. The mockup's single non-negotiable typographic fact is JetBrains
// Mono everywhere (`.prd/assets/mockup.html:14,863`), and after fd42c472/d2c696b7 swept the React
// Native side the 12차 iOS QA round measured the one surface that was still not it: the terminal
// itself, painting a zoomed `0` with no centre dot (`.prd/09-review-followups.md` §WW). `expo-font`
// cannot reach it — it registers faces with the native text system, and the WebView document
// resolves families from its own document. So the document embeds the face.
//
// ⛔ Both exports below are template literals end to end (same hazard as `terminal-webview-html.ts`
// and every `*-injected.ts` sibling): a backtick in a comment inside them terminates the string and
// the file stops parsing somewhere else entirely. Quote identifiers bare.
import {
  JETBRAINS_MONO_BOLD_DATA_URL,
  JETBRAINS_MONO_REGULAR_DATA_URL
} from './terminal-webview-font.generated'

/** The family name the `@font-face` rules declare and xterm's fontFamily leads with. */
export const TERMINAL_FONT_FAMILY = 'JetBrains Mono'

/**
 * The two weights the terminal renders with, and therefore the two the loader waits for. They are
 * declared here rather than inline in the Terminal options so that "the weights xterm asks for" and
 * "the weights this document embedded and waited for" cannot drift apart silently.
 */
export const TERMINAL_FONT_WEIGHT = '300'
export const TERMINAL_FONT_WEIGHT_BOLD = '500'

/**
 * Why weight *ranges* rather than the faces' own 400/700: xterm asks for 300 and 500, and CSS font
 * matching would hand both of those to the 400 face (for a desired weight in [400,500] it searches
 * downwards before upwards), collapsing bold into regular — every TUI that leans on bold for
 * emphasis would lose it. The ranges say what the document means instead: everything up to regular
 * is the Regular face, everything above it is the Bold face. Two files, both weights covered, no
 * synthesis anywhere.
 *
 * `font-display: block` because the terminal is gated on the load anyway (see the loader below):
 * there is no first paint to flash, and block keeps a slow decode from painting one frame of
 * fallback text at the wrong advance.
 */
export const TERMINAL_FONT_FACE_CSS = `
  @font-face {
    font-family: '${TERMINAL_FONT_FAMILY}';
    font-style: normal;
    font-weight: 100 400;
    font-display: block;
    src: url('${JETBRAINS_MONO_REGULAR_DATA_URL}') format('truetype');
  }
  @font-face {
    font-family: '${TERMINAL_FONT_FAMILY}';
    font-style: normal;
    font-weight: 500 900;
    font-display: block;
    src: url('${JETBRAINS_MONO_BOLD_DATA_URL}') format('truetype');
  }
`

/**
 * Font readiness, injected into the WebView IIFE. The ordering it exists to guarantee: xterm
 * measures its cell box once, at term.open(), from whatever face the document can resolve at that
 * instant, and *everything* downstream is arithmetic on that number — the fit scale, the pan
 * clamps, the tap-to-cell mapping, the mouse report columns. Open before the embedded face has
 * decoded and the grid is frozen on fallback metrics for the life of the document, which is the
 * failure this whole file is here to prevent.
 */
export const TERMINAL_FONT_LOADER_JS = `
  var TERMINAL_FONT_FAMILY = ${JSON.stringify(TERMINAL_FONT_FAMILY)};
  var TERMINAL_FONT_WEIGHT = ${JSON.stringify(TERMINAL_FONT_WEIGHT)};
  var TERMINAL_FONT_WEIGHT_BOLD = ${JSON.stringify(TERMINAL_FONT_WEIGHT_BOLD)};
  // The size in a font-load spec is required grammar, not a selector — face matching ignores it —
  // so it is stated once here and has nothing to do with BASE_FONT_PX or the text-size presets.
  var TERMINAL_FONT_LOAD_SPECS = [
    TERMINAL_FONT_WEIGHT + ' 13px "' + TERMINAL_FONT_FAMILY + '"',
    TERMINAL_FONT_WEIGHT_BOLD + ' 13px "' + TERMINAL_FONT_FAMILY + '"'
  ];
  // Why a ceiling: the faces are data URIs that are already in memory, so this settles in the same
  // frame on any engine that implements the API. If one never settles, the terminal still has to
  // open — a terminal on fallback metrics beats a permanently blank pane.
  var TERMINAL_FONT_LOAD_TIMEOUT_MS = 3000;
  var terminalFontReady = false;
  var terminalFontWaiters = [];

  function releaseTerminalFontWaiters() {
    if (terminalFontReady) return;
    terminalFontReady = true;
    var waiters = terminalFontWaiters;
    terminalFontWaiters = [];
    for (var i = 0; i < waiters.length; i++) waiters[i]();
  }

  function whenTerminalFontReady(callback) {
    if (terminalFontReady) {
      callback();
      return;
    }
    terminalFontWaiters.push(callback);
  }

  function beginTerminalFontLoad() {
    var fonts = document.fonts;
    // No CSS Font Loading API (an old WebView under the Chrome 74 floor, or a test document): there
    // is nothing to wait on. The @font-face rules are still declared, so the document resolves them
    // the classic way when it first paints.
    if (!fonts || typeof fonts.load !== 'function' || typeof Promise === 'undefined') {
      releaseTerminalFontWaiters();
      return;
    }
    var loads = [];
    for (var i = 0; i < TERMINAL_FONT_LOAD_SPECS.length; i++) {
      // Why name both specs instead of awaiting fonts.ready: a face nothing has painted yet is
      // simply not loaded, and fonts.ready resolves happily without ever decoding it.
      try { loads.push(fonts.load(TERMINAL_FONT_LOAD_SPECS[i])); } catch (e) {}
    }
    setTimeout(releaseTerminalFontWaiters, TERMINAL_FONT_LOAD_TIMEOUT_MS);
    // Either outcome releases the document: a face that failed to decode will not decode later, and
    // the fallback stack behind it is still monospace.
    Promise.all(loads).then(releaseTerminalFontWaiters, releaseTerminalFontWaiters);
  }
`
