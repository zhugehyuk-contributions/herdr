// Not from orca — orca's status line is nine lines inside a 5,333-line screen and has no test.
// L6 and L7 are the two rules of that line, and both are the kind of thing that regresses silently:
// a label that never escalates still looks fine, and a Retry that resends a request still *looks*
// like it did something.
//
// So this drives the real component through `useConnectionStatus` against a real
// `SupervisedRemote` — no prop-level fake of the status object — and asserts on rendered nodes plus
// what reached the wire. `../../test/live/paneViewerOutage.live.test.tsx` is the same three
// assertions against a real ssh outage; this one is the deterministic half, so a failure names the
// rung rather than the flake.
import { createElement, type ElementType, type ReactNode } from 'react'
import { Children } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HerdrChannelKind } from '@herdr/client-ts'
import {
  FakeTransport,
  type FakeChannel
} from '../../../packages/herdr-client-ts/test/fakeTransport'
import { frameHex, fromHex } from '../../../packages/herdr-client-ts/test/helpers'
import { WELCOME_OK_ANSI_V21 } from '../../../packages/herdr-client-ts/test/vectors'
import { FakeClock, flushMicrotasks } from '../../test/fake-clock'
import { createWireAbiGate } from '../../test/wire-abi-peer'
import { mono } from '../theme/monotone'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))

const { ConnectionStatusLine } = await import('./ConnectionStatusLine')
const { useConnectionStatus } = await import('../transport/use-connection-status')
const { SupervisedRemote } = await import('../transport/supervised-remote')
const { createObserveStreamLink } = await import('../transport/observe-stream-link')
const { createTransportConnection } = await import('../transport/herdr-connection')

const REMOTE = { id: 'scratch', name: 'scratch', target: { type: 'local' as const } }

function host(name: string): ElementType {
  return name as unknown as ElementType
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

/** The component as the route mounts it: the hook feeds it, nothing else. */
function Line({ supervised }: { supervised: InstanceType<typeof SupervisedRemote> | null }) {
  return createElement(ConnectionStatusLine, { status: useConnectionStatus(supervised) })
}

function harness() {
  const transport = new FakeTransport()
  const streams: FakeChannel[] = []
  let welcome = true
  transport.onOpen = (channel: FakeChannel) => {
    if (channel.kind !== HerdrChannelKind.ClientStream) {
      return
    }
    streams.push(channel)
    const write = channel.write.bind(channel)
    // Answer the client's wire-ABI prelude the way a herdr server does, before looking for `Hello`.
    // Not merely cosmetic: without this the prelude's 5th byte would be sniffed as a message tag.
    const wireAbi = createWireAbiGate()
    channel.write = (bytes: Uint8Array) => {
      write(bytes)
      const framed = wireAbi(bytes)
      if (framed === null) {
        return
      }
      if (framed[4] === 0x00 && welcome) {
        channel.emit(fromHex(frameHex(WELCOME_OK_ANSI_V21)))
      }
    }
  }
  const clock = new FakeClock()
  const remote = new SupervisedRemote({
    remoteId: REMOTE.id,
    link: createObserveStreamLink({ connection: createTransportConnection(REMOTE, transport) }),
    timer: clock.timer,
    now: clock.now
  })
  return {
    clock,
    remote,
    streams,
    stopAnswering: () => {
      welcome = false
    },
    /** Kills the newest bridge and lets the loop take its next step. */
    async failOnce() {
      streams[streams.length - 1]?.die({ error: new Error('no route to host') })
      await flushMicrotasks()
      clock.advance(90_000)
      await flushMicrotasks()
      clock.advance(0)
      await flushMicrotasks()
    }
  }
}

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
})

async function mount(
  supervised: InstanceType<typeof SupervisedRemote> | null
): Promise<ReactTestRenderer> {
  let created: ReactTestRenderer | null = null
  await act(async () => {
    created = create(createElement(Line, { supervised }))
  })
  renderer = created
  return created as unknown as ReactTestRenderer
}

