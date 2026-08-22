// Not from orca — orca has no screen to copy a test for, because it has no cross-host agent view
// (../agents/fleet-agents.ts). This is the stage-5 receipt, and it is deliberately the same *kind*
// of receipt as `route-shell-mount.test.tsx`: mount the real route file inside the real root shell,
// let the real provider run the real stage-4 mock, and assert on rendered strings and on the order
// they appear in — never on "it rendered without throwing".
//
// The claim it is here to settle is 04-milestones.md M2 "됐다" (a): *blocked를 Agents 홈에서 발견*.
// A device with a real server is what actually closes (a); what can be closed headlessly is
// everything up to the glass:
//   · the fleet union exists at all — agents from more than one remote in one list;
//   · `blocked` is the first section, asserted by *position*, not by presence;
//   · a blocked row says which remote, which workspace and which pane it is (a row you cannot
//     locate is a row you cannot act on);
//   · tapping that row addresses that pane on that remote — not the same pane id on another box.
//
// What it does NOT prove: anything about a device. No Metro, no Hermes, no real navigator, no
// build. See the report's "안 되는 것".
import { Children, createElement, isValidElement, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mono } from '../theme/monotone'

const routerState = vi.hoisted(() => ({
  screens: {} as Record<string, ReactNode>,
  globalParams: {} as Record<string, string | undefined>,
  pathname: '/',
  pushed: [] as string[]
}))

const splash = vi.hoisted(() => ({
  preventAutoHideAsync: vi.fn(async () => true),
  hideAsync: vi.fn(async () => true)
}))

vi.mock('expo-splash-screen', () => splash)
vi.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }))
vi.mock('lucide-react-native', () => ({ ChevronDown: 'ChevronDown', ChevronRight: 'ChevronRight' }))

vi.mock('expo-router', () => {
  function Stack({ children }: { children?: ReactNode }) {
    const active: ReactNode[] = []
    Children.forEach(children, (child) => {
      if (!isValidElement(child)) {
        return
      }
      const name = (child.props as { name?: string }).name
      if (name && name in routerState.screens) {
        active.push(createElement('Screen', { key: name, name }, routerState.screens[name]))
      }
    })
    return createElement('Stack', null, ...active)
  }
  Stack.Screen = ({ name }: { name: string }) => createElement('StackScreen', { name })
  return {
    Stack,
    useRouter: () => ({ push: (href: string) => routerState.pushed.push(href) }),
    usePathname: () => routerState.pathname,
    useGlobalSearchParams: () => routerState.globalParams,
    useLocalSearchParams: () => routerState.globalParams
  }
})

const storage = vi.hoisted(() => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => {})
}))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }))

const windowSize = vi.hoisted(() => ({ width: 390, height: 844 }))

// The screens read the real safe-area inset since §D1. Its provider comes from the navigator on a
// device, and the navigator is mocked away here — so is the library, which does not load under
// this environment's transform at all. Zero insets = the geometry every assertion below was
// written against; `./safe-area-mount.test.tsx` is where a real inset is the subject.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

vi.mock('react-native', () => {
  class AnimatedValue {
    setValue() {}
    interpolate() {
      return '0deg'
    }
  }
  const Animated = {
    Value: AnimatedValue,
    View: 'AnimatedView',
    loop: () => ({ start() {}, stop() {} }),
    timing: () => ({ start() {}, stop() {} })
  }
  return {
    Animated,
    // `RootLayout` mounts the foreground snapshot poller, which gates itself on the app being
    // active (`src/api/use-foreground-refresh.ts`). Without these two the shell cannot mount at all.
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
    Easing: { linear: 'linear' },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
    Text: 'Text',
    View: 'View',
    useWindowDimensions: () => windowSize
  }
})

const { default: RootLayout } = await import('../../app/_layout')
const { openConfiguredSshConnections } = await import('../../modules/herdr-ssh')
const { default: AgentsHomeScreen } = await import('../../app/index')
const { default: RemoteGroupLayout } = await import('../../app/h/_layout')
const { default: RemoteRoute } = await import('../../app/h/[remoteId]/index')

function host(name: string): ElementType {
  return name as unknown as ElementType
}

let renderer: ReactTestRenderer | null = null

async function mountShell(): Promise<ReactTestRenderer> {
  let created: ReactTestRenderer | null = null
  await act(async () => {
    created = create(createElement(RootLayout))
  })
  // The dial does **not** settle inside the act above — measured: it is still `dialling` after that
  // await, and settles one dynamic `import('expo-constants')` later. Since a dial that has not
  // settled holds the screens at `Loading…` (`src/api/herdr-data-provider.tsx`), the shell has to be
  // let finish, and awaiting the *same* call is what puts the hook's state update inside `act`
  // instead of after the assertions. Nothing here is stubbed: this is the real hook reporting the
  // real "no remote configured" result, which is what makes the mock assertions below mean anything.
  await act(async () => {
    await openConfiguredSshConnections()
  })
  if (!created) {
    throw new Error('RootLayout did not render')
  }
  renderer = created
  return created
}

