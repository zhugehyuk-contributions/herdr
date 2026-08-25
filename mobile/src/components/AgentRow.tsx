// Ported from orca mobile/src/components/WorktreeAgentRow.tsx
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
//
// Kept from orca: `memo`, and the row's reading order — state dot → identity → what it is doing →
// trailing meta, with the label taking the flex and clipping to one line so the trailing column
// never moves between rows.
//
// Changed, each because herdr's `agent.list` is not orca's `RuntimeWorktreeAgentRow`:
//
//  · **`depth` / `INDENT_PER_DEPTH` dropped.** orca indents a spawn lineage built from
//    `row.parentPaneKey` (`src/worktree/agent-row-lineage.ts`). herdr's `AgentInfo` has no parent
//    link of any kind (docs/next/api/herdr-api.schema.json), so there is no tree to indent and the
//    whole lineage module is not ported.
//  · **`now` / time-ago column dropped.** No timestamp exists on the wire — see
//    ../agents/agent-display.ts.
//  · **`unvisited` dropped, `emphasis` added.** orca bolds a row until the user has opened the
//    worktree; herdr has no visited store. The one thing worth emphasising here is `blocked`, which
//    is what the screen exists for.
//  · **Optional second line and `onPress`.** orca's row is never tappable — it sits inside a
//    tappable worktree row, which already answers "where is this". The Agents home has no such
//    enclosing row: it is cross-remote, so each row has to say where it lives and be the tap target
//    itself (mockup.html:640-644, mobile/.prd/01-spec.md decision 3).
import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { spacing } from '../theme/mobile-theme'
import { typography } from '../theme/herdr-typography'
import { mono } from '../theme/monotone'
import {
  agentIdentityLabel,
  agentStateLabel,
  type AgentDisplayFields
} from '../agents/agent-display'
import { AgentStateDot } from './AgentStateDot'

type Props = {
  agent: AgentDisplayFields
  /** Second line — where this agent lives. Omitted when an enclosing row already says so. */
  meta?: string
  /** Right-hand column: the short pane handle (`1-2`). */
  trailing?: string
  /** Bold/foreground treatment. herdr uses it for `blocked`, orca used it for unvisited. */
  emphasis?: boolean
  onPress?: () => void
}

function AgentRowComponent({ agent, meta, trailing, emphasis, onPress }: Props) {
  const label = agentStateLabel(agent)
  const identity = agentIdentityLabel(agent)
  const body = (
    <>
      <View style={styles.head}>
        <AgentStateDot state={agent.agent_status} />
        <Text style={[styles.identity, emphasis && styles.identityEmphasis]} numberOfLines={1}>
          {identity}
        </Text>
        <View style={styles.spacer} />
        {trailing ? <Text style={styles.trailing}>{trailing}</Text> : null}
        {onPress ? <Text style={styles.chevron}>›</Text> : null}
      </View>
      {meta ? (
        <Text style={styles.meta} numberOfLines={1}>
          {`${meta} · ${label}`}
        </Text>
      ) : (
        <Text style={styles.meta} numberOfLines={1}>
          {label}
        </Text>
      )}
    </>
  )

  if (!onPress) {
    return <View style={styles.row}>{body}</View>
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${identity} — ${meta ? `${meta} · ` : ''}${label}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {body}
    </Pressable>
  )
}

export const AgentRow = memo(AgentRowComponent)

const styles = StyleSheet.create({
  row: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: 6
  },
  rowPressed: {
    backgroundColor: mono.ink3
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  identity: {
    fontSize: 14,
    color: mono.fgSoft,
    flexShrink: 1,
    fontFamily: typography.monoFamily
  },
  identityEmphasis: {
    color: mono.fg,
    fontWeight: '700'
  },
  spacer: {
    flex: 1
  },
  trailing: {
    fontSize: 11,
    color: mono.dim,
    fontFamily: typography.monoFamily
  },
  chevron: {
    fontSize: 13,
    color: mono.dim2,
    marginLeft: spacing.xs,
    fontFamily: typography.monoFamily
  },
  meta: {
    marginTop: 2,
    marginLeft: 14,
    fontSize: 11,
    color: mono.dim,
    fontFamily: typography.monoFamily
  }
})