describe('ConnectionStatusLine', () => {
  it('renders nothing at all when the remote has no supervisor', async () => {
    const target = await mount(null)
    // Not "Connected", not a neutral dot. A build with no supervision says nothing about a
    // connection it is not watching — the whole failure L6 names is a reassuring label over a
    // loop nobody is measuring.
    expect(target.toJSON()).toBeNull()
  })

  it('shows the verdict and no button while the loop is healthy (L6 floor, L7 gate)', async () => {
    const { remote, clock } = harness()
    remote.start()
    await flushMicrotasks()
    clock.advance(0)
    await flushMicrotasks()

    const target = await mount(remote)
    expect(textNodes(target)).toEqual(['Connected'])
    // L7: below the escalation threshold the line is a label, not a button — offering Retry during
    // a 500ms backoff teaches the user to poke at a loop that is already working.
    expect(target.root.findAllByType(host('Pressable'))).toHaveLength(0)
    remote.close()
  })

  it('escalates the label and grows a Retry as the loop fails (L6 ladder → L7)', async () => {
    const { remote, stopAnswering, failOnce } = harness()
    stopAnswering()
    remote.start()
    await flushMicrotasks()

    const target = await mount(remote)
    const rungs: { texts: string[]; pressables: number }[] = []
    for (let attempt = 0; attempt < 13; attempt += 1) {
      await act(async () => {
        await failOnce()
      })
      rungs.push({
        texts: textNodes(target),
        pressables: target.root.findAllByType(host('Pressable')).length
      })
    }

    const labels = rungs.map((rung) => rung.texts[0] as string)
    process.stdout.write(`[L6] rendered ladder: ${JSON.stringify(labels)}\n`)
    // "Connecting…" and not "Reconnecting…" because each rung is sampled *after* the backoff fired
    // and the next dial is already in flight — which is the state orca's #10119 comment is about:
    // every redial re-enters `connecting`, so the escalation gates have to apply to it too, or the
    // reassuring label covers most of each cycle. The ladder below is that fix, rendered.
    expect(labels[0]).toBe('Connecting…')
    expect(labels).toContain('Can’t connect')
    expect(labels[labels.length - 1]).toBe('Can’t reach remote')
    // L7, as a rendered fact: the line became a button exactly when the verdict escalated, and it
    // carries the word the user presses.
    const firstButton = rungs.findIndex((rung) => rung.pressables === 1)
    expect(firstButton).toBeGreaterThan(-1)
    expect(labels[firstButton]).toBe('Can’t connect')
    expect(rungs.slice(0, firstButton).every((rung) => rung.pressables === 0)).toBe(true)
    expect(rungs.slice(firstButton).every((rung) => rung.pressables === 1)).toBe(true)
    expect(rungs[rungs.length - 1]?.texts).toContain('Retry')
    remote.close()
  })

  it('L7: pressing Retry revives the transport — a new channel, not a resent request', async () => {
    const { remote, clock, streams, stopAnswering, failOnce } = harness()
    stopAnswering()
    remote.start()
    await flushMicrotasks()
    const target = await mount(remote)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await act(async () => {
        await failOnce()
      })
    }
    const button = target.root.findByType(host('Pressable'))
    expect(button.props.accessibilityRole).toBe('button')
    expect(String(button.props.accessibilityLabel)).toContain('reconnect')

    const channelsBefore = streams.length
    await act(async () => {
      button.props.onPress()
      await flushMicrotasks()
      clock.advance(0)
      await flushMicrotasks()
    })
    // The evidence that it is L7 and not a resend: a *new* client-stream channel was opened. A
    // request replay would have written on the old one, which is dead.
    expect(streams.length).toBeGreaterThan(channelsBefore)
    remote.close()
  })

  it('is monotone at every rung, including the escalated ring', async () => {
    const { remote, stopAnswering, failOnce } = harness()
    stopAnswering()
    remote.start()
    await flushMicrotasks()
    const target = await mount(remote)
    const ramp = new Set<string>([...Object.values(mono), 'transparent'])
    let sawRing = false
    for (let attempt = 0; attempt < 13; attempt += 1) {
      await act(async () => {
        await failOnce()
      })
      const styles = target.root
        .findAll(() => true)
        .flatMap((node) => [node.props.style].flat(3))
        .filter(
          (style): style is Record<string, unknown> => typeof style === 'object' && style !== null
        )
      for (const style of styles) {
        for (const key of ['backgroundColor', 'borderColor', 'color']) {
          const value = style[key]
          if (typeof value === 'string') {
            expect(ramp, `attempt ${attempt} used ${value}`).toContain(value)
          }
        }
        if (style['borderWidth'] === 2 && style['backgroundColor'] === 'transparent') {
          sawRing = true
        }
      }
    }
    // Emphasis by inversion, reached through the real ladder rather than by passing a verdict in.
    expect(sawRing).toBe(true)
    remote.close()
  })
})
