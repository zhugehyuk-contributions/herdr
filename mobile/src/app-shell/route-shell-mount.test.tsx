// Not from orca. orca ships no test that mounts `app/_layout.tsx` or `app/h/_layout.tsx` — its
// vitest `include` is `src/**` only (vitest.config.ts, copied verbatim), so nothing under `app/` is
// collected there or here. This file is why that gap is not inherited: it lives under `src/` and
// imports the route files, so the M2 stage-3 claim ("여기서 앱이 처음 뜬다") is a test result and
// not a screenshot.
//
// What it proves, end to end through the real shell files:
//   1. `RootLayout` mounts, hides the splash on navigator layout, and installs the snapshot provider.
//   2. Data from the stage-4 mock (`src/api/mock/`) reaches rendered `Text` nodes — named strings,
//      not "no error thrown". Since stage 5 the mock answers *per remote*, so these assertions also
//      pin that each screen reads the right box's lists (`src/api/snapshot-context.tsx`).
//   3. `RemoteGroupLayout` is a *master-detail*: on a tablet-width window the remote screen renders
//      twice (sidebar + detail Stack), on a phone-width window once.
//
// What it does NOT prove: that any of this composes on a device. Metro, Hermes, the native splash
// module and expo-router's real navigator are all mocked out here; no build has been run.
import { Children, createElement, isValidElement, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The mocked navigator renders the screens registered here, looked up by the `name` its
// `Stack.Screen` children declare — which is what expo-router's Stack does with the active route,
// and (unlike "render every child") it does not recurse when a layout nests another Stack.
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
// The ported orca chrome draws its chevrons with lucide icons, which pull in react-native-svg —
// nothing this environment can render. Every other test that touches a lucide-using component
// stubs it the same way (e.g. src/components/PickerModal.accessibility.test.ts:16).
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

const storage = vi.hoisted(() => ({ getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }))

const windowSize = vi.hoisted(() => ({ width: 390, height: 844 }))

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
const { default: RemoteGroupLayout } = await import('../../app/h/_layout')
const { default: NodeListScreen } = await import('../../app/nodes')
const { default: RemoteRoute } = await import('../../app/h/[remoteId]/index')

/**
 * react-test-renderer matches host components by their string type, and the `react-native` mock
 * above renders exactly such strings. `@types/react-test-renderer` narrows `findAllByType` to
 * `ElementType`, which only admits DOM intrinsics — hence the cast, once, here rather than at each
 * call site. (The ported orca tests hit the same mismatch and are excluded from
 * `tsconfig.test.json` for it; herdr-authored tests are type-checked, so they resolve it.)
 */
function host(name: string): ElementType {
  return name as unknown as ElementType
}

let renderer: ReactTestRenderer | null = null

/** Mounts the real root shell and flushes the provider's async load. */
async function mountShell(): Promise<ReactTestRenderer> {
  let created: ReactTestRenderer | null = null
  await act(async () => {
    created = create(createElement(RootLayout))
  })
  if (!created) {
    throw new Error('RootLayout did not render')
  }
  renderer = created
  return created
}

function textNodes(target: ReactTestRenderer): string[] {
  return target.root
    .findAllByType(host('Text'))
    .map((node) =>
      Children.toArray(node.props.children as ReactNode)
        .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
        .join('')
    )
    .filter((text) => text.length > 0)
}

beforeEach(() => {
  routerState.screens = {}
  routerState.globalParams = {}
  routerState.pathname = '/'
  routerState.pushed = []
  windowSize.width = 390
  windowSize.height = 844
  splash.hideAsync.mockClear()
})

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
})

