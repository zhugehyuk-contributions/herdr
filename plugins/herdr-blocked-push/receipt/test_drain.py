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
import push_tokens  # noqa: E402

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


# ---------------------------------------------------------------------------
# The push-token registry and the expo adapter (M5's delivery half).
#
# Nothing here opens a socket: `ExpoPushAdapter` takes its POST as a constructor argument precisely
# so the ticket-handling policy -- which failure retries, which one deletes a device -- is testable
# without an outbound call to Expo, and without a real device that could be woken up by one.
# ---------------------------------------------------------------------------


def registration(device_id="phone-abc", token=None, **overrides):
    payload = {
        "v": 1,
        "type": "expo",
        "token": token or "ExponentPushToken[{}]".format(device_id),
        "device_id": device_id,
        "platform": "android",
        "ts_ms": NOW_MS,
    }
    payload.update(overrides)
    return payload


def write_registration(directory, payload, filename=None):
    os.makedirs(directory, exist_ok=True)
    name = filename or "{}.json".format(payload.get("device_id"))
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    return path


class RecordingPost:
    """Stands in for the HTTPS POST. Answers one ticket per message, in order."""

    def __init__(self, tickets=None, raises=None):
        self.tickets = tickets
        self.raises = raises
        self.calls = []

    def __call__(self, messages):
        self.calls.append(messages)
        if self.raises is not None:
            raise self.raises
        return self.tickets or [{"status": "ok", "id": str(i)} for i in range(len(messages))]


def test_token_registry_reads_only_well_formed_entries():
    directory = tempfile.mkdtemp(prefix="tokens-")
    write_registration(directory, registration("phone-good"))
    # The phone's in-flight write. Skipped silently -- reporting it would make every concurrent
    # registration look like a failure.
    write_registration(directory, registration("phone-good"), filename="phone-good.json.part")
    write_registration(directory, registration("phone-v9", v=9))
    write_registration(directory, registration("phone-bad", token="not-a-token"))
    # A record whose `device_id` disagrees with its filename would be duplicated rather than
    # overwritten on the next registration, so it is refused rather than repaired.
    write_registration(directory, registration("phone-other"), filename="phone-mismatch.json")

    entries, rejections = push_tokens.load(directory)
    check("tokens: only the valid entry loads", [e.device_id for e in entries] == ["phone-good"],
          [e.device_id for e in entries])
    check("tokens: every rejection is reported", len(rejections) == 3, rejections)
    check("tokens: partial write is not a rejection",
          not any("part" in r for r in rejections), rejections)
    shutil.rmtree(directory, ignore_errors=True)


def test_token_registry_is_absent_not_broken_before_the_phone_registers():
    entries, rejections = push_tokens.load("/nonexistent/push-tokens.d")
    check("tokens: absent directory is empty, not an error", entries == [] and rejections == [])


def test_expo_adapter_sends_one_message_per_device_with_the_deep_link():
    directory = tempfile.mkdtemp(prefix="tokens-")
    write_registration(directory, registration("phone-a"))
    write_registration(directory, registration("phone-b"))
    post = RecordingPost()
    adapter = adapters.ExpoPushAdapter({"type": "expo", "tokens_dir": directory}, post=post)

    adapter.send(drain.build_payload(record("w1:p1", NOW_MS), "fable"))

    sent = post.calls[0]
    check("expo: one message per registered device", len(sent) == 2, sent)
    check("expo: addressed to the registered tokens",
          sorted(m["to"] for m in sent)
          == ["ExponentPushToken[phone-a]", "ExponentPushToken[phone-b]"], sent)
    check("expo: carries the deep link",
          sent[0]["data"]["url"] == "herdr:///h/fable/pane/w1%3Ap1", sent[0])
    # The app reads these first and falls back to the URL; if they disagree the tap lands elsewhere.
    check("expo: data agrees with the link",
          (sent[0]["data"]["remote_id"], sent[0]["data"]["pane_id"]) == ("fable", "w1:p1"), sent[0])
    check("expo: only blocked is ever pushed", sent[0]["data"]["status"] == "blocked", sent[0])
    # Android reads heads-up behaviour off the channel, not off `priority`; the app creates
    # `blocked` at HIGH importance (`mobile/src/notifications/use-blocked-push.ts`).
    check("expo: routed to the high-importance channel", sent[0]["channelId"] == "blocked", sent[0])
    shutil.rmtree(directory, ignore_errors=True)


