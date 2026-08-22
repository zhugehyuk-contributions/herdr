// Not from orca. orca writes with `terminal.write` on a *persistent* WebSocket whose client owns an
// outbox, so its send path is a one-liner over a queue that already exists. herdr's write is a JSON
// API method on a socket where **one request is one connection** (`src/api/server.rs:139-152`,
// blocker B8) reached over ssh exec, so a tap is a process. That inversion — the queue is the
// problem, not the solution — is what this file is.
//
// The contract it implements, from mobile/.prd/05-orca-transport.md X2:
//
//   > `pane.send_input`은 **절대 큐잉하지 않는다** … 마지막 write가 배달됐는지 모름 ->
//   > delivery-unknown 표시(실패로 단정 금지) + 끊긴 상태의 키 입력은 즉시 거절
//
// Read precisely, that bans two things and neither of them is ordering:
//   1. **holding input across a dead transport and replaying it later.** Below: `pending` is
//      dropped, never retried, the moment a send fails or the connection is gone, and a tap with no
//      connection is answered `rejected` synchronously — it is never parked.
//   2. **calling an unacknowledged write a failure.** Below: only a *server* answer decides. See
//      {@link PaneInputDelivery}.
//
// What it does NOT ban is keeping the phone's own taps in the order the user made them, and that is
// not optional: a pane is a byte stream, and two `pane.send_input` calls in flight at once are two
// ssh execs racing to the same PTY. So there is exactly one request in flight per sender, and taps
// made while it is in flight **merge** rather than fan out — which is also the answer to B8, since N
// taps during one round-trip cost one extra exec instead of N.
//
// The merge is order-preserving, and that constraint comes from the server: `encode_api_input`
// (`src/app/api_helpers.rs:72-84`) writes `text` first and *then* every key, so `{text, keys}` can
// only ever express "this text, then these keys". Two taps merge only when merging does not reorder
// them — see {@link mergeChunk}.
import { JsonApiError, type JsonApiClient } from '@herdr/client-ts'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'

/** One `pane.send_input` payload, in the only shape the server can express (text, then keys). */
export type PaneInputChunk = {
  text: string
  keys: readonly string[]
}

/**
 * What is known about a chunk after the attempt — deliberately three-valued.
 *
 * - `delivered`: the server answered `ok`. It ran.
 * - `rejected`: the server answered an *error envelope* (`JsonApiError`). It reached herdr and herdr
 *   refused it — `invalid_key` for a name outside `parse_key_combo`
 *   (`src/app/api/panes.rs:1552`), `pane_not_found`, `pane_send_failed`. Also the verdict for a tap
 *   this client refused to make at all (no connection, no pane, backpressure).
 * - `unknown`: anything else — the ssh channel died, the reply never parsed, the exec exited. **The
 *   write may or may not have reached the PTY**, and X2 forbids calling that a failure. The UI shows
 *   it as delivery-unknown; nothing retries it.
 */
export type PaneInputDelivery = 'delivered' | 'rejected' | 'unknown'

export type PaneInputResult = {
  delivery: PaneInputDelivery
  /** Present for `rejected` and `unknown`; the server's code, or one of this file's own. */
  reason: string | null
}

export type PaneInputState = {
  /** The verdict on the most recent attempt, or null before the first one. */
  last: PaneInputResult | null
  /** True while a `pane.send_input` is in flight — the single-flight slot is taken. */
  inFlight: boolean
  /** Chunks merged while the slot was taken, waiting for it. Never survives a failure. */
  pendingChunks: number
}

export type PaneInputSenderOptions = {
  /** Null when the remote is listed but not dialled: every tap is then `rejected`, not parked. */
  api: JsonApiClient | null
  /** Null before a pane is resolved. Same treatment. */
  paneId: string | null
  onState?: (state: PaneInputState) => void
}

/**
 * Backpressure bound. Past this many merged-but-unsent chunks the sender refuses taps instead of
 * growing, because an unbounded `pending` is the queue X2 bans wearing a different hat: on a stalled
 * ssh channel it would accumulate keystrokes and then flush minutes of them into a live agent.
 *
 * Four is chosen for what it has to cover: an order-preserving merge only splits when the *kind*
 * alternates (text -> keys -> text …), so four chunks is four alternations inside one round-trip.
 */
export const MAX_PENDING_INPUT_CHUNKS = 4

/**
 * Cap on merged text. `pane.send_input` has no length limit of its own, but the phone is not a paste
 * buffer, and a runaway IME repeat should be refused visibly rather than delivered late.
 */
