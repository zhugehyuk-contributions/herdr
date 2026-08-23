// Not from orca. `.prd/11-mockup-conformance.md` as a test: the UI source of truth is
// `.prd/assets/mockup.html` (7 screens), and the agent that built and QA'd eight milestones never
// opened it — the user found that, and the goal gained a fourth condition (UI QA is mandatory).
//
// What this file guards is the part that rots silently. The repairs are single elements — a back
// chevron, a node name, a FAB — and every one of them can be deleted by a refactor while the
// feature tests stay green, because no feature depends on them. They are how a person *moves*, and
// nothing here simulates a person moving.
//
// One assertion per mockup line item, named by its number in `.prd/11` so the ledger and the gate
// cannot drift apart.
import { createElement, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HerdrRemoteConnection } from '../transport/herdr-connection'

/** What `useSafeAreaInsets()` reports for the next mount. */
const safeArea = vi.hoisted(() => ({
  insets: { top: 0, bottom: 0, left: 0, right: 0 }
}))

/** iPhone 17 Pro, portrait — the device .prd/09-review-followups.md §D1 was measured on. */
const IPHONE_PORTRAIT = { top: 59, bottom: 34, left: 0, right: 0 }

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => safeArea.insets
}))

const routerState = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
  pushed: [] as string[]
}))

vi.mock('expo-router', () => ({
  useRouter: () => ({
    push: (href: string) => routerState.pushed.push(href),
    replace: (href: string) => routerState.pushed.push(href)
  }),
  useLocalSearchParams: () => routerState.params
}))

vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  RefreshCw: 'RefreshCw'
}))

vi.mock('react-native-webview', async () => {
  const React = await import('react')
  const WebView = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => ({ postMessage: () => {}, reload: () => {} }))
    return React.createElement('WebView', props)
  })
  return { WebView, default: WebView }
})

// M6a: the pane viewer now imports react-native-gesture-handler, which reaches into RN internals
// this environment does not have. `test/gesture-handler-double.ts` stands in and renders the same
// tree (its `GestureDetector` passes the child through, its root view is the host `View`), so every
// assertion below still sees what it saw. Driving the gesture is
// `src/app-shell/pane-swipe-mount.test.tsx`'s job, not this suite's.
vi.mock('react-native-gesture-handler', async () => {
  const { createGestureHandlerDouble, createGestureHandlerRegistry } =
    await import('../../test/gesture-handler-double')
  return createGestureHandlerDouble(createGestureHandlerRegistry())
})

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
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
    Easing: { linear: 'linear' },
    // M3+§BB: the bar subscribes to the soft keyboard so its `↵` can climb above it
    // (`src/layout/use-soft-keyboard-height.ts`). A mock that owes only values, not subscriptions,
    // makes the bar throw on mount; `./keyboard-lift-mount.test.tsx` is where the events are the
    // subject.
    Keyboard: { addListener: () => ({ remove: () => {} }) },
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: {
      absoluteFillObject: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
      create: (styles: unknown) => styles
    },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View'
  }
})

const { HerdrClientsProvider } = await import('../transport/herdr-clients-context')
const { HerdrSnapshotProvider } = await import('../api/snapshot-context')
const { loadMockSnapshot } = await import('../api/mock/mock-snapshot-loader')
const { default: NodeListScreen } = await import('../../app/nodes')
const { RemoteScreen } = await import('../../app/h/[remoteId]/index')
const { PaneViewerScreen } = await import('../../app/h/[remoteId]/pane/[paneId]')
const { default: SettingsScreen } = await import('../../app/settings')

const NO_CONNECTIONS: readonly HerdrRemoteConnection[] = []

function host(name: string): ElementType {
  return name as unknown as ElementType
}

function byLabel(target: ReactTestRenderer, label: string): ReactTestInstance {
  const node = target.root.findAll((each) => each.props['accessibilityLabel'] === label)[0]
  if (!node) {
    throw new Error(`no node labelled ${label}`)
  }
  return node
}

let renderer: ReactTestRenderer | null = null

async function mount(node: ReactNode): Promise<ReactTestRenderer> {
  let created: ReactTestRenderer | null = null
  await act(async () => {
    created = create(
      <HerdrClientsProvider connections={NO_CONNECTIONS}>
        <HerdrSnapshotProvider load={loadMockSnapshot}>{node}</HerdrSnapshotProvider>
      </HerdrClientsProvider>
    )
  })
  if (!created) {
    throw new Error('did not render')
  }
  renderer = created
  return created
}

/** The two screens whose bottom edge is a pinned bar, and the label that bar puts on it. */
beforeEach(() => {
  safeArea.insets = IPHONE_PORTRAIT
  routerState.params = { remoteId: 'remote-1', paneId: 'ws-1-p1' }
  routerState.pushed = []
})

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
})

