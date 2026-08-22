// Ported from orca mobile/src/components/bottom-drawer-mount-state.test.ts
// at commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e (github.com/stablyai/orca).
// MIT License, Copyright (c) 2026 Lovecast Inc. — see mobile/THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest'
import { resolveBottomDrawerMounted } from './bottom-drawer-mount-state'

describe('resolveBottomDrawerMounted', () => {
  it('mounts before opening and stays mounted while closing', () => {
    expect(resolveBottomDrawerMounted(true, false)).toBe(true)
    expect(resolveBottomDrawerMounted(true, true)).toBe(true)
    expect(resolveBottomDrawerMounted(false, true)).toBe(true)
    expect(resolveBottomDrawerMounted(false, false)).toBe(false)
  })
})
