// Not from orca (orca's settings screen writes a relay pairing to its own host store and has no
// server to tell). This is the second half of mockup #7: the phone's registry entry is saved by
// `./remote-form.ts` + the keystore, and *this* is what tells the remote about it.
//
// Split out of `app/settings.tsx` for the reason `./remote-form.ts` was: what makes this worth
// having is a set of decisions about which answer means what, and a decision only a mounted screen
// can reach is a decision nobody re-checks. The screen renders the line this returns.
//
// ⚠️ The one fact that shapes every branch below: `remote.set_keybindings` resolves `remote_id`
// against the **answering server's** registry — `handle_remote_set_keybindings` calls
// `state.remote_registry.set_keybindings` (`src/app/api/remotes.rs`), and that registry is what
// `remote.list` returns verbatim (`src/app/api/remotes.rs:10-17`). A server does **not** list
// itself: the multi-remote client synthesises its own box as `ServerId::main()` outside the
// registry (`src/client/supervisor.rs:911-919`). So this call succeeds exactly when the remote the
// phone is editing is *also* a registry entry on the box that answers, and the user is told which
// of those two worlds they are in rather than being shown a control that quietly does nothing.
import { JsonApiClient, JsonApiError } from '@herdr/client-ts'
import { REMOTE_SET_KEYBINDINGS, type RemoteSetKeybindingsParams } from '../api/herdr-api-types'

/** Whatever holds a `request`. Structural so a test can script an answer without a socket. */
export type KeybindingsApi = Pick<JsonApiClient, 'request'>

export type KeybindingsPush = {
  /** True only when a request left the phone *and* the server accepted it. */
  applied: boolean
  /** One line for the settings screen, already phrased. Never contains the remote's key material. */
  line: string
}

/**
 * Pushes one remote's `keybindings` to the server that manages it, and describes what happened.
 *
 * `api` is `null` when that remote is not dialled. That is not an error and not a silent success:
 * the value is in the phone's keystore either way, and the line says so — the alternative is an
 * app that claims to have changed something on a box it is not talking to.
 */
export async function pushKeybindings(
  api: KeybindingsApi | null,
  params: RemoteSetKeybindingsParams
): Promise<KeybindingsPush> {
  const { remote_id: remoteId, keybindings } = params
  if (api === null) {
    return {
      applied: false,
      line: `keybindings · stored as ${keybindings} — ${remoteId} is not connected, so nothing was sent`
    }
  }
  let result: { type: string } & Record<string, unknown>
  try {
    result = await api.request(REMOTE_SET_KEYBINDINGS, { ...params })
  } catch (error) {
    // A `JsonApiError` is the server's own verdict and its code is the useful half —
    // `remote_not_found` means "this box does not manage that remote", which is a different repair
    // from a dead channel. Anything else is the transport, and its message is all there is.
    const reason =
      error instanceof JsonApiError
        ? `${error.code}`
        : error instanceof Error
          ? error.message
          : String(error)
    return { applied: false, line: `keybindings · ${remoteId} refused ${keybindings}: ${reason}` }
  }
  // The reply carries the updated definition, so the value is *read back* rather than assumed. A
  // server that answered something else — an older build reusing the type, a bridge to the wrong
  // box — would otherwise be indistinguishable from one that did the work.
  const echoed = (result['remote'] as { keybindings?: unknown } | undefined)?.keybindings
  if (echoed !== keybindings) {
    return {
      applied: false,
      line: `keybindings · ${remoteId} answered ${String(echoed)}, not ${keybindings}`
    }
  }
  return { applied: true, line: `keybindings · ${remoteId} now uses ${keybindings} keybindings` }
}
