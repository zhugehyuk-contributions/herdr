# herdr-mx.blocked-push

Push a phone notification when an agent goes **blocked**, and land the tap on the pane that
is asking. This is the desktop half of mobile milestone M5 (`mobile/.prd/04-milestones.md`).

Two processes, on purpose:

| | what it does | why it is separate |
|---|---|---|
| **hook** (`hooks/enqueue.sh` + `hooks/enqueue.py`) | herdr runs it on `pane.agent_status_changed`; it appends one line to a queue file and exits | it runs inside herdr's plugin runtime, which has **no timeout, no retry, no dead-letter path** — `start_plugin_command` spawns a thread and `child.wait()`s with no deadline (`src/app/api/plugins/runtime.rs:121-172`). Anything that can block on a network round trip cannot live there. |
| **sender** (`sender/drain.py`) | a launchd/systemd job drains the queue and calls a notification adapter | it owns the schedule, the retries and the failure modes, where they are allowed to be slow |

## Why only `blocked`

`done` is not a device-independent fact. It is `(AgentState::Idle, seen == false)`
(`src/app/api_helpers.rs:101`), and `seen` flips to true the moment the desktop's active
tab shows that pane (`src/app/actions.rs:3113-3117`). A `done` push therefore races the
desktop and fires for things the user already saw. `blocked` does not depend on `seen` at
all (`api_helpers.rs:104`), so it is the only status worth pushing in v1. The stage-1 shell
filter and the stage-2 parser both enforce that, and the receipt asserts it against a server
that demonstrably passed through `working`, `idle` and `done`.

## Why the hook path and not `events.subscribe`

Event hooks run **before** the event reaches the subscription hub:
`emit_event` calls `run_plugin_event_hooks(&event)` and only then `event_hub.push(event)`
(`src/app/api.rs:818-820`). So the hook is upstream of the ring buffer, upstream of the
per-subscription replay, and upstream of the poll-rate cap that blocker **B9**
(`mobile/.prd/03-blockers.md`) is about. It cannot miss an event to eviction.

It is not unconditional, though: herdr drops a hook invocation once 32 plugin commands are
in flight (`src/app/api/plugins/runtime.rs:12` and `:82-100`). That is the one loss mode,
and it is why the hook must stay a few milliseconds long.

## Install

```bash
herdr plugin link /path/to/herdr/plugins/herdr-blocked-push
herdr plugin list --json
```

No server restart. `run_plugin_event_hooks` re-reads the on-disk registry on every hookable
event (`src/app/api/plugins/runtime.rs:223` → `plugins/mod.rs:39-46`), so a link takes effect
on the next status change.

Paths herdr picks for the plugin:

* queue: `$HERDR_PLUGIN_STATE_DIR/queue.ndjson`, i.e.
  `~/.local/state/herdr/plugins/herdr-mx.blocked-push/queue.ndjson`
  (`herdr-dev` instead of `herdr` for a debug build — `src/config/io.rs:22-28`).
* config: `herdr plugin config-dir herdr-mx.blocked-push` → put `sender.json` there.

Requirements: a POSIX `sh` and `python3` on `PATH` (stdlib only, works on 3.9+). Set
`HERDR_BLOCKED_PUSH_PYTHON` if `python3` is not the interpreter you want.

## Sender config

`sender.json`:

```json
{
  "remote_id": "fable",
  "adapter": {
    "type": "expo",
    "tokens_dir": "~/.config/herdr/plugins/config/herdr-mx.blocked-push/push-tokens.d",
    "access_token": "${EXPO_ACCESS_TOKEN}"
  },
  "coalesce_seconds": 60,
  "max_age_seconds": 3600,
  "ledger_max": 2000
}
```

Put this file where `herdr plugin config-dir herdr-mx.blocked-push` prints, and point the launchd
job at it with `--config`. That directory is also where the phone registers (below), so keeping the
two together is what stops `tokens_dir` from pointing at a directory nobody writes.

* `remote_id` — the id **the phone** uses for this machine, i.e. an `extra.herdrRemotes[].id`
  in `mobile/app.json`. It is not the hostname: the desktop has no way to know what the app
  calls it, so the mapping is declared here. Defaults to `uname -n`.
