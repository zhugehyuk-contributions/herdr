// Ported from orca mobile/src/worktree/agent-row-display.ts:33-64
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// A named extraction, not a copy: what is orca's is the *rule* that an agent row must never render
// blank, expressed as a fallback chain ending in a human-readable state word
// (`agentDisplayLabel`, `agentStateLabel`). What is herdr's is every input, because orca reads
// `RuntimeWorktreeAgentRow` (`lastAssistantMessage` / `prompt` / `stateStartedAt` / `interrupted`)
// and herdr's `agent.list` has none of those fields (docs/next/api/herdr-api.schema.json,
// `AgentInfo`).
//
// Three changes, each with its reason:
//
//  1. **`state_labels` wins over any hard-coded word.** orca's `agentStateLabel` is a switch that
//     returns 'Working' / 'Blocked' / …. herdr's server does not do that — its own sidebar renders
//     `state_labels[status]` and only falls back to the bare status word
//     (`src/ui/sidebar.rs:2268-2272` reading `agent_panel_status_key`, default
//     `src/ui/status.rs:221-229`). The API rejects any key outside the `AgentStatus` enum
//     (`src/app/api/panes.rs:1676-1681`), so the map is a per-status override and nothing else.
//     Copying orca's switch would have made the phone the only herdr client that ignores a status
//     the user set on purpose.
//  2. **No staleness decay.** orca degrades a stale `working` to `idle` after 30 min using
//     `row.updatedAt`. herdr's `AgentInfo` carries no timestamp of any kind — `revision` and
//     `state_change_seq` are counters, not clocks — so the decay is unimplementable here and
//     inventing a clock would be worse than not having one. Consequence recorded rather than
//     papered over: a herdr agent that dies without a final report reads as `working` forever.
//  3. **No `formatTimeAgo` / `useNow`.** Same cause: nothing to format. orca's row's fourth column
//     is dropped, not stubbed.
//
// `agentIdentityLabel`'s two-letter code table (orca `:66-85`) is also not ported: it exists for
// the case where `MobileAgentIcon` has no icon, and no icon component is ported, so herdr shows the
// agent's own name instead.
import type { AgentInfo, AgentStatus } from '../api/herdr-api-types'

/** The subset of an agent row this module reads — so a pane row can use it too. */
export type AgentDisplayFields = {
  agent_status: AgentStatus
  state_labels?: Record<string, string>
  name?: string | null
  display_agent?: string | null
  agent?: string | null
  manual_label?: string | null
  title?: string | null
  terminal_title_stripped?: string | null
  /** `PaneInfo.recent`, oldest first — present only when `pane.list` was asked for it. */
  recent?: string[] | null
}

/**
 * What the agent is doing, in the server's own words when it has any.
 * Mirrors `src/ui/sidebar.rs:2268-2272`: custom label for this status, else the status word.
 */
export function agentStateLabel(agent: AgentDisplayFields): string {
  const custom = agent.state_labels?.[agent.agent_status]?.trim()
  return custom && custom.length > 0 ? custom : agent.agent_status
}

/** True when the state word is the server's own override rather than the bare status. */
export function hasCustomStateLabel(agent: AgentDisplayFields): boolean {
  const custom = agent.state_labels?.[agent.agent_status]?.trim()
  return !!custom && custom.length > 0
}

/**
 * Who the row is. orca's fallback chain, over herdr's fields: the agent's own name, then the
 * server's display name for it, then the raw agent id, then the pane's manual rename, then the
 * stripped terminal title — and never blank, because a nameless row cannot be acted on.
 */
export function agentIdentityLabel(agent: AgentDisplayFields): string {
  for (const candidate of [
    agent.name,
    agent.display_agent,
    agent.agent,
    agent.manual_label,
    agent.terminal_title_stripped,
    agent.title
  ]) {
    const trimmed = candidate?.trim()
    if (trimmed) {
      return trimmed
    }
  }
  return 'pane'
}

