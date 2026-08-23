// Not from orca. The one suite that mounts the *whole* junction — `app/_layout.tsx` →
// `modules/herdr-ssh`'s dial → `src/api/herdr-data-provider.tsx` → a list screen — with a remote
// that is configured and unreachable, which is the state a real phone is in the moment a key is
// wrong or a host has moved.
//
// Why it exists: until this landed, that state rendered `src/api/mock/mock-fixture.ts` — 4 nodes and
// 40 agents named claude/codex/build/shell/tail — permanently and silently, because
// `useHerdrSshConnections` dropped the dial's failures and an empty connection list means "nothing
// configured" as much as it means "nothing answered". So the assertions below are deliberately
// about the *fixture's own vocabulary*: if the fallback ever comes back, `claude` reappears and this
// file fails, whereas an assertion about the error message alone would still pass while the screen
// filled up with invented agents.
//
// The mocks here are the transport's environment, never the code under test: `expo-constants`
// supplies the build-time remote list the app really reads, `expo-modules-core` supplies (or
// withholds) the native module, and everything from `parseConfiguredRemotes` down runs for real.
import { Children, createElement, isValidElement, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mono } from '../theme/monotone'

const routerState = vi.hoisted(() => ({
  screens: {} as Record<string, ReactNode>,
  pathname: '/',
  pushed: [] as string[]
}))

/** What the build is configured with, and what its native module does. Rewritten per test. */
const environment = vi.hoisted(() => ({
  remotes: [] as unknown[],
  /** `null` = a build with no `HerdrSsh` at all (Expo Go), which is its own failure cause. */
  native: null as { connect: (config: unknown) => Promise<unknown> } | null
}))

vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      extra: {
        // A getter, not a value: `vi.mock`'s factory runs once, and each test rewrites `environment`
        // before mounting. `app-connections.ts` re-reads `extra.herdrRemotes` on every dial, so the
        // getter is what makes that re-read see the current test's config.
        get herdrRemotes() {
          return environment.remotes
        }
      }
    }
  }
}))

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => environment.native
}))

// The retryable failures below arm `../../modules/herdr-ssh/src/dial-loop.ts`'s ladder, and its
// first armed rung is what makes it load `../transport/app-foreground.ts` — which reaches
// `expo-network` through `../transport/connection-revival-triggers.ts`. Stubbed so the OS half is
// inert rather than half-real: the ladder's own behaviour is `./failed-dial-redial-mount.test.tsx`'s
// subject, and this file is about what the *screen* says.
vi.mock('expo-network', () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: true, type: 'WIFI' })
}))

vi.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: vi.fn(async () => true),
  hideAsync: vi.fn(async () => true)
}))
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
    useGlobalSearchParams: () => ({}),
    useLocalSearchParams: () => ({})
  }
})

const storage = vi.hoisted(() => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => {})
}))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }))

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
  return {
    Animated: {
      Value: AnimatedValue,
      View: 'AnimatedView',
      loop: () => ({ start() {}, stop() {} }),
      timing: () => ({ start() {}, stop() {} })
    },
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
    Easing: { linear: 'linear' },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
    Text: 'Text',
    View: 'View',
    useWindowDimensions: () => ({ width: 390, height: 844 })
  }
})

const { default: RootLayout } = await import('../../app/_layout')
const { default: AgentsHomeScreen } = await import('../../app/index')
const { default: NodeListScreen } = await import('../../app/nodes')
const { openConfiguredSshConnections } = await import('../../modules/herdr-ssh')

function host(name: string): ElementType {
  return name as unknown as ElementType
}

/** A remote that parses cleanly — so whatever fails below is the *dial*, not the config. */
function configuredRemote(id: string, host_: string): Record<string, unknown> {
  return {
    id,
    name: id,
    host: host_,
    username: 'z',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-key\n-----END OPENSSH PRIVATE KEY-----',
    // Otherwise `assertHostKeyPolicy` rejects before `connect` is ever called
    // (`modules/herdr-ssh/src/ssh-transport.ts`), and the test would prove the wrong failure.
    allowUnknownHostKey: true
  }
}

let renderer: ReactTestRenderer | null = null

/** Mounts the real shell and lets the real dial finish — see `./route-shell-mount.test.tsx`. */
async function mountShell(screen: ReactNode, name: string): Promise<ReactTestRenderer> {
  routerState.screens = { [name]: screen }
  let created: ReactTestRenderer | null = null
  await act(async () => {
    created = create(createElement(RootLayout))
  })
  await act(async () => {
    await openConfiguredSshConnections()
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
        .map((child) =>
          typeof child === 'string' || typeof child === 'number' ? String(child) : ''
        )
        .join('')
    )
    .filter((text) => text.length > 0)
}

/** Every agent name the fixture can produce (`../api/mock/mock-fixture.ts`). */
const MOCK_AGENT_NAMES = ['claude', 'codex', 'build', 'shell', 'tail']

function mockLeakedInto(texts: string[]): string[] {
  return texts.filter(
    (text) => MOCK_AGENT_NAMES.includes(text) || text.includes('fable-m5max') || text === 'iq-64'
  )
}

beforeEach(() => {
  routerState.screens = {}
  routerState.pathname = '/'
  routerState.pushed = []
  environment.remotes = []
  environment.native = null
})

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
})

