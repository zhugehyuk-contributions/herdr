// Not from orca. Which of the two channels the phone actually dials — the whole of M2b's
// "`app.json` 경로는 개발 전용으로 강등" in one pure function plus the loader that feeds it.
import { readBundledRemotes } from './bundled-remotes'
import { loadStoredRemotes } from './remote-store'
import type { HerdrSshRemoteConfig, RejectedRemoteConfig } from './remote-config'

export type RemoteSource = 'stored' | 'bundled' | 'none'

export interface RemoteSelection {
  remotes: HerdrSshRemoteConfig[]
  source: RemoteSource
  /** `app.json` entries deliberately not dialled — reported so an ignored config is not a mystery. */
  ignoredBundled: number
}

/**
 * The keystore wins, and it wins *whole* — not merged per id.
 *
 * A merge was the obvious alternative and it is wrong twice over. A bundled entry whose id the user
 * never chose would keep being dialled after they configured their own fleet, with a key they
 * cannot see, cannot edit and cannot delete from the settings screen (it is not in the store). And
 * "the phone dials what the settings screen shows" is the only rule a user can hold in their head;
 * a union of two invisible lists is not.
 */
export function selectRemotes(input: {
  stored: HerdrSshRemoteConfig[]
  bundled: HerdrSshRemoteConfig[]
  allowBundledFallback: boolean
}): RemoteSelection {
  if (input.stored.length > 0) {
    return { remotes: input.stored, source: 'stored', ignoredBundled: input.bundled.length }
  }
  if (input.allowBundledFallback && input.bundled.length > 0) {
    return { remotes: input.bundled, source: 'bundled', ignoredBundled: 0 }
  }
  return { remotes: [], source: 'none', ignoredBundled: input.bundled.length }
}

/**
 * True in a Metro dev build, false in a release bundle.
 *
 * Why a release build ignores `app.json` outright rather than merely preferring the keystore: the
 * entry it would dial carries a key that is *in the binary every user installs*. A shipped app that
 * silently authenticates with a key nobody chose is a credential leak wearing a config's clothes,
 * and the user has no way to remove it — the settings screen can only delete what the keystore
 * holds. The cost of being wrong the other way is a developer who has to add their lab host once
 * through the UI.
 *
 * `__DEV__` is defined by Metro's prelude in **every** bundle it produces —
 * `metro/src/lib/getPreludeCode.js:15` emits `__DEV__=${String(isDev)}` unconditionally — so the
 * only environment where it is missing is a non-Metro one, i.e. this repo's Vitest and Node
 * harnesses, and those are development.
 */
export function bundledFallbackAllowed(): boolean {
  const flag = (globalThis as { __DEV__?: boolean }).__DEV__
  return flag !== false
}

export interface RemoteInventory extends RemoteSelection {
  /** Every remote the keystore holds, whether or not it won. */
  stored: HerdrSshRemoteConfig[]
  /** Every `app.json` remote this build can see, whether or not it is allowed to dial one. */
  bundled: HerdrSshRemoteConfig[]
  /** Entries either channel dropped, prefixed by the channel that dropped them. */
  rejected: RejectedRemoteConfig[]
  /** False when this build has no keystore — the settings screen says so instead of failing later. */
  storeAvailable: boolean
  /** False in a release bundle: `app.json` is not read there at all. */
  bundledFallbackAllowed: boolean
}

export async function loadRemoteInventory(): Promise<RemoteInventory> {
  const [stored, bundled] = await Promise.all([loadStoredRemotes(), readBundledRemotes()])
  const allowBundledFallback = bundledFallbackAllowed()
  const selection = selectRemotes({
    stored: stored.remotes,
    bundled: bundled.remotes,
    allowBundledFallback
  })
  return {
    ...selection,
    stored: stored.remotes,
    bundled: bundled.remotes,
    rejected: [
      ...stored.rejected.map((entry) => ({ ...entry, reason: `keystore ${entry.reason}` })),
      ...bundled.rejected.map((entry) => ({ ...entry, reason: `app.json ${entry.reason}` }))
    ],
    storeAvailable: stored.available,
    bundledFallbackAllowed: allowBundledFallback
  }
}
