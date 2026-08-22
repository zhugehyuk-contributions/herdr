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
    'workspace.list': { type: 'workspace_list', workspaces: [{ workspace_id: 'w1', label: 'live' }] },
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
          pending === null ? Promise.reject(new Error('nothing written')) : Promise.resolve(pending),
        close: () => {}
      }
    }),
    openTerminalStream: () => Promise.reject(new Error('not used here'))
  }
}

let renderer: ReactTestRenderer | null = null

async function mount(connections: readonly HerdrRemoteConnection[]): Promise<ReactTestRenderer> {
  let created: ReactTestRenderer | null = null
  await act(async () => {
    created = create(
      <HerdrClientsProvider connections={connections}>
        <HerdrDataProvider>
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
    .map((node) => (node.props.children as ReactNode[] | string) as string)
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
