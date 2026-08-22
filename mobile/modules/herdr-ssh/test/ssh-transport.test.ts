// Not from orca. The receipt for the React Native ssh transport.
//
// `packages/herdr-client-ts/src/transport.ts` states nine obligations on any `HerdrTransport`
// implementation. Five of them (4, 6, 7, 8, 9) are not about ssh at all — they are about when
// handlers are attached, whose bytes go where, who owns a buffer, what `write` resolving means, and
// what a write racing a close does. Those are decided in `src/ssh-transport.ts`, above the native
// boundary, and this file proves each one against `FakeNativeSsh`.
//
// The other four are proved as far as this side of the boundary allows and no further, which is
// stated explicitly per test rather than implied: obligation 1 is a guard on `BRIDGE_EXEC_OPTIONS`
// (the native side has no pty knob at all), 2 is byte-identity of the command string, 3 is the
// stderr field surviving the marshalling, 5 is the connection count.
//
// ⚠️ What no test here proves: that the Swift or Kotlin sources compile, that libssh2/sshj behave as
// `NativeSshChannel` describes, or that a phone can reach a herdr server. Those need a device build
// and none has been run — see `modules/herdr-ssh/README.md` §Unverified.
import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_EXEC_OPTIONS, HerdrChannelKind, remoteBridgeCommand } from '@herdr/client-ts'
import type { HerdrChannelClose } from '@herdr/client-ts'
import { NativeSshHerdrTransport, type NativeSshTransportOptions } from '../src/ssh-transport'
import type { NativeSshConnectConfig } from '../src/native-types'
import { FakeNativeSsh, type FakeNativeChannel } from './fake-native-ssh'

const SSH: NativeSshConnectConfig = {
  host: 'box.example',
  port: 22,
  username: 'z',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n',
  hostKeySha256: 'BSCsSxvKZL1uVLZ4L0jMTdrKcHhAOQqPLPKzPq1oXbc',
  connectTimeoutMs: 20_000,
  keepaliveIntervalMs: 15_000
}

async function connect(
  options: Partial<NativeSshTransportOptions> = {}
): Promise<{ native: FakeNativeSsh; transport: NativeSshHerdrTransport }> {
  const native = new FakeNativeSsh()
  const transport = await NativeSshHerdrTransport.connect(native, { ssh: SSH, ...options })
  return { native, transport }
}

/** Collects everything a channel's handlers were told, so assertions read as a transcript. */
function recorder(): {
  chunks: Uint8Array[]
  closes: HerdrChannelClose[]
  handlers: { onData(chunk: Uint8Array): void; onClose(close: HerdrChannelClose): void }
} {
  const chunks: Uint8Array[] = []
  const closes: HerdrChannelClose[] = []
  return {
    chunks,
    closes,
    handlers: {
      onData: (chunk) => chunks.push(chunk),
      onClose: (close) => closes.push(close)
    }
  }
}

describe('obligation 1 — exec without a pty', () => {
  it('the codec still says no pty, and the native API has no knob to disagree with', () => {
    // The native `openChannel` takes (command, onData, onClose) and nothing else, so `pty: true` is
    // unexpressible. This asserts the constant it is unexpressible *against*.
    expect(BRIDGE_EXEC_OPTIONS.pty).toBe(false)
  })

  it('refuses to open a channel if that constant ever flips', async () => {
    const { transport } = await connect()
    const mutable = BRIDGE_EXEC_OPTIONS as unknown as { pty: boolean }
    mutable.pty = true
    try {
      await expect(
        transport.openChannel(HerdrChannelKind.ApiRequest, recorder().handlers)
      ).rejects.toThrow(/no longer false/)
    } finally {
      mutable.pty = false
    }
  })
})

