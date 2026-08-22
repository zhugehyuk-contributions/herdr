// Not from orca — orca has no `connection-health.test.ts` at 4fd93ead, and its own comment says the
// most important thing about the file: `UNREACHABLE_ATTEMPTS` "MUST stay aligned with
// GIVE_UP_AFTER_ATTEMPTS". A "MUST" enforced only by a comment is the kind of coupling that breaks
// silently and shows up as L6's failure mode — "'연결 중…' 라벨이 실패 루프를 가림". So the first test
// here is that alignment, checked against the constant itself rather than against a copy of it.
import { describe, expect, it } from 'vitest'
import { GIVE_UP_AFTER_ATTEMPTS } from './reconnect-policy'
import {
  STALE_SINCE_LAST_CONNECT_MS,
  UNREACHABLE_ATTEMPTS,
  WARNING_ATTEMPTS,
  classifyConnection,
  showConnectionRetry,
  verdictDisplayLabel
} from './connection-health'

const NOW = 5_000_000

describe('L6 — the escalation ladder', () => {
  it('is pinned to the transport’s give-up cap', () => {
    // The coupling orca states in prose and nothing checks. If L3's cap moves and this does not,
    // the trickle keeps dialling while the label quietly slides back to reassuring.
    expect(UNREACHABLE_ATTEMPTS).toBe(GIVE_UP_AFTER_ATTEMPTS)
    expect(WARNING_ATTEMPTS).toBe(3)
    expect(STALE_SINCE_LAST_CONNECT_MS).toBe(60_000)
  })

  it('climbs normal → warning → unreachable as the attempt counter climbs', () => {
    const ladder = [0, 1, 2, 3, 5, 11, 12, 40].map((attempts) => {
      const verdict = classifyConnection({
        state: 'reconnecting',
        reconnectAttempts: attempts,
        lastConnectedAt: null,
        nowMs: NOW
      })
      return `${attempts}:${verdict.kind}`
    })
    process.stdout.write(`[L6] ladder: ${ladder.join(' ')}\n`)
    expect(ladder).toEqual([
      '0:normal',
      '1:normal',
      '2:normal',
      '3:warning',
      '5:warning',
      '11:warning',
      '12:unreachable',
      '40:unreachable'
    ])
  })

  it('the pinned counter keeps the verdict stable while the loop trickles — L3’s whole reason', () => {
    // This is the coupling stated from the other side: because `decideReconnect` never moves the
    // counter past the cap, `classifyConnection` reads the same verdict on trickle 1 and trickle 500.
    const first = classifyConnection({
      state: 'reconnecting',
      reconnectAttempts: GIVE_UP_AFTER_ATTEMPTS,
      lastConnectedAt: null,
      nowMs: NOW
    })
    const later = classifyConnection({
      state: 'connecting',
      reconnectAttempts: GIVE_UP_AFTER_ATTEMPTS,
      lastConnectedAt: null,
      nowMs: NOW + 500 * 90_000
    })
    expect(first.kind).toBe('unreachable')
    expect(later.kind).toBe('unreachable')
  })

  it('every redial re-enters "connecting" and must not un-escalate the verdict (#10119)', () => {
    expect(
      classifyConnection({
        state: 'connecting',
        reconnectAttempts: 12,
        lastConnectedAt: null,
        nowMs: NOW
      }).kind
    ).toBe('unreachable')
    expect(
      classifyConnection({
        state: 'handshaking',
        reconnectAttempts: 4,
        lastConnectedAt: null,
        nowMs: NOW
      }).kind
    ).toBe('warning')
  })

  it('a session that WAS connected reads stale only after a minute of failure', () => {
    const fresh = classifyConnection({
      state: 'reconnecting',
      reconnectAttempts: 20,
      lastConnectedAt: NOW - 30_000,
      nowMs: NOW
    })
    expect(fresh.kind).toBe('warning')
    const stale = classifyConnection({
      state: 'reconnecting',
      reconnectAttempts: 20,
      lastConnectedAt: NOW - STALE_SINCE_LAST_CONNECT_MS,
      nowMs: NOW
    })
    expect(stale).toMatchObject({ kind: 'unreachable', reason: 'stale' })
  })

  it('connected and disconnected are never alarming', () => {
    expect(
      classifyConnection({
        state: 'connected',
        reconnectAttempts: 99,
        lastConnectedAt: null,
        nowMs: NOW
      })
    ).toEqual({ kind: 'normal', label: 'Connected' })
    expect(
      classifyConnection({
        state: 'disconnected',
        reconnectAttempts: 99,
        lastConnectedAt: null,
        nowMs: NOW
      }).kind
    ).toBe('normal')
  })
})

describe('L6 — the ssh hints that replaced the Tailscale one', () => {
  it('a fatal failure outranks any "still connecting" reading and names itself', () => {
    const kinds = (['auth', 'missing-binary', 'protocol'] as const).map((kind) => {
      const verdict = classifyConnection({
        state: 'connecting',
        reconnectAttempts: 0,
        lastConnectedAt: null,
        fatalFailure: kind,
        hint: 'Permission denied (publickey)',
        nowMs: NOW
      })
      return `${kind} -> ${verdict.kind}: ${verdictDisplayLabel(verdict)}`
    })
    process.stdout.write(`[L6] fatal verdicts:\n  ${kinds.join('\n  ')}\n`)
    expect(kinds.every((line) => line.includes('-> auth-failed'))).toBe(true)
    // The three labels are distinct — the kind is what the user has to act on.
    expect(new Set(kinds).size).toBe(3)
  })

  it('a retryable failure does NOT outrank anything — it is just the loop working', () => {
    expect(
      classifyConnection({
        state: 'connecting',
        reconnectAttempts: 0,
        lastConnectedAt: null,
        fatalFailure: 'transport',
        nowMs: NOW
      })
    ).toEqual({ kind: 'normal', label: 'Connecting…' })
  })

  it('the hint renders after an em dash, once, and only on escalated verdicts', () => {
    expect(
      verdictDisplayLabel(
        classifyConnection({
          state: 'reconnecting',
          reconnectAttempts: 3,
          lastConnectedAt: null,
          hint: 'herdr: command not found',
          nowMs: NOW
        })
      )
    ).toBe('Can’t connect — herdr: command not found')
    // A hint on a healthy connection would be noise; `normal` never carries one.
    expect(
      verdictDisplayLabel(
        classifyConnection({
          state: 'connected',
          reconnectAttempts: 0,
          lastConnectedAt: NOW,
          hint: 'herdr: command not found',
          nowMs: NOW
        })
      )
    ).toBe('Connected')
  })
})

describe('L7 — the status line becomes a button exactly when the verdict escalates', () => {
  it('offers Retry on warning / unreachable / auth-failed and not below', () => {
    const at = (attempts: number) =>
      showConnectionRetry(
        classifyConnection({
          state: 'reconnecting',
          reconnectAttempts: attempts,
          lastConnectedAt: null,
          nowMs: NOW
        })
      )
    // Below the warning threshold the loop is doing its job in under 8 seconds; a Retry affordance
    // there teaches the user to poke at a working backoff.
    expect([at(0), at(2)]).toEqual([false, false])
    expect([at(3), at(12)]).toEqual([true, true])
    expect(
      showConnectionRetry(
        classifyConnection({
          state: 'connecting',
          reconnectAttempts: 0,
          lastConnectedAt: null,
          fatalFailure: 'auth',
          nowMs: NOW
        })
      )
    ).toBe(true)
  })
})
