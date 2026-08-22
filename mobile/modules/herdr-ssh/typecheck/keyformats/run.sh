#!/usr/bin/env bash
# Load REAL ssh-keygen keys through HerdrSshSession.kt's own key-loading code.
#
# Why this exists: `dial` used to build `OpenSSHKeyFile()` directly. That provider reads only the
# classic PEM container, and every key `ssh-keygen` has produced since OpenSSH 7.8 is the
# openssh-key-v1 one (`BEGIN OPENSSH PRIVATE KEY`) — so the key never loaded, sshj offered the
# server no publickey method, and the device reported `UserAuthException: Exhausted available
# authentication methods`, which reads as "the server rejected us" when in fact we never asked.
# Every other gate stayed green through all of that: ../run.sh only type-checks (both spellings
# compile), and no test in this repo ever fed the module a real key. This is that hole, closed.
#
# WHAT THIS PROVES: the key-loading call as written in HerdrSshSession.kt (extracted from it, not
# retyped) parses all four shapes `ssh-keygen` emits — ed25519 and RSA in openssh-key-v1, RSA in
# classic PEM (`-m PEM`), and an encrypted ed25519 — reports the right key type for each, hands back
# a usable private key, and still refuses the encrypted one when the passphrase is withheld.
#
# WHAT THIS DOES NOT PROVE, and do not claim it does:
#   1. Nothing about the server. No socket is opened. That a key parses says nothing about whether
#      sshd has it in `authorized_keys` or accepts its algorithm (an RSA key with sha1 signatures is
#      refused by modern sshd and would parse perfectly here).
#   2. This is not a build and not a device. Desktop JVM, real jars, no Android SDK, no dex. The
#      Android provider set is the same sshj `DefaultConfig`, but the BouncyCastle swap in
#      `BouncyCastleSetup` exists precisely because the platform below differs; `./gradlew` and a
#      device remain the only things that can speak for Android.
#   3. Only `dial`'s key-loading block runs. The rest of the file is ../run.sh's business.
set -euo pipefail
cd "$(dirname "$0")"
# Same cache and maven base as ../run.sh — one jar dir for the module, and ../.gitignore already
# covers it. asn-one is the one jar the type-check harness does not need: classic-PEM parsing reaches
# for it at runtime only, and without it `-m PEM` dies with
# `NoClassDefFoundError: com/hierynomus/asn1/encodingrules/ASN1Decoder` instead of loading.
CACHE="${HERDR_KT_CACHE:-$PWD/../.cache}"; mkdir -p "$CACHE"
M=https://repo1.maven.org/maven2
declare -a JARS=(
  "com/hierynomus/sshj/0.40.0/sshj-0.40.0.jar"
  "org/slf4j/slf4j-api/2.0.16/slf4j-api-2.0.16.jar"
  "net/i2p/crypto/eddsa/0.3.0/eddsa-0.3.0.jar"
  "org/bouncycastle/bcprov-jdk18on/1.78/bcprov-jdk18on-1.78.jar"
  "org/bouncycastle/bcpkix-jdk18on/1.78/bcpkix-jdk18on-1.78.jar"
  "com/hierynomus/asn-one/0.6.0/asn-one-0.6.0.jar"
)
CP=""
for j in "${JARS[@]}"; do
  f="$CACHE/$(basename "$j")"
  [ -f "$f" ] || curl -sSL --max-time 120 -o "$f" "$M/$j"
  CP="$CP${CP:+:}$f"
done
# Unlike ../run.sh this harness also *runs* the classes, so it needs a JVM of its own: macOS ships a
# `/usr/bin/java` stub that only prints "No Java runtime present", and the homebrew kotlin wrappers
# supply JAVA_HOME to the compiler but not to us.
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
[ -x "$JAVA_HOME/bin/java" ] || { echo "no JDK at JAVA_HOME=$JAVA_HOME (brew install openjdk@17)" >&2; exit 1; }

