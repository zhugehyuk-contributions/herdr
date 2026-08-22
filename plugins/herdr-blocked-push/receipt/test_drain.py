#!/usr/bin/env python3
"""Regression tests for the drain sender's delivery semantics.

The end-to-end receipt (`run_receipt.py`) proves the happy path against a real server. These
cover the cases that are painful to stage there: a partially written queue line, an adapter
that fails, a rotated queue, a poison record, and the coalescing window. Standalone on
purpose -- no pytest, no dependencies, so it runs anywhere the sender itself runs.
"""

import json
import os
import shutil
import sys
import tempfile
import time

SENDER_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sender")
sys.path.insert(0, SENDER_DIR)

import adapters  # noqa: E402
import drain  # noqa: E402

NOW_MS = 1_700_000_000_000
FAILURES = []


def check(name, condition, detail=""):
    if condition:
        print("ok   {}".format(name))
    else:
        print("FAIL {} {}".format(name, detail))
        FAILURES.append(name)


def record(pane_id, ts_ms, record_id=None):
    return {
        "v": 1,
        "id": record_id or "host:{}:{}".format(pane_id, ts_ms),
        "ts_ms": ts_ms,
        "host": "host",
        "status": "blocked",
        "pane_id": pane_id,
        "workspace_id": "w1",
    }


class Case:
    def __init__(self, **config):
        self.dir = tempfile.mkdtemp(prefix="drain-test-")
        self.queue = os.path.join(self.dir, "queue.ndjson")
        self.state = os.path.join(self.dir, "state")
        os.makedirs(self.state)
        self.config = {"remote_id": "r", "coalesce_seconds": 0, "max_age_seconds": 0}
        self.config.update(config)

    def append(self, text):
        with open(self.queue, "a", encoding="utf-8") as handle:
            handle.write(text)

    def append_record(self, rec):
        self.append(json.dumps(rec) + "\n")

    def drain(self, adapter, now_ms=NOW_MS):
        return drain.drain_once(self.state, self.queue, self.config, adapter, now_ms)

    def cleanup(self):
        shutil.rmtree(self.dir, ignore_errors=True)


def test_partial_line_is_left_for_the_next_pass():
    case = Case()
    case.append_record(record("p1", NOW_MS))
    case.append_record(record("p2", NOW_MS))
    case.append('{"v":1,"id":"host:p3:3","ts_ms":3,"status":"blo')  # torn write
    sink = adapters.NullAdapter()
    first = case.drain(sink)
    check("partial: complete lines delivered", first["notified"] == 2, first)

    case.append('cked","pane_id":"p3","host":"host","workspace_id":"w1"}\n')
    second = case.drain(sink)
    check("partial: completed line delivered next pass", second["notified"] == 1, second)
    check("partial: no record delivered twice", len(sink.sent) == 3, len(sink.sent))
    case.cleanup()


def test_adapter_failure_retries_without_losing_the_record():
    case = Case()
    case.append_record(record("p1", NOW_MS))
    failing = adapters.build({"type": "command", "argv": ["/bin/sh", "-c", "exit 3"]})
    first = case.drain(failing)
    check("failure: nothing acked", first["notified"] == 0, first)
    check("failure: error surfaced", "error" in first, first)
    check("failure: cursor held at 0", first["offset"] == 0, first)

    sink = adapters.NullAdapter()
    second = case.drain(sink)
    check("failure: retried on the next pass", second["notified"] == 1, second)
    case.cleanup()


def test_repeated_passes_never_redeliver():
    case = Case()
    for index in range(3):
        case.append_record(record("p{}".format(index), NOW_MS))
    sink = adapters.NullAdapter()
    case.drain(sink)
    case.drain(sink)
    case.drain(sink)
    check("idempotent: three passes deliver three payloads", len(sink.sent) == 3, len(sink.sent))
    case.cleanup()


def test_rotation_resets_the_cursor_without_redelivering():
    case = Case()
    case.append_record(record("p1", NOW_MS))
    sink = adapters.NullAdapter()
    case.drain(sink)
    # The queue is rotated away and recreated with the same byte length, so only the inode
    # betrays it. Resuming at the old offset would silently skip the new file's contents.
    os.unlink(case.queue)
    case.append_record(record("p1", NOW_MS))
    after = case.drain(sink)
    check("rotation: re-read from 0", after["read"] == 1, after)
    check("rotation: ledger suppressed the replay", after["duplicate"] == 1, after)
    check("rotation: adapter untouched", len(sink.sent) == 1, len(sink.sent))

    # And a genuinely new record in the rotated file is picked up rather than skipped.
    case.append_record(record("p9", NOW_MS))
    tail = case.drain(sink)
    check("rotation: post-rotation record delivered", tail["notified"] == 1, tail)
    case.cleanup()


def test_poison_record_does_not_wedge_the_queue():
    case = Case()
    case.append("not json at all\n")
    case.append_record(record("p1", NOW_MS))
    sink = adapters.NullAdapter()
    stats = case.drain(sink)
    check("poison: counted", stats["malformed"] == 1, stats)
    check("poison: following record still delivered", stats["notified"] == 1, stats)
    case.cleanup()


def test_coalesce_window_absorbs_duplicate_blocked_events():
    # herdr re-emits pane.agent_status_changed when only the presentation changed
    # (src/app/api.rs:645-646), so one blocked episode can enqueue several records.
    case = Case(coalesce_seconds=300)
    case.append_record(record("p1", NOW_MS, "a"))
    case.append_record(record("p1", NOW_MS + 500, "b"))
    case.append_record(record("p2", NOW_MS + 600, "c"))
    sink = adapters.NullAdapter()
    stats = case.drain(sink, now_ms=NOW_MS + 700)
    check("coalesce: one notification per pane", stats["notified"] == 2, stats)
    check("coalesce: duplicate suppressed", stats["coalesced"] == 1, stats)
    case.cleanup()


def test_stale_records_are_acked_but_not_delivered():
    case = Case(max_age_seconds=60)
    case.append_record(record("p1", NOW_MS - 3600_000))
    sink = adapters.NullAdapter()
    stats = case.drain(sink, now_ms=NOW_MS)
    check("stale: not delivered", stats["notified"] == 0, stats)
    check("stale: counted", stats["stale"] == 1, stats)
    case.cleanup()


def test_command_adapter_passes_the_payload_on_stdin():
    case = Case()
    case.append_record(record("p1", NOW_MS))
    sink_path = os.path.join(case.dir, "cmd-out.json")
    adapter = adapters.build({
        "type": "command",
        "argv": ["/bin/sh", "-c", "cat > {}".format(sink_path)],
    })
    case.drain(adapter)
    with open(sink_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    check("command adapter: url delivered", payload["url"] == "herdr:///h/r/pane/p1", payload)
    case.cleanup()


def main():
    start = time.time()
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("{} checks failed in {:.2f}s".format(len(FAILURES), time.time() - start))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
