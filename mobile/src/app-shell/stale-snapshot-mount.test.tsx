// Not from orca. The wiring half of .prd/09-review-followups.md §G's residual: `./snapshot-
// staleness.test.ts` fixes *what* may be said about a failing refresh, this fixes *that it reaches
// the glass*, on both list screens, driven by the real poller and the real provider rather than by
// a prop.
//
// Why it is worth a mount at all when the label is a pure function: the residual was never a
// formatting bug. `refreshError` had existed and been correct since the poller landed, and the
// entire defect was that no screen read it (`../api/snapshot-context.tsx:64`'s own doc says "nothing
// is required to"). A test that only calls the formatter would pass on exactly the app that has the
// bug.
//
// Deliberately not folded into `./agents-home-mount.test.tsx`: that suite mounts the real shell over
// the stage-4 fixture, which cannot fail, and making it fail would mean mocking the loader out from
// under every other assertion in it.
import { Children, createElement, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mono } from '../theme/monotone'
import type { HerdrSnapshot } from '../api/snapshot-context'

const appState = vi.hoisted(() => ({
  current: 'active' as string,
  listeners: new Set<(next: string) => void>()
}))

vi.mock('expo-router', () => ({ useRouter: () => ({ push: () => {} }) }))

vi.mock('react-native', () => {
  class AnimatedValue {
    setValue() {}
    interpolate() {
      return '0deg'
    }
  }
  return {
    Animated: {
      Value: AnimatedValue,
      View: 'AnimatedView',
      loop: () => ({ start() {}, stop() {} }),
      timing: () => ({ start() {}, stop() {} })
    },
    AppState: {
      get currentState() {
        return appState.current
      },
      addEventListener: (_type: string, handler: (next: string) => void) => {
        appState.listeners.add(handler)
        return { remove: () => appState.listeners.delete(handler) }
      }
    },
    Easing: { linear: 'linear' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: { create: (styles: unknown) => styles },
    Text: 'Text',
    View: 'View'
  }
})

const { HerdrSnapshotProvider } = await import('../api/snapshot-context')
const { useForegroundRefresh } = await import('../api/use-foreground-refresh')
const { default: AgentsHomeScreen } = await import('../../app/index')
const { default: NodeListScreen } = await import('../../app/nodes')

const INTERVAL_MS = 4000

function host(name: string): ElementType {
  return name as unknown as ElementType
}

/** One box with one agent — enough for both screens to have something to go stale. */
const FLEET: HerdrSnapshot = (() => {
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
            agent_status: 'working' as const,
            revision: 1
          }
        ]
      }
    ]
  }
})()

/** What `app/_layout.tsx` mounts next to the screens; the label has no timer of its own. */
function Poller() {
  useForegroundRefresh(INTERVAL_MS)
  return null
}

let renderer: ReactTestRenderer | null = null
let failing = false

const load = () =>
  failing ? Promise.reject(new Error('ssh: channel closed')) : Promise.resolve(FLEET)

async function mount(screen: ReactNode): Promise<ReactTestRenderer> {
  let created: ReactTestRenderer | null = null
  await act(async () => {
    created = create(
      <HerdrSnapshotProvider load={load}>
        <Poller />
        {screen}
      </HerdrSnapshotProvider>
    )
  })
  if (!created) {
    throw new Error('did not render')
  }
  renderer = created
  return created
}

function textNodes(target: ReactTestRenderer): string[] {
  return target.root
    .findAllByType(host('Text'))
    .map((node) =>
      Children.toArray(node.props.children as ReactNode)
        .map((child) =>
          typeof child === 'string' || typeof child === 'number' ? String(child) : ''
        )
        .join('')
    )
    .filter((text) => text.length > 0)
}

/** The rendered staleness hint, or null — the screens render at most one. */
function staleText(target: ReactTestRenderer): string | null {
  return (
    textNodes(target).find((text) => text.startsWith('stale ') || text === 'never loaded') ?? null
  )
}

/** Every colour literal reachable from a rendered style — same helper as the monotone suite. */
function colorsIn(target: ReactTestRenderer): string[] {
  return target.root
    .findAll(() => true)
    .flatMap((node) => [node.props.style].flat(3))
    .filter(
      (style): style is Record<string, unknown> => typeof style === 'object' && style !== null
    )
    .flatMap((style) =>
      ['backgroundColor', 'borderColor', 'borderTopColor', 'color']
        .map((key) => style[key])
        .filter((value): value is string => typeof value === 'string')
    )
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  appState.current = 'active'
  appState.listeners.clear()
  failing = false
})

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
  vi.useRealTimers()
})

describe('a failing refresh is visible on the list screens', () => {
  it.each([
    ['Agents home', () => createElement(AgentsHomeScreen)],
    ['node list', () => createElement(NodeListScreen)]
  ])('%s says nothing extra while the poll is answering', async (_name, screen) => {
    const target = await mount(screen())
    await advance(INTERVAL_MS * 10)

    expect(staleText(target)).toBeNull()
    // Not "up to date", not a dot, not a timestamp: healthy is the screen that already existed.
    expect(textNodes(target).some((text) => text.includes('date'))).toBe(false)
  })

  it.each([
    ['Agents home', () => createElement(AgentsHomeScreen)],
    ['node list', () => createElement(NodeListScreen)]
  ])('%s names how long it has been failing, and stops when it stops', async (_name, screen) => {
    const target = await mount(screen())
    failing = true

    // Two dropped execs are a tunnel; the screen stays as it was.
    await advance(INTERVAL_MS * 2)
    expect(staleText(target)).toBeNull()

    // Past the absorption window the header starts saying so — advancing off the 4s poll alone,
    // with no second timer anywhere in this tree.
    await advance(INTERVAL_MS * 3)
    expect(staleText(target)).toBe('stale 20s')

    await advance(104_000)
    expect(staleText(target)).toBe('stale 2m')

    // The fleet is still readable throughout: this is a hint on a live screen, not an error page.
    // (The home names the box inside a row's meta line, the node list as the row title.)
    expect(textNodes(target).some((text) => text.includes('a-real-box'))).toBe(true)

    failing = false
    await advance(INTERVAL_MS)
    expect(staleText(target)).toBeNull()
  })

  it('distinguishes "never answered" from "answered two minutes ago"', async () => {
    failing = true
    const target = await mount(createElement(AgentsHomeScreen))

    await advance(INTERVAL_MS * 30)

    // Nothing on screen ever came from a server, so dating it would be the lie.
    expect(staleText(target)).toBe('never loaded')
  })

  it('carries the severity in the word, not in a hue', async () => {
    const target = await mount(createElement(AgentsHomeScreen))
    failing = true
    await advance(INTERVAL_MS * 5)
    expect(staleText(target)).toBe('stale 20s')

    const ramp = new Set<string>([...Object.values(mono), 'transparent'])
    for (const color of colorsIn(target)) {
      expect(ramp, `stale header used ${color}`).toContain(color)
    }
  })
})