SRC=../../android/src/main/java/dev/herdr/ssh
OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT

# The code under test is taken out of the real file, never copied. `HerdrSshConnectConfig` comes from
# HerdrSshModule.kt the same way ../run.sh takes it; the key-loading block comes from `dial` itself,
# bounded by the two lines around it. The end anchor is `authPublickey` and not the `loadKeys` call,
# deliberately: anchoring on the fix would make this extraction fail to compile under the buggy
# shape, and a gate that cannot express the bug it guards cannot catch its return.
{ echo "package dev.herdr.ssh"
  echo "import expo.modules.kotlin.records.Field"
  echo "import expo.modules.kotlin.records.Record"
  awk '/^class HerdrSshConnectConfig/,/^}/' "$SRC/HerdrSshModule.kt"
} > "$OUT/ConfigExtract.kt"
awk '/^    val passwordFinder =/{p=1} /client\.authPublickey\(/{p=0} p' "$SRC/HerdrSshSession.kt" \
  > "$OUT/block.kt"
grep -q 'val keys' "$OUT/block.kt" || {
  echo "keyformats: could not extract the key-loading block from HerdrSshSession.kt." >&2
  echo "  It is bounded by 'val passwordFinder =' and 'client.authPublickey(' and must end in a" >&2
  echo "  'val keys' the harness can return. Re-anchor this awk rather than testing a copy." >&2
  exit 1
}
{ echo "package dev.herdr.ssh"
  # The file's own sshj imports, so whatever provider the block names resolves the same way it does
  # in the module — including a hardcoded one, which must fail at runtime here, not at compile time.
  { grep '^import net\.schmizz' "$SRC/HerdrSshSession.kt"
    echo "import net.schmizz.sshj.SSHClient"
    echo "import net.schmizz.sshj.userauth.keyprovider.KeyProvider"
  } | sort -u
  echo "object RealKeyLoad {"
  echo "  fun load(client: SSHClient, config: HerdrSshConnectConfig): KeyProvider {"
  cat "$OUT/block.kt"
  echo "    return keys"
  echo "  }"
  echo "}"
} > "$OUT/RealKeyLoad.kt"

kotlinc -nowarn -cp "$CP" ../stubs/Record.kt "$OUT/ConfigExtract.kt" "$OUT/RealKeyLoad.kt" \
  KeyFormatProbe.kt -d "$OUT/classes"

# Fixtures are generated per run and die with the temp dir: a private key in the repo is a liability
# even when it is a throwaway, and secret scanners cannot tell the difference.
KEYS="$OUT/keys"; mkdir -p "$KEYS"
PASSPHRASE='herdr-keyformat-gate'
ssh-keygen -q -t ed25519 -N '' -C keyformat-gate -f "$KEYS/ed25519-v1"
ssh-keygen -q -t rsa -b 2048 -N '' -C keyformat-gate -f "$KEYS/rsa-v1"
# `-m PEM` is the only way to still get the pre-7.8 container, and it is why the old code worked for
# whoever wrote it and for nobody else.
ssh-keygen -q -t rsa -b 2048 -m PEM -N '' -C keyformat-gate -f "$KEYS/rsa-pem"
ssh-keygen -q -t ed25519 -N "$PASSPHRASE" -C keyformat-gate -f "$KEYS/ed25519-v1-passphrase"

# `kotlin` and not `java`: the runner puts kotlin-stdlib on the classpath itself. Finding that jar by
# hand is brittle (homebrew keeps it under libexec/lib, not next to the bin/ symlink) and getting it
# wrong is silent — java just reports `NoClassDefFoundError: kotlin/jvm/internal/Intrinsics`.
kotlin -cp "$CP:$OUT/classes" dev.herdr.ssh.KeyFormatProbeKt "$KEYS" "$PASSPHRASE"
echo "herdr-ssh: HerdrSshSession.kt loads all 4 ssh-keygen key formats against sshj 0.40.0"
