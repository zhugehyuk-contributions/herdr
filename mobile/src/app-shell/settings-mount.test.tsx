// Not from orca (orca's `app/settings.tsx` is graded `copy` in the port map, but it is a settings
// *shell* over orca's host store, and herdr's store is a keychain full of ssh keys). This is the
// screen M2b exists for, mounted for real over a fake keystore, and the assertions are the two
// halves of the milestone's "됐다": a remote can be added from the phone, and its key is never on
// the glass.
import { Children, createElement, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mono } from '../theme/monotone'

const keychain = vi.hoisted(() => new Map<string, string>())
const environment = vi.hoisted(() => ({ bundled: [] as unknown[], secureStore: true }))

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
  getItemAsync: (key: string) =>
    environment.secureStore
      ? Promise.resolve(keychain.get(key) ?? null)
      : Promise.reject(new Error('no keystore')),
  setItemAsync: (key: string, value: string) => {
    if (!environment.secureStore) {
      return Promise.reject(new Error('no keystore'))
    }
    keychain.set(key, value)
    return Promise.resolve()
  },
  deleteItemAsync: (key: string) => {
    keychain.delete(key)
    return Promise.resolve()
  },
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly'
}))

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: () => {}, back: () => {} })
}))

// The screens read the real safe-area inset since §D1. Its provider comes from the navigator on a
// device, and the navigator is mocked away here — so is the library, which does not load under
// this environment's transform at all. Zero insets = the geometry every assertion below was
// written against; the last describe in this file is the one that turns them on, and
// `./safe-area-mount.test.tsx` covers the four screens that draw their own top bar.
const safeArea = vi.hoisted(() => ({ insets: { top: 0, bottom: 0, left: 0, right: 0 } }))

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => safeArea.insets
}))

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

const { default: SettingsScreen } = await import('../../app/settings')
const { loadStoredRemotes, saveStoredRemote } =
  await import('../../modules/herdr-ssh/src/remote-store')

const KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----\n'

function host(name: string): ElementType {
  return name as unknown as ElementType
}

let renderer: ReactTestRenderer | null = null

async function mount(): Promise<ReactTestRenderer> {
  let created: ReactTestRenderer | null = null
  await act(async () => {
    created = create(createElement(SettingsScreen))
  })
  if (!created) {
    throw new Error('SettingsScreen did not render')
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

/** Every string this render put anywhere — text, placeholders, values, labels. */
function everyRenderedString(target: ReactTestRenderer): string[] {
  const out: string[] = []
  for (const node of target.root.findAll(() => true)) {
    for (const value of Object.values(node.props as Record<string, unknown>)) {
      if (typeof value === 'string') {
        out.push(value)
      }
    }
  }
  return [...out, ...textNodes(target)]
}

function press(target: ReactTestRenderer, label: string): Promise<void> {
  const node = target.root.findAll(
    (candidate) => candidate.props['accessibilityLabel'] === label && !!candidate.props['onPress']
  )[0]
  if (!node) {
    throw new Error(
      `no pressable labelled "${label}" (have: ${pressableLabels(target).join(', ')})`
    )
  }
  return act(async () => {
    ;(node.props['onPress'] as () => void)()
  })
}

function pressableLabels(target: ReactTestRenderer): string[] {
  return target.root
    .findAll((candidate) => !!candidate.props['onPress'])
    .map((candidate) => String(candidate.props['accessibilityLabel']))
}

function type(target: ReactTestRenderer, label: string, text: string): Promise<void> {
  const node = target.root.findAll(
    (candidate) =>
      candidate.props['accessibilityLabel'] === label && !!candidate.props['onChangeText']
  )[0]
  if (!node) {
    throw new Error(`no field labelled "${label}"`)
  }
  return act(async () => {
    ;(node.props['onChangeText'] as (value: string) => void)(text)
  })
}

async function fillValidRemote(target: ReactTestRenderer): Promise<void> {
  await press(target, 'add remote')
  await type(target, 'id', 'fable')
  await type(target, 'host', '192.168.50.10')
  await type(target, 'username', 'z')
  await type(target, 'private key', KEY)
}

beforeEach(() => {
  safeArea.insets = { top: 0, bottom: 0, left: 0, right: 0 }
  keychain.clear()
  environment.bundled = []
  environment.secureStore = true
})

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
})

