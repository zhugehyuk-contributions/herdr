// Not from orca. What the settings screen says about push, as pure strings, so the wording is
// testable and so the one sentence that has to be there cannot be quietly dropped.
//
// That sentence is the `blocked`-only constraint. It is not a caveat, it is the product's shape:
// the app will *never* tell you an agent finished, because "finished" is `(Idle, seen == false)`
// and `seen` flips the moment the desktop shows that pane (`src/app/api_helpers.rs:104-107`) — so a
// `done` push is a race the desktop usually wins, firing for work the user already watched end.
// A user who does not know this concludes the feature is broken the first time an agent finishes
// quietly. Saying it here is cheaper than every other way of finding out.
import type { BlockedPushStatus } from './use-blocked-push'

/** The invariant line. Always shown, in every state, including the working one. */
export const BLOCKED_ONLY_NOTE =
  'Only blocked is pushed. A finished agent is not — "done" depends on whether the desktop has ' +
  'looked at that pane, so it would fire for work you already watched end. The agents list is ' +
  'what tells you about everything else.'

export interface BlockedPushSummary {
  /** One line. The state, in the user's terms. */
  headline: string
  /** Why, or what to do about it. Empty when there is nothing to say. */
  detail: string[]
}

export function summarisePush(status: BlockedPushStatus): BlockedPushSummary {
  if (!status.available) {
    return {
      headline: 'push is not in this build',
      detail: ['Expo Go and older bundles have no notification module. Use a development build.']
    }
  }
  switch (status.state) {
    case 'starting':
      return { headline: 'checking…', detail: [] }
    case 'no-remotes':
      // Deliberately not an error, and deliberately not a prompt: the app has not asked for
      // permission yet, on purpose (`./blocked-push-registration.ts`).
      return {
        headline: 'nothing to register with',
        detail: ['Add a remote below. Permission is asked for once there is a server to tell.']
      }
    case 'denied':
      return {
        headline: 'notifications are turned off',
        detail: ['Allow notifications for herdr in system settings; the app cannot ask again.']
      }
    case 'no-token':
      return {
        headline: 'no push token',
        detail: [
          status.error ?? 'The push service did not answer.',
          'Offline, or this build has no EAS projectId in app.json (extra.eas.projectId).'
        ]
      }
    case 'failed':
      return {
        headline: 'no server has this phone’s token',
        detail: [...status.failures]
      }
    case 'registered':
      return {
        headline: `registered on ${status.registered.length} of ${
          status.registered.length + status.failures.length
        }`,
        detail: [...status.failures]
      }
  }
}
