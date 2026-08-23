// Not from orca. This is .prd/09-review-followups.md §D1 as a test: on iOS the `settings` button
// rendered at y=31.7 under a ~59pt Dynamic Island, taps were delivered and navigated nowhere, and
// rotating to landscape (status bar hidden) made the same tap work. The defect was never in the
// button — it was that the four screens with no native header padded their top bar by a hardcoded
// 24, which is the Android status-bar height, so the whole class was invisible on the platform QA
// had run.
//
// Why a mount and not a style-object assertion: the bug is *distance from the window edge*, which
// is a property of the whole ancestor chain, not of one StyleSheet entry. `edgePadding` below sums
// the padding every ancestor contributes, which is the same number XCUITest measured as the
// button's frame origin. A test that read `styles.appbar.paddingTop` would pass on the app that
// has the bug, because the number in it (24) was never wrong on Android.
//
// The inset is mocked at the library boundary rather than by rendering a `SafeAreaProvider`: on a
// device the provider comes from the navigator, not from this app's own tree
// (`@react-navigation/native-stack`'s `NativeStackView.native.js:371` wraps every route in
// `SafeAreaProviderCompat`, and expo-router's `Stack` is that navigator —
// `expo-router/build/layouts/StackClient.js:42`), and expo-router is mocked out here.
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
/** The same phone rotated: the status bar is hidden, so the top inset goes away entirely. */
const IPHONE_LANDSCAPE = { top: 0, bottom: 21, left: 59, right: 59 }
/** A phone under edge-to-edge (`android/gradle.properties:47`) with three-button navigation. */
const ANDROID = { top: 24, bottom: 48, left: 0, right: 0 }

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
const { default: AgentsHomeScreen } = await import('../../app/index')
const { default: NodeListScreen } = await import('../../app/nodes')
const { RemoteScreen } = await import('../../app/h/[remoteId]/index')
const { PaneViewerScreen } = await import('../../app/h/[remoteId]/pane/[paneId]')

const NO_CONNECTIONS: readonly HerdrRemoteConnection[] = []

function host(name: string): ElementType {
  return name as unknown as ElementType
}

/** A `style` prop as rendered — object, array, or nested arrays — collapsed into one object. */
function flatten(style: unknown): Record<string, unknown> {
  const layers = ([style].flat(4) as unknown[]).filter(
    (layer): layer is Record<string, unknown> => typeof layer === 'object' && layer !== null
  )
  return Object.assign({}, ...layers) as Record<string, unknown>
}

/**
 * How far `node`'s own edge sits from the window's, in points — every ancestor's padding on that
 * edge, summed. This is the quantity XCUITest reported as the `settings` button's frame origin
 * (`{{314.3, 31.7},…}`), and the one that has to clear the inset.
 *
 * The node's own padding is deliberately excluded: it insets the node's *content*, not the node,
 * and a button whose frame is under the Dynamic Island is unreachable no matter how it is padded
 * inside.
 */
function edgePadding(node: ReactTestInstance, edge: 'Top' | 'Bottom'): number {
  let total = 0
  let cursor: ReactTestInstance | null = node.parent
  while (cursor) {
    const style = flatten(cursor.props['style'])
    const padding = style[`padding${edge}`] ?? style['paddingVertical']
    if (typeof padding === 'number') {
      total += padding
    }
    cursor = cursor.parent
  }
  return total
}

