// Not from orca — orca ships no test for `rpc-session-liveness-watchdog.ts` (`ls
// mobile/src/transport/*liveness*` at 4fd93ead returns the source and nothing else), which is
// notable given that the class is 196 lines of pure decision with an injected clock, i.e. the single
// most testable file in its transport directory.
//
// This is the L1/L1b receipt, and it is the half of M4 that no live test can produce on demand: a
// **half-open channel** — the ssh child alive, the pipe open, and no bytes arriving — is precisely
// the failure that emits no event, so the only way to prove the detector is to drive its clock.
//
//   L1   3-strike: idle 20s arms a probe, an 8s probe timeout is a miss, 3 misses terminate
//   L1   a probe that cannot even be written terminates immediately
//   L1b  a probe window the OS stretched past timeout×1.5 is not a miss — it is re-probed
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../test/fake-clock'
import {
  LIVENESS_IDLE_MS,
  LIVENESS_PROBE_TIMEOUT_MS,
  MISSED_PROBE_LIMIT,
  RpcSessionLivenessWatchdog
} from './rpc-session-liveness-watchdog'

type Trace = { probes: number[]; terminated: number }

function watchdog(options: { sendProbe?: () => boolean } = {}) {
  const clock = new FakeClock()
  const trace: Trace = { probes: [], terminated: 0 }
  const dog = new RpcSessionLivenessWatchdog({
    transport: 'direct',
    sendProbe: () => {
      trace.probes.push(clock.now())
      return options.sendProbe?.() ?? true
    },
    terminate: () => {
      trace.terminated += 1
    },
    now: clock.now,
    setTimer: clock.timer.setTimeout as unknown as typeof setTimeout,
    clearTimer: clock.timer.clearTimeout as unknown as typeof clearTimeout
  })
  return { clock, trace, dog }
}

describe('L1 — the 3-strike liveness watchdog', () => {
  it('uses orca’s constants unchanged: idle 20s / timeout 8s / 3 misses', () => {
    expect(LIVENESS_IDLE_MS).toBe(20_000)
    expect(LIVENESS_PROBE_TIMEOUT_MS).toBe(8_000)
    expect(MISSED_PROBE_LIMIT).toBe(3)
  })

  it('detects a half-open channel in idle + 3×timeout, and not before', () => {
    const { clock, trace, dog } = watchdog()
    const identity = {}
    const startedAt = clock.now()
    dog.start(identity)

    // Nothing happens while the link is merely quiet and under the idle threshold.
    clock.advance(LIVENESS_IDLE_MS - 1)
    expect(trace.probes).toHaveLength(0)

    // Idle threshold: the first probe goes out. Nothing ever answers it — that is the half-open case.
    clock.advance(1)
    expect(trace.probes).toHaveLength(1)

    clock.advance(LIVENESS_PROBE_TIMEOUT_MS)
    expect(trace.probes).toHaveLength(2)
    expect(trace.terminated).toBe(0)

    clock.advance(LIVENESS_PROBE_TIMEOUT_MS)
    expect(trace.probes).toHaveLength(3)
    expect(trace.terminated).toBe(0)

    clock.advance(LIVENESS_PROBE_TIMEOUT_MS)
    expect(trace.terminated).toBe(1)

    const elapsed = clock.now() - startedAt
    process.stdout.write(
      `[L1] probes at +${trace.probes.map((at) => at - startedAt).join('ms, +')}ms; ` +
        `terminated at +${elapsed}ms\n`
    )
    // 20s idle + three 8s windows. orca's own comment claims "three fair misses detect a half-open
    // socket within 24s" (`rpc-client.ts:1171`) — that is the 24s *after the first probe*.
    expect(elapsed).toBe(LIVENESS_IDLE_MS + MISSED_PROBE_LIMIT * LIVENESS_PROBE_TIMEOUT_MS)
    expect(elapsed - LIVENESS_IDLE_MS).toBe(24_000)
  })

  it('terminates at once when the probe cannot even be written', () => {
    const { clock, trace, dog } = watchdog({ sendProbe: () => false })
    dog.start({})
    clock.advance(LIVENESS_IDLE_MS)
    expect(trace.probes).toHaveLength(1)
    // No 3-strike grace: a transport that will not accept a 4-byte frame is already gone.
    expect(trace.terminated).toBe(1)
  })

  it('an inbound frame clears the strikes — recovery is not partial', () => {
    const { clock, trace, dog } = watchdog()
    const identity = {}
    dog.start(identity)
    clock.advance(LIVENESS_IDLE_MS)
    clock.advance(LIVENESS_PROBE_TIMEOUT_MS)
    expect(trace.probes).toHaveLength(2)

    dog.noteAuthenticatedInbound(identity)
    // Back to idle: the next probe is a full idle window away, not a timeout window.
    clock.advance(LIVENESS_IDLE_MS - 1)
    expect(trace.probes).toHaveLength(2)
    clock.advance(1)
    expect(trace.probes).toHaveLength(3)
    // …and the strike count restarted, so it now takes three more misses.
    clock.advance(LIVENESS_PROBE_TIMEOUT_MS * 2)
    expect(trace.terminated).toBe(0)
    clock.advance(LIVENESS_PROBE_TIMEOUT_MS)
    expect(trace.terminated).toBe(1)
  })

  it('stop() disarms everything — a stopped watchdog cannot terminate a later link', () => {
    const { clock, trace, dog } = watchdog()
    const identity = {}
    dog.start(identity)
    dog.stop(identity)
    clock.advance(10 * 60_000)
    expect(trace.probes).toHaveLength(0)
    expect(trace.terminated).toBe(0)
    expect(clock.pending).toBe(0)
  })

  it('ignores a stale identity: an old generation cannot kill the current link', () => {
    const { clock, trace, dog } = watchdog()
    const first = {}
    const second = {}
    dog.start(first)
    dog.start(second)
    dog.noteAuthenticatedInbound(first)
    dog.stop(first)
    // `stop(first)` was a no-op, so the *second* identity is still armed and still probes.
    clock.advance(LIVENESS_IDLE_MS)
    expect(trace.probes).toHaveLength(1)
  })
})