export const MAX_PENDING_INPUT_TEXT = 4096

const IDLE_STATE: PaneInputState = { last: null, inFlight: false, pendingChunks: 0 }

/**
 * Merges `next` into `into` when that cannot reorder them, else null.
 *
 * The rule is forced by `encode_api_input` (`src/app/api_helpers.rs:72-84`): the bytes are `text`
 * then `keys`. So
 *   - text after text-with-no-keys      -> concatenate the text.
 *   - keys after anything               -> append the keys (they are already last).
 *   - text after a chunk that has keys  -> **no merge**; `{ "ab", [Enter] }` + `"c"` would send
 *                                          `ab` `\r` `c`, but the user typed `ab` `\r` … `c` in that
 *                                          order only if `c` comes after, which a merge would break
 *                                          by hoisting `c` in front of the Enter.
 */
export function mergeChunk(into: PaneInputChunk, next: PaneInputChunk): PaneInputChunk | null {
  if (next.text.length > 0 && into.keys.length > 0) {
    return null
  }
  return {
    text: into.text + next.text,
    keys: [...into.keys, ...next.keys]
  }
}

/** True when the chunk would send nothing at all — the server would accept it and do nothing. */
export function isEmptyChunk(chunk: PaneInputChunk): boolean {
  return chunk.text.length === 0 && chunk.keys.length === 0
}