* `coalesce_seconds` — one notification per pane per window. This is not optional polish:
  `emit_pane_state_update` re-emits `pane.agent_status_changed` when only the *presentation*
  changed, with the status still `blocked` (`src/app/api.rs:645-646`), so one blocked episode
  can enqueue several records. Default **60**; `sender/drain.py` carries the derivation, and the
  short version is that the duplicates are a burst around the transition while the cost of the
  window is silencing a genuine re-block, so it is pinned to the 60s discovery budget the mobile
  milestones already accept for the same fact.
* `max_age_seconds` — records older than this are acked without notifying, so a laptop that
  was asleep for a day does not wake up and fire a hundred pushes.

Run it:

```bash
python3 sender/drain.py                 # one shot, for launchd/systemd
python3 sender/drain.py --interval 15   # foreground loop
python3 sender/drain.py --dry-run       # null adapter, prints the stats line
```

Delivery is at-least-once at the transport and effectively-once at the adapter: a byte
cursor (invalidated by inode change or truncation) makes the common pass cheap, a ledger of
delivered record ids makes a replayed cursor harmless, and an adapter that raises stops the
pass without advancing the cursor so the next run retries.

### launchd (macOS)

`~/Library/LaunchAgents/dev.herdr.blocked-push.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>dev.herdr.blocked-push</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string>
    <string>/path/to/plugins/herdr-blocked-push/sender/drain.py</string>
    <string>--state-dir</string>
    <string>/Users/you/.local/state/herdr/plugins/herdr-mx.blocked-push</string>
  </array>
  <key>StartInterval</key><integer>15</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
```

### systemd (Linux)

A `blocked-push.service` of `Type=oneshot` running the same argv, plus a
`blocked-push.timer` with `OnUnitActiveSec=15s`.

## Adapters

`sender/adapters.py` — an adapter is anything with `send(payload)` that raises on failure.

| type | ships here | use |
|---|---|---|
| `expo` | yes | **the real one.** Sends to every device in the token registry through Expo's push service. Needs `tokens_dir`; `access_token` is strongly recommended. |
| `file` | yes | appends the payload as NDJSON. What the receipt asserts against. |
| `command` | yes | runs an argv with the payload on stdin and in `HERDR_PUSH_TITLE`/`_BODY`/`_URL`/`_JSON`. The escape hatch: credentials stay in *your* script, not in this repo. |
| `null` | yes | `--dry-run`. |

`expo` is the one that ships, and the choice is argued at length on the class itself
(`sender/adapters.py`, `ExpoPushAdapter`). The short form: the sender is stdlib-only on purpose, and
APNs (ES256 JWT) and FCM v1 (RS256 JWT) both need a signature the standard library cannot produce,
while Expo's endpoint is one JSON POST. ntfy/Pushover need no app work but the tap then opens *their*
app, which loses the deep link — i.e. loses half of M5's acceptance criterion.

Still not implemented, and each is a `command` adapter away:

* **APNs directly** (`api.push.apple.com`) — for when the app leaves Expo's push service. Apple
  Developer team, `.p8` auth key, key id, team id, the `dev.herdr.mobile` bundle id, and a JWT
  signer (`cryptography`, or a small Rust/Go helper invoked through `command`).
* **FCM** — only if an Android build stops using Expo push.

Note what `expo` does *not* remove: Expo's servers, and then Apple's or Google's, see each
notification's title, body and `data`. On this path that is pane titles and agent names, never
terminal contents. A deployment that cannot accept that wants a self-hosted relay behind `command`.

## Push tokens

The registry is a directory of one JSON file per device:

```
$(herdr plugin config-dir herdr-mx.blocked-push)/push-tokens.d/<device-id>.json
```

**Nothing on this side writes it.** The phone does, on every launch, by exec'ing a short `sh`
command over the ssh connection it already authenticated on
(`mobile/src/notifications/push-token-registration.ts` composes the command and argues the choice;
`sender/push_tokens.py` parses the result). That is the answer to "how does the desktop learn the
phone's address": it does not need a relay, a pairing code or a pasted string, because the phone
already proves possession of an ssh key to every one of these hosts — a strictly stronger credential
than the token being delivered.