describe('a configured remote that cannot be dialled', () => {
  it('renders no mock agent — the fixture is not what a failed dial means', async () => {
    environment.remotes = [configuredRemote('lab', 'lab.invalid')]
    environment.native = {
      connect: () => Promise.reject(new Error('Permission denied (publickey)'))
    }
    const texts = textNodes(await mountShell(createElement(AgentsHomeScreen), 'index'))

    // The load-bearing assertion. `claude` is a name only `../api/mock/mock-fixture.ts` produces.
    expect(mockLeakedInto(texts)).toEqual([])
    // ...and the screen is not silently empty either: it says which remote failed, and why.
    //
    // No `Retrying…` here, and that is the point of using a refused key for this case:
    // `../transport/channel-failure.ts` calls it fatal, so `../../modules/herdr-ssh/src/dial-loop.ts`
    // latches instead of arming a rung, and a message promising a retry that is not coming would be
    // the same class of lie as the fixture. `./failed-dial-redial-mount.test.tsx` is the retryable
    // half.
    const failure = texts.find((text) => text.startsWith('No configured remote could be reached'))
    expect(failure).toBe(
      'No configured remote could be reached — lab: Permission denied (publickey)'
    )
  })

  it('names every remote that failed, not just the first', async () => {
    environment.remotes = [
      configuredRemote('lab', 'lab.invalid'),
      configuredRemote('iq-64', 'iq-64.invalid')
    ]
    environment.native = { connect: () => Promise.reject(new Error('Connection refused')) }
    const texts = textNodes(await mountShell(createElement(AgentsHomeScreen), 'index'))

    expect(mockLeakedInto(texts)).toEqual([])
    // A refused TCP connection *is* retryable, so the sentence ends with the ladder's promise —
    // `·` stays the separator between remotes and the suffix is a sentence of its own.
    expect(texts).toContain(
      'No configured remote could be reached — lab: Connection refused · iq-64: Connection refused. Retrying…'
    )
  })

  it('reports a missing native module as its own cause, not as a failed key', async () => {
    environment.remotes = [configuredRemote('lab', 'lab.invalid')]
    environment.native = null
    const texts = textNodes(await mountShell(createElement(AgentsHomeScreen), 'index'))

    expect(mockLeakedInto(texts)).toEqual([])
    // The fix is a different build, not a different key, so the message must not send the user to
    // their `authorized_keys` — and `lab: no HerdrSsh native module in this build` (which *is* in
    // `failures`) reads exactly like a per-remote auth problem.
    expect(texts).toContain(
      'No ssh module in this build — a configured remote cannot be dialled from Expo Go. Use a dev build.'
    )
    expect(
      texts.filter((text) => text.startsWith('No configured remote could be reached'))
    ).toEqual([])
  })

  it('renders that error legibly on the node list too, at the top of the ramp', async () => {
    environment.remotes = [configuredRemote('lab', 'lab.invalid')]
    environment.native = { connect: () => Promise.reject(new Error('Host is down')) }
    const target = await mountShell(createElement(NodeListScreen), 'nodes')

    expect(textNodes(target)).toContain(
      'No configured remote could be reached — lab: Host is down. Retrying…'
    )
    const style = target.root
      .findAllByType(host('Text'))
      .find((node) => String(node.props.children).startsWith('No configured remote'))!.props
      .style as Record<string, unknown>
    // Not `dim`, which is what it borrowed the row-subtitle style for before: on a screen whose only
    // content is this line, this line is the emphasis. Still grayscale (`../theme/monotone.ts`).
    expect(style['color']).toBe(mono.fg)
    expect(style['paddingHorizontal']).toBe(16)
  })
})

describe('no remote configured', () => {
  it('still renders the fixture — the development and demo path is unchanged', async () => {
    environment.remotes = []
    const texts = textNodes(await mountShell(createElement(AgentsHomeScreen), 'index'))

    // Port map §5 keeps the mock alive on purpose; an empty config is not a failure to report.
    expect(texts).toContain('claude')
    expect(texts.filter((text) => text.startsWith('No configured remote'))).toEqual([])
    expect(texts.filter((text) => text.startsWith('No ssh module'))).toEqual([])
  })

  it('does not flash the fixture while a dial is still in flight', async () => {
    environment.remotes = [configuredRemote('lab', 'lab.invalid')]
    // A host that accepts the TCP connection and then says nothing — the case `connectTimeoutMs`
    // exists for, 20s by default (`modules/herdr-ssh/src/remote-config.ts`). The dial has not
    // settled, so nothing is known yet, *including* whether any remote was configured.
    environment.native = { connect: () => new Promise<never>(() => {}) }
    routerState.screens = { index: createElement(AgentsHomeScreen) }
    let created: ReactTestRenderer | null = null
    await act(async () => {
      created = create(createElement(RootLayout))
    })
    renderer = created
    const texts = textNodes(created!)

    // 20 seconds of a plausible fake fleet is the same defect with a timer on it: the user reads it
    // as real long before it is replaced. A spinner cannot be misread as a fleet.
    expect(mockLeakedInto(texts)).toEqual([])
    expect(texts).toContain('Loading…')
  })
})
