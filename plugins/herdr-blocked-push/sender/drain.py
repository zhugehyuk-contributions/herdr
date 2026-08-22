#!/usr/bin/env python3
"""Drain the blocked queue and hand each record to a notification adapter.

This is a separate process on purpose. The herdr event hook that fills the queue runs
inside herdr's plugin runtime, which has **no timeout, no retry and no dead-letter path**:
`start_plugin_command` spawns a thread that `child.wait()`s with no deadline
(`src/app/api/plugins/runtime.rs:121-172`), and the only backstop is the 32-in-flight cap
(`runtime.rs:12`, enforced at `runtime.rs:82-100`) which *drops* the invocation once hit.
Anything that can block on a network round trip therefore has to live out here, where a
launchd/systemd job owns the schedule and this file owns the retry semantics.

Delivery semantics: at-least-once at the transport, effectively-once at the adapter.
  * A byte cursor makes a normal run cheap.
  * A ledger of sent record ids makes a replayed cursor harmless.
  * A per-pane coalesce window absorbs the duplicate `blocked` events herdr legitimately
    emits for one blocked episode -- `emit_pane_state_update` fires the event when the
    *presentation* changed even if the status did not (`src/app/api.rs:645-646`).
  * An adapter failure stops the run without advancing the cursor, so the next run retries.
"""

import argparse
import errno
import fcntl
import json
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import adapters  # noqa: E402  (path shim above is deliberate: no packaging, no deps)

#: One notification per pane per minute.
#:
#: This window exists because `emit_pane_state_update` re-fires `pane.agent_status_changed` when
#: only the *presentation* changed and the status is still `blocked` (`src/app/api.rs:645-646`,
#: where the condition is `previous_agent_status != agent_status || previous_presentation !=
#: presentation`, and `EffectivePresentation` is title + display_agent + state_labels --
#: `src/terminal/metadata.rs:40-44`). The hook cannot collapse those: it is a fresh process per
#: event and has no memory of the previous one.
#:
#: 60 seconds, and the number is chosen rather than felt:
#:
#: * **Nobody has measured the duplicate rate**, here or anywhere in this repo. `receipt/`'s live
#:   run drives two distinct blocked transitions and observes exactly two records, so it has never
#:   reproduced a presentation-only re-fire at all. A window justified by a made-up rate would be a
#:   made-up window.
#: * What *is* known from the code is the shape: presentation changes are driven by the pane's own
#:   output (terminal title, agent labels), and a pane that is blocked has by definition stopped
#:   producing output. The duplicates therefore cluster around the transition instant; they are a
#:   burst, not a stream. Any window comfortably longer than that burst absorbs the same set.
#: * So the window should be set by its *cost*, which is over-suppression: a genuine second block
#:   inside the window is silent. 60s is the project's own already-accepted latency budget for
#:   noticing a blocked agent -- milestone M2 (a) is "blocked를 Agents 홈에서 60초 내 발견"
#:   (`mobile/.prd/04-milestones.md`). Choosing anything larger would make the push path worse than
#:   the polling path the app already ships, which is the one comparison that is not a guess.
#: * The residual is small for a second reason: the app polls every 4 seconds while it is in the
#:   foreground (`mobile/src/api/use-foreground-refresh.ts`, `FOREGROUND_REFRESH_MS`). The
#:   suppressed case -- a re-block within a minute of the last one -- is overwhelmingly the case
#:   where the user just answered from the phone and is still looking at it, which is exactly the
#:   interval the poll covers. Push is for when they are not.
#:
#: It was 300. That was inherited, not derived, and 300 silences the answer-and-re-block loop that
#: this whole milestone exists to serve.
DEFAULT_COALESCE_SECONDS = 60
DEFAULT_MAX_AGE_SECONDS = 3600
DEFAULT_LEDGER_MAX = 2000


def _read_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (IOError, OSError, ValueError):
        return fallback


def _write_json_atomic(path, value):
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(value, handle)
    os.replace(tmp, path)


