// Not from orca. The order of operations, and each gate in it, without a device.
//
// The one worth reading twice is the first: an app that asks for notification permission before it
// has anywhere to push is spending the user's single cheap "allow" on nothing, and on both
// platforms a denial is not re-askable from inside the app.
import { describe, expect, it, vi } from 'vitest'
import { registerBlockedPush, type PushRegistrationDeps } from './blocked-push-registration'
import type { PushTokenRegistrar } from '../../modules/herdr-ssh/src/push-token-registrar'
import type { PushTokenRegistration } from './push-token-registration'

function registrar(
  remoteId: string,
  fail?: string
): PushTokenRegistrar & {
  seen: PushTokenRegistration[]
} {
  const seen: PushTokenRegistration[] = []
  return {
    remoteId,
    seen,
    register: async (registration) => {
      seen.push(registration)
      if (fail !== undefined) {
        throw new Error(fail)
      }
    }
  }
}

function deps(overrides: Partial<PushRegistrationDeps> = {}): PushRegistrationDeps {
  return {
    registrars: [registrar('fable')],
    getPermission: async () => ({ granted: true, canAskAgain: true }),
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    getToken: async () => 'ExponentPushToken[abc]',
    getDeviceId: async () => 'phone-abc',
    platform: 'android',
    now: () => 1_700_000_000_000,
    ...overrides
  }
}

describe('registering this phone with the fleet', () => {
  it('does not ask for permission when there is nobody to push', async () => {
    const request = vi.fn(async () => ({ granted: true, canAskAgain: true }))
    const outcome = await registerBlockedPush(
      deps({ registrars: [], requestPermission: request, getPermission: request })
    )
    expect(outcome.state).toBe('no-remotes')
    // The cost of getting this wrong is permanent: a denial can only be undone in system settings.
    expect(request).not.toHaveBeenCalled()
  })

  it('asks once when permission is undetermined', async () => {
    const request = vi.fn(async () => ({ granted: true, canAskAgain: true }))
    const outcome = await registerBlockedPush(
      deps({
        getPermission: async () => ({ granted: false, canAskAgain: true }),
        requestPermission: request
      })
    )
    expect(request).toHaveBeenCalledTimes(1)
    expect(outcome.state).toBe('registered')
  })

  it('does not re-ask what the OS will no longer ask', async () => {
    const request = vi.fn(async () => ({ granted: false, canAskAgain: false }))
    const outcome = await registerBlockedPush(
      deps({
        getPermission: async () => ({ granted: false, canAskAgain: false }),
        requestPermission: request
      })
    )
    // Re-asking here resolves instantly with the old answer, so it would only hide the state.
    expect(request).not.toHaveBeenCalled()
    expect(outcome.state).toBe('denied')
  })

  it('reports a token failure as a state, not an exception', async () => {
    const outcome = await registerBlockedPush(
      deps({
        getToken: async () => {
          throw new Error('No "projectId" found')
        }
      })
    )
    expect(outcome.state).toBe('no-token')
    expect(outcome.error).toContain('projectId')
  })

  it('treats an empty token as no token', async () => {
    const outcome = await registerBlockedPush(deps({ getToken: async () => '' }))
    expect(outcome.state).toBe('no-token')
  })

  it('tells every remote, and one refusal does not silence the rest', async () => {
    const good = registrar('fable')
    const bad = registrar('oud', 'oud: exited 127: herdr: not found')
    const other = registrar('mini')
    const outcome = await registerBlockedPush(deps({ registrars: [good, bad, other] }))

    expect(outcome.state).toBe('registered')
    expect(outcome.registered).toEqual(['fable', 'mini'])
    expect(outcome.failures).toEqual(['oud: exited 127: herdr: not found'])
    expect(good.seen[0]?.token).toBe('ExponentPushToken[abc]')
  })

  it('prefixes a failure that did not name its own remote', async () => {
    const outcome = await registerBlockedPush(
      deps({ registrars: [registrar('oud', 'this transport cannot run remote commands')] })
    )
    expect(outcome.state).toBe('failed')
    expect(outcome.failures).toEqual(['oud: this transport cannot run remote commands'])
  })

  it('sends the same registration record to every remote', async () => {
    const a = registrar('a')
    const b = registrar('b')
    await registerBlockedPush(deps({ registrars: [a, b], deviceName: 'z-pixel' }))
    expect(a.seen[0]).toEqual({
      v: 1,
      type: 'expo',
      token: 'ExponentPushToken[abc]',
      device_id: 'phone-abc',
      device_name: 'z-pixel',
      platform: 'android',
      ts_ms: 1_700_000_000_000
    })
    expect(b.seen[0]).toEqual(a.seen[0])
  })
})