/** Rendered `Text` content, in tree order — so an assertion can be about *order*. */
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

type JsonNode = { type: string; props?: Record<string, unknown>; children?: unknown[] } | string

/**
 * The rendered host tree, as text. Printed by the last test in this file so the receipt is the
 * nodes themselves and not a count of green checks — the same thing stages 3 and 4 did by hand.
 */
function dumpTree(node: unknown, depth = 0): string[] {
  if (typeof node === 'string' || typeof node === 'number') {
    return [`${'  '.repeat(depth)}"${String(node)}"`]
  }
  if (Array.isArray(node)) {
    return node.flatMap((child) => dumpTree(child, depth))
  }
  if (!node || typeof node !== 'object') {
    return []
  }
  const element = node as JsonNode & object
  const props = (element as { props?: Record<string, unknown> }).props ?? {}
  const label =
    typeof props['accessibilityLabel'] === 'string' ? ` a11y=${props['accessibilityLabel']}` : ''
  const line = `${'  '.repeat(depth)}<${(element as { type: string }).type}${label}>`
  const children = (element as { children?: unknown[] }).children ?? []
  return [line, ...children.flatMap((child) => dumpTree(child, depth + 1))]
}

/** Every colour literal reachable from a rendered style — same helper as the monotone test. */
function colorsIn(target: ReactTestRenderer): string[] {
  return target.root
    .findAll(() => true)
    .flatMap((node) => [node.props.style].flat(3))
    .filter(
      (style): style is Record<string, unknown> => typeof style === 'object' && style !== null
    )
    .flatMap((style) =>
      ['backgroundColor', 'borderColor', 'borderTopColor', 'borderLeftColor', 'color']
        .map((key) => style[key])
        .filter((value): value is string => typeof value === 'string')
    )
}

beforeEach(() => {
  routerState.screens = { index: createElement(AgentsHomeScreen) }
  routerState.globalParams = {}
  routerState.pathname = '/'
  routerState.pushed = []
  windowSize.width = 390
  windowSize.height = 844
})

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
})

describe('Agents home', () => {
  it('is the union over every dialled remote, not one box', async () => {
    const texts = textNodes(await mountShell())
    // remote.list declares 5; `jump` is disabled, so 4 were dialled.
    expect(texts).toContain('4 nodes')
    // Agents from at least three different remotes are on screen at once. In a per-box list this is
    // structurally impossible, which is what makes it worth asserting.
    for (const remoteName of ['fable-m5max', 'iq-64', 'work-m16', 'blade-4090']) {
      expect(texts.some((text) => text.startsWith(`${remoteName} / `))).toBe(true)
    }
    expect(texts).not.toContain('Loading…')
  })

  it('leads with the number the screen exists for', async () => {
    expect(textNodes(await mountShell())).toContain('8 blocked · 16 working')
  })

  it('puts blocked at the very top — asserted by position, not by presence', async () => {
    const texts = textNodes(await mountShell())
    const sections = texts.filter((text) =>
      /^(blocked|working|done|unknown|idle) · \d+$/.test(text)
    )
    expect(sections).toEqual(['blocked · 8', 'working · 16', 'done · 8', 'unknown · 8'])
    // ...and nothing from another status is rendered above the first blocked row.
    expect(texts.indexOf('blocked · 8')).toBeLessThan(texts.indexOf('working · 16'))
    const firstBlockedRow = texts.findIndex((text) => text.endsWith('· waiting for approval'))
    const firstWorkingRow = texts.findIndex((text) => text.endsWith('· running cargo nextest'))
    expect(firstBlockedRow).toBeGreaterThan(-1)
    expect(firstWorkingRow).toBeGreaterThan(firstBlockedRow)
  })

  it('says of every row which remote, which workspace and which pane it is', async () => {
    const texts = textNodes(await mountShell())
    // remote / workspace · what it is doing — the server's own `state_labels` word, not ours.
    expect(texts).toContain('fable-m5max / herdr · waiting for approval')
    expect(texts).toContain('iq-64 / gtimeline · permission prompt')
    expect(texts).toContain('fable-m5max / herdr · writing mockup html')
    // ...the agent's identity...
    expect(texts).toContain('claude')
    expect(texts).toContain('codex')
    // ...and the pane handle herdr itself uses.
    expect(texts).toContain('1-1')
  })

  it('addresses the tapped pane on the tapped remote — pane ids collide across boxes', async () => {
    const target = await mountShell()
    const row = target.root
      .findAllByType(host('Pressable'))
      .find(
        (node) =>
          node.props.accessibilityLabel === 'claude — fable-m5max / herdr · waiting for approval'
      )
    expect(row, 'the first blocked row was not found by its accessibility label').toBeDefined()
    act(() => {
      ;(row!.props.onPress as () => void)()
    })
    expect(routerState.pushed).toEqual(['/h/remote-1/pane/ws-1-p1'])
    // The same pane id exists on remote-2; a href built from pane_id alone would have gone there.
    expect(routerState.pushed[0]).not.toBe('/h/remote-2/pane/ws-1-p1')
  })

  it('reaches the nodes list, so the physical tree is still one tap away', async () => {
    const target = await mountShell()
    const nodesTab = target.root
      .findAllByType(host('Pressable'))
      .find((node) => node.props.accessibilityLabel === 'nodes tab')
    expect(nodesTab).toBeDefined()
    act(() => {
      ;(nodesTab!.props.onPress as () => void)()
    })
    expect(routerState.pushed).toEqual(['/nodes'])
  })

  it('stays on the monotone ramp', async () => {
    const ramp = new Set<string>([...Object.values(mono), 'transparent'])
    const used = colorsIn(await mountShell())
    expect(used.length).toBeGreaterThan(0)
    for (const color of used) {
      expect(ramp, `home screen used ${color}`).toContain(color)
    }
  })
})