describe('.prd/11 누락 #10 — back breadcrumbs exist on the screens below nodes', () => {
  it('the pane viewer offers a way back to the workspace list', async () => {
    // `app/h/_layout.tsx:56` sets `headerShown: false`, so there is no navigator chrome to fall
    // back on: without this control the only way up is Android's hardware back or an iOS edge
    // swipe, neither of which is visible and neither of which exists on the tablet layout.
    const target = await mount(
      createElement(PaneViewerScreen, { remoteId: 'remote-1', paneId: 'ws-1-p1' })
    )
    expect(byLabel(target, 'back to workspaces')).toBeTruthy()
  })

  it('the workspace list offers a way back to the node list', async () => {
    const target = await mount(createElement(RemoteScreen, { remoteId: 'remote-1' }))
    expect(byLabel(target, 'back to nodes')).toBeTruthy()
  })
})

describe('.prd/11 누락 #15 — the pane header says which node this is', () => {
  it('renders the node name even when a pane is attached', async () => {
    // The regression this replaces: the node reached the bar only through a ternary that prefers
    // the pane title, so it disappeared on the normal path — a pane *is* attached — and an app
    // that shows several boxes at once has to say which box the terminal belongs to.
    const target = await mount(
      createElement(PaneViewerScreen, { remoteId: 'remote-1', paneId: 'ws-1-p1' })
    )
    const texts = target.root.findAllByType(host('Text')).map((node) => String(node.props.children))
    expect(texts.some((text) => text.includes('fable-m5max'))).toBe(true)
  })
})

describe('.prd/11 누락 #4 — the node list can add a remote', () => {
  it('renders the add-remote affordance', async () => {
    // Before this the only route was: notice the word `settings` in the appbar, open it, scroll
    // past push notifications, find a button. The destination is still settings (차이-배치 #3 is
    // open); what changed is that the affordance is where an empty node list is looked at.
    const target = await mount(createElement(NodeListScreen))
    expect(byLabel(target, 'add remote')).toBeTruthy()
  })
})

describe('.prd/11 누락 #3 — the node list is sectioned, not flat', () => {
  it('labels both sections, hub first', async () => {
    // The mockup draws `hub` above the box herdr itself runs on and `remotes` above the rest
    // (`assets/mockup.html:397`, `:402`), and the fixture models exactly that shape — one
    // `{type:'local'}` remote and several ssh ones (`../api/mock/mock-fixture.ts:115`). Order is
    // asserted, not just presence: the point of the split is that the box you are standing on
    // reads differently from the ones you dial, and a `remotes` heading above `hub` says the
    // opposite. An empty section renders no heading at all — structural (`remotes.length === 0`),
    // and not reachable from this fixture. The split itself is `nodeSection`, tested there.
    const target = await mount(createElement(NodeListScreen))
    const labels = target.root
      .findAllByType(host('Text'))
      .map((node) => String(node.props['children']))
    expect(labels).toContain('hub')
    expect(labels).toContain('remotes')
    expect(labels.indexOf('hub')).toBeLessThan(labels.indexOf('remotes'))
  })
})

describe('.prd/11 타이포그래피 — the chrome is monospaced like the mockup', () => {
  it('gives every text style a font family', async () => {
    // The mockup's contract is one line and it is global: `body { font-family: var(--mono) }`
    // (`assets/mockup.html`, `--mono: "JetBrains Mono", ui-monospace, …`). The implementation had
    // it on two components, so the first device UI QA read the app as "generic Material dark"
    // rather than terminal-native even though the palette matched exactly.
    //
    // Asserted on the *rendered* tree rather than on StyleSheet objects: what a reader sees is the
    // sum of the ancestor chain, and a style entry that exists but is never applied would pass a
    // source check while changing nothing on screen.
    const target = await mount(createElement(NodeListScreen))
    const withoutFamily = target.root
      .findAllByType(host('Text'))
      .filter((node) => {
        const style = ([node.props['style']].flat(4) as unknown[]).filter(
          (layer): layer is Record<string, unknown> => typeof layer === 'object' && layer !== null
        )
        const merged = Object.assign({}, ...style) as Record<string, unknown>
        return merged['fontSize'] !== undefined && merged['fontFamily'] === undefined
      })
      .map((node) => String(node.props['children']))
    expect(withoutFamily).toEqual([])
  })
})

describe('.prd/11 누락 #9 — the add-remote form can say whether the host answers', () => {
  it('renders a test affordance beside save', async () => {
    // P0 in the audit, and the reason is the shape of the alternative: adding a remote here means
    // typing a host, a port, a username and a **private key body** into a phone, and before this
    // the app said nothing afterwards — a wrong port and a wrong key both showed up as a list that
    // stayed empty. The mockup's line is `✓ reachable · herdr 0.34.1 · protocol 12 · 41ms`
    // (`assets/mockup.html:460`); this asserts the control that produces it exists on the screen.
    const target = await mount(createElement(SettingsScreen))
    const addRemote = byLabel(target, 'add remote')
    await act(async () => {
      ;(addRemote.props['onPress'] as () => void)()
    })
    expect(byLabel(target, 'test connection')).toBeTruthy()
  })
})
