// Not from orca. The device id is the registry key on every server (`sender/push_tokens.py` keys a
// file by it), so what matters here is that it is *stable* and that it is always a legal filename.
import { describe, expect, it } from 'vitest'
import { DEVICE_ID_STORAGE_KEY, loadPushDeviceId, mintDeviceId } from './push-device-id'
import { DEVICE_ID_PATTERN } from './push-token-registration'

function store(initial: string | null = null) {
  const state = { value: initial, writes: 0 }
  return {
    state,
    getItem: async (key: string) => (key === DEVICE_ID_STORAGE_KEY ? state.value : null),
    setItem: async (key: string, value: string) => {
      if (key === DEVICE_ID_STORAGE_KEY) {
        state.value = value
        state.writes += 1
      }
    }
  }
}

describe('push device id', () => {
  it('mints ids that are legal filenames by construction', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(DEVICE_ID_PATTERN.test(mintDeviceId())).toBe(true)
    }
  })

  it('is stable across launches — a rotating id would leave a dead entry per launch', async () => {
    const backing = store()
    const first = await loadPushDeviceId(backing)
    const second = await loadPushDeviceId(backing)
    expect(second).toBe(first)
    expect(backing.state.writes).toBe(1)
  })

  it('replaces a stored value that could never register again', async () => {
    const backing = store('../not a device id')
    const id = await loadPushDeviceId(backing)
    expect(DEVICE_ID_PATTERN.test(id)).toBe(true)
    expect(backing.state.value).toBe(id)
  })

  it('still produces an id when the store refuses to answer', async () => {
    const broken = {
      getItem: async () => {
        throw new Error('keystore unavailable')
      },
      setItem: async () => {
        throw new Error('keystore unavailable')
      }
    }
    expect(DEVICE_ID_PATTERN.test(await loadPushDeviceId(broken))).toBe(true)
  })
})
