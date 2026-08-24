// Not from orca. orca's remote list is a flat list of hosts with a two-state reachability dot; the
// herdr mockup's node list is grouped and its dot has four states, and both differences carry
// information the flat version cannot (`.prd/11-mockup-conformance.md` 누락 #3, #5, #6).
//
// Pure on purpose, like `../api/snapshot-staleness.ts` next door: what a dot means and when a row
// is allowed to say "reconnecting" are the decisions here, and a decision that can only be
// exercised by mounting a screen is one nobody re-checks.
import type {
  AgentStatus,
  PaneInfo,
  RemoteDefinition,
  RemoteSnapshot
} from '../api/herdr-api-types'

/** The mockup's four node dots (`mockup.html:162-166`, rendered on the node list at `:398-414`). */
export type NodeDotState = 'ok' | 'working' | 'blocked' | 'off'

/**
 * Which of the mockup's two sections a remote belongs under (`mockup.html:397`, `:402`).
 *
 * The split is the registry's own `target.type`, not a phone-side notion: a `local` remote is the
 * box the herdr server itself runs on, which is what the mockup labels `hub` and annotates `local`
 * (`../api/snapshot-context.tsx`'s `remoteSubtitle` already renders that word). A phone normally
 * sees zero of them — it dials someone else's hub — so the `hub` label is rendered only when the
 * group is non-empty rather than as a permanent empty heading.
 */
export function nodeSection(remote: RemoteDefinition): 'hub' | 'remotes' {
  return remote.target.type === 'local' ? 'hub' : 'remotes'
}

function hasStatus(panes: readonly PaneInfo[], status: AgentStatus): boolean {
  return panes.some((pane) => pane.agent_status === status)
}

/**
 * The node's dot.
 *
 * `blocked` wins over `working` for the same reason `rollupText` names it first: it is the one
 * state the phone exists to surface. A remote with no snapshot entry is *also* `blocked` — the
 * inverted ring — because "we asked and got nothing" is an error and the mockup draws exactly that
 * (`blade-4090`, dot `blocked`, meta `reconnecting…`). A disabled remote is `off`: nobody asked, so
 * nothing is wrong.
 */
export function nodeDotState(args: {
  disabled?: boolean
  entry: RemoteSnapshot | null | undefined
}): NodeDotState {
  if (args.disabled === true) {
    return 'off'
  }
  if (!args.entry) {
    return 'blocked'
  }
  if (hasStatus(args.entry.panes, 'blocked')) {
    return 'blocked'
  }
  if (hasStatus(args.entry.panes, 'working')) {
    return 'working'
  }
  return 'ok'
}

/**
 * The `AgentStatus` the shared dot component speaks, per node state.
 *
 * Deliberately a mapping rather than a second dot component: `../components/AgentStateDot.tsx`
 * already renders this exact ramp (ring for `blocked`, `fgSoft` fill for a settled row, `off` for
 * nothing-running) and already carries the recorded deviation that `working` spins rather than
 * pulses. A node dot that pulsed while the pane dots below it spun would be two vocabularies for
 * one idea.
 */
export const NODE_DOT_AGENT_STATUS: Record<NodeDotState, AgentStatus> = {
  ok: 'done',
  working: 'working',
  blocked: 'blocked',
  off: 'idle'
}

/** Same grid as `../api/snapshot-staleness.ts`, and for the same reason — see it. */
const MINUTES_AFTER_MS = 90_000
const HOURS_AFTER_MS = 90 * 60_000
const SECONDS_GRID_S = 5

/** `2m ago` / `45s ago` / `3h ago`. */
export function lastSeenClause(ageMs: number): string {
  if (ageMs < MINUTES_AFTER_MS) {
    const s = Math.max(0, Math.floor(ageMs / 1000 / SECONDS_GRID_S) * SECONDS_GRID_S)
    return `${s}s ago`
  }
  if (ageMs < HOURS_AFTER_MS) {
    return `${Math.floor(ageMs / 60_000)}m ago`
  }
  return `${Math.floor(ageMs / 3_600_000)}h ago`
}

/**
 * The row's second line.
 *
 * The unreachable branch is the mockup's `reconnecting… · last seen 2m ago`. The `last seen` clause
 * is omitted — not faked, not written as `unknown` — when this install has never held a snapshot
 * for that remote: after a cold start the app genuinely does not know, and a fabricated age is
 * worse than a shorter line. `reconnecting…` itself is not a guess: the foreground poller re-dials
 * every few seconds (`../api/use-foreground-refresh.ts`), so the row is describing what is
 * happening rather than promising it.
 */
export function nodeDetail(args: {
  remote: RemoteDefinition
  subtitle: string
  entry: RemoteSnapshot | null | undefined
  rollup: string
  lastSeenAt: number | null
  nowMs: number
}): string {
  if (args.remote.disabled === true) {
    return 'disabled'
  }
  if (!args.entry) {
    return args.lastSeenAt === null
      ? 'reconnecting…'
      : `reconnecting… · last seen ${lastSeenClause(args.nowMs - args.lastSeenAt)}`
  }
  return `${args.subtitle} · ${args.entry.workspaces.length} spaces · ${args.entry.panes.length} panes · ${args.rollup}`
}

/**
 * Last-seen bookkeeping, folded rather than kept in a component.
 *
 * The server does not send it — nothing in `remote.list` says when a remote last answered — so the
 * only honest source is what this app itself observed. `atMs` is the snapshot's own `updatedAt`
 * where there is one, so the age counts from when the *server* answered, not from when React ran.
 */
export function mergeLastSeen(
  previous: ReadonlyMap<string, number>,
  perRemote: readonly RemoteSnapshot[],
  atMs: number
): Map<string, number> {
  const next = new Map(previous)
  for (const entry of perRemote) {
    next.set(entry.remote.id, atMs)
  }
  return next
}

/**
 * The agents screen's fleet reading — `2 nodes`, or `2 nodes · 1 unreachable`.
 *
 * It used to be `perRemote.length`, which counts the remotes that *answered*. The 5차 device round
 * caught what that costs: with one live remote and one dead one the node list showed two rows and
 * the header above it said `1 nodes`, on the same screen, while settings said `app.json · 2`.
 * Counting the fleet is what a person means by "how many nodes do I have".
 *
 * The second clause exists so the first one cannot over-claim in the other direction: a fleet of two
 * where one is down is not the same thing as a healthy two, and this is the only place that
 * difference reaches the Agents home at all — its list is built from the remotes that answered, so
 * a dead one contributes nothing and would otherwise be invisible here.
 *
 * Disabled remotes are counted in the fleet and never in `unreachable`: nobody dialled them, so
 * nothing is wrong with them (the same rule `nodeDotState` uses for the dot).
 */
export function fleetSummary(args: {
  remotes: readonly RemoteDefinition[]
  answered: number
}): string {
  const total = args.remotes.length
  const dialled = args.remotes.filter((remote) => remote.disabled !== true).length
  const unreachable = Math.max(0, dialled - args.answered)
  // A one-node fleet is the common case for a first-time user, so `1 nodes` is the string most
  // likely to be the first thing anyone reads (iOS QA 11차, 2026-08-25).
  const nodes = `${total} ${total === 1 ? 'node' : 'nodes'}`
  return unreachable === 0 ? nodes : `${nodes} · ${unreachable} unreachable`
}