class Ledger:
    """Bounded set of already-delivered record ids, newest last."""

    def __init__(self, path, limit):
        self.path = path
        self.limit = limit
        self.ids = _read_json(path, [])
        if not isinstance(self.ids, list):
            self.ids = []
        self.seen = set(self.ids)

    def __contains__(self, record_id):
        return record_id in self.seen

    def add(self, record_id):
        if record_id in self.seen:
            return
        self.ids.append(record_id)
        self.seen.add(record_id)
        if len(self.ids) > self.limit * 2:
            self.ids = self.ids[-self.limit :]
            self.seen = set(self.ids)

    def save(self):
        _write_json_atomic(self.path, self.ids)


def _resolve_paths(args):
    state_dir = args.state_dir or os.environ.get("HERDR_PLUGIN_STATE_DIR")
    if not state_dir:
        raise SystemExit("drain: pass --state-dir or set HERDR_PLUGIN_STATE_DIR")
    queue = os.environ.get("HERDR_BLOCKED_PUSH_QUEUE") or os.path.join(state_dir, "queue.ndjson")
    config_path = (
        args.config
        or os.environ.get("HERDR_BLOCKED_PUSH_CONFIG")
        or os.path.join(os.environ.get("HERDR_PLUGIN_CONFIG_DIR", state_dir), "sender.json")
    )
    return state_dir, queue, config_path


def _load_config(config_path, dry_run):
    config = _read_json(config_path, {})
    if not isinstance(config, dict):
        raise SystemExit("drain: {} is not a JSON object".format(config_path))
    spec = {"type": "null"} if dry_run else config.get("adapter", {"type": "null"})
    return config, adapters.build(spec)


