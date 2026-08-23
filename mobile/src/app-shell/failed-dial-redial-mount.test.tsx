// Not from orca. `./failed-dial-mount.test.tsx` proved what the screen *says* when a dial fails.
// This proves the app is still trying — which, until `../../modules/herdr-ssh/src/dial-loop.ts`
// landed, it was not.
//
// The defect, measured on an Android device during M4 QA and reproduced 2/2: with the remote
// unreachable at launch and then brought back, the app made **zero** TCP dials over 380s and 221s.
// sshd logged one `Connection from` in each window and it was QA's own `nc -z` probe. All four
// non-force-quit escapes were tried and all four produced zero dials — background→foreground, tab
// switch agents↔nodes, pull-to-refresh, settings and back. `am force-stop` plus a relaunch
// recovered in ten seconds. `.prd/04-milestones.md:175-177` puts the number this fails at zero:
// "강제종료로만 낫는 상태 0건".
//
// The cause was structural rather than local: a remote that failed to dial never entered
// `connections`, and every retry in this app is built per connection (`../transport/
// use-supervised-remotes.ts` supervises what dialled; `../transport/herdr-clients-context.tsx` fans
// the OS revival nudge over supervisors). The one remote that needed retrying was the one nothing
// was watching.
//
// So the assertions below are counts of `connect` calls against a fake clock, plus the two things
// the screen must not do while those calls are happening: render `../api/mock/mock-fixture.ts`
// (that is the "no remote configured" branch, and a remote being retried is configured), or claim
// the app has given up.
import { Children, createElement, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fake-clock'

const routerState = vi.hoisted(() => ({ pathname: '/', pushed: [] as string[] }))

/** What the build is configured with, and what its native module does. Rewritten per test. */
const environment = vi.hoisted(() => ({
  remotes: [] as unknown[],
  native: null as { connect: (config: unknown) => Promise<unknown> } | null
}))

vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      extra: {
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

vi.mock('lucide-react-native', () => ({ ChevronDown: 'ChevronDown', ChevronRight: 'ChevronRight' }))

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: (href: string) => routerState.pushed.push(href) }),
  usePathname: () => routerState.pathname,
  useGlobalSearchParams: () => ({}),
  useLocalSearchParams: () => ({})
}))

const storage = vi.hoisted(() => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => {})
}))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }))

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
  Text: 'Text',
  View: 'View'
}))

const { HerdrClientsProvider } = await import('../transport/herdr-clients-context')
const { HerdrDataProvider } = await import('../api/herdr-data-provider')
const { useHerdrSshConnections } = await import('../../modules/herdr-ssh')
const { default: AgentsHomeScreen } = await import('../../app/index')
type SshDialRetryOptions = Parameters<typeof useHerdrSshConnections>[0]

/**
 * Drains the host's queue without moving the fake clock.
 *
 * `../../test/fake-clock.ts`'s `flushMicrotasks` is not enough here and the reason is worth
 * stating: the real dial path crosses four dynamic `import()`s (the keystore, `expo-constants`,
 * `expo-secure-store`, the native module), and a module load resolves through the runner's own
 * scheduler rather than on a chain of `.then`s. No timer is faked globally in this suite — the
 * loop's clock is a *value* — so a zero-delay `setTimeout` is the host's own scheduler, and one
 * `await` of it is one full round of everything already queued.
 *
 * This is not a wait: the fake clock is the only thing that can make a *rung* come due, and it is
 * never touched here. Draining more rounds than needed costs microseconds and settles nothing that
 * was not already in flight.
 */
async function drain(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * Drains until `done()` holds, or fails the test naming what never happened.
 *
 * Used for the cold first dial only: the depth of that chain is a property of the module runner,
 * not of this app, so asserting a fixed number of rounds would be asserting the runner.
 */
async function drainUntil(done: () => boolean, what: string): Promise<void> {
  for (let round = 0; round < 500; round += 1) {
    // One `act` per round, not one around the loop: React flushes its update queue when an `act`
    // scope *exits*, so a predicate read from inside a single long scope would never see the render
    // it is waiting for.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    if (done()) {
      return
    }
  }
  throw new Error(`the app never reached: ${what}`)
}

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
    allowUnknownHostKey: true
  }
}

/**
 * `app/_layout.tsx`'s composition, minus the navigator.
 *
 * The layout file itself is not mounted because the one thing this suite has to control is the
 * loop's clock, and `app/_layout.tsx` deliberately calls `useHerdrSshConnections()` with no
 * arguments — the injection point is the hook's parameter, and everything between it and the screen
 * (the two providers, the loader choice, the error text) is the real thing.
 */
function Shell({ retry }: { retry: SshDialRetryOptions }) {
  const dial = useHerdrSshConnections(retry)
  return (
    <HerdrClientsProvider connections={dial.connections}>
      <HerdrDataProvider dial={dial}>
        <AgentsHomeScreen />
      </HerdrDataProvider>
    </HerdrClientsProvider>
  )
}

let renderer: ReactTestRenderer | null = null

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

