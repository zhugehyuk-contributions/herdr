// Not from orca as code, but this is the slot orca's `app/_layout.tsx` `:73-150` occupied and that
// this repo's port explicitly left empty ("notification tap routing … the routing lands with M5").
//
// Three jobs, and they are separate effects because they fail separately:
//
//   1. **Listen.** Attach the response listener and the foreground handler *first*, before anything
//      that can await. A notification tapped while the app is already running is delivered to
//      whoever is subscribed at that instant, and a subscription that waits on a permission dialog
//      or an ssh round trip is a tap dropped on the floor.
//   2. **Route**, including the cold start. A tap that launched the process arrives as
//      `getLastNotificationResponse()` rather than as an event, and it must not be acted on until
//      there is a navigator to act on — hence `ready`, which `app/_layout.tsx` sets from the same
//      `onLayout` that hides the splash. A tap that arrives before that is held, not lost.
//   3. **Register.** Ask for permission, get a token, and hand it to every remote over ssh
//      (`./blocked-push-registration.ts` owns that order and its reasons).
//
// ⚠️ `expo-notifications` and `expo-constants` are reached through **dynamic** imports, for the
// reason `modules/herdr-ssh/src/native-types.ts` states about `expo-modules-core`: they pull in
// `react-native`, which is Flow source the test transformer cannot parse. A static import here
// would make `app/_layout.tsx` unloadable and take every existing mount suite down with it. A build
// without the module gets no notifications instead of a crashed shell.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Platform } from 'react-native'
import type { PushTokenRegistrar } from '../../modules/herdr-ssh/src/push-token-registrar'
import {
  registerBlockedPush,
  type PushRegistrationOutcome,
  type PushRegistrationState
} from './blocked-push-registration'
import {
  foregroundBehavior,
  pushData,
  resolvePaneTarget,
  type PushResponseLike
} from './blocked-push-notification'
import { paneTargetHref } from './pane-deep-link'
import { loadPushDeviceId } from './push-device-id'

/**
 * The Android channel a blocked push is delivered on.
 *
 * Android ignores per-notification priority and reads the *channel*'s importance, so without a
 * channel at `HIGH` the notification lands silently in the tray — which is precisely the failure
 * M5 exists to prevent (the user is not looking at the desktop, and now not at the phone either).
 * The id has to match what the sender puts in `channelId` (`sender/adapters.py`).
 */
export const BLOCKED_CHANNEL_ID = 'blocked'

export interface BlockedPushStatus extends Omit<PushRegistrationOutcome, 'state'> {
  state: PushRegistrationState | 'starting'
  /** False when this build has no `expo-notifications` — not a permission problem. */
  available: boolean
}

const STARTING: BlockedPushStatus = Object.freeze({
  state: 'starting',
  token: null,
  registered: Object.freeze([]) as readonly string[],
  failures: Object.freeze([]) as readonly string[],
  error: null,
  available: true
})

export interface UseBlockedPushOptions {
  registrars: readonly PushTokenRegistrar[]
  /** Where a tap goes. `app/_layout.tsx` passes the router's `push`. */
  navigate: (href: string) => void
  /** True once a navigator exists. A cold-start tap is held until it does. */
  ready: boolean
}