/** The first thing the screen draws — its top bar's leading label. */
function firstText(target: ReactTestRenderer): ReactTestInstance {
  const node = target.root.findAllByType(host('Text'))[0]
  if (!node) {
    throw new Error('the screen rendered no text at all')
  }
  return node
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

/** Every screen that draws its own top bar — i.e. every route with `headerShown: false`. */
const TOP_BAR_SCREENS: readonly [string, () => ReactNode][] = [
  ['Agents home', () => createElement(AgentsHomeScreen)],
  ['node list', () => createElement(NodeListScreen)],
  ['workspace browser', () => createElement(RemoteScreen, { remoteId: 'remote-1' })],
  [
    'pane viewer',
    () => createElement(PaneViewerScreen, { remoteId: 'remote-1', paneId: 'ws-1-p1' })
  ]
]

/** The two screens whose bottom edge is a pinned bar, and the label that bar puts on it. */
const BOTTOM_BAR_SCREENS: readonly [string, () => ReactNode, string][] = [
  ['Agents home', () => createElement(AgentsHomeScreen), 'agents tab'],
  ['node list', () => createElement(NodeListScreen), 'nodes tab'],
  [
    'pane viewer',
    () => createElement(PaneViewerScreen, { remoteId: 'remote-1', paneId: 'ws-1-p1' }),
    'Send input'
  ]
]

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

describe('top bars clear the status bar / Dynamic Island', () => {
  it.each(TOP_BAR_SCREENS)('%s starts below the top inset on iPhone', async (_name, screen) => {
    const target = await mount(screen())
    expect(edgePadding(firstText(target), 'Top')).toBeGreaterThanOrEqual(IPHONE_PORTRAIT.top)
  })

  it.each([
    ['Agents home', () => createElement(AgentsHomeScreen)],
    ['node list', () => createElement(NodeListScreen)]
  ])('%s puts the settings button where it can be tapped', async (_name, screen) => {
    const target = await mount(screen())
    // The measured defect, in one number: 31.7 < 59 meant every tap landed on the status bar.
    expect(edgePadding(byLabel(target, 'settings'), 'Top')).toBeGreaterThanOrEqual(
      IPHONE_PORTRAIT.top
    )
  })

  it.each(TOP_BAR_SCREENS)('%s keeps its own spacing in landscape', async (_name, screen) => {
    // The orientation that already worked. With no status bar there is no inset to clear, and a
    // bar padded by the raw inset would jump to the very top edge — this is what pins the floor.
    safeArea.insets = IPHONE_LANDSCAPE
    const target = await mount(screen())
    expect(edgePadding(firstText(target), 'Top')).toBeGreaterThanOrEqual(16)
  })

  it.each([
    ['Agents home', () => createElement(AgentsHomeScreen)],
    ['node list', () => createElement(NodeListScreen)]
  ])('%s renders unchanged on Android', async (_name, screen) => {
    // 24 was the Android status-bar height all along, and edge-to-edge reports exactly that as the
    // inset — so the fix has to be a no-op here, to the point.
    safeArea.insets = ANDROID
    const target = await mount(screen())
    expect(edgePadding(firstText(target), 'Top')).toBe(24)
  })
})

describe('bottom bars clear the home indicator', () => {
  it.each(BOTTOM_BAR_SCREENS)('%s lifts its bar above the inset', async (_name, screen, label) => {
    const target = await mount(screen())
    expect(edgePadding(byLabel(target, label), 'Bottom')).toBeGreaterThanOrEqual(
      IPHONE_PORTRAIT.bottom
    )
  })

  it('the workspace browser ends its list above the indicator, having no bar', async () => {
    // The one screen of the four with nothing pinned to its bottom edge: the scroll content runs
    // into the home indicator itself, so the padding has to be on the content.
    const target = await mount(createElement(RemoteScreen, { remoteId: 'remote-1' }))
    const list = target.root.findByType(host('ScrollView'))
    expect((list.props.contentContainerStyle as Record<string, unknown>)['paddingBottom']).toBe(
      IPHONE_PORTRAIT.bottom
    )
  })

  it.each(BOTTOM_BAR_SCREENS)(
    '%s lifts it above the Android navigation bar too',
    async (_name, screen, label) => {
      // Same class, and it was live on Android as well: edge-to-edge draws the app under the
      // navigation bar, so the tab strip has been sitting behind it since it landed.
      safeArea.insets = ANDROID
      const target = await mount(screen())
      expect(edgePadding(byLabel(target, label), 'Bottom')).toBeGreaterThanOrEqual(ANDROID.bottom)
    }
  )
})
