#!/usr/bin/env bash
# RUN HerdrSshSession.kt's close path and assert the payload it hands to JS.
#
# Why this exists: `finish()` used to call `pumps.shutdownNow()` and then read `exitStatus` and the
# stderr transcript on the spot. Both reads are too early. One CHANNEL_EOF ends stdout and stderr
# together (sshj 0.40.0 SessionChannel.java:205-209) but each `ChannelInputStream` keeps its own
# buffer and still serves it afterwards (ChannelInputStream.java:94-98), so the stderr pump is
# normally still draining when the stdout pump reports EOF — and `shutdownNow()` interrupts it
# mid-drain (ChannelInputStream.java:106-111). `exit-status` is a separate channel request
# (SessionChannel.java:133-134) with no ordering against EOF, which is why sshj's own javadoc says
# "Always call close() first before inspecting the exit status" (Session.java:64-70).
# Downstream, `mobile/src/transport/channel-failure.ts` reads `exitCode === 127` as a *field* and
# matches `permission denied` / `publickey` in the stderr text; anything it cannot see falls through
# to `{kind:'transport', fatal:false}` and the app retries a refused key forever, on a phone.
# ../run.sh type-checks that file and cannot see any of this: both shapes compile.
#
# WHAT THIS PROVES: the real `HerdrSshChannel` (compiled from the module's own source, not a copy),
# driven through three scripted channel lifecycles, delivers exactly one `onClose` payload and that
# payload carries (1) the complete stderr transcript when the stderr stream still held buffered
# bytes at stdout's EOF, (2) the exit status when it arrives with the channel close rather than with
# the EOF, (3) whatever it did collect plus an `errorMessage` naming the bound it hit when the peer
# never closes the channel or a pump never ends — within that bound, not never.
# Both streams are real sshj `ChannelInputStream`s over a real `Window.Local`, so the buffering, EOF
# and interrupt semantics under test are sshj's code.
#
# WHAT THIS DOES NOT PROVE, and do not claim it does:
#   1. No socket, no sshd, no server. The packet *ordering* is scripted by this harness from sshj's
#      source and RFC 4254 §6.10 ("exit-status is sent before the channel closes", with no ordering
#      against EOF); a real server that sends the exit status before EOF would make the old code
#      look fine, which is exactly why the fix is anchored on sshj's contract and not on one sshd.
#   2. The stderr race is made deterministic by pacing the reads (see `PacedStream`). The pacing does
#      not create the loss — `finish()` did not wait for the stderr pump *at all*, so any nonzero
#      drain time lost bytes — but it does mean this check measures a fixed interleaving, not the
#      distribution of them. It cannot tell you how often the old code truncated on a real phone.
#   3. Not a build and not a device: desktop JVM, real jars, no Android SDK, no dex. The two Expo
#      symbols are the stubs in ../stubs (plus the recording `JavaScriptFunction` here, whose call
#      signature is diffed against the shared one below). `./gradlew :herdr-ssh:assembleDebug` and a
#      device remain the only things that can speak for Android.
#   4. The 20 s that `exec.close()` can spend awaiting the peer (`conn.getTimeoutMs()` =
#      `connectTimeoutMs`, HerdrSshModule.kt:32) is the *caller's* wait and predates this change;
#      the harness fakes it as 50 ms. What is asserted is only that `finish()` adds no wait of its
#      own to that caller.
set -euo pipefail
cd "$(dirname "$0")"
# Same cache and jar set as ../run.sh — one jar dir for the module, already gitignored.
CACHE="${HERDR_KT_CACHE:-$PWD/../.cache}"; mkdir -p "$CACHE"
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
# This harness runs the classes, so it needs a JVM of its own: macOS ships a `/usr/bin/java` stub
# that only prints "No Java runtime present", and the homebrew kotlin wrappers give JAVA_HOME to the
# compiler but not to us.
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
[ -x "$JAVA_HOME/bin/java" ] || { echo "no JDK at JAVA_HOME=$JAVA_HOME (brew install openjdk@17)" >&2; exit 1; }

SRC=../../android/src/main/java/dev/herdr/ssh
OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT

# The recording stub may add a hook, never a different call shape: if the shared stub's signature
# moves, this harness would be compiling the module against an API the type-check gate does not
# recognise. Compare the parameter list, which is the whole of the contract the module sees.
sig() { sed -n '/operator fun invoke(/,/appContext: AppContext/p' "$1"; }
if ! diff <(sig ../stubs/JavaScriptFunction.kt) <(sig stubs/JavaScriptFunction.kt) >/dev/null; then
  echo "closepayload: stubs/JavaScriptFunction.kt has drifted from ../stubs/JavaScriptFunction.kt." >&2
  echo "  The recording stub must keep the shared stub's exact invoke() signature." >&2
  diff <(sig ../stubs/JavaScriptFunction.kt) <(sig stubs/JavaScriptFunction.kt) >&2 || true
  exit 1
fi

# The Record lives in HerdrSshModule.kt next to the Expo DSL that cannot be stubbed; take its real
# text, exactly as ../run.sh does.
{ echo "package dev.herdr.ssh"
  echo "import expo.modules.kotlin.records.Field"
  echo "import expo.modules.kotlin.records.Record"
  awk '/^class HerdrSshConnectConfig/,/^}/' "$SRC/HerdrSshModule.kt"
} > "$OUT/ConfigExtract.kt"

# HerdrSshSession.kt goes in whole and unedited: the code under test is the shipped file, and the
# only substitutions are the two Expo symbols it cannot have here.
kotlinc -nowarn -cp "$CP" \
  ../stubs/AppContext.kt ../stubs/SharedObject.kt ../stubs/Record.kt \
  stubs/JavaScriptFunction.kt \
  "$OUT/ConfigExtract.kt" "$SRC/HerdrSshSession.kt" ClosePayloadProbe.kt \
  -d "$OUT/classes"

# `kotlin` and not `java`: the runner puts kotlin-stdlib on the classpath itself, and finding that
# jar by hand is brittle and silently wrong (NoClassDefFoundError: kotlin/jvm/internal/Intrinsics).
kotlin -cp "$CP:$OUT/classes" dev.herdr.ssh.ClosePayloadProbeKt
