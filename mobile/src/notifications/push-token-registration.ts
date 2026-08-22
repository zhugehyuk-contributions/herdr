// Not from orca. **How a herdr server learns this phone's push token**, which is the one design
// decision M5 could not avoid, because it is a security decision wearing a plumbing decision's
// clothes: the token is the address a push is sent to, the servers are the things that send, and
// something has to carry the first from the second's outside to its inside.
//
// The answer taken here: **over the ssh connection the app already has.** Not a relay, not a paste
// into `sender.json`, not a QR code.
//
//   · The phone already proves possession of an ssh key to every one of these hosts on every
//     launch (`modules/herdr-ssh/src/app-connections.ts`, `openConfiguredSshConnections`), and that
//     key is a *stronger* credential than the thing being delivered — it is shell access
//     (`.prd/03-blockers.md` B11). A channel that already carries the greater secret needs no new
//     trust to carry the lesser one, and no new secret is created by using it. The alternative that
//     `.prd/07` §6.7 left open — "2lab 인프라에 작은 HTTPS 릴레이를 세울지" — is a new internet-facing
//     service, a new credential and a new thing that can be down, bought for a capability the app
//     already holds.
//   · It is the only option that stays correct when the token rotates. An Expo push token is not
//     stable: it changes on reinstall, on some OS upgrades, and whenever the underlying FCM/APNs
//     token is reissued. A pasted token silently stops working, and the failure looks exactly like
//     "no agent got blocked". Re-registering on every launch makes rotation a non-event.
//   · It composes with the fleet instead of the cloud: N servers get told by the one client that
//     dials all N, with no central list of which phones exist.
//
// What it costs, stated rather than hidden: the registration runs as an `sh` exec on the remote, so
// the token is visible in that host's process table for the lifetime of the command, and it lands
// in a file under the plugin's config directory. Both are inside the trust boundary of a host where
// this phone can already open a shell. The token is a bearer capability to *send this device a
// notification* — it cannot read anything and it is not the ssh key.
//
// The one deployment shape this does not cover, and it is the open decision it is waiting on: if
// the user takes `.prd/07` §6.4's recommendation and pins the phone's key to
// `command="…bridge-dispatch"` in `authorized_keys`, this exec is dispatched through that wrapper
// like every other, and the wrapper has to allow it. That is the same one-line-per-server install
// that decision already implies; it is not an extra one.
import { shellQuote } from '@herdr/client-ts'

/** The plugin whose config directory holds the registry. Must match `herdr-plugin.toml`'s `id`. */
export const BLOCKED_PUSH_PLUGIN_ID = 'herdr-mx.blocked-push'

/** Sub-directory of the plugin config dir. Must match `sender/push_tokens.py`'s `TOKENS_DIRNAME`. */
export const TOKENS_DIRNAME = 'push-tokens.d'

/**
 * The device id doubles as a **filename** on the remote, so it is constrained to something that
 * cannot be a path, a flag, or a shell surprise even before `shellQuote` sees it. Rejecting is the
 * only handling: a device id that needs escaping is a bug in whatever generated it, not input.
 */
export const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

/** One line of the registry, as `sender/push_tokens.py` parses it. Bump `v` if this changes. */
export interface PushTokenRegistration {
  v: 1
  /** Always `expo`: an `ExponentPushToken[...]`, the only kind `sender/adapters.py` can send to. */
  type: 'expo'
  token: string
  device_id: string
  device_name?: string
  platform: string
  app_id?: string
  ts_ms: number
}

export interface RegisterCommandOptions {
  registration: PushTokenRegistration
  /** Absolute path to the remote `herdr`. Same field, same meaning as `HerdrSshRemoteConfig`. */
  herdrBinary?: string | undefined
  /** Same `env` prefix the bridge command uses, so herdr resolves the same config/state dirs. */
  env?: Record<string, string> | undefined
}

/**
 * The exact command the phone execs on one remote.
 *
 * Everything variable is a **positional argument**, not interpolated into the script, so the only
 * shell metacharacters the remote parses are ones this file wrote. The script body is a constant.
 *
 * Why `herdr plugin config-dir` rather than a hard-coded path: the destination is
 * `~/.local/state/…` or `~/.config/…` depending on build, `herdr-dev` on a debug build
 * (`src/config/io.rs:22-28`), and hashed for some plugin ids
 * (`src/plugin_paths.rs:16-19`). The one thing that always knows is the binary, and it will print
 * it (`src/cli/plugin.rs:88-101`) — and creates the directory while it is there
 * (`ensure_plugin_user_dirs`). Hard-coding that path is how the phone and the sender end up writing
 * and reading two different files and nobody notices for a week.
 *
 * Why the write is `printf` + `mv` rather than a shell redirect into the final name: the sender
 * reads this directory on a timer, and a half-written token file that parses as JSON-but-truncated
 * is a delivery that silently goes nowhere. `mv` within one directory is atomic.
 */
export function registerPushTokenCommand(options: RegisterCommandOptions): string {
  const { registration } = options
  if (!DEVICE_ID_PATTERN.test(registration.device_id)) {
    throw new Error(
      `device id ${JSON.stringify(registration.device_id)} is not [a-z0-9][a-z0-9-]{0,62}; ` +
        'it is used as a filename on the remote'
    )
  }
  if (registration.token.trim().length === 0) {
    throw new Error('refusing to register an empty push token')
  }
  const parts = ['exec']
  const env = options.env ?? {}
  const names = Object.keys(env)
  if (names.length > 0) {
    parts.push('env')
    for (const name of names) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(
          `${JSON.stringify(name)} is not a POSIX environment variable name; it cannot be ` +
            'passed to the remote `env`'
        )
      }
      parts.push(`${name}=${shellQuote(env[name] as string)}`)
    }
  }
  parts.push(
    'sh',
    '-c',
    shellQuote(REGISTER_SCRIPT),
    // `$0`. It is what shows up in the remote's process table, so it says what this is.
    'herdr-blocked-push-register',
    shellQuote(options.herdrBinary ?? 'herdr'),
    shellQuote(BLOCKED_PUSH_PLUGIN_ID),
    shellQuote(JSON.stringify(registration)),
    shellQuote(registration.device_id)
  )
  return parts.join(' ')
}

/**
 * `$1` herdr binary · `$2` plugin id · `$3` registration JSON · `$4` device id.
 *
 * `umask 077` before anything is created: the registry is inside the user's own config directory,
 * but a token readable by every account on a shared build box is a free "make this phone buzz"
 * button for anyone with a login.
 */
const REGISTER_SCRIPT = [
  'set -eu',
  'umask 077',
  `dir="$("$1" plugin config-dir "$2")/${TOKENS_DIRNAME}"`,
  'mkdir -p "$dir"',
  'printf %s "$3" > "$dir/$4.json.part"',
  'mv "$dir/$4.json.part" "$dir/$4.json"'
].join('; ')