describe('workspace / pane browser', () => {
  beforeEach(() => {
    routerState.globalParams = { remoteId: 'remote-2' }
    routerState.pathname = '/h/remote-2'
    routerState.screens = {
      h: createElement(RemoteGroupLayout),
      '[remoteId]/index': createElement(RemoteRoute)
    }
  })

  it('collapses each workspace to one row until it is opened', async () => {
    const texts = textNodes(await mountShell())
    expect(texts).toContain('palladium')
    expect(texts).toContain('3 panes · 2 tabs')
    // Panes are not rendered yet — no tab headers, no pane handles.
    expect(texts.filter((text) => text.startsWith('tab '))).toEqual([])
  })

  it('expands a workspace into its panes, grouped by tab', async () => {
    const target = await mountShell()
    const row = target.root
      .findAllByType(host('Pressable'))
      .find((node) => String(node.props.accessibilityLabel).startsWith('palladium — 1 blocked'))
    expect(row, 'the palladium workspace row was not found').toBeDefined()
    act(() => {
      ;(row!.props.onPress as () => void)()
    })
    const texts = textNodes(target)
    // Two tabs for three panes — the fixture puts two panes in tab 1 precisely so a client that
    // aliases one tab per pane fails here.
    expect(texts).toContain('tab 1 · palladium 1')
    expect(texts).toContain('tab 2 · palladium 2')
    expect(texts).toContain('1-1')
    expect(texts).toContain('2-1')
    // The blocked pane in tab 2 carries the server's own word for what it is waiting on.
    expect(texts).toContain('permission prompt')
  })

  it('routes a pane tap at that pane on that remote', async () => {
    const target = await mountShell()
    const row = target.root
      .findAllByType(host('Pressable'))
      .find((node) => String(node.props.accessibilityLabel).startsWith('palladium — '))
    act(() => {
      ;(row!.props.onPress as () => void)()
    })
    const pane = target.root
      .findAllByType(host('Pressable'))
      .find((node) => node.props.accessibilityLabel === '2-1 build')
    expect(pane, 'the blocked pane row was not found').toBeDefined()
    act(() => {
      ;(pane!.props.onPress as () => void)()
    })
    expect(routerState.pushed).toEqual(['/h/remote-2/pane/ws-4-p3'])
  })
})

describe('receipt', () => {
  it('dumps the rendered Agents home so the claim is inspectable, not just green', async () => {
    const target = await mountShell()
    const lines = dumpTree(target.toJSON())
    // Printed on purpose: `vitest run` output carries the tree into the report.
    console.log(`\n===== rendered Agents home (${lines.length} nodes) =====\n${lines.join('\n')}`)
    expect(lines.length).toBeGreaterThan(100)
  })

  it('dumps the workspace/pane browser with a workspace expanded', async () => {
    routerState.globalParams = { remoteId: 'remote-2' }
    routerState.pathname = '/h/remote-2'
    routerState.screens = {
      h: createElement(RemoteGroupLayout),
      '[remoteId]/index': createElement(RemoteRoute)
    }
    const target = await mountShell()
    const row = target.root
      .findAllByType(host('Pressable'))
      .find((node) => String(node.props.accessibilityLabel).startsWith('palladium — '))
    act(() => {
      ;(row!.props.onPress as () => void)()
    })
    const lines = dumpTree(target.toJSON())
    console.log(
      `\n===== rendered remote-2 browser, palladium expanded (${lines.length} nodes) =====\n${lines.join('\n')}`
    )
    expect(lines.length).toBeGreaterThan(100)
  })
})
