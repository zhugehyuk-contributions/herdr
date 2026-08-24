import { describe, expect, it } from 'vitest'
import type { PaneInfo, RemoteDefinition, RemoteSnapshot } from '../api/herdr-api-types'
import {
  NODE_DOT_AGENT_STATUS,
  fleetSummary,
  lastSeenClause,
  mergeLastSeen,
  nodeDetail,
  nodeDotState,
  nodeSection
} from './node-list-model'

function pane(status: PaneInfo['agent_status']): PaneInfo {
  return {
    pane_id: `p-${status}`,
    terminal_id: 't',
    workspace_id: 'ws-1',
    tab_id: 'tab-1',
    focused: false,
    agent_status: status,
    revision: 1
  }
}

function remote(over: Partial<RemoteDefinition> = {}): RemoteDefinition {
  return { id: 'r1', name: 'iq-64', target: { type: 'ssh', target: 'z@iq-64' }, ...over }
}

function entry(panes: PaneInfo[], workspaces = 1): RemoteSnapshot {
  return {
    remote: remote(),
    workspaces: Array.from({ length: workspaces }, (_unused, i) => ({
      workspace_id: `ws-${i + 1}`,
      number: i + 1,
      label: `ws-${i + 1}`,
      focused: false,
      pane_count: panes.length,
      tab_count: 1
    })),
    panes
  } as unknown as RemoteSnapshot
}

describe('목업 #3 — hub / remotes 섹션', () => {
  it('local 타깃은 hub, ssh 타깃은 remotes', () => {
    expect(nodeSection(remote({ target: { type: 'local' } }))).toBe('hub')
    expect(nodeSection(remote())).toBe('remotes')
  })
})

describe('목업 #5 — 노드 dot 4종', () => {
  it('disabled → off (아무도 묻지 않았으므로 오류가 아니다)', () => {
    expect(nodeDotState({ disabled: true, entry: entry([pane('blocked')]) })).toBe('off')
  })

  it('스냅샷 항목이 없으면 blocked — 물었는데 답이 없었다', () => {
    expect(nodeDotState({ entry: null })).toBe('blocked')
  })

  it('blocked가 working을 이긴다', () => {
    expect(nodeDotState({ entry: entry([pane('working'), pane('blocked')]) })).toBe('blocked')
  })

  it('working 하나면 working', () => {
    expect(nodeDotState({ entry: entry([pane('idle'), pane('working')]) })).toBe('working')
  })

  it('전부 조용하면 ok', () => {
    expect(nodeDotState({ entry: entry([pane('idle'), pane('done')]) })).toBe('ok')
  })

  it('네 상태가 공유 dot의 서로 다른 모양으로 간다', () => {
    const mapped = Object.values(NODE_DOT_AGENT_STATUS)
    expect(new Set(mapped).size).toBe(mapped.length)
    expect(NODE_DOT_AGENT_STATUS.blocked).toBe('blocked')
  })
})

describe('목업 #6 — reconnecting… · last seen', () => {
  it('도달 못 한 원격은 마지막 목격 시각을 싣는다', () => {
    expect(
      nodeDetail({
        remote: remote(),
        subtitle: 'z@iq-64',
        entry: null,
        rollup: '',
        lastSeenAt: 1_000_000,
        nowMs: 1_000_000 + 125_000
      })
    ).toBe('reconnecting… · last seen 2m ago')
  })

  it('한 번도 못 본 원격은 시각을 지어내지 않는다', () => {
    expect(
      nodeDetail({
        remote: remote(),
        subtitle: 'z@iq-64',
        entry: null,
        rollup: '',
        lastSeenAt: null,
        nowMs: 5
      })
    ).toBe('reconnecting…')
  })

  it('disabled가 reconnecting보다 먼저다 — 재시도하지 않으니까', () => {
    expect(
      nodeDetail({
        remote: remote({ disabled: true }),
        subtitle: 'z@iq-64',
        entry: null,
        rollup: '',
        lastSeenAt: 1,
        nowMs: 999_999
      })
    ).toBe('disabled')
  })

  it('정상 행은 기존 롤업 문장 그대로', () => {
    expect(
      nodeDetail({
        remote: remote(),
        subtitle: 'z@iq-64',
        entry: entry([pane('working'), pane('idle')], 4),
        rollup: '1 working · 1 idle',
        lastSeenAt: null,
        nowMs: 0
      })
    ).toBe('z@iq-64 · 4 spaces · 2 panes · 1 working · 1 idle')
  })

  it('경과 표기는 5초 그리드 → 분 → 시간', () => {
    expect(lastSeenClause(43_000)).toBe('40s ago')
    expect(lastSeenClause(125_000)).toBe('2m ago')
    expect(lastSeenClause(4 * 3_600_000)).toBe('4h ago')
  })
})

describe('mergeLastSeen', () => {
  it('이번에 답한 원격만 갱신하고 나머지는 보존한다', () => {
    const first = mergeLastSeen(new Map(), [entry([])], 100)
    expect(first.get('r1')).toBe(100)
    const second = mergeLastSeen(first, [], 200)
    expect(second.get('r1')).toBe(100)
  })
})

describe('fleetSummary — 5차가 잡은 자기모순 헤더', () => {
  it('says node, not nodes, when the fleet is one', () => {
    // The single-node fleet is a first-time user's whole screen, so `1 nodes` is the string most
    // likely to be the first thing anyone reads (iOS QA 11차, 2026-08-25).
    expect(fleetSummary({ remotes: [remote('a')], answered: 1 })).toBe('1 node')
    expect(fleetSummary({ remotes: [remote('a')], answered: 0 })).toBe('1 node · 1 unreachable')
  })

  const remote = (id: string, over: Partial<RemoteDefinition> = {}): RemoteDefinition => ({
    id,
    name: id,
    target: { type: 'ssh', target: `z@${id}` },
    ...over
  })

  it('답한 수가 아니라 함대를 센다 — 그게 "노드가 몇 개냐"의 뜻이다', () => {
    // 5차 실측: 살아있는 1 + 죽은 1인데 헤더가 `1 nodes`, 그 아래 목록은 2행, settings는 `app.json · 2`.
    expect(fleetSummary({ remotes: [remote('a'), remote('b')], answered: 1 })).toBe(
      '2 nodes · 1 unreachable'
    )
  })

  it('전부 답하면 두 번째 절은 없다 — 발명하지 않는다', () => {
    expect(fleetSummary({ remotes: [remote('a'), remote('b')], answered: 2 })).toBe('2 nodes')
  })

  it('disabled는 함대에 세되 unreachable로는 세지 않는다 — 아무도 안 걸었으니까', () => {
    expect(
      fleetSummary({ remotes: [remote('a'), remote('b', { disabled: true })], answered: 1 })
    ).toBe('2 nodes')
  })

  it('빈 함대', () => {
    expect(fleetSummary({ remotes: [], answered: 0 })).toBe('0 nodes')
  })
})