def test_expo_adapter_raises_when_no_device_has_registered():
    directory = tempfile.mkdtemp(prefix="tokens-")
    adapter = adapters.ExpoPushAdapter({"type": "expo", "tokens_dir": directory},
                                       post=RecordingPost())
    case = Case()
    case.append_record(record("p1", NOW_MS))
    stats = case.drain(adapter)
    # Not acked: a record dropped here is a notification the user never gets, and the queue is the
    # only thing holding it.
    check("expo: nothing delivered", stats["notified"] == 0, stats)
    check("expo: the pass reports the failure", "error" in stats, stats)
    check("expo: the cursor did not advance", stats["offset"] == 0, stats)
    case.cleanup()
    shutil.rmtree(directory, ignore_errors=True)


def test_expo_adapter_forgets_a_device_the_service_says_is_gone():
    directory = tempfile.mkdtemp(prefix="tokens-")
    dead = write_registration(directory, registration("phone-dead"))
    post = RecordingPost(tickets=[{
        "status": "error",
        "message": "\"ExponentPushToken[phone-dead]\" is not a registered push notification recipient",
        "details": {"error": "DeviceNotRegistered"},
    }])
    adapter = adapters.ExpoPushAdapter({"type": "expo", "tokens_dir": directory}, post=post)

    # Does not raise: retrying a revoked token is guaranteed to fail forever, so wedging the queue on
    # it would stop every *other* notification too.
    adapter.send(drain.build_payload(record("p1", NOW_MS), "r"))

    check("expo: the dead registration is deleted", not os.path.exists(dead))
    check("expo: registry is empty afterwards", push_tokens.load(directory)[0] == [])
    shutil.rmtree(directory, ignore_errors=True)


def test_expo_adapter_retries_a_transient_failure():
    directory = tempfile.mkdtemp(prefix="tokens-")
    alive = write_registration(directory, registration("phone-a"))
    post = RecordingPost(tickets=[{
        "status": "error",
        "message": "Too many messages",
        "details": {"error": "MessageRateExceeded"},
    }])
    adapter = adapters.ExpoPushAdapter({"type": "expo", "tokens_dir": directory}, post=post)

    raised = None
    try:
        adapter.send(drain.build_payload(record("p1", NOW_MS), "r"))
    except adapters.AdapterError as err:
        raised = str(err)

    check("expo: a transient ticket raises", raised is not None and "phone-a" in raised, raised)
    check("expo: and the device is kept", os.path.exists(alive))
    shutil.rmtree(directory, ignore_errors=True)


def test_expo_adapter_is_reachable_through_the_config():
    directory = tempfile.mkdtemp(prefix="tokens-")
    adapter = adapters.build({"type": "expo", "tokens_dir": directory})
    check("expo: built from a sender.json spec", adapter.kind == "expo")
    missing = None
    try:
        adapters.build({"type": "expo"})
    except adapters.AdapterError as err:
        missing = str(err)
    check("expo: a spec with no tokens_dir is refused",
          missing is not None and "tokens_dir" in missing, missing)
    shutil.rmtree(directory, ignore_errors=True)


def test_default_coalesce_window_is_the_discovery_budget():
    # Pinned rather than merely documented: the number is an argument (`sender/drain.py`), and a
    # silent change to it silently changes how many blocked episodes the phone never hears about.
    check("coalesce: default is 60s", drain.DEFAULT_COALESCE_SECONDS == 60,
          drain.DEFAULT_COALESCE_SECONDS)


def test_default_coalesce_window_still_suppresses_a_re_fire():
    case = Case()
    del case.config["coalesce_seconds"]  # take the default
    case.append_record(record("p1", NOW_MS))
    # A presentation-only re-emit, 5s later: same pane, still blocked (`src/app/api.rs:645-646`).
    case.append_record(record("p1", NOW_MS + 5_000, record_id="host:p1:re-fire"))
    # A genuine second block, just past the window.
    case.append_record(record("p1", NOW_MS + 61_000, record_id="host:p1:re-block"))
    sink = adapters.NullAdapter()
    stats = case.drain(sink, now_ms=NOW_MS + 61_000)
    check("coalesce default: re-fire suppressed", stats["coalesced"] == 1, stats)
    check("coalesce default: re-block gets through", stats["notified"] == 2, stats)
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