describe('obligation 2 — the command string comes from the codec, verbatim', () => {
  it('passes remoteBridgeCommand output through byte for byte, for every kind', async () => {
    const options = {
      herdrBinary: '/home/z/.local/bin/herdr',
      session: 'my session',
      env: { HERDR_SOCKET_PATH: '/tmp/herdr live.sock' }
    }
    const { native, transport } = await connect(options)
    const encoder = new TextEncoder()
    for (const kind of Object.values(HerdrChannelKind)) {
      await transport.openChannel(kind, recorder().handlers)
      const sent = native.only().last().command
      expect([...encoder.encode(sent)]).toEqual([
        ...encoder.encode(remoteBridgeCommand(kind, options))
      ])
    }
  })

  it('pins the exact string, so a platform-side rebuild would be visible here', async () => {
    const { native, transport } = await connect({
      herdrBinary: '/home/z/.local/bin/herdr',
      session: 'my session',
      env: { HERDR_SOCKET_PATH: '/tmp/herdr live.sock' }
    })
    await transport.openChannel(HerdrChannelKind.ClientStream, recorder().handlers)
    expect(native.only().last().command).toBe(
      "exec env HERDR_SOCKET_PATH='/tmp/herdr live.sock' /home/z/.local/bin/herdr " +
        "--session 'my session' remote-client-bridge"
    )
  })

  it('omits --session for the default session, exactly as the Rust side does', async () => {
    const { native, transport } = await connect({ session: 'default' })
    await transport.openChannel(HerdrChannelKind.ApiStream, recorder().handlers)
    expect(native.only().last().command).toBe('exec herdr remote-api-bridge')
  })
})

describe('obligation 3 — stderr rides the close', () => {
  it('carries the only error channel the bridges have through to HerdrChannelClose', async () => {
    const { native, transport } = await connect()
    const seen = recorder()
    await transport.openChannel(HerdrChannelKind.ApiRequest, seen.handlers)
    native.only().last().die({ exitCode: 1, stderr: 'protocol mismatch: server 19, client 20\n' })
    expect(seen.closes).toEqual([
      { exitCode: 1, stderr: 'protocol mismatch: server 19, client 20\n' }
    ])
  })

  it('drops null and empty stderr rather than printing `stderr=null`', async () => {
    const { native, transport } = await connect()
    const seen = recorder()
    await transport.openChannel(HerdrChannelKind.ApiRequest, seen.handlers)
    // Kotlin's nullable fields marshal as `null`, Swift's optionals as `undefined`; both mean absent.
    native.only().last().die({ exitCode: 0, signal: null, stderr: '', errorMessage: null })
    expect(seen.closes).toEqual([{ exitCode: 0 }])
  })
})

describe('obligation 4 — handlers are attached before the channel is observable', () => {
  it('delivers bytes the remote produced before openChannel resolved', async () => {
    const { native, transport } = await connect()
    const seen = recorder()
    const pending = transport.openChannel(HerdrChannelKind.ApiStream, seen.handlers)
    // `onOpen` already ran, synchronously, inside `openChannel` — before the await below.
    native.only().last().emitText('{"id":"ts-events","result":{"type":"subscription_started"}}\n')
    expect(seen.chunks).toHaveLength(1)
    await pending
  })

  it('delivers a close that happened before openChannel resolved, exactly once', async () => {
    const native = new FakeNativeSsh()
    const transport = await NativeSshHerdrTransport.connect(native, { ssh: SSH })
    const seen = recorder()
    // The `ensure_remote_server_running` failure mode: the bridge writes its whole complaint to
    // stderr and exits before the exec is acknowledged (`src/remote/unix.rs:592-611`).
    native.only().onOpen = (channel: FakeNativeChannel) => {
      channel.die({ exitCode: 1, stderr: 'herdr: command not found\n' })
    }
    const channel = await transport.openChannel(HerdrChannelKind.ApiRequest, seen.handlers)
    expect(seen.closes).toEqual([{ exitCode: 1, stderr: 'herdr: command not found\n' }])
    channel.close()
    expect(seen.closes).toHaveLength(1)
  })
})

