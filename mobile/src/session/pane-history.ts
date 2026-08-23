// Not from orca, and the *absence* of an orca counterpart is the design note.
//
// orca has no history reader because it does not need one: its desktop pushes a serialized xterm
// scrollback (`SnapshotEnd` → `{type:'scrollback', serialized}`,
// `src/transport/rpc-client-terminal-binary-frame.ts:67`) and then streams raw PTY bytes, so newer
// output *scrolls* the local buffer and `scrollback: 5000` fills itself. History there is the
// terminal, and the surface that reads it is the terminal.
//
// herdr cannot do that, and the reason is a single line of the renderer:
//
//   src/protocol/render_ansi.rs:613   write!(writer, "\x1b[{};{}H", y + 1, x + 1)
//
// Every cell is preceded by an absolute cursor position, so the pane's ANSI stream **overwrites**
// the viewport instead of scrolling it. Nothing is ever pushed out of the top, so nothing enters
// xterm's scrollback: QA measured `.xterm-viewport scrollHeight == clientHeight == 777` after
// flushing 60 rows through a 25-row viewport (`.prd/09-review-followups.md` §CC). `scrollback: 5000`
// in `../terminal/terminal-webview-html.ts:769` is inert — there is no path that fills it.
//
// So M6c diverges from orca deliberately: **history is a server read, not a client buffer.** The
// server keeps the real scrollback (it is the thing running the PTY), and `pane.read` already
// exposes it — `PaneReadParams` (`src/api/schema/panes.rs:275-287`) →
// `read_terminal_snapshot` (`src/app/api_helpers.rs:109-141`) → `recent_text_snapshot`. That is the
// same JSON API M3's writes use, and it is orthogonal to the observe stream, so it does not touch
// the §2.3 bargain that got `AttachScroll` (and M6b) deleted: no attach, no shared-PTY resize, no
// lock.
//
// The consequence the caller must respect, and the reason this file returns *text* rather than
// bytes to write: what comes back **cannot be appended to the xterm buffer**. That buffer is the
// current screen and the next frame overwrites it. History belongs on its own surface
// (`./PaneHistoryOverlay.tsx`).
//
// ⚠️ B8 lives here. One JSON call is one ssh exec is one remote `herdr` process
// (`src/api/server.rs:139-152`: one request is one connection). A history reader that fetched per
// scroll tick would be a process per flick, so this one fetches **once per pane** and caches; only
// an explicit refresh spends a second exec.
import { JsonApiError, type JsonApiClient } from '@herdr/client-ts'

/**
 * How many lines one history read asks for.
 *
 * 1000 because that is the server's own ceiling — `read_terminal_snapshot` clamps with
 * `lines.min(1000)` (`src/app/api_helpers.rs:118`) — and because of B8 the *number of calls* is the
 * cost, not the number of lines in one call. Asking for less would spend the same exec for less
 * history; asking for more is silently clamped to this anyway. Omitting `lines` would take the
 * server's default of 80 (`:119`), which on a phone is roughly two screens and would make the
 * feature pointless.
 *
 * When more history exists than this, the server says so in `truncated` and the surface shows it,
 * rather than pretending the top of the text is the beginning of time.
 */
export const PANE_HISTORY_LINES = 1000

/**
 * `recent_unwrapped`, not `recent`.
 *
 * Both read the same scrollback; they differ in whether the terminal's own hard wraps survive
 * (`recent_text_snapshot` vs `recent_unwrapped_text_snapshot`, `src/pane/terminal.rs:2035,2061`).
 * The surface this feeds is a text view a few dozen columns wide, not a 107-column terminal, so
 * keeping the host's wraps would bake one wrap into every line and let React Native wrap it a
 * second time — every long line broken twice, at the wrong place. Logical lines let the surface
 * that knows the width do the wrapping.
 *
 * The cost, stated rather than hidden: a TUI's box drawing loses its columns. That is a real loss
 * and it is accepted here because the live pane is where a TUI is read; this surface exists for the
 * prose that scrolled past.
 */
export const PANE_HISTORY_SOURCE = 'recent_unwrapped'

/**
 * `text`, not `ansi`.
 *
 * `ReadFormat::Ansi` would return SGR sequences, and rendering those needs an SGR parser plus a
 * per-run `<Text>` tree. The overlay is monochrome by the same rule every other new surface follows
 * (`../theme/monotone.ts`), so the colour would be discarded anyway.
 */
export const PANE_HISTORY_FORMAT = 'text'

/** One `pane.read` answer, as the surface consumes it. */
export type PaneHistorySnapshot = {
  paneId: string
  /** The server's `read.text` verbatim, trailing newline included. */
  text: string
  /** The server's `read.truncated`: older lines exist that this read did not carry. */
  truncated: boolean
  /** Epoch ms of the exec that produced it. History is a point-in-time read, and it says when. */
  fetchedAt: number
}

export type PaneHistoryReaderOptions = {
  /** Null when the remote is listed but not dialled — a read then fails instead of hanging. */
  api: JsonApiClient | null
  /** Injected so tests do not depend on the wall clock. */
  now?: () => number
}

/** Thrown for anything the surface has to show as a failed read. */
export class PaneHistoryError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PaneHistoryError'
    this.code = code
  }
}

