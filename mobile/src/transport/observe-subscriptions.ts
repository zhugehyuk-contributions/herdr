// Rewritten for herdr, from orca mobile/src/transport/rpc-client.ts:853-858 (`markStreamsForReplay`),
// :1076-1082 (`streamListeners` holds `{method, params}`) and
// mobile/src/transport/rpc-client-terminal-subscription.ts:12-34 (`updateTerminalSubscriptionViewport`)
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// X1 and X1b of mobile/.prd/05-orca-transport.md.
//
// X1's rule is orca's exactly: **every subscription is kept, and a reconnect replays all of them.**
// The failure it prevents is the one that looks like success — the transport comes back, the status
// dot goes green, and the pane stays frozen forever because nothing ever re-asked for it.
//
// X1b's rule is why the geometry lives *in here* and not in the screen: orca learned that a
// reconnect that replays a stale subscription reattaches at the size the phone had when it first
// subscribed. Its cure is to mutate the stored params in place when the viewport changes
// (`rpc-client-terminal-subscription.ts:29-32`), so the replay always carries the newest one.
//
// What changes for herdr is *what a subscription is*. orca has one message, `terminal.subscribe`,
// carrying `{terminal, viewport}`. herdr's read path is a handshake across two messages on a
// resident channel — `Hello{cols, rows}` then `ObserveTerminal{target}`
// (`src/session/pane-observer.ts`, verified end to end by `packages/herdr-client-ts/test/live-ssh/`)
// — and the geometry rides the *first* one. So the stored record holds both halves, which is
// literally what 05 asks for:
//
//   > 재연결 `Hello`의 cols/rows + observe 타깃을 함께 저장
//
// Storing them apart would reintroduce X1b through the back door: a `Hello` from one generation and
// an `ObserveTerminal` from another is exactly "재연결했더니 예전 크기로 붙음".

/** One pane the app is watching, in the form a reconnect needs to recreate it. */
export type ObserveSubscription = {
  readonly id: string
  /** `ClientMessage::ObserveTerminal { target }`. */
  paneId: string
  /** `ClientMessage::Hello { cols, rows }` — the grid the server renders this client's frames at. */
  cols: number
  rows: number
  /**
   * False until the handshake for *this generation of the connection* has gone out. A reconnect
   * flips every entry back to false; the supervisor sends what is false and nothing else, so a
   * replay that races a live subscribe cannot double-observe the same pane.
   */
  sent: boolean
}

export type ObserveSubscriptionParams = {
  paneId: string
  cols: number
  rows: number
}

/**
 * The subscriptions a connection must be able to rebuild from nothing.
 *
 * Deliberately free of the codec, the channel and React: X1 is bookkeeping, and bookkeeping that
 * cannot be tested without a socket is bookkeeping nobody tests.
 */
export class ObserveSubscriptionRegistry {
  private readonly entries = new Map<string, ObserveSubscription>()
  private nextId = 1

  /** Registers a pane and returns its handle. The entry starts unsent — the caller sends it. */
  add(params: ObserveSubscriptionParams): ObserveSubscription {
    const id = `observe-${this.nextId}`
    this.nextId += 1
    const entry: ObserveSubscription = { id, ...params, sent: false }
    this.entries.set(id, entry)
    return entry
  }

  remove(id: string): void {
    this.entries.delete(id)
  }

  get(id: string): ObserveSubscription | undefined {
    return this.entries.get(id)
  }

  get size(): number {
    return this.entries.size
  }

  list(): readonly ObserveSubscription[] {
    return [...this.entries.values()]
  }

  markSent(id: string): void {
    const entry = this.entries.get(id)
    if (entry) {
      entry.sent = true
    }
  }

  /**
   * orca `markStreamsForReplay` (`rpc-client.ts:853-858`). Called the moment a connection dies, not
   * when the next one succeeds: an entry left `sent: true` across a dead channel is a subscription
   * the app believes is live and the server has never heard of.
   *
   * Returns the count, because "0 replays after a reconnect" is a diagnosis and a silent no-op is
   * how X1 regressions ship.
   */
  markStreamsForReplay(): number {
    let marked = 0
    for (const entry of this.entries.values()) {
      if (entry.sent) {
        marked += 1
      }
      entry.sent = false
    }
    return marked
  }

  /** What a reconnect owes the server: everything not yet sent on this generation. */
  pendingReplay(): readonly ObserveSubscription[] {
    return [...this.entries.values()].filter((entry) => !entry.sent)
  }

  /**
   * X1b. orca `updateTerminalSubscriptionViewport` (`rpc-client-terminal-subscription.ts:12-34`) —
   * updates the stored params *in place* so a replay carries the newest geometry, keyed by target
   * because a rotation changes every subscription on that pane at once.
   *
   * Note what it does **not** do: it does not resubscribe. herdr's observe mode never resizes the
   * pane (02-architecture.md §2.3), so a viewport change is only ever a note for the *next*
   * `Hello`. That is the whole reason orca's 293-line resubscribe/fit loop is `drop` here
   * (08-orca-port-map.md §6 위험 3) and this is four lines.
   */
  updateObserveViewport(paneId: string, viewport: { cols: number; rows: number }): number {
    let updated = 0
    for (const entry of this.entries.values()) {
      if (entry.paneId !== paneId) {
        continue
      }
      entry.cols = viewport.cols
      entry.rows = viewport.rows
      updated += 1
    }
    return updated
  }

  clear(): void {
    this.entries.clear()
  }
}
