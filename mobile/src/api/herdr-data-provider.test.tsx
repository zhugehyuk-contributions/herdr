// Not from orca. `./herdr-data-provider.tsx` is one `useMemo`, and one `useMemo` is exactly the
// size of decision that gets silently inverted later — "the app is live now, so drop the mock" is
// the change this file exists to fail, and so is its opposite.
import { createElement, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonApiClient, type JsonApiConnection } from '@herdr/client-ts'
import type { HerdrRemoteConnection } from '../transport/herdr-connection'

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))

const { HerdrDataProvider } = await import('./herdr-data-provider')
type RemoteDialOutcome = import('./herdr-data-provider').RemoteDialOutcome
const { HerdrClientsProvider } = await import('../transport/herdr-clients-context')
const { useHerdrSnapshot } = await import('./snapshot-context')

function host(name: string): ElementType {
  return name as unknown as ElementType
}

/** Renders the snapshot as text, so the assertion is on what a screen would actually see. */
function Probe() {
  const { status, snapshot, error } = useHerdrSnapshot()
  return createElement(
    host('View'),
    null,
    createElement(host('Text'), null, `${status}:${error ?? ''}`),
    createElement(host('Text'), null, snapshot.remotes.map((remote) => remote.name).join(','))
  )
}

/** A connection whose box reports exactly one workspace, so live data is unmistakable. */
function liveConnection(): HerdrRemoteConnection {
  const script: Record<string, unknown> = {
    'remote.list': { type: 'remote_list', remotes: [] },
    'workspace.list': {
      type: 'workspace_list',
      workspaces: [{ workspace_id: 'w1', label: 'live' }]
    },
    'pane.list': { type: 'pane_list', panes: [] },
    'agent.list': { type: 'agent_list', agents: [] }
  }
  return {
    remote: { id: 'live-1', name: 'a-real-box', target: { type: 'ssh', target: 'z@live' } },
    api: new JsonApiClient(async (): Promise<JsonApiConnection> => {
      let pending: string | null = null
      return {
        write: (line: string) => {
          const request = JSON.parse(line) as { id: string; method: string }
          pending = JSON.stringify({ id: request.id, result: script[request.method] })
        },
        readLine: () =>
          pending === null
            ? Promise.reject(new Error('nothing written'))
            : Promise.resolve(pending),
        close: () => {}
      }
    }),
    openTerminalStream: () => Promise.reject(new Error('not used here'))
  }
}

let renderer: ReactTestRenderer | null = null

async function mount(
  connections: readonly HerdrRemoteConnection[],
  dial?: RemoteDialOutcome
): Promise<ReactTestRenderer> {
  let created: ReactTestRenderer | null = null
  await act(async () => {
    created = create(
      <HerdrClientsProvider connections={connections}>
        <HerdrDataProvider dial={dial}>
          <Probe />
        </HerdrDataProvider>
      </HerdrClientsProvider>
    )
  })
  if (!created) {
    throw new Error('did not render')
  }
  renderer = created
  return created
}

function texts(target: ReactTestRenderer): string[] {
  return target.root
    .findAllByType(host('Text'))
    .map((node) => node.props.children as ReactNode[] | string as string)
}

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
})

describe('herdr data provider', () => {
  it('falls back to the fixture when there is no reachable remote — which is a phone, today', async () => {
    const target = await mount([])
    expect(texts(target)[0]).toBe('ready:')
    // The stage-4 fixture's own fleet (`./mock/mock-fixture.ts`).
    expect(texts(target)[1]).toContain('fable-m5max')
  })

  it('uses the live loader the moment a remote is reachable', async () => {
    const target = await mount([liveConnection()])
    expect(texts(target)[0]).toBe('ready:')
    expect(texts(target)[1]).toBe('a-real-box')
    // And the fixture is not blended in behind it.
    expect(texts(target)[1]).not.toContain('fable-m5max')
  })

  it('surfaces a live failure as an error rather than quietly showing the fixture', async () => {
    const dead: HerdrRemoteConnection = {
      ...liveConnection(),
      api: new JsonApiClient(() => Promise.reject(new Error('ssh: connect failed')))
    }
    const target = await mount([dead])
    expect(texts(target)[0]).toBe('error:ssh: connect failed')
    expect(texts(target)[1]).toBe('')
  })
})

