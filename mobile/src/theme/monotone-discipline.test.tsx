// Not from orca. orca's theme test checks WCAG contrast (`mobile-theme-contrast.test.ts`, ported
// next to this file and still running); it cannot check "is this monotone", because orca is not.
// herdr's mockup fixes a grayscale ramp with emphasis by inversion
// (mobile/.prd/assets/mockup.html:863), and that rule is only worth stating if something enforces
// it — otherwise the next screen quietly reaches for `colors.statusRed`, which is still exported by
// the verbatim orca palette sitting in the same directory.
import { createElement, type ElementType } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mono } from './monotone'

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
    Easing: { linear: 'linear' },
    StyleSheet: { create: (styles: unknown) => styles },
    View: 'View'
  }
})

const { AgentStateDot } = await import('../components/AgentStateDot')
const { StatusDot } = await import('../components/StatusDot')

/**
 * react-test-renderer matches host components by their string type, and the `react-native` mock
 * above renders exactly such strings. `@types/react-test-renderer` narrows `findAllByType` to
 * `ElementType`, which only admits DOM intrinsics — hence the cast, once, here rather than at each
 * call site. (The ported orca tests hit the same mismatch and are excluded from
 * `tsconfig.test.json` for it; herdr-authored tests are type-checked, so they resolve it.)
 */
function host(name: string): ElementType {
  return name as unknown as ElementType
}

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
    renderer = null
  }
})

function render(element: ReturnType<typeof createElement>): ReactTestRenderer {
  let created: ReactTestRenderer | null = null
  act(() => {
    created = create(element)
  })
  if (!created) {
    throw new Error('did not render')
  }
  renderer = created
  return created
}

/** Every colour literal reachable from a rendered style, flattened. */
function colorsIn(target: ReactTestRenderer): string[] {
  return target.root
    .findAll(() => true)
    .flatMap((node) => [node.props.style].flat(3))
    .filter((style): style is Record<string, unknown> => typeof style === 'object' && style !== null)
    .flatMap((style) =>
      ['backgroundColor', 'borderColor', 'borderTopColor', 'color']
        .map((key) => style[key])
        .filter((value): value is string => typeof value === 'string')
    )
}

const RAMP = new Set<string>([...Object.values(mono), 'transparent'])

describe('state dots are monotone', () => {
  it.each(['idle', 'working', 'blocked', 'done', 'unknown'] as const)(
    'AgentStateDot(%s) uses only the grayscale ramp',
    (state) => {
      const used = colorsIn(render(createElement(AgentStateDot, { state })))
      expect(used.length).toBeGreaterThan(0)
      for (const color of used) {
        expect(RAMP, `${state} used ${color}`).toContain(color)
      }
    }
  )

  it.each(['connected', 'connecting', 'reconnecting', 'disconnected', 'auth-failed'] as const)(
    'StatusDot(%s) uses only the grayscale ramp',
    (state) => {
      for (const color of colorsIn(render(createElement(StatusDot, { state })))) {
        expect(RAMP, `${state} used ${color}`).toContain(color)
      }
    }
  )

  it('draws blocked as an inverted ring, not a brighter fill', () => {
    const style = render(createElement(AgentStateDot, { state: 'blocked' })).root
      .findAllByType(host('View'))
      .map((node) => node.props.style as Record<string, unknown>)
      .find((candidate) => candidate?.['borderWidth'] !== undefined)
    expect(style).toMatchObject({ backgroundColor: 'transparent', borderColor: mono.fg })
  })

  it('escalates an unreachable verdict to the ring too, overriding the transport state', () => {
    const style = render(
      createElement(StatusDot, { state: 'reconnecting', verdict: { kind: 'unreachable' } })
    ).root.findAllByType(host('View'))[0]!.props.style as Record<string, unknown>
    expect(style).toMatchObject({ backgroundColor: 'transparent', borderColor: mono.fg })
  })

  it('keeps every ramp entry distinct, so brightness can carry meaning', () => {
    const values = Object.values(mono)
    expect(new Set(values).size).toBe(values.length)
  })
})
