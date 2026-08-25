// Not from orca as a file, but it is the receipt for the one thing orca's `app/_layout.tsx`
// `:73-150` did that this repo's port deliberately left out: **a tapped push notification has to
// land on the pane that is asking.** `app/_layout.tsx`'s header records the omission ("notification
// tap routing — `src/notifications/*` is `port(M5)` … the routing lands with M5"), and until this
// file existed nothing anywhere asserted it.
//
// This is M5's acceptance criterion ("데스크톱을 안 보고 있을 때 blocked 발생 → 폰 알림 → 탭 →
// 해당 pane 도달", `.prd/04-milestones.md:193`) reduced to the half a device is not needed for: the
// notification is delivered to the app's own listener, and the assertion is the route it produced.
//
// What it does NOT prove, and what the QA script in the handoff exists for: that APNs/FCM deliver
// anything, that the OS shows a banner, that a cold start (process not running) replays the tap, or
// that the ssh registration reached a real server. Those are device facts.
import { Children, createElement, isValidElement, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const routerState = vi.hoisted(() => ({
  screens: {} as Record<string, ReactNode>,
  globalParams: {} as Record<string, string | undefined>,
  pathname: '/',
  pushed: [] as string[]
}))

/** The `expo-notifications` surface the app is allowed to use, as a scriptable double. */
const notifications = vi.hoisted(() => {
  type Response = { notification: { request: { content: { data?: Record<string, unknown> } } } }
  return {
    permission: 'granted' as string,
    canAskAgain: true,
    requested: 0,
    token: 'ExponentPushToken[unit-test-token]',
    tokenCalls: 0,
    tokenFailure: null as Error | null,
    handler: null as unknown,
    channels: [] as { id: string }[],
    responseListeners: new Set<(response: Response) => void>(),
    receivedListeners: new Set<(notification: unknown) => void>(),
    /** What `getLastNotificationResponse()` answers — the cold-start path. */
    lastResponse: null as Response | null,
    cleared: 0,
    /** Delivers a tap the way the OS does while the app is running. */
    tap(data: Record<string, unknown>) {
      const response = { notification: { request: { content: { data } } } }
      for (const listener of this.responseListeners) {
        listener(response)
      }
    }
  }
})

vi.mock('expo-notifications', () => ({
  setNotificationHandler: (handler: unknown) => {
    notifications.handler = handler
  },
  getPermissionsAsync: async () => ({
    status: notifications.permission,
    granted: notifications.permission === 'granted',
    canAskAgain: notifications.canAskAgain
  }),
  requestPermissionsAsync: async () => {
    notifications.requested += 1
    return {
      status: notifications.permission,
      granted: notifications.permission === 'granted',
      canAskAgain: notifications.canAskAgain
    }
  },
  getExpoPushTokenAsync: async () => {
    notifications.tokenCalls += 1
    if (notifications.tokenFailure) {
      throw notifications.tokenFailure
    }
    return { type: 'expo', data: notifications.token }
  },
  setNotificationChannelAsync: async (id: string) => {
    notifications.channels.push({ id })
    return null
  },
  addNotificationResponseReceivedListener: (listener: (response: unknown) => void) => {
    const bound = listener as Parameters<typeof notifications.responseListeners.add>[0]
    notifications.responseListeners.add(bound)
    return {
      remove: () => {
        notifications.responseListeners.delete(bound)
      }
    }
  },
  addNotificationReceivedListener: (listener: (notification: unknown) => void) => {
    notifications.receivedListeners.add(listener)
    return {
      remove: () => {
        notifications.receivedListeners.delete(listener)
      }
    }
  },
  getLastNotificationResponse: () => notifications.lastResponse,
  clearLastNotificationResponse: () => {
    notifications.cleared += 1
    notifications.lastResponse = null
  },
  AndroidImportance: { HIGH: 4 }
}))

const splash = vi.hoisted(() => ({
  preventAutoHideAsync: vi.fn(async () => true),
  hideAsync: vi.fn(async () => true)
}))

vi.mock('expo-splash-screen', () => splash)

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
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
    Easing: { linear: 'linear' },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Platform: { OS: 'android' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
    Text: 'Text',
    View: 'View',
    useWindowDimensions: () => ({ width: 390, height: 844 })
  }
})

const { default: RootLayout } = await import('../../app/_layout')

function host(name: string): ElementType {
  return name as unknown as ElementType
}

let renderer: ReactTestRenderer | null = null

/** Mounts the real shell and flushes the dial + the notification effects, as the suites above do. */
async function mountShell(): Promise<ReactTestRenderer> {
  let created: ReactTestRenderer | null = null
  await act(async () => {
    created = create(createElement(RootLayout))
  })
  if (!created) {
    throw new Error('did not render')
  }
  renderer = created
  // The splash hides on navigator layout, and that same callback is what tells the app the router
  // can be navigated. Firing it is what a mounted navigator does on a device.
  await act(async () => {
    const root = created!.root.findAllByType(host('View'))[0]
    const onLayout = root?.props.onLayout as (() => void) | undefined
    onLayout?.()
    await Promise.resolve()
  })
  return created
}

beforeEach(() => {
  routerState.pushed.length = 0
  routerState.screens = {}
  notifications.permission = 'granted'
  notifications.canAskAgain = true
  notifications.requested = 0
  notifications.tokenCalls = 0
  notifications.tokenFailure = null
  notifications.handler = null
  notifications.channels.length = 0
  notifications.responseListeners.clear()
  notifications.receivedListeners.clear()
  notifications.lastResponse = null
  notifications.cleared = 0
})

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
})

describe('M5: a tapped blocked notification reaches the pane', () => {
  it('subscribes to notification responses at all', async () => {
    await mountShell()
    expect(notifications.responseListeners.size).toBe(1)
  })

  it('routes a tap to the pane the record names', async () => {
    await mountShell()

    await act(async () => {
      notifications.tap({
        url: 'herdr:///h/fable/pane/w1%3Ap1',
        remote_id: 'fable',
        pane_id: 'w1:p1',
        status: 'blocked'
      })
      await Promise.resolve()
    })

    expect(routerState.pushed).toEqual(['/h/fable/pane/w1:p1'])
  })

  it('replays a cold-start tap once the navigator exists, then clears it', async () => {
    notifications.lastResponse = {
      notification: {
        request: {
          content: {
            data: { url: 'herdr:///h/oud/pane/w2%3Ap9', remote_id: 'oud', pane_id: 'w2:p9' }
          }
        }
      }
    }

    await mountShell()

    expect(routerState.pushed).toEqual(['/h/oud/pane/w2:p9'])
    // Cleared, or every remount of the shell re-navigates to a pane the user handled days ago.
    expect(notifications.cleared).toBe(1)
  })
})