/**
 * Rows of `recent` a snapshot loader has to ask `pane.list` for to draw this one line reliably.
 *
 * Three for a line that renders **one**, and the extra two are not slack: the field counts terminal
 * ROWS the way `pane.read`'s `lines` does (`src/app/api/panes.rs`, `pane_recent_lines`), so a pane
 * whose cursor rests on a blank row spends one of them on that blank row and blank rows drop out of
 * the answer. Asking for a single row would leave exactly those panes with an empty `recent` and no
 * summary at all. It costs nothing on the wire that matters — it is still ONE request for every
 * pane on the box, which under blocker B8 (one request = one ssh exec) is the whole reason the
 * server grew the batch field.
 *
 * Declared here, next to its only consumer, so the two loaders cannot ask for different amounts.
 */
export const PANE_SUMMARY_RECENT_LINES = 3

/**
 * The newest line of a pane's `recent` that has anything on it, or `null`.
 *
 * The array is oldest first, so this reads from the end. It scans past blank entries instead of
 * taking `at(-1)` because the server counts terminal ROWS, not text lines: a pane whose cursor
 * rests on a blank row spends one of the requested rows on it, and a screen with trailing blank
 * rows would otherwise summarise as an empty string.
 */
function lastOutputLine(agent: AgentDisplayFields): string | null {
  const recent = agent.recent
  if (!Array.isArray(recent)) {
    return null
  }
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const trimmed = recent[index]?.trim()
    if (trimmed) {
      return trimmed
    }
  }
  return null
}

/**
 * What the pane is *doing*, for the second line the mockup draws under every pane row
 * (`mockup.html:535` — `└ Running cargo nextest… · 2m41s`).
 *
 * **The mockup's own source, now that the server can serve it in one round trip.** The mockup's
 * acceptance line (`:555`) says *"요약 줄 = `pane.read` {recent, lines:1}"*, i.e. the pane's last
 * output line. `.prd/06-open-decisions.md` 결정 9 refused to implement that as written and said why:
 * one `pane.read` per pane is one ssh exec per pane under blocker B8, so a twelve-pane workspace
 * would spend twelve execs to draw one list — and it named the correct repair, *"올바른 수리는
 * 클라이언트가 아니라 서버다"*, a batch field on `pane.list`. That field now exists:
 * `pane.list {recent_lines: n}` fills every returned pane's `recent` from the same source
 * `pane.read {source: recent}` reads (`src/api/schema/panes.rs`, `src/app/api/panes.rs`
 * `handle_pane_list`), so the mockup's semantics cost **zero** extra execs. `recent`'s last
 * non-blank line therefore wins here.
 *
 * `terminal_title_stripped` stays as the fallback rather than being deleted, and it is not
 * vestigial: the field is opt-in, an older server (or any caller that did not ask for it) returns
 * panes with no `recent` at all, and a pane that has produced no output has an empty one. Both land
 * on the running command, which is what this line said for eight milestones.
 *
 * Returns `null` rather than a placeholder when the only candidate is what
 * {@link agentIdentityLabel} already rendered — a row that says `claude` twice is worse than a row
 * with one line, and the identity chain falls through to the terminal title precisely when there is
 * no agent name to show.
 */
export function paneActivityLabel(agent: AgentDisplayFields): string | null {
  const identity = agentIdentityLabel(agent)
  for (const candidate of [lastOutputLine(agent), agent.terminal_title_stripped, agent.title]) {
    const trimmed = candidate?.trim()
    if (trimmed && trimmed !== identity) {
      return trimmed
    }
  }
  return null
}

/**
 * The short pane handle herdr shows in its own UI (`1-2` = tab 1, pane 2 — mockup.html:472). It is
 * carried on the wire as the pane's manual label; when a pane has never been renamed there is no
 * short form and the id is the only honest answer.
 */
export function agentPaneHandle(agent: Pick<AgentInfo, 'manual_label' | 'pane_id'>): string {
  const manual = agent.manual_label?.trim()
  return manual && manual.length > 0 ? manual : agent.pane_id
}
