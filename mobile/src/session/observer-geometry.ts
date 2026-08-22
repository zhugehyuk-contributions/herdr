// Not from orca — and this is the one place the port map says orca has nothing to give
// (mobile/.prd/08-orca-port-map.md §4 N5, §6 위험 3): orca resizes the desktop PTY to fit the
// phone (`mobile/src/session/mobile-terminal-viewport-resubscribe.ts`, 293 lines + 333 of tests,
// all dropped), and herdr's observe path is forbidden from resizing anything
// (02-architecture.md §2.3). So the phone has to pick a *reading* viewport instead, and this file
// is that decision.
//
// ## What the server does with the number, and why "the phone's size" is the wrong answer
//
// An observing client's frame is `render_terminal_virtual(runtime, area)`
// (`src/server/headless.rs:4152-4153` -> `src/server/render_stream.rs:434-446`), where `area` comes
// straight from the client's own `Hello` cols/rows. The pane's runtime renders into that rect: ask
// for more than the pane and the surplus is blank padding, ask for less and the pane is **cropped
// to its top-left** — blocker B4. A phone is ~40 columns; a desktop pane is 53 and up. Sending the
// phone's grid therefore throws away the right-hand side of every pane, permanently, with no
// error. The M2 answer (04-milestones.md M2-e) is to send the *pane's* size and let the reader
// pinch-zoom and scroll horizontally.
//
// ## Where the pane's size comes from — measured 2026-08-22 against a live isolated server
//
// `pane.get` has no width/height (`src/api/schema/panes.rs:398-430`), so the exact PTY grid is not
// readable over the JSON API at all; the only exact method is running `stty size` inside the pane,
// which is a *write* and M2 is read-only. What is readable:
//
//   · `pane.layout` -> `PaneLayoutSnapshot` with `area` (the whole workspace rect) and one
//     `panes[].rect` per pane, in cells. Observed on a fresh server: `area 54x23`, single pane
//     `rect 54x23`, and `stty size` inside that pane `23x53`.
//   · `pane.get`/`pane.list` -> `scroll.viewport_rows`, observed `23` — exactly the PTY rows.
//
// So rows are exact and columns are within one cell — but not reliably *above*: after `pane.split`
// the same probe reported `rect 27x23` for both panes while `stty size` still said 53 and 54,
// because a pane's PTY is only resized while a client is attached (`headless.rs:4074`,
// `resize_panes = pane_infos.is_empty()`). A pane can therefore be **wider than its own rect**, and
// the split rect is the one number that must not be trusted on its own.
//
// Hence the rule below: take the maximum of every upper bound in evidence rather than the most
// specific one. Over-asking costs blank cells and bytes; under-asking silently truncates the
// screen, which is the failure this whole file exists to prevent.

/** `PaneLayoutRect` — `src/api/schema/panes.rs:551-557`. Cells, not pixels. */
export type PaneLayoutRect = {
  x: number
  y: number
  width: number
  height: number
}

/** `PaneLayoutSnapshot` — `src/api/schema/panes.rs:540-549`, the `pane.layout` result's `layout`. */
export type PaneLayoutSnapshot = {
  workspace_id: string
  tab_id: string
  zoomed: boolean
  area: PaneLayoutRect
  focused_pane_id: string
  panes: { pane_id: string; focused: boolean; rect: PaneLayoutRect }[]
  splits?: unknown[]
}

/**
 * What a herdr server renders at when nothing is attached: `effective_size = (MIN_COLS, MIN_ROWS)`
 * whenever there is no foreground client (`src/server/headless.rs:1086`, `:515`), and
 * `MIN_COLS/MIN_ROWS` are 80/24 (`:258-259`). So this is not a guess at a terminal size — it is the
 * size the server itself falls back to, which makes it the right floor for a pane whose layout the
 * phone could not read.
 */
export const DEFAULT_OBSERVER_COLS = 80
export const DEFAULT_OBSERVER_ROWS = 24

export type ObserverGeometry = {
  cols: number
  rows: number
}

export type ObserverGeometryInput = {
  paneId: string
  /** `pane.layout`'s snapshot, or null when the call failed or has not returned yet. */
  layout?: PaneLayoutSnapshot | null
  /** `PaneInfo.scroll.viewport_rows` from the snapshot the screen already has. Exact, when present. */
  viewportRows?: number | null
}

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * The cols/rows this client puts in `Hello` — derived from the pane, never from the device.
 *
 * `Hello.cols/rows` is also what `TerminalFrame.width/height` comes back as, so this number is the
 * xterm grid the reader pans around inside; it has nothing to do with how many cells fit on the
 * screen at once.
 */
export function resolveObserverGeometry(input: ObserverGeometryInput): ObserverGeometry {
  const layout = input.layout ?? null
  const rect = layout?.panes.find((pane) => pane.pane_id === input.paneId)?.rect ?? null
  const cols = Math.max(
    positive(layout?.area.width),
    positive(rect?.width),
    DEFAULT_OBSERVER_COLS
  )
  const rows = Math.max(
    positive(layout?.area.height),
    positive(rect?.height),
    positive(input.viewportRows),
    DEFAULT_OBSERVER_ROWS
  )
  return { cols, rows }
}

/** Reads `pane.layout`'s result envelope, or null if it is not the shape this build expects. */
export function paneLayoutFromResult(
  result: { type: string } & Record<string, unknown>
): PaneLayoutSnapshot | null {
  const layout = result['layout']
  if (typeof layout !== 'object' || layout === null) {
    return null
  }
  const candidate = layout as Partial<PaneLayoutSnapshot>
  if (!Array.isArray(candidate.panes) || typeof candidate.area !== 'object' || candidate.area === null) {
    return null
  }
  return candidate as PaneLayoutSnapshot
}
