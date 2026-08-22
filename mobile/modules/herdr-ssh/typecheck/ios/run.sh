#!/usr/bin/env bash
# Type-check HerdrSshSession.swift against the REAL Citadel, with no Xcode and no iOS SDK.
#
# Companion to ../run.sh (the Kotlin half). Same reason: this module shipped with zero compilations,
# and a compiler is the only thing that can say whether never-compiled code is real.
#
# WHAT THIS PROVES: HerdrSshSession.swift type-checks against Citadel 0.12.1's actual API — the
# connect/withExec/auth/host-key surface and all of the file's own logic — built for macOS.
#
# WHAT THIS DOES NOT PROVE:
#   1. HerdrSshModule.swift is NOT compiled. Like its Kotlin twin it is Expo's `ModuleDefinition`
#      DSL; a loose stub would go green on code real Expo rejects. Only the Record is pulled in,
#      by extracting its real text.
#   2. It builds for macOS, not iOS. Citadel is cross-platform and the file uses no UIKit, so the
#      Citadel surface is the same, but this is not an iOS build and does not replace `pod install`.
#   3. The Expo symbols under Sources/ExpoModulesCore are stubs hand-matched to expo-modules-core
#      (SharedObject.swift:13,28,33 · JavaScriptFunction.swift:6,27 · Records/Field.swift:5,41,59 ·
#      Records/Record.swift:5,14). They will not notice an upstream signature change.
#   4. Language mode is Swift 5, which is what the podspec ships. Under Swift 6 mode this file does
#      NOT compile: 16 `NSLock.lock()/unlock()` calls sit in async contexts and `noasync`
#      availability turns from warning into error. See ../../.prd/06-open-decisions.md decision 6.
set -euo pipefail
cd "$(dirname "$0")"
SRC=../../ios
mkdir -p Sources/HerdrSshCheck
{ echo "import ExpoModulesCore"; echo "import Foundation"
  awk '/^struct HerdrSshConnectConfig: Record \{/,/^\}/' "$SRC/HerdrSshModule.swift"
} > Sources/HerdrSshCheck/ConfigExtract.swift
cp "$SRC/HerdrSshSession.swift" Sources/HerdrSshCheck/
swift build
echo "herdr-ssh: HerdrSshSession.swift type-checks against Citadel 0.12.1"
