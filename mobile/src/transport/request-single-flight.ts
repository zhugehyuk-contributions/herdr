// Ported from orca mobile/src/transport/request-single-flight.ts
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// X5. The algorithm below — a `(client, host, kind)` keyed map, one request on the wire, **at most
// one trailing follow-up whose params the latest trigger wins**, and an `onSettled` that recurses —
// is orca's, line for line. Three names differ and nothing else does:
//
//   orca                          here                     why
//   `RpcClient`                   `JsonApiClient`          the identity that owns the map's first key
//   `client.sendRequest(k, p)`    `client.request(k, p)`    herdr's control plane is NDJSON, not RPC frames
//   `RpcResponse`                 `JsonApiResult`          `request` returns the `result` envelope
//
// **Why this matters more here than in orca.** orca's client multiplexes over one WebSocket, so a
// duplicate refresh costs a frame. herdr's does not: blocker B8 — `handle_connection` reads exactly
// one line and returns (`src/api/server.rs:139-152`) — makes **one JSON call one ssh exec one remote
// `herdr` process**. So the failure this prevents is not chattiness, it is a fork bomb: N panes
// resuming at once, each refreshing, is N remote processes spawned in the same instant on a box
// whose whole appeal is that it is someone's laptop. 05-orca-transport.md says exactly that —
// "B8이 남아있는 동안 특히 필수" — and L4 guarantees the simultaneity, because AppState 'active' and a
// Wi-Fi→cellular change reach every screen in the same tick.
import type { JsonApiClient } from '@herdr/client-ts'

/** What `JsonApiClient.request` resolves to: the `result` envelope, tagged. */
export type JsonApiResult = { type: string } & Record<string, unknown>

type Deferred = {
  promise: Promise<JsonApiResult>
  resolve: (value: JsonApiResult) => void
  reject: (reason?: unknown) => void
}

type SingleFlightEntry = {
  // The request currently on the wire for this (client, host, kind).
  current: Promise<JsonApiResult>
  // At most one trailing follow-up: every trigger that arrives while `current` is in flight coalesces
  // here so a refresh requested mid-read still re-reads the latest state (latest params win) instead of
  // being silently answered by the older in-flight response.
  followUp: { deferred: Deferred; params: Record<string, unknown> } | null
}

const inFlightRequests = new WeakMap<JsonApiClient, Map<string, Map<string, SingleFlightEntry>>>()

function makeDeferred(): Deferred {
  let resolve!: (value: JsonApiResult) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<JsonApiResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export function sendSingleFlightRequest(
  client: JsonApiClient,
  hostId: string,
  requestKind: string,
  params: Record<string, unknown> = {}
): Promise<JsonApiResult> {
  let requestsByHost = inFlightRequests.get(client)
  if (!requestsByHost) {
    requestsByHost = new Map()
    inFlightRequests.set(client, requestsByHost)
  }
  let requestsByKind = requestsByHost.get(hostId)
  if (!requestsByKind) {
    requestsByKind = new Map()
    requestsByHost.set(hostId, requestsByKind)
  }

  const send = (): Promise<JsonApiResult> => {
    try {
      return client.request(requestKind, params)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  const existing = requestsByKind.get(requestKind)
  if (existing) {
    // A read is already on the wire: don't fire a duplicate now, but don't drop this trigger either.
    // Record (or refresh) a single trailing follow-up that runs once the current read settles.
    if (existing.followUp) {
      existing.followUp.params = params
    } else {
      existing.followUp = { deferred: makeDeferred(), params }
    }
    return existing.followUp.deferred.promise
  }

  const entry: SingleFlightEntry = { current: send(), followUp: null }
  requestsByKind.set(requestKind, entry)

  const byKind = requestsByKind
  const byHost = requestsByHost
  const cleanup = (): void => {
    if (byKind.get(requestKind) !== entry) {
      return
    }
    byKind.delete(requestKind)
    if (byKind.size === 0) {
      byHost.delete(hostId)
    }
    if (byHost.size === 0) {
      inFlightRequests.delete(client)
    }
  }

  // Chain each settled request into either its queued follow-up (delivering the fresh result to every
  // caller that awaited it) or entry teardown. Recurses so triggers arriving during a follow-up queue
  // the next one.
  const onSettled = (): void => {
    const followUp = entry.followUp
    if (!followUp) {
      cleanup()
      return
    }
    entry.followUp = null
    let next: Promise<JsonApiResult>
    try {
      next = client.request(requestKind, followUp.params)
    } catch (error) {
      next = Promise.reject(error)
    }
    entry.current = next
    next.then(
      (response) => followUp.deferred.resolve(response),
      (error: unknown) => followUp.deferred.reject(error)
    )
    void next.then(onSettled, onSettled)
  }

  void entry.current.then(onSettled, onSettled)
  return entry.current
}

/** How many `(host, kind)` slots this client currently holds. Zero after everything settles. */
export function inFlightRequestCount(client: JsonApiClient): number {
  const requestsByHost = inFlightRequests.get(client)
  if (!requestsByHost) {
    return 0
  }
  let total = 0
  for (const byKind of requestsByHost.values()) {
    total += byKind.size
  }
  return total
}