def _acquire_lock(state_dir):
    """One sender at a time. A second run exits 0 rather than double-sending."""
    os.makedirs(state_dir, exist_ok=True)
    handle = open(os.path.join(state_dir, "drain.lock"), "a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (IOError, OSError) as err:
        if err.errno in (errno.EAGAIN, errno.EACCES):
            return None
        raise
    return handle


def build_payload(record, remote_id):
    """Render one queue record into the adapter payload, including the deep link.

    URL contract (see README.md#deep-link): `herdr:///h/<remote_id>/pane/<pane_id>`, which
    is the app's `mobile/app/h/[remoteId]/pane/[paneId].tsx` route under the `herdr` scheme
    declared in `mobile/app.json`. `remote_id` is the app's id for this machine, not the
    machine's hostname -- the mapping lives in the sender config because the desktop has no
    way to know what the phone calls it.

    Both segments are percent-encoded. herdr pane ids contain a colon (`w1:p1`), which is a
    legal path character but is exactly the kind of thing URL parsers disagree about; the
    router hands the segment back decoded, so encoding here costs nothing.
    """
    agent = record.get("display_agent") or record.get("agent") or "agent"
    where = record.get("title") or record.get("pane_id")
    return {
        "title": "{} is blocked".format(agent),
        "body": "{} needs an answer in {}".format(agent, where),
        "url": "herdr:///h/{}/pane/{}".format(
            urllib.parse.quote(str(remote_id), safe=""),
            urllib.parse.quote(record["pane_id"], safe=""),
        ),
        "record": record,
    }


def _resume_offset(queue_path, cursor):
    """Where this pass should start reading, and the inode it is reading.

    A byte offset alone is only meaningful against the file it was measured on. If the queue
    was rotated (new inode) or truncated in place, resuming at the old offset would read
    from the middle of unrelated bytes. Both cases restart at 0; the ledger is what keeps
    the restart from re-notifying anything already delivered.
    """
    try:
        stat = os.stat(queue_path)
    except OSError:
        return 0, None
    offset = cursor.get("offset", 0) if isinstance(cursor, dict) else 0
    previous_ino = cursor.get("ino") if isinstance(cursor, dict) else None
    if previous_ino is not None and previous_ino != stat.st_ino:
        offset = 0
    elif offset > stat.st_size:
        offset = 0
    return offset, stat.st_ino


def _iter_complete_lines(queue_path, offset):
    """Yield (line, end_offset) for complete lines only; a partial tail is left for later."""
    if not os.path.exists(queue_path):
        return
    with open(queue_path, "rb") as handle:
        handle.seek(offset)
        buffered = handle.read()
    start = 0
    while True:
        newline = buffered.find(b"\n", start)
        if newline < 0:
            return
        yield buffered[start:newline], offset + newline + 1
        start = newline + 1


def drain_once(state_dir, queue_path, config, adapter, now_ms):
    cursor_path = os.path.join(state_dir, "cursor.json")
    coalesce_path = os.path.join(state_dir, "coalesce.json")
    ledger = Ledger(
        os.path.join(state_dir, "sent.json"), int(config.get("ledger_max", DEFAULT_LEDGER_MAX))
    )
    coalesce_window_ms = int(config.get("coalesce_seconds", DEFAULT_COALESCE_SECONDS)) * 1000
    max_age_ms = int(config.get("max_age_seconds", DEFAULT_MAX_AGE_SECONDS)) * 1000
    remote_id = config.get("remote_id") or os.uname().nodename
    coalesce = _read_json(coalesce_path, {})
    if not isinstance(coalesce, dict):
        coalesce = {}

    offset, ino = _resume_offset(queue_path, _read_json(cursor_path, {}))
    stats = {
        "read": 0,
        "notified": 0,
        "duplicate": 0,
        "coalesced": 0,
        "stale": 0,
        "malformed": 0,
        "offset": offset,
    }
    failure = None

    for raw, end_offset in _iter_complete_lines(queue_path, offset):
        stats["read"] += 1
        try:
            record = json.loads(raw.decode("utf-8"))
            record_id = record["id"]
            pane_key = "{}|{}".format(record.get("host", "?"), record["pane_id"])
        except (ValueError, KeyError, TypeError) as err:
            # A poison line must not wedge the queue forever.
            sys.stderr.write("drain: skipping malformed record: {}\n".format(err))
            stats["malformed"] += 1
            stats["offset"] = end_offset
            continue

        if record_id in ledger:
            stats["duplicate"] += 1
        elif max_age_ms > 0 and now_ms - int(record.get("ts_ms", 0)) > max_age_ms:
            stats["stale"] += 1
            ledger.add(record_id)
        elif now_ms - int(coalesce.get(pane_key, 0)) < coalesce_window_ms:
            stats["coalesced"] += 1
            ledger.add(record_id)
        else:
            try:
                adapter.send(build_payload(record, remote_id))
            except adapters.AdapterError as err:
                failure = str(err)
                break
            ledger.add(record_id)
            coalesce[pane_key] = record.get("ts_ms", now_ms)
            stats["notified"] += 1
        stats["offset"] = end_offset

    # Forget coalesce entries that can no longer suppress anything.
    coalesce = {
        key: value
        for key, value in coalesce.items()
        if now_ms - int(value) < max(coalesce_window_ms, 1)
    }
    ledger.save()
    _write_json_atomic(coalesce_path, coalesce)
    _write_json_atomic(cursor_path, {"offset": stats["offset"], "ino": ino})
    if failure:
        stats["error"] = failure
    return stats


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config")
    parser.add_argument("--state-dir")
    parser.add_argument("--dry-run", action="store_true", help="use the null adapter")
    parser.add_argument(
        "--interval",
        type=float,
        default=0,
        help="seconds between passes; 0 (default) makes this a one-shot for launchd/systemd",
    )
    args = parser.parse_args(argv)

    state_dir, queue_path, config_path = _resolve_paths(args)
    config, adapter = _load_config(config_path, args.dry_run)
    lock = _acquire_lock(state_dir)
    if lock is None:
        print(json.dumps({"skipped": "another drain holds the lock"}))
        return 0

    try:
        while True:
            stats = drain_once(state_dir, queue_path, config, adapter, int(time.time() * 1000))
            print(json.dumps(stats, sort_keys=True))
            sys.stdout.flush()
            if args.interval <= 0:
                return 1 if "error" in stats else 0
            time.sleep(args.interval)
    finally:
        lock.close()


if __name__ == "__main__":
    raise SystemExit(main())
