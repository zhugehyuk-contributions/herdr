// Ported from orca mobile/src/terminal/terminal-webview-query-reply-injected.ts
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
// Kept as one injectable unit so tests execute the same replay/generation gate
// that the WebView document runs, rather than a TypeScript reimplementation.
export const TERMINAL_QUERY_REPLY_JS = `
  var terminalDataRepliesEnabled = false;

  function resetTerminalDataReplyAuthority() {
    terminalDataRepliesEnabled = false;
  }

  function resumeTerminalDataReplyAuthority() {
    terminalDataRepliesEnabled = true;
  }

  function forwardTerminalDataReply(data) {
    if (terminalDataRepliesEnabled) notify({ type: 'terminal-data', bytes: data });
  }

  function enqueueTerminalDataReplyBoundary(gen) {
    enqueueWriteBoundary(function() {
      if (gen === terminalGeneration) terminalDataRepliesEnabled = true;
    });
  }

  function attachTerminalQueryReplyBridge(term, gen) {
    // Why: parser replies require stdin enabled, but mobile input is owned by
    // native controls. Keep xterm's textarea inert for touch/hardware keys.
    try {
      term.attachCustomKeyEventHandler(function() { return false; });
      if (term.textarea) {
        term.textarea.readOnly = true;
        term.textarea.tabIndex = -1;
        term.textarea.setAttribute('inputmode', 'none');
      }
    } catch (e) {}
    try {
      termObserverDisposables.push(term.onData(function(data) {
        forwardTerminalDataReply(data);
      }));
    } catch (e) {}
    // Why: live output can queue before initial replay finishes. Enable replies
    // at the replay boundary so those live queries are answered, never replayed ones.
    enqueueTerminalDataReplyBoundary(gen);
  }
`