export function useBlockedPush(options: UseBlockedPushOptions): BlockedPushStatus {
  const { navigate, ready, registrars } = options
  const [status, setStatus] = useState<BlockedPushStatus>(STARTING)
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  /** A target that arrived before the navigator did. At most one: the newest tap is the intent. */
  const pending = useRef<string | null>(null)
  const [pendingRevision, setPendingRevision] = useState(0)

  const consume = useCallback((response: PushResponseLike | null | undefined) => {
    const target = resolvePaneTarget(pushData(response))
    if (target === null) {
      return
    }
    pending.current = paneTargetHref(target)
    setPendingRevision((revision) => revision + 1)
  }, [])

  // (1) + the cold-start read. Runs once; nothing in it depends on the dial.
  useEffect(() => {
    let live = true
    let subscription: { remove: () => void } | null = null
    void loadNotifications().then((notifications) => {
      if (notifications === null) {
        if (live) {
          setStatus({ ...STARTING, state: 'no-remotes', available: false })
        }
        return
      }
      if (!live) {
        return
      }
      notifications.setNotificationHandler?.({
        handleNotification: async (notification: PushResponseLike['notification']) =>
          foregroundBehavior(pushData({ notification }))
      })
      if (Platform.OS === 'android') {
        void notifications
          .setNotificationChannelAsync?.(BLOCKED_CHANNEL_ID, {
            name: 'Blocked agents',
            importance: notifications.AndroidImportance?.HIGH ?? 4,
            // Android decides heads-up from the channel, and the channel is created once per
            // install: getting this wrong is not fixable by a later app update.
            enableVibrate: true
          })
          .catch(() => {})
      }
      subscription = notifications.addNotificationResponseReceivedListener?.(consume) ?? null
      // The cold start. Read *after* subscribing, so a tap that lands in between is not missed.
      consume(notifications.getLastNotificationResponse?.() ?? null)
    })
    return () => {
      live = false
      subscription?.remove()
    }
  }, [consume])

  // (2). Kept out of the effect above so a tap arriving at any time routes as soon as it can.
  useEffect(() => {
    if (!ready || pending.current === null) {
      return
    }
    const href = pending.current
    pending.current = null
    navigateRef.current(href)
    // Or every remount replays a tap the user handled days ago. `clear` is also what makes the
    // hook's own `getLastNotificationResponse` read idempotent across a re-mount.
    void loadNotifications().then((notifications) => {
      notifications?.clearLastNotificationResponse?.()
    })
  }, [pendingRevision, ready])

  // (3). Re-runs when the dialled set changes — a remote added on the settings screen re-dials
  // (`modules/herdr-ssh/src/app-connections.ts`), and a server nobody told has no token.
  const registrarKey = useMemo(
    () => registrars.map((registrar) => registrar.remoteId).join(','),
    [registrars]
  )
  useEffect(() => {
    let live = true
    void (async () => {
      const notifications = await loadNotifications()
      if (notifications === null || !live) {
        return
      }
      const outcome = await registerBlockedPush({
        registrars,
        getPermission: async () => toAnswer(await notifications.getPermissionsAsync?.()),
        requestPermission: async () => toAnswer(await notifications.requestPermissionsAsync?.()),
        getToken: async () => {
          const projectId = await loadProjectId()
          const token = await notifications.getExpoPushTokenAsync?.(
            projectId === null ? undefined : { projectId }
          )
          return token?.data ?? ''
        },
        getDeviceId: loadPushDeviceId,
        platform: Platform.OS
      })
      if (live) {
        setStatus({ ...outcome, available: true })
      }
    })()
    return () => {
      live = false
    }
    // `registrars` is read through `registrarKey`: the array identity changes on every dial even
    // when the set did not, and re-registering on every render is an ssh exec per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registrarKey])

  return status
}

/** The slice of `expo-notifications` this app uses, so the dynamic import has a shape. */
interface NotificationsModule {
  setNotificationHandler?: (handler: unknown) => void
  setNotificationChannelAsync?: (id: string, channel: unknown) => Promise<unknown>
  addNotificationResponseReceivedListener?: (listener: (response: PushResponseLike) => void) => {
    remove: () => void
  }
  getLastNotificationResponse?: () => PushResponseLike | null
  clearLastNotificationResponse?: () => void
  getPermissionsAsync?: () => Promise<{ granted?: boolean; canAskAgain?: boolean } | undefined>
  requestPermissionsAsync?: () => Promise<{ granted?: boolean; canAskAgain?: boolean } | undefined>
  getExpoPushTokenAsync?: (options?: {
    projectId: string
  }) => Promise<{ data?: string } | undefined>
  AndroidImportance?: { HIGH?: number }
}

async function loadNotifications(): Promise<NotificationsModule | null> {
  try {
    return (await import('expo-notifications')) as unknown as NotificationsModule
  } catch {
    return null
  }
}

/**
 * The EAS project id, without which Expo cannot mint a token
 * (`node_modules/expo-notifications/build/getExpoPushTokenAsync.js`: it throws
 * `ERR_NOTIFICATIONS_NO_EXPERIENCE_ID`).
 *
 * `getExpoPushTokenAsync` reads the same two places itself when the option is omitted, so passing
 * it explicitly changes nothing on a correctly configured build. It exists so that the *absence*
 * surfaces here as a reported `no-token` with a readable message rather than as a coded error from
 * inside a dependency.
 */
async function loadProjectId(): Promise<string | null> {
  try {
    const constants = (await import('expo-constants')) as unknown as {
      default?: {
        easConfig?: { projectId?: string }
        expoConfig?: { extra?: { eas?: { projectId?: string } } }
      }
    }
    const config = constants.default
    return config?.easConfig?.projectId ?? config?.expoConfig?.extra?.eas?.projectId ?? null
  } catch {
    return null
  }
}

/**
 * `granted` is the only field worth reading on either platform, and `canAskAgain` is the only thing
 * that decides whether asking again is anything but a no-op.
 *
 * An absent answer — a module build that does not expose the function at all — reads as *not*
 * granted, never as granted. It stays askable, which costs one further call into the same absent
 * function and then terminates at `denied`; the alternative default would report a phone as
 * registered for pushes it can never receive.
 */
function toAnswer(value: { granted?: boolean; canAskAgain?: boolean } | undefined) {
  return { granted: value?.granted === true, canAskAgain: value?.canAskAgain !== false }
}