describe('L1b — the unfair window', () => {
  it('does not count a miss when the OS suspended JS across the probe', () => {
    const { clock, trace, dog } = watchdog()
    dog.start({})
    clock.advance(LIVENESS_IDLE_MS)
    expect(trace.probes).toHaveLength(1)

    // The phone slept. Wall-clock moved far past the 8s deadline, so when the timer finally runs it
    // is judging a window that was never the peer's to answer in.
    clock.jump(LIVENESS_PROBE_TIMEOUT_MS * 1.5 + 1)
    clock.advance(LIVENESS_PROBE_TIMEOUT_MS)

    // Re-probed rather than struck. The proof that it was not counted: three *fair* windows from
    // here are still needed, so nothing has terminated yet after two of them.
    expect(trace.probes.length).toBeGreaterThanOrEqual(2)
    expect(trace.terminated).toBe(0)
    clock.advance(LIVENESS_PROBE_TIMEOUT_MS)
    expect(trace.terminated).toBe(0)
    clock.advance(LIVENESS_PROBE_TIMEOUT_MS)
    expect(trace.terminated).toBe(1)
  })

  it('a 30-minute background does not produce three instant false strikes', () => {
    const { clock, trace, dog } = watchdog()
    dog.start({})
    clock.advance(LIVENESS_IDLE_MS)
    expect(trace.probes).toHaveLength(1)

    // Milestone M4's third scenario, verbatim: "30분 백그라운드 후 복귀".
    clock.jump(30 * 60_000)
    clock.advance(LIVENESS_PROBE_TIMEOUT_MS)
    process.stdout.write(
      `[L1b] after a 30min suspension: probes=${trace.probes.length} terminated=${trace.terminated}\n`
    )
    // Exactly orca's finding: without this rule the resume books three misses in one tick and tears
    // down a link that may be perfectly alive.
    expect(trace.terminated).toBe(0)
  })

  it('a window that is merely slow, not unfair, still counts as a miss', () => {
    const { clock, trace, dog } = watchdog()
    dog.start({})
    clock.advance(LIVENESS_IDLE_MS)
    // 1.4× the timeout is inside the fairness bound, so it is a genuine miss.
    clock.jump(LIVENESS_PROBE_TIMEOUT_MS * 0.4)
    clock.advance(LIVENESS_PROBE_TIMEOUT_MS)
    clock.advance(LIVENESS_PROBE_TIMEOUT_MS)
    clock.advance(LIVENESS_PROBE_TIMEOUT_MS)
    expect(trace.terminated).toBe(1)
  })
})
