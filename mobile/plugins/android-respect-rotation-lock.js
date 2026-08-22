// Ported from orca mobile/plugins/android-respect-rotation-lock.js
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins')

// Why: Expo's top-level `orientation` only emits portrait/landscape/unspecified.
// "unspecified" still auto-rotates on many Android devices even when the system
// rotation lock is on. "fullUser" honors the user's auto-rotate setting (no
// rotation when locked) while still allowing every orientation when unlocked —
// matching the iOS UISupportedInterfaceOrientations behavior. iOS is untouched.
const ANDROID_SCREEN_ORIENTATION = 'fullUser'

module.exports = function withAndroidRespectRotationLock(config) {
  return withAndroidManifest(config, (cfg) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults)
    activity.$['android:screenOrientation'] = ANDROID_SCREEN_ORIENTATION
    return cfg
  })
}
