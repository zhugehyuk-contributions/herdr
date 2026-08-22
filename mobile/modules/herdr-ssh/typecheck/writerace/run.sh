#!/usr/bin/env bash
# RUN HerdrSshSession.swift's attach/write path against a real ssh server, in this process.
#
# Why this exists: `attach` used to start the pump as a detached `Task` and return `true` at once,
# while the stdin writer is only handed over inside Citadel's `withExec` *closure* — which runs
# after `_executeCommandStream` has opened the channel and had the exec request acknowledged
# (Citadel 0.12.1 TTY.swift:456-476 and :307-341), two round trips later. Everything above the
# module writes on the statement after `openChannel` resolves: `ServerMessageChannel.open` sends the
# wire prelude (`packages/herdr-client-ts/src/transport.ts:848`) and `JsonApiClient.call` writes its
# request line (`packages/herdr-client-ts/src/jsonApi.ts:210`). A write that lost that race got
# `HerdrSshError.channelGone` -> "the ssh channel is no longer open" on screen, with an exec on the
# remote that opened, read zero bytes of stdin and closed. Measured on an iOS device 2026-08-23.
# ../ios/run.sh type-checks this same file and cannot see any of it: both shapes compile.
#
# WHAT THIS PROVES: the real `HerdrSshChannel` (compiled from the module's own source, not a copy),
# driven against Citadel's own `SSHServer` over loopback TCP with a real key exchange, real
# publickey auth, a real `CHANNEL_OPEN` and a real `exec` request, (1) is writable on the statement
# after `attach` returns — ten channels, ten times, with the bytes arriving at the server's stdin —
# (2) carries the command verbatim, one exec per channel, (3) delivers the remote's bytes back
# through `onData`, (4) tears the remote exec down when `close()` is called, and (5) still releases
# `attach` when the exec is refused outright, reporting it through `onClose` rather than hanging.
#
# WHAT THIS DOES NOT PROVE, and do not claim it does:
#   1. Not a build and not a device: macOS, SwiftPM, no iOS SDK, no Xcode, no simulator. It is the
#      same "macOS, not iOS" caveat ../ios/run.sh carries, and `pod install` remains the only thing
#      that speaks for the app target.
#   2. `HerdrSshModule.swift` is still NOT compiled here — only the `Record` is pulled in, by
#      extracting its real text, exactly as ../ios/run.sh does. The Expo `ModuleDefinition` DSL, and
#      therefore the `appContext` class of defect (commit 5b4f33ad), remains invisible to both.
#   3. The two Expo symbols are the stubs in Sources/ExpoModulesCore — the recording variant of
#      ../ios/Sources/ExpoModulesCore/Stubs.swift, whose declarations are diffed against it below.
#      They will not notice an upstream signature change any more than the originals will.
#   4. The window it opens is *narrower* than the app's, in two ways that pull in opposite
#      directions, so do not read the "10/10" as a frequency. Narrower: loopback, so the round trip
#      the old code had to lose is as short as it gets. Wider: the write is called from Swift
#      directly, while the app's goes JS-thread -> Expo `AsyncFunction` -> native queue after the
#      promise resolves, and those hops are the slack that let some writes on the device win (the
#      QA's two api-bridge channels did; the client-stream channel did not). What this asserts is
#      the contract — attach returned, therefore the write lands — not a probability.
#   5. Nothing about exit codes: Citadel never surfaces the remote's `exit-status` to this module
#      (../../.prd/06-open-decisions.md decision 7), so this probe does not assert one.
set -euo pipefail
cd "$(dirname "$0")"
SRC=../../ios

# The recording stub may add a hook, never a different call shape: if the type-check gate's stub
# moves, this harness would be running the module against an API that gate does not recognise.
# Compare the declarations, which are the whole of the contract the module sees.
# Only the declarations, never the bodies — the bodies are the whole point of this copy. `grep -o`
# stops at the opening brace, so a comment that merely names one of these does not match either.
sig() {
  grep -h -o -E \
    '(public func call\([^{]*|public func executeOnJavaScriptThread\([^{]*|public internal\(set\) weak var appContext[^{]*|open func sharedObjectWillRelease\([^{]*)' \
    "$1"
}
if ! diff <(sig ../ios/Sources/ExpoModulesCore/Stubs.swift) <(sig Sources/ExpoModulesCore/Stubs.swift) >/dev/null; then
  echo "writerace: Sources/ExpoModulesCore/Stubs.swift has drifted from ../ios's." >&2
  echo "  The recording stubs must keep the type-check gate's exact declarations." >&2
  diff <(sig ../ios/Sources/ExpoModulesCore/Stubs.swift) <(sig Sources/ExpoModulesCore/Stubs.swift) >&2 || true
  exit 1
fi

# The Record lives in HerdrSshModule.swift next to the Expo DSL that cannot be stubbed; take its
# real text, exactly as ../ios/run.sh does.
{ echo "import ExpoModulesCore"; echo "import Foundation"
  awk '/^struct HerdrSshConnectConfig: Record \{/,/^\}/' "$SRC/HerdrSshModule.swift"
} > Sources/WriteRaceProbe/ConfigExtract.swift
# HerdrSshSession.swift goes in whole and unedited: the code under test is the shipped file.
cp "$SRC/HerdrSshSession.swift" Sources/WriteRaceProbe/
swift run WriteRaceProbe