function totalPendingText(chunks: readonly PaneInputChunk[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
}

/**
 * The pane write path: one in flight, order preserved, nothing retried.
 *
 * Construct one per (connection, pane) — `use-pane-input.ts` does that — and call {@link send}. It
 * resolves with what is *known*, so a caller that wants to render "delivery unknown" can, and a
 * caller that treats `unknown` as failure is choosing to, against X2.
 */
export class PaneInputSender {
  private readonly options: PaneInputSenderOptions
  private state: PaneInputState = IDLE_STATE
  private pending: PaneInputChunk[] = []
  private draining: Promise<void> | null = null
  private closed = false

  constructor(options: PaneInputSenderOptions) {
    this.options = options
  }

  getState(): PaneInputState {
    return this.state
  }

  /**
   * Sends text, keys, or both.
   *
   * Resolves once *this* chunk has a verdict. Note that a merged chunk shares one verdict with
   * whatever it merged into, which is the truth: they became one `pane.send_input`.
   */
  async send(chunk: PaneInputChunk): Promise<PaneInputResult> {
    if (isEmptyChunk(chunk)) {
      return this.settle({ delivery: 'rejected', reason: 'empty_input' })
    }
    // Refused, not parked: X2's "끊긴 상태의 키 입력은 즉시 거절". A phone with no transport must
    // not accumulate an approval that lands minutes later, when the prompt it answered is gone.
    if (this.closed) {
      return this.settle({ delivery: 'rejected', reason: 'sender_closed' })
    }
    if (this.options.api === null) {
      return this.settle({ delivery: 'rejected', reason: 'no_transport' })
    }
    if (this.options.paneId === null) {
      return this.settle({ delivery: 'rejected', reason: 'no_pane' })
    }

    const enqueued = this.enqueue(chunk)
    if (enqueued !== null) {
      return this.settle(enqueued)
    }
    this.publish()
    await this.drain()
    return this.state.last ?? { delivery: 'unknown', reason: 'no_result' }
  }

  /** Convenience for the IME path: soft-keyboard text goes as `text`, never as keys. */
  sendText(text: string): Promise<PaneInputResult> {
    return this.send({ text, keys: [] })
  }

  /** Convenience for the accessory row: named keys, never bytes. */
  sendKeys(keys: readonly string[]): Promise<PaneInputResult> {
    return this.send({ text: '', keys })
  }

  /**
   * Stops accepting input and forgets whatever had not been sent.
   *
   * Forgetting is the point. A pane switch or an unmount must not leave a keystroke that fires into
   * a *different* prompt when the channel recovers.
   */
  close(): void {
    this.closed = true
    this.pending = []
    this.publish()
  }

  /** Appends or merges. Returns a rejection when the bound is hit, else null. */
  private enqueue(chunk: PaneInputChunk): PaneInputResult | null {
    const tail = this.pending[this.pending.length - 1]
    if (tail !== undefined) {
      const merged = mergeChunk(tail, chunk)
      if (merged !== null) {
        if (merged.text.length > MAX_PENDING_INPUT_TEXT) {
          return { delivery: 'rejected', reason: 'input_backpressure' }
        }
        this.pending[this.pending.length - 1] = merged
        return null
      }
    }
    if (this.pending.length >= MAX_PENDING_INPUT_CHUNKS) {
      return { delivery: 'rejected', reason: 'input_backpressure' }
    }
    if (totalPendingText(this.pending) + chunk.text.length > MAX_PENDING_INPUT_TEXT) {
      return { delivery: 'rejected', reason: 'input_backpressure' }
    }
    this.pending.push({ text: chunk.text, keys: [...chunk.keys] })
    return null
  }

  /** The single-flight loop. Concurrent callers await the same promise; only one drains. */
  private drain(): Promise<void> {
    if (this.draining !== null) {
      return this.draining
    }
    const run = this.runDrain().finally(() => {
      this.draining = null
    })
    this.draining = run
    return run
  }

  private async runDrain(): Promise<void> {
    for (;;) {
      const chunk = this.pending.shift()
      if (chunk === undefined) {
        this.setState({ ...this.state, inFlight: false, pendingChunks: 0 })
        return
      }
      this.setState({ ...this.state, inFlight: true, pendingChunks: this.pending.length })
      const result = await this.request(chunk)
      this.setState({ ...this.state, last: result })
      if (result.delivery !== 'delivered') {
        // Nothing is retried and nothing is kept. Whatever had merged behind a chunk that did not
        // land is dropped here rather than replayed onto a pane whose screen has moved on.
        this.pending = []
        this.setState({ ...this.state, inFlight: false, pendingChunks: 0 })
        return
      }
    }
  }

  private async request(chunk: PaneInputChunk): Promise<PaneInputResult> {
    const api = this.options.api
    const paneId = this.options.paneId
    if (api === null || paneId === null) {
      return { delivery: 'rejected', reason: 'no_transport' }
    }
    // `text` and `keys` are both `#[serde(default, skip_serializing_if = …)]`
    // (`src/api/schema/panes.rs:243-250`), so omitting the empty one is the shape the server itself
    // serializes; sending `""`/`[]` is equally accepted but says less.
    const params: Record<string, unknown> = { pane_id: paneId }
    if (chunk.text.length > 0) {
      params['text'] = chunk.text
    }
    if (chunk.keys.length > 0) {
      params['keys'] = [...chunk.keys]
    }
    try {
      await api.request('pane.send_input', params)
      return { delivery: 'delivered', reason: null }
    } catch (error) {
      // The one branch where the server *answered*. An error envelope is proof of delivery: the
      // request reached herdr, herdr parsed it and said no. That is knowledge, so it is not `unknown`.
      if (error instanceof JsonApiError) {
        return { delivery: 'rejected', reason: error.code }
      }
      // Everything else — a dead exec channel, a truncated line, a protocol error — leaves the
      // question open. X2: do not call it a failure.
      //
      // `markRpcDeliveryUnknown` is orca's own marker for this exact condition
      // (`mobile/src/transport/rpc-delivery-ambiguity.ts`, ported byte-identical as part of M4). It
      // is applied here so the two vocabularies are one: this file predates the port and reached
      // the same three-valued conclusion independently, and a caller that inspects the *error*
      // rather than the {@link PaneInputResult} — a retry helper, a log — now gets the same answer
      // instead of a second, subtly different rule. The WeakSet costs nothing and never disagrees.
      return {
        delivery: 'unknown',
        reason: describe(markRpcDeliveryUnknown(asError(error)))
      }
    }
  }

  private settle(result: PaneInputResult): PaneInputResult {
    this.setState({ ...this.state, last: result })
    return result
  }

  private setState(next: PaneInputState): void {
    this.state = next
    this.publish()
  }

  private publish(): void {
    this.options.onState?.({ ...this.state, pendingChunks: this.pending.length })
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The marker is a `WeakSet<Error>`, so a non-`Error` rejection has to become one to be tagged. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** The one line the header shows about the last write, in the mockup's status slot. */
export function inputStatusLabel(state: PaneInputState): string | null {
  if (state.inFlight) {
    return 'sending'
  }
  if (state.last === null) {
    return null
  }
  switch (state.last.delivery) {
    case 'delivered':
      return 'sent'
    case 'rejected':
      return `refused: ${state.last.reason ?? 'unknown'}`
    case 'unknown':
      // Never "failed". The write may have landed; saying otherwise invites the user to press the
      // approval a second time, which on an agent prompt is a second answer.
      return 'delivery unknown'
  }
}
