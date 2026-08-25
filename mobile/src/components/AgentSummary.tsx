// Ported from orca mobile/src/components/WorktreeAgentSummary.tsx
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// Kept from orca, and it is the whole value of the file: `MAX_VISIBLE_AGENTS = 3` with a `+N`
// overflow count, the collapsed form being *dots only* (so a workspace row stays one line however
// many agents it holds), the expanded form being a word, the chevron pair, and the accessibility
// contract — `accessibilityRole="button"` + `accessibilityState={{expanded}}` + a label that names
// the action and the subject. `event.stopPropagation()` on press is also orca's, and load-bearing:
// this sits inside a pressable row, so without it expanding also navigates.
//
// Changed:
//  · `RuntimeWorktreeAgentRow` -> herdr's `AgentInfo`, and `agentDotState(agent, now)` -> the
//    wire's `agent_status` directly. orca derives a dot state because its wire state needs a
//    staleness decay against `updatedAt`; herdr has no timestamp (../agents/agent-display.ts).
//  · `MobileAgentIcon` dropped — it is orca's agent-brand SVG set (`drop`, port map §0: brand).
//    The collapsed chip shows the state dot alone, which is what the mockup draws
//    (mockup.html:487, `● claude working` / `◌ codex blocked`).
//  · Palette -> ../theme/monotone. Same reason as AgentStateDot: colour *is* the meaning here.
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { AgentInfo } from '../api/herdr-api-types'
import { radii, spacing } from '../theme/mobile-theme'
import { mono } from '../theme/monotone'
import { typography } from '../theme/herdr-typography'
import { agentIdentityLabel } from '../agents/agent-display'
import { AgentStateDot } from './AgentStateDot'

const MAX_VISIBLE_AGENTS = 3

type Props = {
  agents: AgentInfo[]
  expanded: boolean
  onToggle: () => void
}

export function AgentSummary({ agents, expanded, onToggle }: Props) {
  const visibleAgents = agents.slice(0, MAX_VISIBLE_AGENTS)
  const hiddenCount = agents.length - visibleAgents.length
  const subject = `${agents.length} agents`

  return (
    <Pressable
      style={({ pressed }) => [
        styles.summary,
        !expanded && styles.summaryCollapsed,
        pressed && styles.summaryPressed
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${subject}`}
      accessibilityState={{ expanded }}
      onPress={(event) => {
        event.stopPropagation()
        onToggle()
      }}
    >
      {expanded ? (
        <Text style={styles.expandedLabel}>{subject}</Text>
      ) : (
        <View style={styles.agentIcons}>
          {visibleAgents.map((agent) => (
            <View key={agent.pane_id} style={styles.agentStatus}>
              <AgentStateDot state={agent.agent_status} />
              <Text style={styles.agentName} numberOfLines={1}>
                {agentIdentityLabel(agent)}
              </Text>
            </View>
          ))}
          {hiddenCount > 0 ? <Text style={styles.hiddenCount}>+{hiddenCount}</Text> : null}
        </View>
      )}
      {expanded ? (
        <ChevronDown size={12} color={mono.dim} />
      ) : (
        <ChevronRight size={12} color={mono.dim} />
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  summary: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.button
  },
  summaryCollapsed: {
    borderWidth: 1,
    borderColor: mono.lineSoft,
    backgroundColor: mono.ink2
  },
  summaryPressed: {
    opacity: 0.72
  },
  // Every text style here names a family, `expandedLabel` a heavier one instead of a weight: this
  // sits inside `WorkspaceListRow`, which is JetBrains Mono throughout, and Android synthesises
  // nothing for a custom family (`../theme/herdr-typography.ts`).
  expandedLabel: {
    flex: 1,
    paddingLeft: spacing.xs,
    fontSize: 11,
    fontFamily: typography.monoFamilyMedium,
    color: mono.dim
  },
  agentIcons: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  agentStatus: {
    height: 19,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 3,
    borderRadius: radii.button,
    backgroundColor: mono.ink3
  },
  agentName: {
    fontSize: 10,
    color: mono.fgSoft,
    fontFamily: typography.monoFamily
  },
  hiddenCount: {
    fontSize: 10,
    color: mono.dim,
    fontFamily: typography.monoFamily
  }
})