describe('obligation 5 — one connection, N channels', () => {
  it('never dials twice, whatever the channel mix', async () => {
    const { native, transport } = await connect()
    for (const kind of [
      HerdrChannelKind.ApiRequest,
      HerdrChannelKind.ApiRequest,
      HerdrChannelKind.ApiStream,
      HerdrChannelKind.ClientStream
    ]) {
      await transport.openChannel(kind, recorder().handlers)
    }
    expect(native.connections).toHaveLength(1)
    expect(transport.connectionCount).toBe(1)
    expect(transport.channelCount).toBe(4)
    expect(native.only().channels).toHaveLength(4)
  })

  it('refuses to open after the transport is closed, and disconnects once', async () => {
    const { native, transport } = await connect()
    transport.close()
    transport.close()
    await expect(
      transport.openChannel(HerdrChannelKind.ApiRequest, recorder().handlers)
    ).rejects.toThrow('transport is closed')
    expect(native.only().disconnects).toBe(1)
  })
})

describe('obligation 6 — ordered, exactly once, never on another channel', () => {
  it('keeps the two streams apart and in order', async () => {
    const { native, transport } = await connect()
    const api = recorder()
    const stream = recorder()
    await transport.openChannel(HerdrChannelKind.ApiStream, api.handlers)
    const apiChannel = native.only().last()
    await transport.openChannel(HerdrChannelKind.ClientStream, stream.handlers)
    const streamChannel = native.only().last()

    apiChannel.emitText('a1')
    streamChannel.emitText('s1')
    apiChannel.emitText('a2')
    streamChannel.emitText('s2')
    apiChannel.emitText('a3')

    const decode = (chunks: Uint8Array[]): string =>
      chunks.map((chunk) => new TextDecoder().decode(chunk)).join('')
    expect(decode(api.chunks)).toBe('a1a2a3')
    expect(decode(stream.chunks)).toBe('s1s2')
  })

  it('drops — and counts — bytes that arrive after onClose', async () => {
    const { native, transport } = await connect()
    const seen = recorder()
    const channel = await transport.openChannel(HerdrChannelKind.ClientStream, seen.handlers)
    const remote = native.only().last()
    remote.emitText('before')
    remote.die({ exitCode: 0 })
    // A length-prefixed framer that is told the stream ended and then handed more bytes does not
    // lose "an event"; it loses the frame boundary, permanently.
    remote.emitText('after')
    expect(seen.chunks).toHaveLength(1)
    expect(channel.dataAfterClose).toBe(1)
    expect(seen.closes).toHaveLength(1)
  })

  it('reports onClose once even when both sides close', async () => {
    const { native, transport } = await connect()
    const seen = recorder()
    const channel = await transport.openChannel(HerdrChannelKind.ApiRequest, seen.handlers)
    channel.close()
    native.only().last().die({ exitCode: 0 })
    transport.close()
    expect(seen.closes).toHaveLength(1)
  })
})

describe('obligation 7 — the onData buffer belongs to the transport', () => {
  it('forwards the native buffer by reference, adding no copy of its own', async () => {
    const { native, transport } = await connect()
    const seen = recorder()
    await transport.openChannel(HerdrChannelKind.ClientStream, seen.handlers)
    const chunk = new Uint8Array([1, 2, 3])
    native.only().last().emit(chunk)
    // Identity, not equality: a defensive copy here would be paid on every 55 KB frame, and the
    // consumers that need to keep bytes already copy (`FrameReader.push`, `LineAccumulator.push`).
    expect(seen.chunks[0]).toBe(chunk)
  })

  it('survives a transport that reuses one buffer, because nothing above retains it', async () => {
    const { native, transport } = await connect()
    const copied: string[] = []
    await transport.openChannel(HerdrChannelKind.ClientStream, {
      onData: (chunk) => copied.push(new TextDecoder().decode(chunk.slice())),
      onClose: () => {}
    })
    const scratch = new Uint8Array(2)
    const remote = native.only().last()
    scratch.set([0x68, 0x69])
    remote.emit(scratch)
    scratch.set([0x79, 0x6f])
    remote.emit(scratch)
    expect(copied).toEqual(['hi', 'yo'])
  })
})

