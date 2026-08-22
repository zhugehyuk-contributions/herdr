// Not from orca. This asserts the exact bytes that get executed on the user's herdr servers, which
// is the reason it is stricter than a normal unit test: everything here runs as `sh` on a machine
// where this phone has shell access, so "it probably quotes right" is not a standard this file can
// hold itself to.
//
// Two properties carry the weight:
//   1. **Nothing variable is interpolated into the script.** The token, the device id, the binary
//      path and the plugin id are positional arguments; the script body is a constant. That is what
//      makes the quoting question finite.
//   2. **The destination is asked for, not assumed.** `herdr plugin config-dir` is the only thing
//      that knows whether this build writes to `herdr` or `herdr-dev`, and whether the id is hashed
//      (`src/plugin_paths.rs`). A hard-coded path is how the phone and the sender end up on two
//      different files.
import { describe, expect, it } from 'vitest'
import {
  BLOCKED_PUSH_PLUGIN_ID,
  DEVICE_ID_PATTERN,
  TOKENS_DIRNAME,
  registerPushTokenCommand,
  type PushTokenRegistration
} from './push-token-registration'

function registration(overrides: Partial<PushTokenRegistration> = {}): PushTokenRegistration {
  return {
    v: 1,
    type: 'expo',
    token: 'ExponentPushToken[abc-123]',
    device_id: 'phone-m5x',
    platform: 'android',
    ts_ms: 1_700_000_000_000,
    ...overrides
  }
}

describe('the command the phone runs on each herdr server', () => {
  it('passes every variable part as an argument, never inside the script', () => {
    const command = registerPushTokenCommand({ registration: registration() })
    // The script is the one single-quoted run between `sh -c` and the `$0` name, and it contains no
    // quote of its own — which is itself the property being relied on.
    const script = /sh -c '([^']*)' herdr-blocked-push-register/.exec(command)?.[1]
    expect(script).toBeDefined()

    expect(script).not.toContain('ExponentPushToken')
    expect(script).not.toContain('phone-m5x')
    // The script refers to them positionally, which is the only reading the remote shell can give.
    expect(script).toContain('"$3"')
    expect(script).toContain('"$dir/$4.json"')
  })

  it('asks herdr where the plugin config lives instead of hard-coding a path', () => {
    const command = registerPushTokenCommand({ registration: registration() })
    expect(command).toContain('plugin config-dir')
    expect(command).toContain(BLOCKED_PUSH_PLUGIN_ID)
    expect(command).toContain(TOKENS_DIRNAME)
  })

  it('writes through a temporary name so the sender never reads a half-written token', () => {
    const command = registerPushTokenCommand({ registration: registration() })
    // The sender polls this directory on a timer; `mv` within one directory is the atomicity.
    expect(command).toContain('.json.part')
    expect(command).toContain('mv ')
    expect(command).toContain('umask 077')
  })

  it('shell-quotes a binary path and an env prefix exactly like the bridge command does', () => {
    const command = registerPushTokenCommand({
      registration: registration(),
      herdrBinary: '/opt/my herdr/bin/herdr',
      env: { HERDR_LOG: 'debug' }
    })
    expect(command.startsWith('exec env HERDR_LOG=debug sh -c ')).toBe(true)
    expect(command).toContain("'/opt/my herdr/bin/herdr'")
  })

  it('carries the whole registration as one JSON argument', () => {
    const command = registerPushTokenCommand({ registration: registration() })
    // Single-quoted, so the remote shell expands nothing inside it.
    const json = command.match(/'(\{.*\})'/)?.[1]
    expect(json).toBeDefined()
    expect(JSON.parse(json as string)).toEqual(registration())
  })

  it('refuses a device id that is not safe as a filename', () => {
    for (const device_id of ['../escape', 'Phone', 'a b', '-lead', '', 'x'.repeat(64)]) {
      expect(DEVICE_ID_PATTERN.test(device_id), device_id).toBe(false)
      expect(() => registerPushTokenCommand({ registration: registration({ device_id }) })).toThrow(
        /device id/
      )
    }
  })

  it('refuses an empty token rather than registering an address nothing can reach', () => {
    expect(() => registerPushTokenCommand({ registration: registration({ token: '  ' }) })).toThrow(
      /empty push token/
    )
  })

  it('refuses an env name the remote `env` could not have taken anyway', () => {
    expect(() =>
      registerPushTokenCommand({ registration: registration(), env: { 'X-Y': '1' } })
    ).toThrow(/POSIX environment variable name/)
  })
})
