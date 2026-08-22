// Ported from orca mobile/src/components/WorktreeAgentList.tsx
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// Kept from orca, and it is the whole shape of the file: the collapse rule. More than one agent in
// a row means the row shows a single summary chip and nothing else until the user expands it
// (`usesSummary = summaryAgents.length > 1`); exactly one means the agent is rendered inline with
// no chip at all. That is what keeps a workspace list scannable when a workspace holds five agents.
//
// Changed: the lineage flattening is gone. orca computes `flattenAgentRowLineage(agents)` and
// `buildAgentRowLineageTree(agents)` (`src/worktree/agent-row-lineage.ts`, 88 lines) to render a
// spawn tree, indenting children and summarising only the roots. herdr's `agent.list` has no parent
// pointer — no `parentPaneKey`, no equivalent (docs/next/api/herdr-api.schema.json, `AgentInfo`) —
// so the flatten would be the identity function and the tree a list of roots. Porting the module to
// compute that would be porting 88 lines of dead code; it is dropped, and this is the record of
// why. If herdr ever publishes a spawn parent, that file is the thing to bring over.
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { AgentInfo } from '../api/herdr-api-types'
import { AgentRow } from './AgentRow'
import { AgentSummary } from './AgentSummary'

type Props = {
  agents: AgentInfo[]
  /** Passed through to each row; the enclosing row already says which remote/workspace this is. */
  paneHandleOf?: (agent: AgentInfo) => string
}

export function AgentList({ agents, paneHandleOf }: Props) {
  const [expanded, setExpanded] = useState(false)
  const usesSummary = agents.length > 1

  return (
    <View style={styles.list}>
      {usesSummary ? (
        <AgentSummary
          agents={agents}
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
        />
      ) : null}
      {!usesSummary || expanded
        ? agents.map((agent) => (
            <AgentRow
              key={agent.pane_id}
              agent={agent}
              trailing={paneHandleOf?.(agent)}
              emphasis={agent.agent_status === 'blocked'}
            />
          ))
        : null}
    </View>
  )
}

const styles = StyleSheet.create({
  list: {
    marginTop: 3
  }
})
