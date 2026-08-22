#!/usr/bin/env python3
"""Stage 2 of the `pane.agent_status_changed` hook: append one blocked record to the queue.

Contract with herdr (all verified against the tree this ships in, not assumed):

* `HERDR_PLUGIN_EVENT` is the dot name `pane.agent_status_changed`
  (`src/app/api/plugins/runtime.rs:59` + `src/api/schema/events.rs:253`).
* `HERDR_PLUGIN_EVENT_JSON` is `serde_json::to_string(&EventEnvelope)`
  (`src/app/api/plugins/runtime.rs:62` and `.../runtime.rs:236`), i.e.
  `{"event":"pane_agent_status_changed","data":{"type":"pane_agent_status_changed", ...}}`.
* The payload fields come from `EventData::PaneAgentStatusChanged`
  (`src/api/schema/events.rs:543-556`): `pane_id`, `workspace_id`, `agent_status`, and the
  optional `agent`, `title`, `display_agent`, `state_labels`.
* `HERDR_PLUGIN_STATE_DIR` already exists; herdr creates it before spawning the hook
  (`src/app/api/plugins/runtime.rs:34` -> `src/plugin_paths.rs:27`).

Only `blocked` is enqueued. `done` is deliberately excluded: it is not a device-independent
fact but `(AgentState::Idle, seen == false)` (`src/app/api_helpers.rs:104-105`), and the
`seen` bit flips as soon as the desktop looks at the pane (`src/app/actions.rs:1282`), so a
`done` push would race the desktop and fire for something the user already saw.

This module imports nothing that can open a socket. `os.uname().nodename` is used instead of
`socket.gethostname()`/`platform.node()` precisely so that the import list itself is evidence.
"""

import json
import os
import sys
import time

SCHEMA_VERSION = 1
PLUGIN_VERSION = "0.1.0"
# Records stay small so that a single O_APPEND write cannot interleave with a concurrent
# hook's write. Regular-file appends are already serialized by the inode lock on Linux and
# macOS; the cap keeps that true for any filesystem with a weaker guarantee, and keeps one
# runaway pane title from bloating the queue.
MAX_RECORD_BYTES = 2048
MAX_TEXT_CHARS = 200


def _fail(message):
    sys.stderr.write("herdr-mx.blocked-push: {}\n".format(message))
    raise SystemExit(1)


def _clip(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value:
        return None
    if len(value) > MAX_TEXT_CHARS:
        return value[: MAX_TEXT_CHARS - 1] + "…"
    return value


def _queue_path():
    override = os.environ.get("HERDR_BLOCKED_PUSH_QUEUE")
    if override:
        return override
    state_dir = os.environ.get("HERDR_PLUGIN_STATE_DIR")
    if not state_dir:
        _fail("HERDR_PLUGIN_STATE_DIR is unset; refusing to guess a queue location")
    return os.path.join(state_dir, "queue.ndjson")


def _build_record(envelope):
    data = envelope.get("data")
    if not isinstance(data, dict):
        _fail("event envelope has no object `data`")
    if data.get("agent_status") != "blocked":
        # Stage 1's substring test matched something else in the payload (a pane title, for
        # instance). Not an error -- this is the exact case stage 1 is allowed to be sloppy
        # about, because stage 2 is authoritative.
        raise SystemExit(0)

    pane_id = data.get("pane_id")
    workspace_id = data.get("workspace_id")
    if not isinstance(pane_id, str) or not pane_id:
        _fail("blocked event carried no pane_id")
    if not isinstance(workspace_id, str) or not workspace_id:
        _fail("blocked event carried no workspace_id")

    now_ms = int(time.time() * 1000)
    host = os.uname().nodename
    record = {
        "v": SCHEMA_VERSION,
        # Unique per emitted event, and stable if the sender replays the same line: the
        # sender's ledger keys on this. pid + ms disambiguates two hooks for one pane.
        "id": "{}:{}:{}:{}".format(host, pane_id, now_ms, os.getpid()),
        "ts_ms": now_ms,
        "host": host,
        "status": "blocked",
        "pane_id": pane_id,
        "workspace_id": workspace_id,
        "plugin_version": PLUGIN_VERSION,
    }
    session = _clip(os.environ.get("HERDR_SESSION"))
    if session:
        record["session"] = session
    for source_key, target_key in (
        ("agent", "agent"),
        ("display_agent", "display_agent"),
        ("title", "title"),
    ):
        clipped = _clip(data.get(source_key))
        if clipped:
            record[target_key] = clipped
    return record


def _append(queue_path, record):
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
    encoded = line.encode("utf-8")
    if len(encoded) > MAX_RECORD_BYTES:
        # Drop the free-text fields rather than the event.
        for key in ("title", "display_agent", "agent"):
            record.pop(key, None)
        record["truncated"] = True
        encoded = (
            json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        ).encode("utf-8")
    os.makedirs(os.path.dirname(queue_path) or ".", exist_ok=True)
    fd = os.open(queue_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        written = os.write(fd, encoded)
        if written != len(encoded):
            _fail("short write to {} ({} of {} bytes)".format(queue_path, written, len(encoded)))
    finally:
        os.close(fd)


def main():
    event_name = os.environ.get("HERDR_PLUGIN_EVENT")
    if event_name != "pane.agent_status_changed":
        _fail("unexpected HERDR_PLUGIN_EVENT {!r}".format(event_name))
    raw = os.environ.get("HERDR_PLUGIN_EVENT_JSON")
    if not raw:
        _fail("HERDR_PLUGIN_EVENT_JSON is unset")
    try:
        envelope = json.loads(raw)
    except ValueError as err:
        _fail("HERDR_PLUGIN_EVENT_JSON is not JSON: {}".format(err))
    if not isinstance(envelope, dict):
        _fail("event envelope is not an object")
    _append(_queue_path(), _build_record(envelope))


if __name__ == "__main__":
    main()
