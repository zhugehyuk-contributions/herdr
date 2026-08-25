// Not from orca. Where a private key lives once a user has typed one in: the platform keystore, and
// nowhere else.
//
// What it replaces: until M2b the only channel was `app.json`'s `expo.extra.herdrRemotes`, so a
// working phone build meant an OpenSSH private key sitting in a committed file and shipped inside
// the APK (2026-08-23: wiring one QA lab host put a plaintext key in the working tree, one
// `git add -A` from being permanent). That channel is now `./bundled-remotes.ts` and development
// only; this is the durable one.
//
// The four rules this file exists to hold:
//   1. The key goes to `expo-secure-store` and to nothing else. AsyncStorage is plaintext on both
//      platforms and is used here only for the install marker below, which is not a secret.
//   2. Nothing here logs. Not the value, not a redacted value, not "saving key for host X" —
//      `console` on a device is `logcat`/Console.app, and a crash reporter reads breadcrumbs.
//   3. Failures name the remote, never the payload (`parseRemoteConfig`'s `reason` is paths only).
//   4. Callers that only need to *describe* a remote get `loadStoredRemoteSummaries`, which has no
//      key field at all — so the settings screen cannot leak what it never receives.
//
// ⚠️ Both `import()`s are dynamic, for the reason `./native-module.ts` explains at length: these
// packages reach `react-native`, which is Flow source the test runner cannot parse, and a static
// import would make `app/_layout.tsx` unloadable in three existing suites.
// `modules/herdr-ssh/test/bundle-contract.test.ts` enforces it.
import {
  parseRemoteConfig,
  type HerdrSshRemoteConfig,
  type RejectedRemoteConfig
} from './remote-config'
import { describePrivateKey, type PrivateKeyDescriptor } from './private-key-format'

/**
 * SecureStore keys are `/^[\w.-]+$/`
 * (`node_modules/expo-secure-store/build/SecureStore.js:150`) — no `:`, so this is not the
 * `herdr:`-prefixed spelling `src/storage/sidebar-width.ts` uses for AsyncStorage.
 */
const INDEX_KEY = 'herdr.remotes.index.v1'
const ENTRY_PREFIX = 'herdr.remote.v1.'

/**
 * AsyncStorage, deliberately: this marker has to die with the app, and on iOS a keychain entry does
 * not (see `purgeIfFreshInstall`). It holds a timestamp, never a secret.
 */
const INSTALL_MARKER_KEY = 'herdr:secureStoreInstalledAt'

/** An id has to survive being concatenated into a keystore key, so it is bounded to that charset. */
export const STORED_REMOTE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** Exactly the surface used here — declared rather than imported, so the import stays dynamic. */
interface SecureStoreApi {
  getItemAsync(key: string): Promise<string | null>
  setItemAsync(
    key: string,
    value: string,
    options?: { keychainAccessible?: unknown }
  ): Promise<void>
  deleteItemAsync(key: string): Promise<void>
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY?: unknown
}

interface AsyncStorageApi {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
}

async function secureStore(): Promise<SecureStoreApi | null> {
  try {
    const module = await import('expo-secure-store')
    return module as unknown as SecureStoreApi
  } catch {
    // Not a phone. Same answer `loadNativeHerdrSsh` gives, for the same reason.
    return null
  }
}

async function appStorage(): Promise<AsyncStorageApi | null> {
  try {
    const module = await import('@react-native-async-storage/async-storage')
    return module.default as unknown as AsyncStorageApi
  } catch {
    return null
  }
}

/**
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, and each half is a decision.
 *
 * `AFTER_FIRST_UNLOCK` rather than `WHEN_UNLOCKED`: the dial happens at launch, and M5's push wake
 * is explicitly a *phone in a pocket* case — a key readable only while the screen is unlocked would
 * turn "notification, tap, see the pane" into an auth failure.
 * `THIS_DEVICE_ONLY`: an ssh private key must not ride an encrypted backup onto a new phone.
 * Android ignores the option entirely (its store is SharedPreferences + Keystore).
 */
function writeOptions(store: SecureStoreApi): { keychainAccessible?: unknown } {
  const accessible = store.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
  return accessible === undefined ? {} : { keychainAccessible: accessible }
}

const entryKey = (id: string): string => `${ENTRY_PREFIX}${id}`

export interface StoredRemoteInventory {
  remotes: HerdrSshRemoteConfig[]
  /** One per indexed id that could not be read back. `index` is its position in the index. */
  rejected: RejectedRemoteConfig[]
  /** False when this build has no keystore at all — not a phone, or an Expo Go without the module. */
  available: boolean
}