/** One mounted app plus the two OS facts the loop takes by injection. */
function mount() {
  const clock = new FakeClock()
  const foreground = { on: true }
  let nudge: (() => void) | null = null
  const retry: SshDialRetryOptions = {
    timer: clock.timer,
    isForeground: () => foreground.on,
    subscribeRevival: (fire: () => void) => {
      nudge = fire
      return () => {
        nudge = null
      }
    }
  }
  return {
    clock,
    foreground,
    async open(): Promise<ReactTestRenderer> {
      let created: ReactTestRenderer | null = null
      await act(async () => {
        created = create(createElement(Shell, { retry }))
      })
      if (!created) {
        throw new Error('Shell did not render')
      }
      const target = created as ReactTestRenderer
      renderer = target
      // `Loading…` is `../api/herdr-data-provider.tsx`'s `loadWhileDialling`, i.e. exactly "the
      // first dial has not resolved". Every test here configures a remote, so it is always the
      // first thing on screen and its disappearance is the settle signal.
      await drainUntil(() => !textNodes(target).includes('Loading…'), 'the first dial resolving')
      return target
    },
    /** Fires the next armed rung and lets the dial it starts settle. */
    async rung(): Promise<void> {
      await act(async () => {
        clock.runNext()
        await drain()
      })
    },
    async elapse(ms: number): Promise<void> {
      await act(async () => {
        clock.advance(ms)
        await drain()
      })
    },
    /** The OS saying the app came back, or the radio did. */
    async resume(): Promise<void> {
      foreground.on = true
      await act(async () => {
        nudge?.()
        await drain()
      })
    }
  }
}

/** A native module that counts dials and refuses every one of them. */
function refusing(reason = 'Connection refused') {
  const calls: unknown[] = []
  return {
    calls,
    module: {
      connect: (config: unknown) => {
        calls.push(config)
        return Promise.reject(new Error(reason))
      }
    }
  }
}

beforeEach(() => {
  routerState.pathname = '/'
  routerState.pushed = []
  environment.remotes = [configuredRemote('lab', 'lab.invalid')]
  environment.native = null
})

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
})

describe('a remote that was unreachable at mount', () => {
  it('is dialled again on L3’s ladder rather than once and never', async () => {
    const native = refusing()
    environment.native = native.module
    const app = mount()
    await app.open()
    expect(native.calls.length).toBe(1)

    for (let i = 0; i < 8; i += 1) {
      await app.rung()
    }
    // Nine dials where the device made one. The rungs are `../transport/reconnect-policy.ts`'s and
    // nothing in this file restates them.
    expect(native.calls.length).toBe(9)
  })

  it('makes no dial at all while the app is backgrounded', async () => {
    const native = refusing()
    environment.native = native.module
    const app = mount()
    await app.open()
    expect(native.calls.length).toBe(1)

    app.foreground.on = false
    await app.elapse(30 * 60_000)
    // The 30-minute background window M4's QA measured as a PASS. A repair that spends it trades
    // one milestone for another.
    expect(native.calls.length).toBe(1)

    app.foreground.on = true
    await app.rung()
    expect(native.calls.length).toBe(2)
  })

  it('dials the instant the app comes back, rather than waiting out the rung', async () => {
    const native = refusing()
    environment.native = native.module
    const app = mount()
    await app.open()
    for (let i = 0; i < 8; i += 1) {
      await app.rung()
    }
    // The rung now armed is 60s away, and past the cap it becomes 90s. That wait is what QA's
    // escape hatch ① was supposed to skip and did not.
    expect(app.clock.armedDelays.at(-1)).toBe(60_000)
    const before = native.calls.length

    app.foreground.on = false
    await app.elapse(5 * 60_000)
    expect(native.calls.length).toBe(before)
    await app.resume()

    // No clock movement between the nudge and the dial.
    expect(native.calls.length).toBe(before + 1)
  })

  it('never renders the fixture while it retries, and never claims it has stopped', async () => {
    const native = refusing()
    environment.native = native.module
    const app = mount()
    const target = await app.open()

    const seen: string[][] = [textNodes(target)]
    for (let i = 0; i < 4; i += 1) {
      await app.rung()
      seen.push(textNodes(target))
    }
    for (const texts of seen) {
      // The whole point of `../api/herdr-data-provider.tsx`'s `dial` parameter: a remote that is
      // being retried is a *configured* remote that has not answered, and collapsing that into
      // "nothing configured" renders 4 invented nodes and 40 invented agents on a phone whose only
      // job is to say whether a real agent is blocked.
      expect(mockLeakedInto(texts)).toEqual([])
      expect(texts).toContain(
        'No configured remote could be reached — lab: Connection refused. Retrying…'
      )
    }
  })

  it('keeps saying so while a retry dial is in flight — no spinner, no fixture', async () => {
    let hang: (() => void) | null = null
    const calls: unknown[] = []
    environment.native = {
      connect: (config: unknown) => {
        calls.push(config)
        return calls.length === 1
          ? Promise.reject(new Error('Connection refused'))
          : new Promise<never>(() => {
              hang = () => {}
            })
      }
    }
    const app = mount()
    const target = await app.open()
    await app.rung()
    expect(calls.length).toBe(2)
    expect(hang).not.toBe(null)

    const texts = textNodes(target)
    // `settled` stays true across a retry round. Flipping it back would put the screen behind
    // `loadWhileDialling`, i.e. a spinner over an error the user has already read — which reads as
    // progress and is not.
    expect(mockLeakedInto(texts)).toEqual([])
    expect(texts).toContain(
      'No configured remote could be reached — lab: Connection refused. Retrying…'
    )
  })

  it('does not promise a retry it will not make — a refused key latches', async () => {
    const native = refusing('Permission denied (publickey)')
    environment.native = native.module
    const app = mount()
    const target = await app.open()

    expect(textNodes(target)).toContain(
      'No configured remote could be reached — lab: Permission denied (publickey)'
    )
    await app.elapse(60 * 60_000)
    await app.resume()
    // An hour, plus a resume. `../transport/channel-failure.ts` says a dial cannot change this
    // answer, so the ladder never armed and the message never promised one.
    expect(native.calls.length).toBe(1)
  })
})
