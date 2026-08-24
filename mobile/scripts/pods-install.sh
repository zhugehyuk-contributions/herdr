#!/usr/bin/env bash
# `pod install` for this app. Use this instead of a bare `pod install`.
#
# CocoaPods' SPM integration (HerdrSsh.podspec's `spm_dependency`) allocates ids for its four SPM
# objects from a counter starting at zero, colliding with the Pods project's own project object,
# main group and products group once enough pods are installed — expo-camera, which condition 5
# needs, is enough. The result is a Pods.xcodeproj Xcode refuses to open ("The project 'Pods' is
# damaged"), no pod target builds, and the herdr target fails with every modulemap missing.
# Measured 2026-08-24; see .prd/12-qr-pairing.md.
#
# So: install once WITHOUT the SPM declarations to capture the objects that would be evicted, then
# install normally and put them back.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here/ios"

snapshot="$(mktemp -t pods-clean).pbxproj"
trap 'rm -f "$snapshot"' EXIT

echo "[pods-install] pass 1/2 — snapshot without SPM"
HERDR_SSH_SPM=0 pod install >/dev/null
cp Pods/Pods.xcodeproj/project.pbxproj "$snapshot"

echo "[pods-install] pass 2/2 — real install"
pod install >/dev/null

node "$here/scripts/repair-pods-spm-collision.mjs" \
  Pods/Pods.xcodeproj/project.pbxproj "$snapshot"

# The repair is the whole point of this script; a Pods project that still has no PBXProject would
# fail much later, during the app build, with an error that names none of this.
if ! grep -q "isa = PBXProject;" Pods/Pods.xcodeproj/project.pbxproj; then
  echo "[pods-install] FAILED: Pods.xcodeproj still has no PBXProject object" >&2
  exit 1
fi
echo "[pods-install] ok"
