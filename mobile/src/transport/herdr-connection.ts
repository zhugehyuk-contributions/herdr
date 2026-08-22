// Not from orca. orca's transport is a WebSocket that React Native provides, so the whole notion of
// "how do I reach this host" collapses into a URL there; herdr's is an ssh exec channel onto
// `herdr remote-{api,client}-bridge` (mobile/.prd/02-architecture.md §2.1), and the ssh stack is a
// native module that does not exist yet (§2.4 N1). This file is the shape of a reachable remote
// *without* naming who implements the ssh: everything below is written against `HerdrTransport`
// (`packages/herdr-client-ts/src/transport.ts`), the interface both the Node `ssh2` adapter and a
// future React Native native module satisfy.
//
// ⚠️ Nothing here may import `@herdr/client-ts/node`. That entry point is ssh2/Node and
// `metro.config.js` blocks it out of the bundle on purpose; the app sees the interface, the test
// harness supplies the implementation.
import {
  ServerMessageChannel,
  createTransportJsonApiClient,
  type HerdrTransport,
  type JsonApiClient,
  type ServerMessageChannelHandlers,
  type ServerMessageChannelOptions,
  type TransportJsonApiOptions
} from '@herdr/client-ts'
import type { RemoteDefinition } from '../api/herdr-api-types'

/**
 * One remote the phone can actually talk to, as the screens see it.
 *
 * Two faces, because herdr is two protocols on two bridges: {@link HerdrRemoteConnection.api} is
 * the NDJSON control plane (enumeration, and later input), {@link
 * HerdrRemoteConnection.openTerminalStream} is the framed client protocol that carries one pane's
 * screen. Keeping them on one object is the fact 02-architecture.md §2.1 states — both ride the
 * *same* ssh connection, so a screen that has one has the other.
 *
 * What is deliberately absent, and where it lands instead: connection state, reconnect policy,
 * acquire/release ref-counting and `forceReconnect` are orca's `client-context.tsx` (port map §2.3,
 * L1-L7 / X1-X6, scheduled for M4 stage 8). Adding a placeholder for them here would be a second
 * home for a state machine that is going to be ported wholesale.
 */
export type HerdrRemoteConnection = {
  remote: RemoteDefinition
  /** `remote-api-bridge`. One exec channel per request — blocker B8, not a choice made here. */
  api: JsonApiClient
  /** `remote-client-bridge`. Resident, one per observed pane; the caller owns closing it. */
  openTerminalStream: (
    handlers: ServerMessageChannelHandlers,
    options?: ServerMessageChannelOptions
  ) => Promise<ServerMessageChannel>
}

export type TransportConnectionOptions = {
  json?: TransportJsonApiOptions
  stream?: ServerMessageChannelOptions
}

/**
 * Wraps a {@link HerdrTransport} into a {@link HerdrRemoteConnection}.
 *
 * This is the entire stage-6 adaptation, and it is three lines because `packages/herdr-client-ts`
 * already did the work: `createTransportJsonApiClient` turns the transport into the same
 * `JsonApiClient` the unix-socket harness uses, and `ServerMessageChannel.open` turns it into the
 * framed stream. Whoever supplies the transport — `SshHerdrTransport` in Node, a native module on a
 * phone — is invisible from here up.
 */
export function createTransportConnection(
  remote: RemoteDefinition,
  transport: HerdrTransport,
  options: TransportConnectionOptions = {}
): HerdrRemoteConnection {
  return {
    remote,
    api: createTransportJsonApiClient(transport, options.json ?? {}),
    openTerminalStream: (handlers, streamOptions) =>
      ServerMessageChannel.open(transport, handlers, streamOptions ?? options.stream ?? {})
  }
}