/**
 * The four dial states the fallback decision turns on. They exist because two of them used to be
 * one: `connections: []` meant both "nothing configured" (fixture, correct) and "nothing answered"
 * (fixture, a lie — `./herdr-data-provider.tsx`'s header). The end-to-end proof that a failed dial
 * shows no fixture agents is `../app-shell/failed-dial-mount.test.tsx`; this is the decision table.
 */
describe('herdr data provider — what the dial said', () => {
  const settled = (over: Partial<RemoteDialOutcome> = {}): RemoteDialOutcome => ({
    settled: true,
    failures: [],
    nativeModuleMissing: false,
    ...over
  })

  it('keeps the fixture when the dial settled with nothing configured', async () => {
    const target = await mount([], settled())
    expect(texts(target)[0]).toBe('ready:')
    expect(texts(target)[1]).toContain('fable-m5max')
  })

  it('reports the failed remotes instead of the fixture when every dial failed', async () => {
    const target = await mount(
      [],
      settled({ failures: ['lab: Permission denied', 'iq: timed out'] })
    )
    expect(texts(target)[0]).toBe(
      'error:No configured remote could be reached — lab: Permission denied · iq: timed out'
    )
    expect(texts(target)[1]).toBe('')
  })

  it('distinguishes a build with no native module from a remote that refused the key', async () => {
    // Both arrive with the same `failures` — `dialRemote` throws per remote either way
    // (`modules/herdr-ssh/src/app-connections.ts`) — so only `nativeModuleMissing` can separate
    // "this build cannot dial anything" from "this key was rejected", and they need different fixes.
    const target = await mount(
      [],
      settled({
        failures: ['lab: no HerdrSsh native module in this build'],
        nativeModuleMissing: true
      })
    )
    expect(texts(target)[0]).toBe(
      'error:No ssh module in this build — a configured remote cannot be dialled from Expo Go. Use a dev build.'
    )
  })

  it('stays on loading while the dial is still in flight, rather than showing the fixture', async () => {
    const target = await mount([], { settled: false, failures: [], nativeModuleMissing: false })
    expect(texts(target)[0]).toBe('loading:')
    expect(texts(target)[1]).toBe('')
  })

  it('goes live on a partial dial — one remote that answered is a real answer', async () => {
    const target = await mount([liveConnection()], settled({ failures: ['dead-1: timed out'] }))
    expect(texts(target)[0]).toBe('ready:')
    expect(texts(target)[1]).toBe('a-real-box')
    // Making the partial failure an error would throw away the box that did answer, so it stays
    // live. The failed remote is absent *here* only because this outcome names no configuration —
    // the next test is the same dial with `configured` filled in, which is what the phone sends.
    expect(texts(target)[1]).not.toContain('dead-1')
  })

  it('gives the live loader the whole configuration, so a failed remote still has a row', async () => {
    // The seam the QA phone was missing: `dataSourceOf` says `'live'` on a partial dial (above),
    // and until `configured` was threaded through, the remote that failed appeared nowhere at all —
    // no row, no error, header `1 nodes`. `dataSourceOf` is unchanged; what changed is that the
    // loader is now told what was configured (`./live/live-snapshot-loader.ts`).
    const target = await mount(
      [liveConnection()],
      settled({
        failures: ['dead-1: timed out'],
        configured: [
          { id: 'live-1', name: 'a-real-box', target: { type: 'ssh', target: 'z@live' } },
          { id: 'dead-1', name: 'blade-4090', target: { type: 'ssh', target: 'z@blade' } }
        ]
      })
    )
    expect(texts(target)[0]).toBe('ready:')
    expect(texts(target)[1]).toBe('a-real-box,blade-4090')
  })
})