describe('adding a remote from the phone', () => {
  it('writes it to the keystore and lists it, with no rebuild', async () => {
    const target = await mount()
    await fillValidRemote(target)
    await press(target, 'save remote')

    const { remotes } = await loadStoredRemotes()
    expect(remotes.map((remote) => remote.host)).toEqual(['192.168.50.10'])
    expect(remotes[0]?.privateKey).toBe(KEY)
    expect(textNodes(target)).toContain('z@192.168.50.10:22')
  })

  it('never renders the key it just stored — not as text, not as an input value', async () => {
    const target = await mount()
    await fillValidRemote(target)
    await press(target, 'save remote')

    expect(everyRenderedString(target).filter((text) => text.includes('OPENSSH'))).toEqual([])
    // What it says instead is what the key *is* — enough to recognise it, useless to steal.
    expect(textNodes(target).some((text) => text.startsWith('key · '))).toBe(true)
  })

  it('reports a bad field instead of storing a half-remote', async () => {
    const target = await mount()
    await press(target, 'add remote')
    await type(target, 'host', 'box.example')
    await press(target, 'save remote')

    expect((await loadStoredRemotes()).remotes).toEqual([])
    const texts = textNodes(target)
    expect(texts.some((text) => text.startsWith('id ·'))).toBe(true)
    expect(texts.some((text) => text.startsWith('private key ·'))).toBe(true)
  })

  it('warns that iOS will refuse a key Android accepts', async () => {
    const target = await mount()
    await press(target, 'add remote')
    await type(
      target,
      'private key',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----\n'
    )

    const advisory = textNodes(target).find((text) => text.includes('iOS'))
    expect(advisory, 'no iOS advisory for a classic-PEM key').toBeDefined()
    expect(advisory).toContain('openssh-key-v1')
  })
})

describe('editing and deleting', () => {
  it('edits a remote without ever putting its key in the form', async () => {
    await saveStoredRemote({
      id: 'fable',
      name: 'fable-m5max',
      host: '192.168.50.10',
      port: 22,
      username: 'z',
      privateKey: KEY,
      connectTimeoutMs: 20_000,
      keepaliveIntervalMs: 15_000
    })
    const target = await mount()
    await press(target, 'edit fable')

    expect(everyRenderedString(target).filter((text) => text.includes('OPENSSH'))).toEqual([])

    // The id names the keystore entry, so it is not editable in place — a save that changed it
    // would look for a remote that does not exist.
    const idField = target.root.findAll(
      (node) => node.props['accessibilityLabel'] === 'id' && !!node.props['onChangeText']
    )[0]
    expect(idField?.props['editable']).toBe(false)

    await type(target, 'host', '10.0.0.9')
    await press(target, 'save remote')

    const { remotes } = await loadStoredRemotes()
    expect(remotes[0]?.host).toBe('10.0.0.9')
    // The edit did not have the key, so the store had to be the one that kept it.
    expect(remotes[0]?.privateKey).toBe(KEY)
  })

  it('deletes only after a confirmation, because a key cannot be recovered', async () => {
    await saveStoredRemote({
      id: 'fable',
      host: '192.168.50.10',
      port: 22,
      username: 'z',
      privateKey: KEY,
      connectTimeoutMs: 20_000,
      keepaliveIntervalMs: 15_000
    })
    const target = await mount()
    await press(target, 'delete fable')

    expect((await loadStoredRemotes()).remotes).toHaveLength(1)

    await press(target, 'confirm delete fable')

    expect((await loadStoredRemotes()).remotes).toEqual([])
    expect([...keychain.values()].some((value) => value.includes('OPENSSH'))).toBe(false)
  })
})

