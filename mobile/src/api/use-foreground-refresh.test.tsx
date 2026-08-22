// Not from orca. The receipt for the one thing a device proved this app could not do: on
// 2026-08-22 a real server flipped an agent `working` → `blocked` and 20+ seconds later the phone
// still showed `working` — the snapshot was loaded once at mount and `reload` had no caller
// anywhere in `app/`. So the assertion that matters below is not "a timer fires"; it is "a status
// the loader changed reaches the context", which is 04-milestones.md M2 (a) ("blocked를 Agents
// 홈에서 60초 내 발견") reduced to something headless.
//
// The other tests are the *reasons* this could not simply be `reload()` on a timer: reload flips
// `status` to `'loading'` and blanks the snapshot on failure, which on a phone — where a dropped
// ssh exec is routine, not exceptional — would be a worse app than the one that never refreshes.
import { createElement, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from './herdr-api-types'
import type { HerdrSnapshot, SnapshotLoader } from './snapshot-context'

const appState = vi.hoisted(() => ({
  current: 'active' as string,
  listeners: new Set<(next: string) => void>()
}))

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.current
    },
    addEventListener: (_type: string, handler: (next: string) => void) => {
      appState.listeners.add(handler)
      return {
        remove: () => {
          appState.listeners.delete(handler)
        }
      }
    }
  },
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))

const { HerdrSnapshotProvider, useHerdrSnapshot } = await import('./snapshot-context')
const { useForegroundRefresh } = await import('./use-foreground-refresh')

const INTERVAL_MS = 4000

function host(name: string): ElementType {
  return name as unknown as ElementType
}

/** One box, one agent — the shape the device regression happened in, minus everything else. */
function fleetWith(agentStatus: AgentStatus): HerdrSnapshot {
  const remote = { id: 'r1', name: 'a-real-box', target: { type: 'ssh' as const, target: 'z@box' } }
  return {
    remotes: [remote],
    perRemote: [
      {
        remote,
        workspaces: [],
        panes: [],
        agents: [
          {
            pane_id: 'p1',
            terminal_id: 't1',
            workspace_id: 'w1',
            tab_id: 'tab1',
            focused: true,
            agent_status: agentStatus,
            revision: 1
          }
        ]
      }
    ]
  }
}

/** Every status the context has ever exposed, so "it never flipped to loading" is checkable. */
const statusLog: string[] = []
/** The user-initiated path, captured so a test can prove polling did not repurpose it. */
let contextReload: (() => void) | null = null

function Probe() {
  useForegroundRefresh(INTERVAL_MS)
  const { status, snapshot, error, refreshError, reload } = useHerdrSnapshot()
  statusLog.push(status)
  contextReload = reload
  return createElement(
    host('View'),
    null,
    createElement(host('Text'), null, `${status}:${error ?? ''}:${refreshError ?? ''}`),
    createElement(
      host('Text'),
      null,
      snapshot.perRemote
        .flatMap((entry) => entry.agents.map((agent) => agent.agent_status))
        .join(',')
    )
  )
}

let renderer: ReactTestRenderer | null = null

async function mount(load: SnapshotLoader): Promise<ReactTestRenderer> {
  let created: ReactTestRenderer | null = null
  await act(async () => {
    created = create(
      <HerdrSnapshotProvider load={load}>
        <Probe />
      </HerdrSnapshotProvider>
    )
  })
  if (!created) {
    throw new Error('did not render')
  }
  renderer = created
  return created
}

function texts(target: ReactTestRenderer): string[] {
  return target.root
    .findAllByType(host('Text'))
    .map((node) => node.props.children as ReactNode[] | string as string)
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function enterAppState(next: string) {
  appState.current = next
  await act(async () => {
    for (const listener of appState.listeners) {
      listener(next)
    }
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  appState.current = 'active'
  appState.listeners.clear()
  statusLog.length = 0
  contextReload = null
})

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
  vi.useRealTimers()
})

describe('foreground snapshot polling', () => {
  it('shows a status the server changed after mount — the device regression, headless', async () => {
    let status: AgentStatus = 'working'
    const target = await mount(() => Promise.resolve(fleetWith(status)))
    expect(texts(target)[1]).toBe('working')

    status = 'blocked'
    await advance(INTERVAL_MS)

    expect(texts(target)[1]).toBe('blocked')
  })

  it('never flips the screen back to loading while polling', async () => {
    const target = await mount(() => Promise.resolve(fleetWith('working')))
    expect(texts(target)[0]).toBe('ready::')
    statusLog.length = 0

    await advance(INTERVAL_MS * 3)

    // A poll built on `reload()` would have put 'loading' in here three times.
    expect(statusLog).not.toContain('loading')
    expect(texts(target)[0]).toBe('ready::')
  })

  it('keeps the last good snapshot when a refresh fails', async () => {
    let fail = false
    const target = await mount(() =>
      fail
        ? Promise.reject(new Error('ssh: channel closed'))
        : Promise.resolve(fleetWith('working'))
    )
    fail = true

    await advance(INTERVAL_MS)

    // Still the last thing the server confirmed, and reachable — not an empty error page.
    expect(texts(target)[1]).toBe('working')
    expect(texts(target)[0]).toBe('ready::ssh: channel closed')
    expect(statusLog).not.toContain('error')
  })

  it('never runs two loads at once — one load is one ssh exec (B8)', async () => {
    const calls = vi.fn()
    await mount(() => {
      calls()
      return new Promise<HerdrSnapshot>(() => {})
    })

    await advance(INTERVAL_MS * 5)

    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('stops in the background and refreshes the moment it returns', async () => {
    const calls = vi.fn()
    await mount(() => {
      calls()
      return Promise.resolve(fleetWith('working'))
    })
    expect(calls).toHaveBeenCalledTimes(1)

    await enterAppState('background')
    await advance(INTERVAL_MS * 3)
    expect(calls).toHaveBeenCalledTimes(1)

    // Returning must not cost the user a full interval of staring at stale rows.
    await enterAppState('active')
    expect(calls).toHaveBeenCalledTimes(2)

    await advance(INTERVAL_MS)
    expect(calls).toHaveBeenCalledTimes(3)
  })

  it('leaves the explicit reload alone — that one is still the spinner path', async () => {
    const target = await mount(() => Promise.resolve(fleetWith('working')))
    statusLog.length = 0

    await act(async () => {
      contextReload?.()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(statusLog).toContain('loading')
    expect(texts(target)[0]).toBe('ready::')
  })
})
