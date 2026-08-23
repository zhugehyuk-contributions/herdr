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
 * What the pane is *doing*, for the second line the mockup draws under every pane row
 * (`mockup.html:535` — `└ Running cargo nextest… · 2m41s`).
 *
 * **This diverges from the mockup's stated source and the divergence is deliberate.** The mockup's
 * acceptance line (`:555`) says *"요약 줄 = `pane.read` {recent, lines:1}"*, i.e. read the pane's
 * last output line from the server. On this client that is one JSON call per pane — blocker B8
 * makes each one an ssh exec and a remote `herdr` process — so a workspace with twelve panes would
 * spend twelve execs to draw a list. `terminal_title_stripped` carries the running command and is
 * **already in the `pane.list` payload** (`src/api/herdr-api-types.ts:104`), so the same line costs
 * nothing. `.prd/11-mockup-conformance.md` records this as an open question rather than a silent
 * substitution: if the last output line is what the user actually wants, the fix is a server-side
 * batch field, not twelve execs.
 *
 * Returns `null` rather than a placeholder when the only candidate is what
 * {@link agentIdentityLabel} already rendered — a row that says `claude` twice is worse than a row
 * with one line, and the identity chain falls through to the terminal title precisely when there is
 * no agent name to show.
 */
export function paneActivityLabel(agent: AgentDisplayFields): string | null {
  const identity = agentIdentityLabel(agent)
  for (const candidate of [agent.terminal_title_stripped, agent.title]) {
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
