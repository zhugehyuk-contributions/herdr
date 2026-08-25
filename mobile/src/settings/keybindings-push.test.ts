// Not from orca. The wire half of mockup #7, kept out of the screen for the same reason
// `./remote-form.test.ts`'s subject is: the interesting part is which answer means what, and the
// four answers below are four different repairs for the user.
//
// The payload assertion is the load-bearing one. `remote.set_keybindings` is the phone's only
// mutating request on this API, and a params shape the server cannot deserialize comes back as
// `invalid_request` with a *dropped id* — indistinguishable, from the client's side, from asking
// for a method that does not exist (`src/api/server.rs:159-172`). So the request is pinned here
// rather than discovered on a device.
import { JsonApiError } from '@herdr/client-ts'
import { describe, expect, it } from 'vitest'
import { pushKeybindings, type KeybindingsApi } from './keybindings-push'
import type { RemoteDefinition } from '../api/herdr-api-types'

type Sent = { method: string; params: Record<string, unknown> }

const FABLE: RemoteDefinition = {
  id: 'fable',
  name: 'fable-m5max',
  target: { type: 'ssh', target: 'z@192.168.50.10' },
  keybindings: 'local'
}

/** Records what was asked and answers with whatever the case under test needs. */
function api(
  sent: Sent[],
  answer: () => Promise<{ type: string } & Record<string, unknown>>
): KeybindingsApi {
  return {
    request: (method: string, params: Record<string, unknown> = {}) => {
      sent.push({ method, params })
      return answer()
    }
  }
}

function accepts(sent: Sent[], keybindings: 'local' | 'server'): KeybindingsApi {
  return api(sent, () =>
    Promise.resolve({ type: 'remote_enabled_changed', remote: { ...FABLE, keybindings } })
  )
}

describe('pushKeybindings', () => {
  it('sends exactly the params RemoteSetKeybindingsParams declares', async () => {
    const sent: Sent[] = []
    await pushKeybindings(accepts(sent, 'server'), { remote_id: 'fable', keybindings: 'server' })

    expect(sent).toEqual([
      { method: 'remote.set_keybindings', params: { remote_id: 'fable', keybindings: 'server' } }
    ])
  })

  it('reports applied only when the server echoes the side back', async () => {
    const result = await pushKeybindings(accepts([], 'server'), {
      remote_id: 'fable',
      keybindings: 'server'
    })

    expect(result.applied).toBe(true)
    expect(result.line).toContain('fable')
    expect(result.line).toContain('server')
  })

  it('does not call a reply that echoes the other side a success', async () => {
    // An older build that reused `remote_enabled_changed` without honouring the new params, or a
    // bridge pointed at the wrong box, both land here — and both would otherwise be reported as
    // "done" while the remote kept its old side.
    const result = await pushKeybindings(accepts([], 'local'), {
      remote_id: 'fable',
      keybindings: 'server'
    })

    expect(result.applied).toBe(false)
    expect(result.line).toContain('answered local')
  })

  it('surfaces the server’s own code, because remote_not_found is a different repair', async () => {
    const sent: Sent[] = []
    const refusing = api(sent, () =>
      Promise.reject(
        new JsonApiError('remote.set_keybindings', 'remote_not_found', 'remote not found')
      )
    )
    const result = await pushKeybindings(refusing, { remote_id: 'fable', keybindings: 'server' })

    expect(result.applied).toBe(false)
    expect(result.line).toContain('remote_not_found')
    // The request was still made: "the server said no" and "nothing was sent" are the two states
    // this function exists to keep apart.
    expect(sent).toHaveLength(1)
  })

  it('says nothing was sent when the remote is not dialled, rather than claiming success', async () => {
    const result = await pushKeybindings(null, { remote_id: 'fable', keybindings: 'server' })

    expect(result.applied).toBe(false)
    expect(result.line).toContain('not connected')
    expect(result.line).toContain('stored as server')
  })
})
