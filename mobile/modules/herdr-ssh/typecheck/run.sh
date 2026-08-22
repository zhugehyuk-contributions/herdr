#!/usr/bin/env bash
# Type-check HerdrSshSession.kt against the REAL sshj, with no Android SDK.
#
# Why this exists: this module shipped for weeks with zero compilations, and the first thing a
# compiler said about it was that `keys.init(pem, null, { ... })` does not compile — `PasswordFinder`
# has two abstract methods, so Kotlin SAM conversion does not apply. Reading the code did not catch
# it; reading sshj's source did, and only a compiler proved it. Keep that proof re-runnable.
#
# WHAT THIS PROVES: every line of HerdrSshSession.kt type-checks against sshj 0.40.0's real API —
# the ssh calls, the stream/threading code, Kotlin null-safety, the whole 200+ lines of logic.
#
# WHAT THIS DOES NOT PROVE, and do not claim it does:
#   1. HerdrSshModule.kt is NOT compiled here. It is almost entirely Expo's `ModuleDefinition` DSL,
#      whose overload machinery cannot be stubbed faithfully; a loose stub would go green on code
#      real Expo rejects, which is worse than no check. Only the Record is pulled in, verbatim.
#      That file IS compiled for real by `./gradlew :herdr-ssh:assembleDebug` (needs the Android SDK
#      and JDK 17). This harness is the fast pre-check that needs neither; gradle is the real gate.
#   2. The three Expo symbols are stubs (typecheck/stubs/), matched by hand to expo-modules-core.
#      If Expo changes those signatures this harness will not notice. Re-derive on Expo upgrades.
#   3. This is not a build. No Android SDK, no aapt, no dex, no device. `./gradlew` remains the
#      only thing that can say the module builds.
set -euo pipefail
cd "$(dirname "$0")"
CACHE="${HERDR_KT_CACHE:-$PWD/.cache}"; mkdir -p "$CACHE"
M=https://repo1.maven.org/maven2
declare -a JARS=(
  "com/hierynomus/sshj/0.40.0/sshj-0.40.0.jar"
  "org/slf4j/slf4j-api/2.0.16/slf4j-api-2.0.16.jar"
  "net/i2p/crypto/eddsa/0.3.0/eddsa-0.3.0.jar"
  "org/bouncycastle/bcprov-jdk18on/1.78/bcprov-jdk18on-1.78.jar"
  "org/bouncycastle/bcpkix-jdk18on/1.78/bcpkix-jdk18on-1.78.jar"
)
CP=""
for j in "${JARS[@]}"; do
  f="$CACHE/$(basename "$j")"
  [ -f "$f" ] || curl -sSL --max-time 120 -o "$f" "$M/$j"
  CP="$CP${CP:+:}$f"
done
SRC=../android/src/main/java/dev/herdr/ssh
OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT
# The Record lives in HerdrSshModule.kt next to the DSL we cannot stub; take its real text, not a copy.
{ echo "package dev.herdr.ssh"
  echo "import expo.modules.kotlin.records.Field"
  echo "import expo.modules.kotlin.records.Record"
  awk '/^class HerdrSshConnectConfig/,/^}/' "$SRC/HerdrSshModule.kt"
} > "$OUT/ConfigExtract.kt"
kotlinc -nowarn -cp "$CP" stubs/*.kt "$OUT/ConfigExtract.kt" "$SRC/HerdrSshSession.kt" -d "$OUT/classes"
test -f "$OUT/classes/dev/herdr/ssh/HerdrSshConnection.class"
echo "herdr-ssh: HerdrSshSession.kt type-checks against sshj 0.40.0"