describe('what the screen says about push', () => {
  it('states that only blocked is pushed, before anyone has to discover it', async () => {
    // M5's design constraint, on the glass. `done` is `(Idle, seen == false)`
    // (`src/app/api_helpers.rs:104-107`) and `seen` flips when the *desktop* shows the pane, so a
    // `done` push fires for work the user already watched end. A user who is not told this
    // concludes the feature is broken the first time an agent finishes quietly.
    const target = await mount()
    const strings = everyRenderedString(target).join(' ')
    expect(strings).toContain('Only blocked is pushed')
    expect(strings).toContain('The agents list is what tells you about everything else')
  })

  it('has a slot for the registration state, so a push that never arrives is not silent', async () => {
    // Without a line here, "no notification arrived" and "nothing was blocked" look identical, and
    // one of them is the normal state — which is exactly what makes the other one invisible.
    //
    // This mount has no `BlockedPushProvider` above it (the shell installs one, `app/_layout.tsx`),
    // so the state read here is the context default. What the *other* states say is
    // `src/notifications/blocked-push-summary.test.ts`; what is asserted here is that the screen
    // renders whatever that says, under a heading the user can find.
    const target = await mount()
    expect(textNodes(target)).toContain('push')
    expect(textNodes(target)).toContain('checking…')
  })
})

describe('what the screen says about the build it is running in', () => {
  it('shows an app.json remote as a development entry it will not edit', async () => {
    environment.bundled = [
      { id: 'lab', name: 'lab', host: 'lab.invalid', username: 'z', privateKey: KEY }
    ]
    const target = await mount()

    const texts = textNodes(target)
    expect(texts).toContain('lab')
    expect(texts.some((text) => text.includes('app.json'))).toBe(true)
    expect(pressableLabels(target)).not.toContain('edit lab')
    expect(pressableLabels(target)).not.toContain('delete lab')
    expect(everyRenderedString(target).filter((text) => text.includes('OPENSSH'))).toEqual([])
  })

  it('says so when the build has no keystore, instead of failing on save', async () => {
    environment.secureStore = false
    const target = await mount()

    expect(textNodes(target).some((text) => text.includes('secure storage'))).toBe(true)
  })

  it('stays on the grayscale ramp', async () => {
    await saveStoredRemote({
      id: 'fable',
      host: '192.168.50.10',
      port: 22,
      username: 'z',
      privateKey: KEY,
      connectTimeoutMs: 20_000,
      keepaliveIntervalMs: 15_000
    })
    const target = await mount()
    await press(target, 'add remote')

    const ramp = new Set<string>([...Object.values(mono), 'transparent'])
    const used = target.root
      .findAll(() => true)
      .flatMap((node) => [node.props.style].flat(3))
      .filter(
        (style): style is Record<string, unknown> => typeof style === 'object' && style !== null
      )
      .flatMap((style) =>
        ['backgroundColor', 'borderColor', 'borderTopColor', 'borderBottomColor', 'color']
          .map((key) => style[key])
          .filter((value): value is string => typeof value === 'string')
      )
    expect(used.length).toBeGreaterThan(0)
    for (const color of used) {
      expect(ramp, `settings used ${color}`).toContain(color)
    }
  })
})

// The screen §D1 does *not* touch at the top, and why that is a decision rather than an omission.
describe('settings and the safe area', () => {
  const IPHONE_PORTRAIT = { top: 59, bottom: 34, left: 0, right: 0 }

  it('does not count the top inset a second time under its native header', async () => {
    safeArea.insets = IPHONE_PORTRAIT
    const target = await mount()

    // `app/_layout.tsx` gives this route a real header (`options={{ title: 'settings' }}`), and a
    // native header already sits below the inset — so the bar under it keeps the 24 it was drawn
    // with. Taking the inset here would push the screen's own content 59pt down for nothing.
    const logo = target.root.findAllByType(host('Text'))[0]
    expect(logo, 'the settings appbar rendered no label').toBeDefined()
    const bar = logo!.parent
    expect(bar, 'the settings appbar was not found').not.toBeNull()
    expect((bar!.props['style'] as Record<string, unknown>)['paddingTop']).toBe(24)
  })

  it('ends its scroll content above the home indicator', async () => {
    safeArea.insets = IPHONE_PORTRAIT
    const target = await mount()

    // No bottom bar on this route: the list runs into the indicator itself.
    const body = target.root.findByType(host('ScrollView'))
    expect((body.props.contentContainerStyle as Record<string, unknown>)['paddingBottom']).toBe(
      IPHONE_PORTRAIT.bottom
    )
  })
})
