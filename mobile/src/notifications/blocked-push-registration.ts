// Not from orca. The order of operations for "this phone can be pushed to", as one function over
// injected dependencies, so every branch is testable without a device, a permission dialog or a
// network.
//
// The order is the design, and each step is a gate on the next:
//
//   1. **Is there anyone to tell?** No reachable remote means no registrar, and this returns before
//      asking for anything. A permission prompt raised by an app that cannot yet push is a prompt
//      the user denies once and then has to find in system settings to undo — the most expensive
//      possible outcome, spent on nothing.
//   2. **Permission**, asked once and only while it is still askable. `canAskAgain === false` is a
//      terminal state on both platforms: the request resolves immediately with the old answer, so
//      re-asking is a no-op that hides the fact from the UI.
//   3. **Token.** `getExpoPushTokenAsync` is a network call to Expo and it is the step most likely
//      to fail on a phone (offline, or no `projectId` configured yet), so its failure is a reported
//      state and not an exception.
//   4. **Registration, per remote, in parallel, failure-isolated.** One host with no `herdr` on
//      `PATH` must not stop the other three from learning the token; the whole point of registering
//      over ssh is that N servers are told by the one client that reaches all N.
import type { PushTokenRegistrar } from '../../modules/herdr-ssh/src/push-token-registrar'
import type { PushTokenRegistration } from './push-token-registration'

export interface PushPermissionAnswer {
  granted: boolean
  canAskAgain: boolean
}

export interface PushRegistrationDeps {
  registrars: readonly PushTokenRegistrar[]
  getPermission: () => Promise<PushPermissionAnswer>
  requestPermission: () => Promise<PushPermissionAnswer>
  getToken: () => Promise<string>
  getDeviceId: () => Promise<string>
  platform: string
  appId?: string | undefined
  deviceName?: string | undefined
  now?: () => number
}

export type PushRegistrationState =
  /** Nothing to register with. Not an error: it is every build before a remote is configured. */
  | 'no-remotes'
  /** The user said no, or the OS will not let us ask. */
  | 'denied'
  /** Permission is granted but Expo did not hand back a token. `error` says why. */
  | 'no-token'
  /** At least one remote holds this token. `failures` may still be non-empty. */
  | 'registered'
  /** A token exists and no remote accepted it. */
  | 'failed'

export interface PushRegistrationOutcome {
  state: PushRegistrationState
  token: string | null
  /** Remote ids that acknowledged the write. */
  registered: readonly string[]
  /** `id: reason` per remote that did not, in the shape `SshDialState.failures` already uses. */
  failures: readonly string[]
  /** Set only for `no-token`; the permission states are not errors. */
  error: string | null
}

export async function registerBlockedPush(
  deps: PushRegistrationDeps
): Promise<PushRegistrationOutcome> {
  if (deps.registrars.length === 0) {
    return outcome('no-remotes')
  }

  let permission = await deps.getPermission()
  if (!permission.granted && permission.canAskAgain) {
    permission = await deps.requestPermission()
  }
  if (!permission.granted) {
    return outcome('denied')
  }

  let token: string
  try {
    token = await deps.getToken()
  } catch (error) {
    return { ...outcome('no-token'), error: errorMessage(error) }
  }
  if (token.trim().length === 0) {
    return { ...outcome('no-token'), error: 'the push service returned an empty token' }
  }

  const registration: PushTokenRegistration = {
    v: 1,
    type: 'expo',
    token,
    device_id: await deps.getDeviceId(),
    platform: deps.platform,
    ts_ms: (deps.now ?? Date.now)()
  }
  if (deps.deviceName !== undefined) {
    registration.device_name = deps.deviceName
  }
  if (deps.appId !== undefined) {
    registration.app_id = deps.appId
  }

  const settled = await Promise.allSettled(
    deps.registrars.map((registrar) => registrar.register(registration))
  )
  const registered: string[] = []
  const failures: string[] = []
  for (const [index, result] of settled.entries()) {
    const remoteId = deps.registrars[index]?.remoteId ?? String(index)
    if (result.status === 'fulfilled') {
      registered.push(remoteId)
    } else {
      // `createPushTokenRegistrar` already prefixes its own rejections with the remote id; a
      // rejection from anywhere else (a transport with no exec, say) has not.
      const reason = errorMessage(result.reason)
      failures.push(reason.startsWith(`${remoteId}:`) ? reason : `${remoteId}: ${reason}`)
    }
  }

  return {
    state: registered.length > 0 ? 'registered' : 'failed',
    token,
    registered,
    failures,
    error: null
  }
}

function outcome(state: PushRegistrationState): PushRegistrationOutcome {
  return { state, token: null, registered: [], failures: [], error: null }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