/** The full configs, key included. Only the dialler should ask for these. */
export async function loadStoredRemotes(): Promise<StoredRemoteInventory> {
  const store = await secureStore()
  if (store === null) {
    return { remotes: [], rejected: [], available: false }
  }
  let ids: string[]
  try {
    ids = await readIndex(store)
  } catch {
    // The package loaded but the platform behind it did not answer (no keychain, a locked device,
    // Expo Go without the native half). Reported as unavailable rather than as an empty list: the
    // settings screen says so up front instead of letting every save fail one at a time.
    return { remotes: [], rejected: [], available: false }
  }
  const remotes: HerdrSshRemoteConfig[] = []
  const rejected: RejectedRemoteConfig[] = []
  for (const [index, id] of ids.entries()) {
    const raw = await store.getItemAsync(entryKey(id)).catch(() => null)
    if (raw === null) {
      rejected.push({ index, reason: `${id}: nothing stored under this id` })
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      rejected.push({ index, reason: `${id}: stored entry is not JSON` })
      continue
    }
    const parsed = parseRemoteConfig(value)
    if (parsed.ok) {
      remotes.push(parsed.config)
    } else {
      rejected.push({ index, reason: `${id}: ${parsed.reason}` })
    }
  }
  return { remotes, rejected, available: true }
}

/**
 * A remote as a screen may hold it: everything except the secret.
 *
 * This is the whole reason the settings screen can be trusted with a list of remotes — it is not
 * trusted with the keys. `key` describes the stored key (`./private-key-format.ts`) without
 * returning a byte of it, which is what lets the screen say "ed25519, unencrypted" and warn that
 * iOS will refuse an RSA one.
 */
export interface StoredRemoteSummary {
  id: string
  name: string
  host: string
  port: number
  username: string
  hostKeySha256: string | null
  allowUnknownHostKey: boolean
  herdrBinary: string | null
  session: string | null
  /**
   * mockup #7. Resolved, not optional — absent in the store means `local`
   * (`./remote-config.ts`), and a summary that passed the ambiguity on would make the settings
   * form render a segmented control with neither segment selected.
   */
  keybindings: NonNullable<HerdrSshRemoteConfig['keybindings']>
  hasPassphrase: boolean
  key: PrivateKeyDescriptor
}

export interface StoredRemoteSummaries {
  summaries: StoredRemoteSummary[]
  rejected: RejectedRemoteConfig[]
  available: boolean
}

export async function loadStoredRemoteSummaries(): Promise<StoredRemoteSummaries> {
  const { remotes, rejected, available } = await loadStoredRemotes()
  return { summaries: remotes.map(summariseRemote), rejected, available }
}

/**
 * Exported for the one other caller that holds full configs and must not keep them: the settings
 * screen, which reads `app.json`'s development remotes through `./bundled-remotes.ts` and turns
 * them into rows. It summarises them on arrival rather than holding them in component state.
 */
export function summariseRemote(config: HerdrSshRemoteConfig): StoredRemoteSummary {
  return {
    id: config.id,
    name: config.name ?? config.id,
    host: config.host,
    port: config.port,
    username: config.username,
    hostKeySha256: config.hostKeySha256 ?? null,
    allowUnknownHostKey: config.allowUnknownHostKey ?? false,
    herdrBinary: config.herdrBinary ?? null,
    session: config.session ?? null,
    keybindings: config.keybindings ?? 'local',
    hasPassphrase: (config.passphrase ?? '').length > 0,
    key: describePrivateKey(config.privateKey)
  }
}

/** Adds or replaces one remote, key included. */
export async function saveStoredRemote(config: HerdrSshRemoteConfig): Promise<void> {
  assertStorableId(config.id)
  const store = await requireSecureStore()
  // Entry first, then the index: a crash in between leaves an entry nothing points at (invisible,
  // overwritten by the next save with that id) rather than an index row pointing at nothing.
  await store.setItemAsync(entryKey(config.id), JSON.stringify(config), writeOptions(store))
  const ids = await readIndex(store)
  if (!ids.includes(config.id)) {
    await writeIndex(store, [...ids, config.id])
  }
  notify()
}

/** A remote as the settings form knows it — the fields a user edits, and none of the secrets. */
export type StoredRemoteEdit = Omit<HerdrSshRemoteConfig, 'privateKey' | 'passphrase'>

/**
 * Edits everything except the key material, which is read from the existing entry and put back
 * unchanged.
 *
 * Why the key *and* the passphrase travel together: a passphrase is meaningless apart from the key
 * it decrypts, so "keep the key" has to mean "keep the pair". Changing either is a re-entry of both
 * through `saveStoredRemote`.
 */
export async function updateStoredRemote(edit: StoredRemoteEdit): Promise<void> {
  assertStorableId(edit.id)
  const store = await requireSecureStore()
  const raw = await store.getItemAsync(entryKey(edit.id))
  if (raw === null) {
    throw new Error(`no stored remote "${edit.id}" to update`)
  }
  const existing = parseRemoteConfig(JSON.parse(raw) as unknown)
  if (!existing.ok) {
    throw new Error(`stored remote "${edit.id}" cannot be read back: ${existing.reason}`)
  }
  const merged: HerdrSshRemoteConfig = {
    ...edit,
    privateKey: existing.config.privateKey,
    ...(existing.config.passphrase === undefined ? {} : { passphrase: existing.config.passphrase })
  }
  await saveStoredRemote(merged)
}

