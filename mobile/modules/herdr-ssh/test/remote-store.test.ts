// Not from orca. The receipt for the security half of M2b: a private key the user types into the
// app reaches the platform keystore and *nothing else* — not `app.json`, not AsyncStorage, not a
// console line, not an error message.
//
// The mocks below stand in for the two stores, and they are deliberately plain `Map`s rather than
// `vi.fn()` recorders: every assertion here is about what ends up *in* a store, so the store's
// contents have to be readable by the test the way a `logcat` dump or a `SharedPreferences` file
// would be readable by an attacker with the device.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const keychain = vi.hoisted(() => new Map<string, string>())
const prefs = vi.hoisted(() => new Map<string, string>())

vi.mock('expo-secure-store', () => ({
  getItemAsync: (key: string) => Promise.resolve(keychain.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    keychain.set(key, value)
    return Promise.resolve()
  },
  deleteItemAsync: (key: string) => {
    keychain.delete(key)
    return Promise.resolve()
  },
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly'
}))

/** Hoisted so a test can make `setItem` fail without a dynamic import of the mocked module. */
const storage = vi.hoisted(() => ({
  getItem: (key: string) => Promise.resolve(prefs.get(key) ?? null),
  setItem: (key: string, value: string) => {
    prefs.set(key, value)
    return Promise.resolve()
  }
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }))

const {
  deleteStoredRemote,
  loadStoredRemotes,
  purgeIfFreshInstall,
  saveStoredRemote,
  storedRemotesRevision,
  subscribeStoredRemotes,
  updateStoredRemote
} = await import('../src/remote-store')

/** A throwaway shape, not a real key — this file must be safe to read in a diff. */
const KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----\n'

const CONFIG = {
  id: 'fable',
  name: 'fable-m5max',
  host: '192.168.50.10',
  port: 22,
  username: 'z',
  privateKey: KEY,
  connectTimeoutMs: 20_000,
  keepaliveIntervalMs: 15_000
}

beforeEach(() => {
  keychain.clear()
  prefs.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the keystore is where a key lives', () => {
  it('round-trips a remote through expo-secure-store', async () => {
    await saveStoredRemote(CONFIG)
    const inventory = await loadStoredRemotes()

    expect(inventory.available).toBe(true)
    expect(inventory.rejected).toEqual([])
    expect(inventory.remotes).toEqual([CONFIG])
  })

  it('puts no key material anywhere but the keystore', async () => {
    const logged: string[] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '))
      })
    }

    await saveStoredRemote(CONFIG)
    await loadStoredRemotes()

    // AsyncStorage is plaintext on both platforms (a file in the app container / an unencrypted
    // SharedPreferences), so a key there is a key on disk in the clear.
    expect([...prefs.entries()].filter(([, value]) => value.includes('OPENSSH'))).toEqual([])
    // ...and the one place it *is* allowed to be is the encrypted store, under this remote's key.
    expect(
      [...keychain.keys()].filter((key) => (keychain.get(key) ?? '').includes('OPENSSH'))
    ).toEqual(['herdr.remote.v1.fable'])
    // logcat / Console.app / a crash reporter's breadcrumbs all read what console writes.
    expect(logged.filter((line) => line.includes('OPENSSH') || line.includes(KEY))).toEqual([])
  })

  it('drops a corrupt entry by id without quoting what was stored', async () => {
    await saveStoredRemote(CONFIG)
    keychain.set('herdr.remote.v1.fable', `{"id":"fable","privateKey":${JSON.stringify(KEY)}}`)
    const inventory = await loadStoredRemotes()

    expect(inventory.remotes).toEqual([])
    expect(inventory.rejected).toHaveLength(1)
    expect(inventory.rejected[0]?.reason).toContain('fable')
    // The reason is rendered on a settings screen; echoing the value back would put the key on the
    // glass and into any screenshot of it.
    expect(inventory.rejected[0]?.reason).not.toContain('OPENSSH')
  })

  it('deletes both the entry and its index row', async () => {
    await saveStoredRemote(CONFIG)
    await deleteStoredRemote('fable')

    expect((await loadStoredRemotes()).remotes).toEqual([])
    expect([...keychain.values()].some((value) => value.includes('OPENSSH'))).toBe(false)
  })

  it('edits a remote without the caller ever holding its key', async () => {
    await saveStoredRemote(CONFIG)
    const { privateKey: _dropped, ...withoutKey } = CONFIG
    await updateStoredRemote({ ...withoutKey, host: '10.0.0.9' })

    const [stored] = (await loadStoredRemotes()).remotes
    expect(stored?.host).toBe('10.0.0.9')
    // The key survived an edit that never mentioned it — which is what lets the settings screen
    // render an edit form with no secret in its state.
    expect(stored?.privateKey).toBe(KEY)
  })

  it('refuses an id that cannot be a keystore key', async () => {
    // `expo-secure-store` keys are `/^[\w.-]+$/`
    // (node_modules/expo-secure-store/build/SecureStore.js:150), so an id with a slash in it would
    // throw from inside the store and leave a half-written index.
    await expect(saveStoredRemote({ ...CONFIG, id: 'a/b' })).rejects.toThrow(/id/)
    expect([...keychain.keys()]).toEqual([])
  })

  it('notifies subscribers so a save re-dials without a restart', async () => {
    const before = storedRemotesRevision()
    let seen = 0
    const unsubscribe = subscribeStoredRemotes(() => {
      seen += 1
    })
    await saveStoredRemote(CONFIG)
    await deleteStoredRemote('fable')
    unsubscribe()
    await saveStoredRemote(CONFIG)

    expect(seen).toBe(2)
    expect(storedRemotesRevision()).toBeGreaterThan(before)
  })
})

describe('a fresh install', () => {
  it('wipes keys left in the iOS keychain by a previous install', async () => {
    await saveStoredRemote(CONFIG)
    // The app container — and with it AsyncStorage — is deleted on uninstall on both platforms;
    // the iOS keychain is not (Expo docs, "Data persistence"). So an absent marker beside a present
    // keychain entry is exactly the signature of "this app was reinstalled".
    prefs.clear()

    expect(await purgeIfFreshInstall()).toBe('purged')
    expect((await loadStoredRemotes()).remotes).toEqual([])
    expect([...keychain.values()].some((value) => value.includes('OPENSSH'))).toBe(false)
  })

  it('runs once — a second launch keeps what the user configured', async () => {
    expect(await purgeIfFreshInstall()).toBe('purged')
    await saveStoredRemote(CONFIG)

    expect(await purgeIfFreshInstall()).toBe('kept')
    expect((await loadStoredRemotes()).remotes).toEqual([CONFIG])
  })

  it('keeps the remotes when the marker cannot be written', async () => {
    vi.spyOn(storage, 'setItem').mockRejectedValue(new Error('disk full'))
    await saveStoredRemote(CONFIG)

    // Fail *towards the user's data*: a marker write that keeps failing would otherwise wipe a
    // working configuration on every single launch.
    await expect(purgeIfFreshInstall()).resolves.toBe('kept')
    expect((await loadStoredRemotes()).remotes).toEqual([CONFIG])
  })
})
