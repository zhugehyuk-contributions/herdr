// Not from orca. Mounts the real bar over a scripted `usePaneInput` view and presses its real
// `Pressable`s, so "one tap sends `y`" is a render-level fact rather than a claim about a table.
// The live suite presses the same nodes against a real server.
import { createElement, type ElementType } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneInputChunk, PaneInputResult, PaneInputState } from './pane-input'
import type { PaneInputView } from './use-pane-input'

// The screens read the real safe-area inset since §D1. Its provider comes from the navigator on a
// device, and the navigator is mocked away here — so is the library, which does not load under
// this environment's transform at all. Zero insets = the geometry every assertion below was
// written against; `../app-shell/safe-area-mount.test.tsx` is where a real inset is the subject.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

const { PaneInputBar } = await import('./PaneInputBar')
const { HERDR_ACCESSORY_KEYS } = await import('../terminal/terminal-accessory-herdr-keys')

function host(name: string): ElementType {
  return name as unknown as ElementType
}

const IDLE: PaneInputState = { last: null, inFlight: false, pendingChunks: 0 }

function view(overrides: Partial<PaneInputView> = {}): {
  input: PaneInputView
  sent: PaneInputChunk[]
} {
  const sent: PaneInputChunk[] = []
  const send = async (chunk: PaneInputChunk): Promise<PaneInputResult> => {
    sent.push(chunk)
    return { delivery: 'delivered', reason: null }
  }
  return {
    sent,
    input: {
      state: IDLE,
      enabled: true,
      send,
      sendText: (text) => send({ text, keys: [] }),
      sendKeys: (keys) => send({ text: '', keys }),
      ...overrides
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

function render(input: PaneInputView): ReactTestRenderer {
  let created: ReactTestRenderer | null = null
  act(() => {
    created = create(createElement(PaneInputBar, { input }))
  })
  if (created === null) {
    throw new Error('did not render')
  }
  renderer = created
  return created
}

function pressByLabel(target: ReactTestRenderer, label: string): void {
  const node = target.root
    .findAllByType(host('Pressable'))
    .find((candidate) => candidate.props.accessibilityLabel === label)
  if (node === undefined) {
    throw new Error(
      `no pressable labelled ${label}; have ${target.root
        .findAllByType(host('Pressable'))
        .map((candidate) => String(candidate.props.accessibilityLabel))
        .join(', ')}`
    )
  }
  act(() => {
    node.props.onPress()
  })
}

describe('PaneInputBar', () => {
  it('sends `y` as a key on one tap — M3’s headline', () => {
    const { input, sent } = view()
    pressByLabel(render(input), 'Answer yes')
    expect(sent).toEqual([{ text: '', keys: ['y'] }])
  })

  it('sends the other answers as keys too', () => {
    const { input, sent } = view()
    const target = render(input)
    pressByLabel(target, 'Answer no')
    pressByLabel(target, 'Answer yes and submit')
    pressByLabel(target, 'Accept')
    pressByLabel(target, 'Cancel prompt')
    expect(sent).toEqual([
      { text: '', keys: ['n'] },
      { text: '', keys: ['y', 'enter'] },
      { text: '', keys: ['enter'] },
      { text: '', keys: ['esc'] }
    ])
  })

  it('sends an accessory key as its herdr name, not orca’s bytes', () => {
    const { input, sent } = view()
    const target = render(input)
    pressByLabel(target, 'Enter')
    pressByLabel(target, 'Interrupt terminal')
    pressByLabel(target, 'Arrow Up')
    expect(sent).toEqual([
      { text: '', keys: ['enter'] },
      { text: '', keys: ['ctrl+c'] },
      { text: '', keys: ['up'] }
    ])
    // The bytes orca's table holds for those never appear.
    expect(JSON.stringify(sent)).not.toContain('\\u001b')
  })

  it('renders one button per mappable accessory key and no dead ones', () => {
    const target = render(view().input)
    const labels = target.root
      .findAllByType(host('Pressable'))
      .map((node) => String(node.props.accessibilityLabel))
    for (const key of HERDR_ACCESSORY_KEYS) {
      expect(labels).toContain(key.accessibilityLabel ?? key.label)
    }
    expect(labels).not.toContain('Forward delete')
  })

  it('sends the text field with Enter, in one chunk', () => {
    const { input, sent } = view()
    const target = render(input)
    const field = target.root.findByType(host('TextInput'))
    act(() => {
      field.props.onChangeText('yes please')
    })
    pressByLabel(target, 'Send input')
    // One `pane.send_input`, not a text call racing an Enter call: `encode_api_input` emits text
    // then keys (`src/app/api_helpers.rs:72-84`), and one call is one exec (B8).
    expect(sent).toEqual([{ text: 'yes please', keys: ['enter'] }])
  })

  it('submits on the keyboard’s return key as well as the button', () => {
    const { input, sent } = view()
    const target = render(input)
    const field = target.root.findByType(host('TextInput'))
    act(() => {
      field.props.onChangeText('ok')
    })
    act(() => {
      field.props.onSubmitEditing()
    })
    expect(sent).toEqual([{ text: 'ok', keys: ['enter'] }])
  })

  it('clears the field after submitting and sends nothing when it is empty', () => {
    const { input, sent } = view()
    const target = render(input)
    const field = () => target.root.findByType(host('TextInput'))
    act(() => {
      field().props.onChangeText('hi')
    })
    act(() => {
      field().props.onSubmitEditing()
    })
    expect(field().props.value).toBe('')
    act(() => {
      field().props.onSubmitEditing()
    })
    expect(sent).toHaveLength(1)
  })

  it('disables every control when there is no transport', () => {
    const target = render(view({ enabled: false }).input)
    for (const node of target.root.findAllByType(host('Pressable'))) {
      expect(node.props.disabled, String(node.props.accessibilityLabel)).toBe(true)
    }
    expect(target.root.findByType(host('TextInput')).props.editable).toBe(false)
  })

  it('shows the delivery verdict, and never calls an unacknowledged write a failure', () => {
    const target = render(
      view({ state: { ...IDLE, last: { delivery: 'unknown', reason: 'EPIPE' } } }).input
    )
    const texts = target.root.findAllByType(host('Text')).map((node) => String(node.props.children))
    expect(texts).toContain('delivery unknown')
    expect(texts.some((text) => text.includes('failed'))).toBe(false)
  })

  it('shows nothing in the status slot before the first write', () => {
    const target = render(view().input)
    const texts = target.root.findAllByType(host('Text')).map((node) => String(node.props.children))
    expect(texts).not.toContain('sent')
    expect(texts).not.toContain('sending')
  })

  it('keeps taps alive with the keyboard open, like orca’s chip strip', () => {
    // orca `:4416-4420` (#5106): without this the first tap is eaten by keyboard dismissal — which
    // on this bar is the tap that answers the prompt.
    const target = render(view().input)
    expect(target.root.findByType(host('ScrollView')).props.keyboardShouldPersistTaps).toBe(
      'handled'
    )
  })
})
