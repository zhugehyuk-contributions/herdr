// Not from orca. What the app is allowed to conclude from a push payload, as pure functions, so
// the two decisions that matter can be tested without a device:
//
//  1. **where a tap goes** — `resolvePaneTarget`, and
//  2. **what the app raises while it is in the foreground** — `foregroundBehavior`, which is where
//     the "v1 pushes `blocked` only" constraint stops being prose and becomes behaviour.
//
// On (2), the constraint and its source: `done` is not a device-independent fact. It is
// `(AgentState::Idle, seen == false)` (`src/app/api_helpers.rs:104-107`), and the `seen` bit flips
// the instant the *desktop* shows that pane (`src/app/actions.rs:3113-3117`), so a `done` push
// races the desktop and fires for something the user already watched finish. `.prd/09` §B4 P4
// records that as live-reproduced: same pane, same command, `idle` when focused and `done` when
// not. The desktop half therefore queues `blocked` and nothing else
// (`plugins/herdr-blocked-push/hooks/enqueue.py`).
//
// The app does not merely trust that. A notification that is not `blocked` is delivered silently:
// it is not raised as a banner and it does not make a sound, but it is still routable if the user
// finds it in the tray. That is the smallest honest expression of the constraint — a future sender
// that starts pushing `done` cannot turn this app into something that interrupts the user for a
// fact it cannot vouch for, and nothing is hidden from the user either.
import { parsePaneDeepLink, type PaneTarget } from './pane-deep-link'

/** The `data` block the sender puts on a notification (`sender/adapters.py`, `expo` adapter). */
export interface BlockedPushData {
  url?: unknown
  remote_id?: unknown
  pane_id?: unknown
  status?: unknown
}

/** The subset of `expo-notifications`' `NotificationResponse` this app reads. */
export interface PushResponseLike {
  notification?: {
    request?: {
      content?: {
        data?: Record<string, unknown> | null
      } | null
    } | null
  } | null
}

/** `data` off a response or a notification, with every hop that can legally be missing tolerated. */
export function pushData(response: PushResponseLike | null | undefined): BlockedPushData {
  const data = response?.notification?.request?.content?.data
  return data && typeof data === 'object' ? (data as BlockedPushData) : {}
}

/**
 * The pane a payload points at, or `null`.
 *
 * The explicit fields win over the URL. They are the same fact twice, but the fields survive a hop
 * that rewrites or drops the URL, and reading them first means a payload whose URL an intermediary
 * mangled still lands on the right pane. The URL is the fallback, and it is the *only* thing
 * present when the app is opened by the link rather than by the notification.
 */
export function resolvePaneTarget(data: BlockedPushData): PaneTarget | null {
  const remoteId = nonEmptyString(data.remote_id)
  const paneId = nonEmptyString(data.pane_id)
  if (remoteId !== null && paneId !== null) {
    return { remoteId, paneId }
  }
  return parsePaneDeepLink(data.url)
}

/** True only for the one status this milestone can vouch for. */
export function isBlockedPush(data: BlockedPushData): boolean {
  return data.status === 'blocked'
}

/**
 * `NotificationBehavior` for a notification that arrives while the app is open.
 *
 * Shape and field names are `expo-notifications`' (`NotificationsHandler.d.ts`); `shouldShowAlert`
 * is deliberately absent because it is deprecated there in favour of the banner/list pair.
 */
export interface ForegroundBehavior {
  shouldShowBanner: boolean
  shouldShowList: boolean
  shouldPlaySound: boolean
  shouldSetBadge: boolean
}

export function foregroundBehavior(data: BlockedPushData): ForegroundBehavior {
  const blocked = isBlockedPush(data)
  return {
    shouldShowBanner: blocked,
    shouldShowList: true,
    shouldPlaySound: blocked,
    // Never. A badge is a count the app would have to clear, and nothing in this app clears one —
    // an uncleared badge is a permanent red dot that stops meaning anything within a day.
    shouldSetBadge: false
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}
