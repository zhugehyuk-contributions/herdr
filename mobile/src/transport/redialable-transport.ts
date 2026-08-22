// Not from orca. orca redials by constructing a `WebSocket`, so it has no equivalent of this file:
// its transport *is* the dial, and replacing it is one assignment inside `rpc-client.ts`. herdr's
// transport is an ssh connection that `modules/herdr-ssh/src/app-connections.ts` opened once at
// mount, wrapped by `./herdr-connection.ts` into an object with no teardown and no redial — a
// deliberate omission that became a hole the moment M4 started retrying against it
// (`.prd/09-review-followups.md` §L1).
//
// This is the smallest thing that closes it: **an indirection, not a policy.** One object that
// implements `HerdrTransport` by forwarding to whichever ssh connection is current, and that can be
// told to open another one. It owns no timer, counts no attempts and decides nothing — L3 already
// owns all three (`./reconnect-policy.ts`), and a second scheduler here is precisely the "두 개의
// 스케줄러" failure orca's #10119 is about.
//
// What it *does* own is the two rules a caller cannot enforce from outside:
//
//   1. **One host, one ssh connection** (`packages/herdr-client-ts/src/transport.ts`, obligation 5).
//      The dying connection is closed *before* the new one is dialled, so the two never coexist. A
//      phone that overlapped them would hold two sshd sessions, two TCP flows and — via whatever
//      channels were open — two sets of remote `herdr` processes (03-blockers.md B8), for as long
//      as a dial on a bad radio takes, which is exactly when it can least afford them.
//   2. **One redial at a time.** `renew` is single-flight, so N callers arriving during one dial
//      produce one ssh connection and not N.
import type {
  HerdrChannel,
  HerdrChannelHandlers,
  HerdrChannelKind,
  HerdrTransport
} from '@herdr/client-ts'
import { createTransportConnection, type TransportConnectionOptions } from './herdr-connection'
import type { HerdrRemoteConnection } from './herdr-connection'
import type { RemoteDefinition } from '../api/herdr-api-types'

/**
 * Opens one ssh connection to the host this transport is for.
 *
 * The signal is advisory rather than binding, and that is stated rather than hidden: a native ssh
 * connect (`modules/herdr-ssh/src/ssh-transport.ts`, and `ssh2` in Node) has no cancellation — it
 * has a `connectTimeoutMs`. So an implementation is free to ignore it, and {@link
 * RedialableTransport} honours it at the seams instead: a connection that arrives after the caller
 * gave up is closed rather than installed.
 */
export type TransportDialer = (signal: AbortSignal) => Promise<HerdrTransport>

/** What {@link RedialableTransport.renew} rejects with when the caller stopped waiting. */
export const RENEW_ABANDONED_MESSAGE = 'the ssh redial was abandoned'

/** What every method rejects with once the owner has hung up for good. */
export const TRANSPORT_CLOSED_MESSAGE = 'the transport is closed'

export class RedialableTransport implements HerdrTransport {
  private current: HerdrTransport
  private readonly open: TransportDialer
  private renewal: Promise<void> | null = null
  private ended = false
  private dialled = 1

  constructor(first: HerdrTransport, open: TransportDialer) {
    this.current = first
    this.open = open
  }

  /**
   * ssh connections opened, the first included.
   *
   * The receipt's headline number, because two very different behaviours look identical without
   * it: a link that recovered, and a link that recovered by opening one ssh connection per failed
   * attempt. Only the first is shippable to a phone.
   *
   * ⚠️ Wording, not style: `modules/herdr-ssh/test/bundle-contract.test.ts` walks this module graph
   * with a regex over raw source and cannot see comments, so an import keyword or the word before
   * a specifier, followed by a quoted phrase, is read as a real import and fails the Hermes-bundle
   * gate. Prose in this subtree keeps quoted phrases out of that position.
   */
  get dialCount(): number {
    return this.dialled
  }

  openChannel(kind: HerdrChannelKind, handlers: HerdrChannelHandlers): Promise<HerdrChannel> {
    if (this.ended) {
      return Promise.reject(new Error(TRANSPORT_CLOSED_MESSAGE))
    }
    // Read at call time, never captured: a channel opened after a renew must land on the connection
    // that renew installed, and a caller holding this object across the swap is the normal case
    // (`./observe-stream-link.ts` captures the connection once, for the life of the supervisor).
    return this.current.openChannel(kind, handlers)
  }

  /**
   * Drops the current ssh connection and opens another.
   *
   * Rejecting rather than resolving on failure is the contract that matters: the caller is a dial
   * inside L3's loop (`./observe-stream-link.ts`), and a redial that failed must arrive there as a
   * failed dial so the ladder backs off. Resolving would report a working connection that is not.
   */
  renew(signal: AbortSignal): Promise<void> {
    if (this.ended) {
      return Promise.reject(new Error(TRANSPORT_CLOSED_MESSAGE))
    }
    if (signal.aborted) {
      return Promise.reject(new Error(RENEW_ABANDONED_MESSAGE))
    }
    this.renewal ??= this.replace(signal).finally(() => {
      this.renewal = null
    })
    return this.renewal
  }

  close(): void | Promise<void> {
    if (this.ended) {
      return
    }
    this.ended = true
    return this.current.close()
  }

  private async replace(signal: AbortSignal): Promise<void> {
    const dying = this.current
    // Rule 1, and the ordering is the rule. It also gives every channel on the old connection its
    // one termination (`NativeSshHerdrTransport.close` synthesizes them), so a pane observer
    // holding a stream on the dead connection learns it is dead here rather than never.
    try {
      await dying.close()
    } catch {
      // A connection that is already gone is the normal case here, not an error — it is why this
      // method was called.
    }
    const next = await this.open(signal)
    if (this.ended || signal.aborted) {
      // Nobody is waiting for this any more. Installing it would leave an ssh connection and its
      // sshd session held by an object the caller has stopped reading.
      void next.close()
      throw new Error(this.ended ? TRANSPORT_CLOSED_MESSAGE : RENEW_ABANDONED_MESSAGE)
    }
    this.current = next
    this.dialled += 1
  }
}

/**
 * One remote, dialled, with the ability to dial it again.
 *
 * The single call site's whole job: `createTransportConnection` already turns a transport into the
 * two faces the screens use, so all this adds is the transport that can be replaced and the verb
 * that replaces it, wired to each other. Keeping the wiring here rather than in
 * `modules/herdr-ssh/src/app-connections.ts` is what lets `test/live/` and the Node harness build
 * the same thing over `SshHerdrTransport` without repeating the reasoning.
 */
export function createRedialableConnection(
  remote: RemoteDefinition,
  first: HerdrTransport,
  open: TransportDialer,
  options: TransportConnectionOptions = {}
): { connection: HerdrRemoteConnection; transport: RedialableTransport } {
  const transport = new RedialableTransport(first, open)
  return {
    connection: {
      ...createTransportConnection(remote, transport, options),
      redialTransport: (signal: AbortSignal) => transport.renew(signal)
    },
    transport
  }
}
