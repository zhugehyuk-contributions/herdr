// Not from orca. The one file that touches `expo-modules-core`, kept to four statements so that
// "the native module is missing" and "the transport is broken" stay distinguishable.
//
// ⚠️ The import is **dynamic on purpose.** `expo-modules-core` re-exports `react-native`, which is
// Flow source; the test runner's transformer cannot parse it (measured 2026-08-22: `Flow is not
// supported` at `react-native/index.js:1`). A static import here would make every module that
// transitively reaches this file unloadable in the test environment — including `app/_layout.tsx`,
// which two existing suites mount (`src/app-shell/route-shell-mount.test.tsx`,
// `src/app-shell/agents-home-mount.test.tsx`). Deferring it to call time means a phone loads it and
// a test never does.
import type { NativeHerdrSsh } from './native-types'

/**
 * The native ssh module, or `null` when this build has none.
 *
 * `null` is the normal state today, not an error: Expo Go and any bundle built before the native
 * module landed have no `HerdrSsh`, and `requireOptionalNativeModule` is the API that says so
 * without throwing. The caller's response is to dial nobody, which is what
 * `app/_layout.tsx` did unconditionally before this module existed.
 */
export async function loadNativeHerdrSsh(): Promise<NativeHerdrSsh | null> {
  try {
    const core = await import('expo-modules-core')
    return core.requireOptionalNativeModule<NativeHerdrSsh>('HerdrSsh')
  } catch {
    // Not a phone: `expo-modules-core` could not even be loaded. Same answer, different reason.
    return null
  }
}
