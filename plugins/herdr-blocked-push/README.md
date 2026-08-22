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
  "adapter": { "type": "command", "argv": ["/usr/local/bin/my-push.sh"] },
  "coalesce_seconds": 300,
  "max_age_seconds": 3600,
  "ledger_max": 2000
}
```

* `remote_id` — the id **the phone** uses for this machine, i.e. an `extra.herdrRemotes[].id`
  in `mobile/app.json`. It is not the hostname: the desktop has no way to know what the app
  calls it, so the mapping is declared here. Defaults to `uname -n`.
* `coalesce_seconds` — one notification per pane per window. This is not optional polish:
  `emit_pane_state_update` re-emits `pane.agent_status_changed` when only the *presentation*
  changed, with the status still `blocked` (`src/app/api.rs:645-646`), so one blocked episode
  can enqueue several records.
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
| `file` | yes | appends the payload as NDJSON. What the receipt asserts against. |
| `command` | yes | runs an argv with the payload on stdin and in `HERDR_PUSH_TITLE`/`_BODY`/`_URL`/`_JSON`. The escape hatch: credentials stay in *your* script, not in this repo. |
| `null` | yes | `--dry-run`. |

**What a real deployment still needs** — none of these are implemented here, because each one
needs credentials and an outbound call:

* **Expo push** (`https://exp.host/--/api/v2/push/send`) — lowest friction while the app is an
  Expo build. Needs an `ExpoPushToken` obtained by the app and handed to this machine; no
  Apple/Google account work. This is the one to build first.
* **APNs directly** (`api.push.apple.com`) — needed once the app leaves Expo's push service.
  Requires an Apple Developer team, a `.p8` auth key, key id, team id, and the
  `dev.herdr.mobile` bundle id, plus a JWT signer (`cryptography` or a small Rust/Go helper).
* **ntfy / Pushover / Gotify** — a self-hosted or third-party topic. No app work at all beyond
  installing their client, but then the tap opens *their* app, so the deep link below is lost.
  Fine as a stopgap, wrong as the destination.
* **FCM** — only if an Android build stops using Expo push.

Until one exists, `command` covers all of them without changing this code.

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
