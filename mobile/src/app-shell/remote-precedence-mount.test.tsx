// Not from orca. The junction test for M2b: with a remote in the keystore *and* a remote in
// `app.json`, which host does the phone actually dial?
//
// It mounts the same real stack `failed-dial-mount.test.tsx` does — `app/_layout.tsx` ->
// `modules/herdr-ssh`'s dial -> `src/api/herdr-data-provider.tsx` -> a list screen — and asserts on
// the config that reached the native `connect`, because that is the only place the answer is
// unambiguous. Before M2b there was one source and it was the app bundle; the whole milestone is
// that the bundle becomes a development convenience the keystore overrides.
import { Children, createElement, isValidElement, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const routerState = vi.hoisted(() => ({
  screens: {} as Record<string, ReactNode>,
  pushed: [] as string[]
}))

const environment = vi.hoisted(() => ({
  /** `app.json`'s `expo.extra.herdrRemotes` — the build-time channel. */
  bundled: [] as unknown[],
  dialled: [] as { host: string; privateKey: string }[]
}))

const keychain = vi.hoisted(() => new Map<string, string>())
const prefs = vi.hoisted(() => new Map<string, string>())

vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      extra: {
        get herdrRemotes() {
          return environment.bundled
        }
      }
    }
  }
}))

vi.mock('expo-secure-store', () => ({
  getItemAsync: (key: string) => Promise.resolve(keychain.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    keychain.set(key, value)
    return Promise.resolve()
  },
  deleteItemAsync: (key: string) => {
    keychain.delete(key)
    return Promise.resolve()
  },
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly'
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: (key: string) => Promise.resolve(prefs.get(key) ?? null),
    setItem: (key: string, value: string) => {
      prefs.set(key, value)
      return Promise.resolve()
    }
  }
}))

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => ({
    connect: (config: { host: string; privateKey: string }) => {
      environment.dialled.push({ host: config.host, privateKey: config.privateKey })
      return Promise.reject(new Error('Permission denied (publickey)'))
    }
  })
}))

vi.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: vi.fn(async () => true),
  hideAsync: vi.fn(async () => true)
}))

// `_layout.tsx` loads the mockup's JetBrains Mono through expo-font, which drags expo-modules-core
// (and its `__DEV__`) into a plain Vitest process. The faces are irrelevant to what these tests
// assert, so the loader is reported as already settled.
vi.mock('@expo-google-fonts/jetbrains-mono', () => ({
  useFonts: () => [true, null],
  JetBrainsMono_400Regular: 'JetBrainsMono_400Regular',
  JetBrainsMono_700Bold: 'JetBrainsMono_700Bold'
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
    usePathname: () => '/',
    useGlobalSearchParams: () => ({}),
    useLocalSearchParams: () => ({})
  }
})

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
    TextInput: 'TextInput',
    View: 'View',
    useWindowDimensions: () => ({ width: 390, height: 844 })
  }
})

const { default: RootLayout } = await import('../../app/_layout')
const { default: AgentsHomeScreen } = await import('../../app/index')
const { openConfiguredSshConnections } = await import('../../modules/herdr-ssh')
const { saveStoredRemote } = await import('../../modules/herdr-ssh/src/remote-store')

const BUNDLED_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nYnVuZGxlZA==\n-----END OPENSSH PRIVATE KEY-----\n'
const STORED_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nc3RvcmVk\n-----END OPENSSH PRIVATE KEY-----\n'

function bundledRemote(id: string, host: string): Record<string, unknown> {
  return { id, name: id, host, username: 'z', privateKey: BUNDLED_KEY, allowUnknownHostKey: true }
}

function host(name: string): ElementType {
  return name as unknown as ElementType
}

let renderer: ReactTestRenderer | null = null

async function mountShell(): Promise<ReactTestRenderer> {
  routerState.screens = { index: createElement(AgentsHomeScreen) }
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

/**
 * Unique hosts, because `mountShell` dials twice on purpose — once through the mounted layout and
 * once directly, which is `failed-dial-mount.test.tsx`'s way of flushing the effect inside `act`.
 * Which hosts were dialled is the question here; how many times is that harness's business.
 */
function dialledHosts(): string[] {
  return [...new Set(environment.dialled.map((entry) => entry.host))]
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

beforeEach(() => {
  routerState.screens = {}
  routerState.pushed = []
  environment.bundled = []
  environment.dialled = []
  keychain.clear()
  prefs.clear()
  // Not a fresh install: the fresh-install purge is `remote-store.test.ts`'s subject, and without
  // this marker it would wipe the very entry these tests are about.
  prefs.set('herdr:secureStoreInstalledAt', '2026-08-23T00:00:00.000Z')
})

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
})

describe('a remote in the keystore', () => {
  it('is dialled instead of the one baked into app.json', async () => {
    environment.bundled = [bundledRemote('lab', 'lab.invalid')]
    await saveStoredRemote({
      id: 'mine',
      name: 'mine',
      host: 'mine.invalid',
      port: 22,
      username: 'z',
      privateKey: STORED_KEY,
      allowUnknownHostKey: true,
      connectTimeoutMs: 20_000,
      keepaliveIntervalMs: 15_000
    })

    const texts = textNodes(await mountShell())

    expect(dialledHosts()).toEqual(['mine.invalid'])
    expect(environment.dialled[0]?.privateKey).toBe(STORED_KEY)
    expect(texts).toContain(
      'No configured remote could be reached — mine: Permission denied (publickey)'
    )
    // Whatever else the screen says, it does not say this.
    expect(texts.filter((text) => text.includes('OPENSSH'))).toEqual([])
  })

  it('is reachable from the home screen, or it may as well not exist', async () => {
    const target = await mountShell()
    const entry = target.root.findAll(
      (node) => node.props['accessibilityLabel'] === 'settings' && !!node.props['onPress']
    )[0]
    expect(entry, 'no settings affordance on the agents home').toBeDefined()

    await act(async () => {
      ;(entry!.props['onPress'] as () => void)()
    })

    expect(routerState.pushed).toEqual(['/settings'])
  })

  it('marks the fixture as demo data once "nothing configured" is a user state', async () => {
    // Nothing in either channel — which, now that a user can add a remote from the phone, is the
    // state of every fresh install rather than of a half-configured dev build. The fixture still
    // renders (port map §5 keeps the demo path alive) and now says what it is.
    const texts = textNodes(await mountShell())

    expect(texts).toContain('demo data')
    expect(texts).toContain('claude')
  })

  it('does not call a failed dial demo data', async () => {
    environment.bundled = [bundledRemote('lab', 'lab.invalid')]

    const texts = textNodes(await mountShell())

    expect(texts).not.toContain('demo data')
    expect(texts.some((text) => text.startsWith('No configured remote could be reached'))).toBe(
      true
    )
  })

  it('leaves app.json as the development fallback when the keystore is empty', async () => {
    environment.bundled = [bundledRemote('lab', 'lab.invalid')]

    await mountShell()

    expect(dialledHosts()).toEqual(['lab.invalid'])
  })
})
