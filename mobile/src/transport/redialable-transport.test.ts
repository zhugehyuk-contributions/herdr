// Not from orca. `./ssh-redial.test.ts` proves *when* the ssh connection is replaced, against a
// contract rather than an implementation; this proves the implementation the app actually ships,
// and the two things it owns that a caller cannot check from outside:
//
//   1. the dying connection is closed **before** the replacement is dialled, so a phone never holds
//      two sshd sessions for the same host (`packages/herdr-client-ts/src/transport.ts`,
//      obligation 5, and 03-blockers.md B8 for what rides on each one);
//   2. concurrent callers produce **one** ssh connection, not one each.
//
// Both are about cost on a metered radio, which is why they are asserted as *ordering* and *counts*
// rather than as "it worked".
import { describe, expect, it } from 'vitest'
import { HerdrChannelKind, type HerdrChannel, type HerdrChannelHandlers } from '@herdr/client-ts'
import { FakeTransport } from '../../../packages/herdr-client-ts/test/fakeTransport'
import { flushMicrotasks } from '../../test/fake-clock'
import {
  RedialableTransport,
  createRedialableConnection,
  RENEW_ABANDONED_MESSAGE,
  TRANSPORT_CLOSED_MESSAGE
} from './redialable-transport'
import type { RemoteDefinition } from '../api/herdr-api-types'

const REMOTE: RemoteDefinition = { id: 'scratch', name: 'scratch', target: { type: 'local' } }

/** A dialer that hands out fresh fake connections and records the order of events. */
function host() {
  const trace: string[] = []
  const opened: FakeTransport[] = []
  let pending: ((transport: FakeTransport) => void) | null = null

  const make = (): FakeTransport => {
    const transport = new FakeTransport()
    const index = opened.push(transport) - 1
    const close = transport.close.bind(transport)
    transport.close = () => {
      trace.push(`close#${index}`)
      close()
    }
    return transport
  }

  return {
    trace,
    opened,
    /** The connection the transport starts on. */
    first: make(),
    /** Resolves the dial in flight, if the test is holding one open. */
    settle() {
      const resolve = pending
      pending = null
      resolve?.(make())
    },
    /** Dials at once. */
    open: (): Promise<FakeTransport> => {
      trace.push(`open#${opened.length}`)
      return Promise.resolve(make())
    },
    /** Dials, and does not answer until {@link settle} is called. */
    hold: (): Promise<FakeTransport> => {
      trace.push(`open#${opened.length}`)
      return new Promise<FakeTransport>((resolve) => {
        pending = resolve
      })
    }
  }
}

const live = (): AbortSignal => new AbortController().signal

describe('RedialableTransport', () => {
  it('closes the connection it is replacing before it dials the replacement', async () => {
    const h = host()
    const transport = new RedialableTransport(h.first, h.open)

    await transport.renew(live())

    // The ordering *is* the rule: reversed, a phone on a bad radio holds two ssh connections, two
    // sshd sessions and two sets of remote `herdr` processes for the length of a dial.
    expect(h.trace).toEqual(['close#0', 'open#1'])
    expect(transport.dialCount).toBe(2)
  })

  it('sends channels to the connection that is current, not the one it was built with', async () => {
    const h = host()
    const transport = new RedialableTransport(h.first, h.open)
    await transport.openChannel(HerdrChannelKind.ClientStream, handlers())
    await transport.renew(live())
    await transport.openChannel(HerdrChannelKind.ClientStream, handlers())

    expect(h.opened[0]!.channels).toHaveLength(1)
    expect(h.opened[1]!.channels).toHaveLength(1)
  })

  it('opens one connection for concurrent callers, not one each', async () => {
    const h = host()
    const transport = new RedialableTransport(h.first, h.hold)

    const both = Promise.all([transport.renew(live()), transport.renew(live())])
    // The dial is reached only after the old connection's `close()` has been awaited, which is the
    // ordering rule above — so the peer cannot answer before the microtasks in between have run.
    await flushMicrotasks()
    h.settle()
    await both

    expect(h.trace).toEqual(['close#0', 'open#1'])
    expect(transport.dialCount).toBe(2)
  })

  it('does not install a connection that arrived after the caller gave up', async () => {
    const h = host()
    const transport = new RedialableTransport(h.first, h.hold)
    const abort = new AbortController()

    const renewed = transport
      .renew(abort.signal)
      .catch((error: unknown) => (error as Error).message)
    await flushMicrotasks()
    abort.abort()
    h.settle()

    expect(await renewed).toBe(RENEW_ABANDONED_MESSAGE)
    // …and it was closed rather than leaked: the ssh connection exists on the far side whether or
    // not this object kept a reference to it.
    expect(h.opened[1]!.closed).toBe(true)
    expect(transport.dialCount).toBe(1)
  })

  it('refuses to renew or open once it has been closed for good', async () => {
    const h = host()
    const transport = new RedialableTransport(h.first, h.open)
    transport.close()

    await expect(transport.renew(live())).rejects.toThrow(TRANSPORT_CLOSED_MESSAGE)
    await expect(transport.openChannel(HerdrChannelKind.ClientStream, handlers())).rejects.toThrow(
      TRANSPORT_CLOSED_MESSAGE
    )
    // Idempotent: `useHerdrSshConnections`'s cleanup and a supervisor teardown can both land.
    transport.close()
    expect(h.trace).toEqual(['close#0'])
  })

  it('rejects a renew rather than resolving it, so a failed redial reaches L3 as a failed dial', async () => {
    const h = host()
    const transport = new RedialableTransport(h.first, () =>
      Promise.reject(new Error('no route to host'))
    )

    await expect(transport.renew(live())).rejects.toThrow('no route to host')
    expect(transport.dialCount).toBe(1)
    // A second attempt is allowed: the single-flight latch is released, or one failed dial would
    // park the redial path forever — L3's #5049 one layer down.
    await expect(transport.renew(live())).rejects.toThrow('no route to host')
  })
})

describe('createRedialableConnection', () => {
  it('gives the connection the verb, wired to the transport', async () => {
    const h = host()
    const { connection, transport } = createRedialableConnection(REMOTE, h.first, h.open)

    expect(connection.remote).toBe(REMOTE)
    expect(connection.redialTransport).toBeDefined()
    await connection.redialTransport?.(live())

    expect(transport.dialCount).toBe(2)
    // The stream opener follows the swap without the caller re-reading anything, which is the point
    // of putting the indirection in the transport rather than in the connection: `PaneObserver` and
    // `JsonApiClient` hold this object too and neither knows a redial happened.
    await connection.openTerminalStream({ onMessage: () => {}, onClose: () => {} })
    expect(h.opened[1]!.channels).toHaveLength(1)
  })
})

function handlers(): HerdrChannelHandlers {
  return { onData: () => {}, onClose: () => {} }
}

/** Compile-time only: the class really is a `HerdrTransport`, which is how it can be swapped in. */
const _assignable: (t: RedialableTransport) => Promise<HerdrChannel> = (t) =>
  t.openChannel(HerdrChannelKind.ClientStream, handlers())
void _assignable