describe('obligation 8 — write resolves on hand-off, not on delivery', () => {
  it('resolves as soon as the send path accepts the bytes, with no reply in sight', async () => {
    const { native, transport } = await connect()
    const seen = recorder()
    const channel = await transport.openChannel(HerdrChannelKind.ClientStream, seen.handlers)
    await channel.write(new Uint8Array([9, 9]))
    const remote = native.only().last()
    expect(remote.handedOff).toBe(1)
    // The only end-to-end confirmation this protocol has is a reply on the same channel, and there
    // is none: the write resolved anyway.
    expect(seen.chunks).toHaveLength(0)
    expect([...(remote.written[0] as Uint8Array)]).toEqual([9, 9])
  })
})

describe('obligation 9 — a write racing a close must not throw', () => {
  it('drops a write issued after close, and counts it', async () => {
    const { native, transport } = await connect()
    const channel = await transport.openChannel(HerdrChannelKind.ClientStream, recorder().handlers)
    native.only().last().die({ exitCode: 0 })
    await expect(channel.write(new Uint8Array([1]))).resolves.toBeUndefined()
    expect(channel.writesAfterClose).toBe(1)
  })

  it('swallows a native rejection that lands after the channel is gone', async () => {
    const { native, transport } = await connect()
    const channel = await transport.openChannel(HerdrChannelKind.ClientStream, recorder().handlers)
    const remote = native.only().last()
    let rejectWrite: (error: Error) => void = () => {}
    remote.pendingWrite = new Promise<void>((_, reject) => {
      rejectWrite = reject
    })
    const inFlight = channel.write(new Uint8Array([1]))
    remote.die({ exitCode: 0 })
    rejectWrite(new Error('channel closed while writing'))
    await expect(inFlight).resolves.toBeUndefined()
    expect(channel.writesAfterClose).toBe(1)
  })

  it('still surfaces a write failure on a live channel', async () => {
    const { native, transport } = await connect()
    const channel = await transport.openChannel(HerdrChannelKind.ClientStream, recorder().handlers)
    native.only().last().pendingWrite = Promise.reject(new Error('socket buffer full'))
    await expect(channel.write(new Uint8Array([1]))).rejects.toThrow('socket buffer full')
  })
})

describe('teardown and host keys', () => {
  it('gives every live channel exactly one termination when the transport closes', async () => {
    const { transport } = await connect()
    const first = recorder()
    const second = recorder()
    await transport.openChannel(HerdrChannelKind.ApiStream, first.handlers)
    await transport.openChannel(HerdrChannelKind.ClientStream, second.handlers)
    transport.close()
    for (const seen of [first, second]) {
      expect(seen.closes).toHaveLength(1)
      expect(seen.closes[0]?.error?.message).toBe('transport closed')
    }
  })

  it('refuses to dial a host whose key it cannot check', async () => {
    const native = new FakeNativeSsh()
    const { hostKeySha256: _omitted, ...noFingerprint } = SSH
    await expect(NativeSshHerdrTransport.connect(native, { ssh: noFingerprint })).rejects.toThrow(
      /no host key fingerprint configured for box.example/
    )
    expect(native.connections).toHaveLength(0)
  })

  it('dials when the caller opts out explicitly', async () => {
    const native = new FakeNativeSsh()
    const { hostKeySha256: _omitted, ...noFingerprint } = SSH
    await NativeSshHerdrTransport.connect(native, {
      ssh: { ...noFingerprint, allowUnknownHostKey: true }
    })
    expect(native.connections).toHaveLength(1)
  })

  it('does not leak a channel record when openChannel fails', async () => {
    const { native, transport } = await connect()
    native.only().openFailure = new Error('exec request refused')
    await expect(
      transport.openChannel(HerdrChannelKind.ApiRequest, recorder().handlers)
    ).rejects.toThrow('exec request refused')
    expect(transport.channelCount).toBe(0)
    const closes = vi.fn()
    transport.close()
    expect(closes).not.toHaveBeenCalled()
  })
})
