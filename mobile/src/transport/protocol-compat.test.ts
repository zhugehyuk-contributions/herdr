// Not from orca (orca's copy is covered by its desktop `src/shared/protocol-compat.ts` test, which
// is not in the ported closure). X6's failure mode is "버전 불일치가 원인불명 재연결 루프로 보임", so
// the receipt has to show two things: the verdict is reached, *and* the verdict is fatal — because a
// blocked peer that is merely labelled is still a peer the loop trickles at every 90 seconds.
import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@herdr/client-ts'
import {
  MIN_COMPATIBLE_SERVER_VERSION,
  MOBILE_PROTOCOL_VERSION,
  compatBlockMessage,
  evaluateCompat
} from './protocol-compat'
import { classifyChannelFailure } from './channel-failure'

describe('X6 / B1 — protocol compatibility', () => {
  it('tracks the codec’s version rather than a hand-copied number', () => {
    expect(MOBILE_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION)
    // The window is degenerate because the server negotiates exact equality
    // (`src/protocol/wire.rs:1225`) — widening it would only make this file lie.
    expect(MIN_COMPATIBLE_SERVER_VERSION).toBe(MOBILE_PROTOCOL_VERSION)
  })

  it('accepts the matching version and blocks either direction of skew', () => {
    expect(evaluateCompat({ serverProtocolVersion: PROTOCOL_VERSION })).toEqual({ kind: 'ok' })
    expect(evaluateCompat({ serverProtocolVersion: PROTOCOL_VERSION + 1 })).toMatchObject({
      kind: 'blocked',
      reason: 'app-too-old'
    })
    expect(evaluateCompat({ serverProtocolVersion: PROTOCOL_VERSION - 1 })).toMatchObject({
      kind: 'blocked',
      reason: 'server-too-old'
    })
    // A server that never answered is not "compatible by default".
    expect(evaluateCompat({ serverProtocolVersion: undefined }).kind).toBe('blocked')
  })

  it('a matching version is still blocked once the layout probe condemns the peer', () => {
    // B1's whole point: mx and upstream both report 20 and disagree on `ServerMessage::Terminal`.
    // A version check cannot see that; `WireLayoutProbe` can, and its verdict has to be able to
    // block on its own.
    const verdict = evaluateCompat({
      serverProtocolVersion: PROTOCOL_VERSION,
      layoutMismatch: true
    })
    expect(verdict).toMatchObject({ kind: 'blocked', reason: 'layout-skew' })
    process.stdout.write(`[X6] ${compatBlockMessage(verdict) ?? ''}\n`)
  })

  it('every block reason produces a line that names the action, and ok produces none', () => {
    expect(compatBlockMessage({ kind: 'ok' })).toBeNull()
    const messages = (['app-too-old', 'server-too-old', 'layout-skew'] as const).map((reason) =>
      compatBlockMessage({ kind: 'blocked', reason, serverVersion: 19 })
    )
    expect(messages.every((line) => (line ?? '').length > 0)).toBe(true)
    expect(new Set(messages).size).toBe(3)
  })

  it('a version mismatch reaches the reconnect loop as FATAL, not as another retry', () => {
    // The join between X6 and L3. Without this the app dials a peer it can never talk to, forever,
    // while showing "Reconnecting…" — which is the exact symptom X6 is named after.
    const stderr =
      'remote herdr server is running with protocol 19, but this bridge needs protocol 20'
    expect(classifyChannelFailure({ stderr }).fatal).toBe(true)
  })
})
