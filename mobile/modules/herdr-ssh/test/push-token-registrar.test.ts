// Not from orca. The ssh half of M5's token delivery, against the same `FakeNativeSsh` the
// transport obligations are proved on — so "the phone tells the server its push token" is a test
// result and not a design note.
//
// The claim being tested is narrow and load-bearing: `runCommand` is a **second** capability beside
// the bridge, not a widening of it. `openChannel` still runs only what `remoteBridgeCommand()`
// produced (obligation 2), and the registration is a separate exec that is torn down with the
// transport.
import { describe, expect, it, vi } from 'vitest'
import { FakeNativeSsh, type FakeNativeChannel } from './fake-native-ssh'
import { NativeSshHerdrTransport } from '../src/ssh-transport'
import { createPushTokenRegistrar } from '../src/push-token-registrar'
import { parseRemoteConfig, type HerdrSshRemoteConfig } from '../src/remote-config'
import type { PushTokenRegistration } from '../../../src/notifications/push-token-registration'

const REGISTRATION: PushTokenRegistration = {
  v: 1,
  type: 'expo',
  token: 'ExponentPushToken[abc-123]',
  device_id: 'phone-m5x',
  platform: 'android',
  ts_ms: 1_700_000_000_000
}

function config(overrides: Record<string, unknown> = {}): HerdrSshRemoteConfig {
  const parsed = parseRemoteConfig({
    id: 'fable',
    host: '10.0.0.9',
    username: 'z',
    privateKey: 'KEY',
    hostKeySha256: 'AAAA',
    ...overrides
  })
  if (!parsed.ok) {
    throw new Error(parsed.reason)
  }
  return parsed.config
}

async function connect() {
  const native = new FakeNativeSsh()
  const transport = await NativeSshHerdrTransport.connect(native, {
    ssh: {
      host: '10.0.0.9',
      port: 22,
      username: 'z',
      privateKey: 'KEY',
      hostKeySha256: 'AAAA',
      connectTimeoutMs: 1000,
      keepaliveIntervalMs: 1000
    }
  })
  return { native, transport }
}

/** Lets the exec be acknowledged before the remote answers, which is what a real round trip does. */
async function settleOpen() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('push token registration over the existing ssh connection', () => {
  it('runs the registration command and resolves on exit 0', async () => {
    const { native, transport } = await connect()
    const registrar = createPushTokenRegistrar(config(), transport)

    const pending = registrar.register(REGISTRATION)
    await settleOpen()
    const channel = native.only().last()
    expect(channel.command).toContain('plugin config-dir')
    expect(channel.command).toContain('ExponentPushToken[abc-123]')
    channel.die({ exitCode: 0 })

    await expect(pending).resolves.toBeUndefined()
  })

  it('does not open a second ssh connection to do it', async () => {
    const { native, transport } = await connect()
    const pending = createPushTokenRegistrar(config(), transport).register(REGISTRATION)
    await settleOpen()
    native.only().last().die({ exitCode: 0 })
    await pending

    // Obligation 5 holds across the new capability: one host, one connection, N channels.
    expect(native.connections).toHaveLength(1)
    expect(transport.connectionCount).toBe(1)
  })

  it('leaves the bridge contract alone — the exec is not counted as a channel open', async () => {
    const { native, transport } = await connect()
    const pending = createPushTokenRegistrar(config(), transport).register(REGISTRATION)
    await settleOpen()
    native.only().last().die({ exitCode: 0 })
    await pending

    // `channelCount` is the bridge's ledger; a registration is not a bridge channel and must not
    // show up there, or every observation of "how many bridges did this app open" becomes a lie.
    expect(transport.channelCount).toBe(0)
  })

  it('reports the remote failure, named by remote, instead of resolving quietly', async () => {
    const { native, transport } = await connect()
    const pending = createPushTokenRegistrar(config(), transport).register(REGISTRATION)
    await settleOpen()
    native.only().last().die({ exitCode: 127, stderr: 'sh: herdr: not found' })

    await expect(pending).rejects.toThrow(/^fable: exited 127: sh: herdr: not found$/)
  })

  it('uses the remote its config names, not a default binary', async () => {
    const { native, transport } = await connect()
    const pending = createPushTokenRegistrar(
      config({ herdrBinary: '/opt/herdr/bin/herdr', env: { XDG_STATE_HOME: '/srv/state' } }),
      transport
    ).register(REGISTRATION)
    await settleOpen()
    const command = native.only().last().command
    expect(command).toContain('/opt/herdr/bin/herdr')
    expect(command).toContain('XDG_STATE_HOME=/srv/state')
    native.only().last().die({ exitCode: 0 })
    await pending
  })

  it('gives up on its own deadline rather than holding a channel for a dead remote', async () => {
    vi.useFakeTimers()
    try {
      const { native, transport } = await connect()
      const pending = transport.runCommand('true', { timeoutMs: 50 })
      await settleOpen()
      const channel = native.only().last() as FakeNativeChannel
      // The remote never answers. A phone dials on every launch; a leaked channel per launch is a
      // leak per launch.
      await vi.advanceTimersByTimeAsync(60)
      const result = await pending
      expect(result.exitCode).toBeNull()
      expect(result.stderr).toContain('timed out')
      expect(channel.closeCalls).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes an in-flight registration when the transport is torn down', async () => {
    const { native, transport } = await connect()
    const pending = transport.runCommand('true')
    await settleOpen()
    const channel = native.only().last() as FakeNativeChannel

    transport.close()

    expect(channel.closeCalls).toBeGreaterThan(0)
    // `FakeNativeChannel.close()` delivers the close, so the promise settles rather than hanging.
    await expect(pending).resolves.toMatchObject({ exitCode: null })
  })

  it('refuses to run anything once the transport is closed', async () => {
    const { transport } = await connect()
    transport.close()
    await expect(transport.runCommand('true')).rejects.toThrow(/transport is closed/)
  })

  it('collects the remote stdout so a diagnostic is not lost', async () => {
    const { native, transport } = await connect()
    const pending = transport.runCommand('echo hi')
    await settleOpen()
    const channel = native.only().last() as FakeNativeChannel
    channel.emitText('hi\n')
    channel.die({ exitCode: 0 })
    await expect(pending).resolves.toMatchObject({ stdout: 'hi\n', exitCode: 0 })
  })
})
