// Not from orca (it ships the module without a test). X2's first half — "delivery-unknown 표시(실패로
// 단정 금지)" — is a claim about a *terminal*, where the cost of getting it wrong is concrete: a tap
// that answered an agent's approval prompt and was reported as failed invites the user to press it
// again, and a second `y` on a prompt that already moved on is a second answer to a different
// question.
//
// The second half of X2 — "끊긴 상태의 키 입력은 즉시 거절", never queued — lives in
// `src/session/pane-input.test.ts`, which predates this port. This file covers the marker and the
// seam where the two meet.
import { describe, expect, it } from 'vitest'
import { isRpcDeliveryUnknown, markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import { PaneInputSender } from '../session/pane-input'
import type { JsonApiClient } from '@herdr/client-ts'

describe('X2 — the delivery-unknown marker', () => {
  it('marks in place and returns the same error, so a throw site can tag inline', () => {
    const error = new Error('channel closed')
    expect(markRpcDeliveryUnknown(error)).toBe(error)
    expect(isRpcDeliveryUnknown(error)).toBe(true)
  })

  it('an unmarked error, a non-error and a lookalike are all "not unknown"', () => {
    // Default-deny: only the write path that actually reached the wire may claim ambiguity.
    expect(isRpcDeliveryUnknown(new Error('channel closed'))).toBe(false)
    expect(isRpcDeliveryUnknown('channel closed')).toBe(false)
    expect(isRpcDeliveryUnknown(null)).toBe(false)
    expect(isRpcDeliveryUnknown({ message: 'channel closed' })).toBe(false)
  })

  it('the set is per-object, not per-message', () => {
    const marked = markRpcDeliveryUnknown(new Error('same text'))
    expect(isRpcDeliveryUnknown(marked)).toBe(true)
    expect(isRpcDeliveryUnknown(new Error('same text'))).toBe(false)
  })
})

describe('X2 — the pane write path speaks the same vocabulary', () => {
  function sender(reject: unknown) {
    const errors: unknown[] = []
    const api = {
      request: () => {
        errors.push(reject)
        return Promise.reject(reject)
      }
    } as unknown as JsonApiClient
    return { errors, sender: new PaneInputSender({ api, paneId: 'w1:p1' }) }
  }

  it('a dead channel gives `unknown` and tags the error the caller saw', async () => {
    const error = new Error('ssh channel closed')
    const { sender: it } = sender(error)
    const result = await it.sendText('y')
    expect(result.delivery).toBe('unknown')
    // The two rules now agree by construction rather than by coincidence.
    expect(isRpcDeliveryUnknown(error)).toBe(true)
    process.stdout.write(
      `[X2] delivery=${result.delivery} reason=${result.reason ?? ''} marked=${isRpcDeliveryUnknown(error)}\n`
    )
  })

  it('a non-Error rejection is still tagged — the marker needs an Error, so it makes one', async () => {
    const { sender: it } = sender('exec refused')
    expect((await it.sendText('y')).delivery).toBe('unknown')
  })

  it('a server error envelope is NOT delivery-unknown — the server answered', async () => {
    const { JsonApiError } = await import('@herdr/client-ts')
    const error = new JsonApiError('pane.send_input', 'invalid_key', 'no such key')
    const { sender: it } = sender(error)
    const result = await it.sendText('y')
    expect(result).toEqual({ delivery: 'rejected', reason: 'invalid_key' })
    expect(isRpcDeliveryUnknown(error)).toBe(false)
  })
})