Consequences worth knowing:

* Re-registration **overwrites** by device id, so a rotated Expo token (reinstall, some OS upgrades)
  heals itself on the next launch instead of silently pushing to a dead address forever.
* A `DeviceNotRegistered` ticket **deletes** the file. That is the only correct response — the
  address is gone and no retry can bring it back.
* An empty registry makes the adapter *raise*, not ack, so records wait in the queue until the phone
  has registered. `max_age_seconds` is what retires a backlog nobody ever claimed.

## Deep link

Canonical form, emitted as `payload.url`:

```
herdr:///h/<remote_id>/pane/<pane_id>
```

* `herdr` is the scheme declared in `mobile/app.json` (`expo.scheme`).
* `/h/<remoteId>/pane/<paneId>` is the existing app route,
  `mobile/app/h/[remoteId]/pane/[paneId].tsx`.
* The empty authority (`:///`) is deliberate. `herdr://h/x/pane/y` parses the `h` as a host
  in strict URL parsers and as a path segment in Expo's linking layer; `:///` means one thing
  everywhere.
* Both segments are percent-encoded. herdr pane ids contain a colon (`w1:p1` →
  `w1%3Ap1`); the router hands the segment back decoded.
* The record also carries `workspace_id`, `host` and `session`, so a richer route can be
  derived later without changing the queue schema (`v` is bumped if it is).

The app side of this (registering the handler, routing a cold start) is owned by the mobile
agent; this side only guarantees the URL.

## No network from the hook

Three independent pieces, all re-run by `receipt/run_receipt.py`:

1. **Static, and decisive for the language.** `receipt/assert_no_network_imports.py` parses
   `hooks/enqueue.py` and fails on any import outside `{json, os, sys, time}`, on
   `os.system`/`os.popen`/`os.exec*`, and on `eval`/`exec`/`__import__`. A pure-Python script
   that imports none of `socket`, `ssl`, `subprocess`, `ctypes`, `urllib`, `http`, `asyncio`
   has no expressible way to open a socket. The shell stage is scanned for
   `curl`/`wget`/`nc`/`ssh`/`openssl`/`http`.
2. **Dynamic.** The receipt links a copy of this plugin whose hook command is wrapped in
   `sandbox-exec -f receipt/no-network.sb`, which is `(allow default) (deny network*)`. The
   real server then fires the real hook, and the queue still fills with every hook invocation
   exiting 0. Measured: under that profile a `connect()` to `1.1.1.1:53` **and** a `connect()`
   to an existing AF_UNIX socket both fail with `EPERM` — so this also proves the hook never
   calls back into herdr's own API socket.
3. **Positive control.** The same profile is applied to a canary that does try to connect, and
   the receipt fails if the canary succeeds. Without this, (2) would also pass against a
   sandbox that silently did nothing.

## Receipts

```bash
rustup run 1.96.1 cargo build --locked --bin herdr    # once
python3 receipt/test_drain.py                         # sender semantics, no server
python3 receipt/run_receipt.py                        # isolated live server, end to end
```

`run_receipt.py` spawns its **own** herdr server under an isolated
`XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_RUNTIME_DIR`/`HERDR_SOCKET_PATH`, links the plugin
into *that* registry, drives real status transitions, and tears the server down by pid. It
contains no `pkill`, no `killall` and no pattern-based process match, and it prints the
user's herdr pid set before and after.

## Known limits

* Unix only (`platforms = ["linux", "macos"]`). The seatbelt half of the no-network proof is
  macOS-specific; the Linux equivalent is `unshare -rn`.
* A burst past 32 concurrent plugin commands drops hook invocations
  (`src/app/api/plugins/runtime.rs:82-100`). Nothing in this plugin can fix that; keeping the
  hook at a couple of milliseconds is the mitigation.
* The queue grows forever. The sender advances a cursor but never truncates, because
  truncating races the appending hook. Rotate it out of band; the cursor detects the new
  inode and the ledger prevents redelivery.
* Coalescing is a time window, not an episode boundary, because the hook deliberately does
  not record non-blocked transitions. A genuine re-block inside the window is suppressed.