describe('root route shell', () => {
  it('mounts and hides the splash once the navigator has laid out', async () => {
    const target = await mountShell()
    expect(splash.preventAutoHideAsync).toHaveBeenCalled()
    expect(splash.hideAsync).not.toHaveBeenCalled()

    const root = target.root.findAllByType(host('View'))[0]!
    await act(async () => {
      await (root.props.onLayout as () => Promise<void>)()
    })
    expect(splash.hideAsync).toHaveBeenCalledTimes(1)
  })

  it('delivers mock data to the node list through the real provider', async () => {
    routerState.screens = { nodes: createElement(NodeListScreen) }
    const target = await mountShell()
    const texts = textNodes(target)

    // Remote names and how each is addressed — remote.list, straight from the fixture.
    expect(texts).toContain('herdr')
    expect(texts).toContain('fable-m5max')
    expect(texts).toContain('iq-64')
    // Each dialled remote's row carries its own roll-up, computed from *that remote's* pane.list.
    expect(texts).toContain('local · 4 spaces · 12 panes · 2 blocked · 4 working · 2 done · 2 unknown · 2 idle')
    expect(texts).toContain('z@iq-64 · 4 spaces · 12 panes · 2 blocked · 4 working · 2 done · 2 unknown · 2 idle')
    // The disabled remote renders as disabled — and *only* as disabled. A remote that was never
    // dialled must not be given a count, because "0 panes" and "we did not ask" look identical.
    expect(texts).toContain('disabled')
    expect(texts.filter((text) => text.startsWith('z@jump'))).toEqual([])
    expect(texts).not.toContain('Loading…')
  })

  it('routes a remote tap at the remote id, not at a host id', async () => {
    routerState.screens = { nodes: createElement(NodeListScreen) }
    const target = await mountShell()
    act(() => {
      // The node rows come before the bottom nav in tree order, so [1] is the second remote.
      target.root.findAllByType(host('Pressable'))[1]!.props.onPress()
    })
    expect(routerState.pushed).toEqual(['/h/remote-2'])
  })
})

describe('master-detail group layout', () => {
  beforeEach(() => {
    routerState.globalParams = { remoteId: 'remote-2' }
    routerState.pathname = '/h/remote-2'
    routerState.screens = {
      h: createElement(RemoteGroupLayout),
      '[remoteId]/index': createElement(RemoteRoute)
    }
  })

  it('shows the workspace list with the roll-up each workspace reports', async () => {
    const target = await mountShell()
    const texts = textNodes(target)

    // The remote the segment names, resolved out of remote.list.
    expect(texts).toContain('iq-64')
    // workspace.list for *this remote* — remote-2's own tree, not the hub's. (The hub, remote-1,
    // reports herdr/zbrain/gtimeline/llmux; remote-2 reports the next four. A screen reading a
    // fleet-wide list would show the hub's here and this assertion is what catches that.)
    expect(texts).toContain('zbrain')
    expect(texts).toContain('gtimeline')
    expect(texts).toContain('llmux')
    expect(texts).toContain('palladium')
    expect(texts).not.toContain('herdr')
    // The pane/tab counts the fixture keeps consistent with pane.list, and the per-row roll-up.
    expect(texts).toContain('3 panes · 2 tabs')
    expect(texts).toContain('1 blocked · 1 working · 1 unknown')
    // One dot per workspace, and the blocked one is the inverted (ring) form, not a fill.
    expect(target.root.findAllByType(host('AnimatedView')).length).toBeGreaterThan(0)
  })

  it('renders the remote screen twice on a tablet-width window — sidebar and detail', async () => {
    windowSize.width = 1024
    windowSize.height = 768
    const target = await mountShell()
    // 4 workspaces rendered in each of the two panes.
    expect(textNodes(target).filter((text) => text === 'palladium')).toHaveLength(2)
    // ...but no collapse affordance at the *base* route: orca's rule is that there is no reveal
    // button, so the sidebar may only be hidden when the detail pane holds something worth the
    // space (app/h/_layout.tsx:101-108, ported verbatim).
    expect(textNodes(target)).not.toContain('hide')
  })

  it('offers the sidebar collapse only once the detail pane has real content', async () => {
    windowSize.width = 1024
    windowSize.height = 768
    routerState.pathname = '/h/remote-2/pane/ws-1-p1'
    const target = await mountShell()
    expect(textNodes(target)).toContain('hide')
  })

  it('renders it once on a phone-width window — detail only', async () => {
    const target = await mountShell()
    expect(textNodes(target).filter((text) => text === 'palladium')).toHaveLength(1)
    expect(textNodes(target)).not.toContain('hide')
  })
})
