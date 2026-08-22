// Not from orca. A stable name for *this install*, because the token registry on each server is
// keyed by one (`push-token-registration.ts`, `DEVICE_ID_PATTERN`).
//
// Why a key at all instead of one file per token: a phone re-registers on every launch and its
// Expo token rotates on reinstall and on some OS upgrades. Without a stable key each rotation would
// leave the old token in the registry forever, and the sender would keep pushing to an address
// that stopped existing — visible only as `DeviceNotRegistered` tickets nobody reads. With one, a
// re-registration *overwrites* the entry, and the fleet converges without anybody cleaning up.
//
// AsyncStorage and not `expo-secure-store`: this is a name, not a credential. It identifies which
// slot of a registry to overwrite, it is written into a filename on hosts where this phone already
// has shell access, and putting it in the keychain would only mean it survives an uninstall — the
// exact moment the token behind it stops being valid.
// ⚠️ AsyncStorage is reached through a **dynamic** import, the same discipline
// `modules/herdr-ssh/src/remote-store.ts` follows and for the same measured reason: it pulls in
// `react-native`, which is Flow source the test transformer cannot parse, and this module is in
// `app/_layout.tsx`'s static graph. A build without it gets a fresh id per launch, not a crash.
import { DEVICE_ID_PATTERN } from './push-token-registration'

export const DEVICE_ID_STORAGE_KEY = 'herdr.push.device-id'

/** Injected so the generator is testable; the default is AsyncStorage, loaded on demand. */
export interface DeviceIdStore {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
}

async function defaultStore(): Promise<DeviceIdStore | null> {
  try {
    const module = (await import('@react-native-async-storage/async-storage')) as unknown as {
      default?: DeviceIdStore
    }
    return module.default ?? null
  } catch {
    return null
  }
}

/**
 * Reads the stored id, or mints and stores one.
 *
 * A stored value that no longer matches the pattern is replaced rather than trusted: it would be
 * rejected by `registerPushTokenCommand` on every launch, and a device that can never register is
 * worse than one that changes its name once.
 */
export async function loadPushDeviceId(
  provided?: DeviceIdStore,
  mint: () => string = mintDeviceId
): Promise<string> {
  const store = provided ?? (await defaultStore())
  if (store === null) {
    return mint()
  }
  const stored = await store.getItem(DEVICE_ID_STORAGE_KEY).catch(() => null)
  if (stored !== null && DEVICE_ID_PATTERN.test(stored)) {
    return stored
  }
  const minted = mint()
  // Swallowed: a storage that refuses to write means a new id next launch, which costs one stale
  // registry entry. Failing the whole registration over it would cost every push.
  await store.setItem(DEVICE_ID_STORAGE_KEY, minted).catch(() => {})
  return minted
}

/**
 * `phone-<base36 time><base36 random>` — lowercase alphanumerics and a dash, i.e. inside
 * {@link DEVICE_ID_PATTERN} by construction.
 *
 * `Math.random` is deliberate and sufficient: this is not a secret and not an authenticator, it is
 * a slot name that only has to avoid colliding with the user's *other* handful of devices.
 */
export function mintDeviceId(): string {
  const stamp = Date.now().toString(36)
  const noise = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(5, '0')
  return `phone-${stamp}${noise}`
}