export async function deleteStoredRemote(id: string): Promise<void> {
  const store = await requireSecureStore()
  // Index first here, for the mirror of the reason above: the user asked for this remote to be
  // gone, so the half-done state has to be "not listed, key still encrypted at rest" and never
  // "listed, key already deleted".
  await writeIndex(
    store,
    (await readIndex(store)).filter((candidate) => candidate !== id)
  )
  await store.deleteItemAsync(entryKey(id))
  notify()
}

export async function clearStoredRemotes(): Promise<void> {
  const store = await secureStore()
  if (store === null) {
    return
  }
  // A keystore that cannot be read has nothing to clear, and this runs on the launch path
  // (`purgeIfFreshInstall` <- `app-connections.ts`), where a rejection would leave the app dialling
  // forever behind a spinner.
  let ids: string[]
  try {
    ids = await readIndex(store)
  } catch {
    return
  }
  await writeIndex(store, [])
  for (const id of ids) {
    await store.deleteItemAsync(entryKey(id))
  }
  if (ids.length > 0) {
    notify()
  }
}

export type FreshInstallOutcome = 'purged' | 'kept' | 'unavailable'

/**
 * Deletes keys that outlived the install that created them.
 *
 * M2b's third acceptance criterion is "앱 삭제 시 키가 같이 사라진다", and on iOS that is **false by
 * default**: Expo's own documentation says data written by `expo-secure-store` "will persist across
 * app uninstallations if the app is reinstalled with the same bundle ID", because keychain items
 * outlive the app container, while on Android it "will not be preserved upon app uninstallation"
 * (<https://docs.expo.dev/versions/latest/sdk/securestore/#data-persistence>). So the platform
 * alone cannot satisfy the criterion, and this closes the gap in the app.
 *
 * How it knows: the marker lives in AsyncStorage, which is inside the app container on both
 * platforms and therefore *is* deleted with the app. Marker absent + keychain entries present is
 * exactly the signature of a reinstall, and the response is to drop the inherited keys — the new
 * install's user has to re-enter them, which is the intended meaning of "delete the app".
 *
 * Order matters: the marker is written **before** anything is deleted. If that write keeps failing
 * the outcome is `kept`, i.e. a stale key survives — the alternative failure mode wipes a working
 * user's remotes on every launch, and only one of the two is recoverable by the user.
 */
export async function purgeIfFreshInstall(): Promise<FreshInstallOutcome> {
  const storage = await appStorage()
  if (storage === null) {
    return 'unavailable'
  }
  const marker = await storage.getItem(INSTALL_MARKER_KEY).catch(() => null)
  if (marker !== null) {
    return 'kept'
  }
  try {
    await storage.setItem(INSTALL_MARKER_KEY, new Date().toISOString())
  } catch {
    return 'kept'
  }
  await clearStoredRemotes()
  return 'purged'
}

async function requireSecureStore(): Promise<SecureStoreApi> {
  const store = await secureStore()
  if (store === null) {
    throw new Error('this build has no secure storage — a remote cannot be saved on it')
  }
  return store
}

function assertStorableId(id: string): void {
  if (!STORED_REMOTE_ID_PATTERN.test(id)) {
    throw new Error(
      'a remote id may contain letters, digits, ".", "-" and "_" only, and at most 64 of them'
    )
  }
}

/** Throws when the keystore itself is unreachable; a missing index is `[]`, not an error. */
async function readIndex(store: SecureStoreApi): Promise<string[]> {
  const raw = await store.getItemAsync(INDEX_KEY)
  if (raw === null) {
    return []
  }
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
  } catch {
    return []
  }
}

async function writeIndex(store: SecureStoreApi, ids: string[]): Promise<void> {
  await store.setItemAsync(INDEX_KEY, JSON.stringify(ids), writeOptions(store))
}

/**
 * "The store changed" as an external store, so a save re-dials without an app restart — M2b's first
 * acceptance criterion ("재빌드 없이 붙는다") is really "no restart either".
 *
 * A counter rather than the data: `useHerdrSshConnections` subscribes through
 * `useSyncExternalStore`, which needs a snapshot that is `Object.is`-stable between notifications,
 * and the remotes themselves are re-read asynchronously anyway.
 */
let revision = 0
const listeners = new Set<() => void>()

export function storedRemotesRevision(): number {
  return revision
}

export function subscribeStoredRemotes(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify(): void {
  revision += 1
  for (const listener of listeners) {
    listener()
  }
}