/**
 * Reads a pane's server-side scrollback, at most once per pane.
 *
 * Construct one per connection (`./use-pane-history.ts` does) and call {@link read}. Two properties
 * are the whole point and both exist because of B8:
 *
 *  - **cache**: a pane already read is answered from memory. Re-opening the surface, switching away
 *    and back, or re-mounting the screen while the connection lives costs zero execs.
 *  - **single flight**: two reads of the same pane that overlap share one exec. Without this a
 *    double-tap on the button is two remote processes.
 *
 * Nothing here expires the cache on a timer. A history read is explicitly a snapshot — the surface
 * labels it with {@link PaneHistorySnapshot.fetchedAt} and offers a refresh — because a
 * self-refreshing history is a poll, and a poll over one-exec-per-request is the thing B8 forbids.
 */
export class PaneHistoryReader {
  private readonly options: PaneHistoryReaderOptions
  private readonly cache = new Map<string, PaneHistorySnapshot>()
  private readonly inFlight = new Map<string, Promise<PaneHistorySnapshot>>()

  constructor(options: PaneHistoryReaderOptions) {
    this.options = options
  }

  /** The cached snapshot for a pane, or null. Never spends an exec — the surface opens on this. */
  peek(paneId: string | null): PaneHistorySnapshot | null {
    if (paneId === null) {
      return null
    }
    return this.cache.get(paneId) ?? null
  }

  /**
   * Returns this pane's history, from cache when there is one.
   *
   * `refresh` forces a new read and replaces the cached snapshot — the one path that spends a
   * second exec on a pane, and it is only ever reached from an explicit user press.
   */
  async read(
    paneId: string | null,
    options: { refresh?: boolean } = {}
  ): Promise<PaneHistorySnapshot> {
    if (paneId === null) {
      throw new PaneHistoryError('no_pane', 'no pane to read')
    }
    if (!options.refresh) {
      const cached = this.cache.get(paneId)
      if (cached !== undefined) {
        return cached
      }
      const pending = this.inFlight.get(paneId)
      if (pending !== undefined) {
        return pending
      }
    }
    const api = this.options.api
    if (api === null) {
      throw new PaneHistoryError('no_transport', 'this remote is not connected')
    }
    const request = this.request(api, paneId).finally(() => {
      // Only clear the slot if it is still ours: a refresh started while a first read was in flight
      // replaced it, and the loser must not delete the winner.
      if (this.inFlight.get(paneId) === request) {
        this.inFlight.delete(paneId)
      }
    })
    this.inFlight.set(paneId, request)
    return request
  }

  /** Drops one pane's cache, or all of it. A refresh goes through {@link read} instead. */
  invalidate(paneId?: string): void {
    if (paneId === undefined) {
      this.cache.clear()
      return
    }
    this.cache.delete(paneId)
  }

  private async request(api: JsonApiClient, paneId: string): Promise<PaneHistorySnapshot> {
    let result: { type: string } & Record<string, unknown>
    try {
      result = await api.request('pane.read', {
        pane_id: paneId,
        source: PANE_HISTORY_SOURCE,
        lines: PANE_HISTORY_LINES,
        format: PANE_HISTORY_FORMAT
        // `strip_ansi` is deliberately not sent. It defaults to true
        // (`src/api/schema/panes.rs:283`) and `handle_pane_read` never reads it
        // (`src/app/api/panes.rs:1189-1228`) — `format` alone selects text or ANSI — so sending it
        // would state a parameter that decides nothing.
      })
    } catch (error) {
      // A server error envelope is an answer: `pane_not_found` for a pane that has gone, and so on.
      // Anything else is the transport, and the surface says so differently.
      if (error instanceof JsonApiError) {
        throw new PaneHistoryError(error.code, error.message)
      }
      throw new PaneHistoryError('transport', describe(error))
    }
    const snapshot = toSnapshot(paneId, result, this.options.now?.() ?? Date.now())
    this.cache.set(paneId, snapshot)
    return snapshot
  }
}

/**
 * Narrows one `pane.read` result.
 *
 * `JsonApiClient.request` is untyped on purpose (`packages/herdr-client-ts/src/jsonApi.ts`), so the
 * check is here. It is deliberately thin — the fields this surface reads, and no more — because a
 * transcription of `PaneReadResult` would be a second schema to keep in step with the server's.
 */
function toSnapshot(
  paneId: string,
  result: { type: string } & Record<string, unknown>,
  fetchedAt: number
): PaneHistorySnapshot {
  const read = result['read']
  if (typeof read !== 'object' || read === null) {
    throw new PaneHistoryError('malformed', `pane.read answered ${result.type} with no read body`)
  }
  const body = read as Record<string, unknown>
  const text = body['text']
  if (typeof text !== 'string') {
    throw new PaneHistoryError('malformed', 'pane.read answered without text')
  }
  return {
    paneId,
    text,
    truncated: body['truncated'] === true,
    fetchedAt
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Line count of a snapshot, ignoring the trailing newline the server's last line carries. */
export function historyLineCount(snapshot: PaneHistorySnapshot): number {
  if (snapshot.text.length === 0) {
    return 0
  }
  const trimmed = snapshot.text.endsWith('\n') ? snapshot.text.slice(0, -1) : snapshot.text
  return trimmed.split('\n').length
}

/**
 * The one line the overlay shows about the read itself.
 *
 * Absolute wall time rather than "12s ago": a relative label needs a tick source, and a history
 * snapshot that silently ages while the user reads it is exactly the lie §Q made this codebase
 * careful about. `truncated` is stated because the top of the text is otherwise indistinguishable
 * from the beginning of the session.
 */
export function historySummary(snapshot: PaneHistorySnapshot): string {
  const lines = historyLineCount(snapshot)
  const at = new Date(snapshot.fetchedAt)
  const clock = [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
  return `${lines} lines${snapshot.truncated ? ' (older lines omitted)' : ''} · read ${clock}`
}
