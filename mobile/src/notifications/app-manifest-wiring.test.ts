// The manifest half of M5, asserted against the code that depends on it.
//
// M5's app code landed complete and was wired into nothing: 1472 lines shipped, and `grep` for
// them outside their own directory returned zero. This file is the counter-pressure for the piece
// of that milestone which lives in `app.json` rather than in TypeScript, where no import can reach
// it and no type can check it.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// `use-blocked-push` reaches for `Platform`, which drags in react-native's Flow-typed entry point;
// this file wants one exported string out of that module and nothing else. Same shape the mount
// tests use (`src/app-shell/settings-mount.test.tsx:60`).
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }))

import { BLOCKED_CHANNEL_ID } from './use-blocked-push'

interface PluginProps {
  defaultChannel?: string
}

type PluginEntry = string | [string, PluginProps?]

function plugins(): PluginEntry[] {
  const manifest = fileURLToPath(new URL('../../app.json', import.meta.url))
  const config = JSON.parse(readFileSync(manifest, 'utf8')) as {
    expo?: { plugins?: PluginEntry[] }
  }
  return config.expo?.plugins ?? []
}

function entry(name: string): PluginEntry | undefined {
  return plugins().find((p) => (Array.isArray(p) ? p[0] : p) === name)
}

describe('app.json wires the notification plugin', () => {
  it('lists expo-notifications', () => {
    // Without the config plugin the native side is never prepared: no iOS `aps-environment`, and
    // on Android none of the FCM meta-data. The JS in `use-blocked-push.ts` still imports cleanly
    // and still reports a state, so the absence is invisible from inside the app — which is why
    // this assertion is on the file and not on a behaviour.
    expect(entry('expo-notifications')).toBeDefined()
  })

  it('points the FCM default channel at the channel the app actually creates', () => {
    // `setNotificationChannelAsync(BLOCKED_CHANNEL_ID, { importance: HIGH })` runs at startup, and
    // Android reads heads-up behaviour off the channel rather than off the notification. A default
    // channel naming anything else sends a push that arrives while the app has never run to the
    // low-importance tray — silent, which is the one outcome M5 exists to prevent.
    const found = entry('expo-notifications')
    expect(Array.isArray(found)).toBe(true)
    expect((found as [string, PluginProps])[1]?.defaultChannel).toBe(BLOCKED_CHANNEL_ID)
  })
})
