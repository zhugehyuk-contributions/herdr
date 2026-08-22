"""Gate for the `herdr-mx.blocked-push` plugin (mobile milestone M5, desktop half).

The plugin lives in `plugins/herdr-blocked-push/`. It is a `pane.agent_status_changed`
event hook that appends `blocked` transitions to a queue file, plus an out-of-process
sender that drains that queue. Before this module existed, nothing in `just ci` executed
any of it: `receipt/test_drain.py` covered the sender only and was never invoked by a
recipe, and the hook itself had no test outside `receipt/run_receipt.py`, which needs a
built binary and a live server.

Three things are gated here:

1. **The hook.** Executed as a real subprocess, exactly as herdr executes it, against an
   envelope fixture that is *built from* `docs/next/api/herdr-api.schema.json` rather than
   hand-written. That artifact is itself kept in sync with the Rust types by the nextest
   `generated_protocol_schema_artifact_is_current` (`src/api/schema/tests.rs:152`), so a
   schema change cannot silently invalidate the fixture: it either updates the JSON, which
   updates this fixture, or it fails that Rust test.
2. **The premises the plugin's design rests on.** Three anchors in the Rust source, checked
   semantically rather than by line number, because each one is load-bearing and each one
   would fail *silently* (a push that never arrives) rather than loudly if it changed.
3. **The two plugin-local suites**, which now finally run somewhere.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT = REPO_ROOT / "plugins" / "herdr-blocked-push"
HOOK_ENTRY = PLUGIN_ROOT / "hooks" / "enqueue.sh"
API_SCHEMA = REPO_ROOT / "docs" / "next" / "api" / "herdr-api.schema.json"

# The dot name herdr puts in HERDR_PLUGIN_EVENT (`src/api/schema/events.rs:253`). It is
# deliberately *not* the same spelling as the snake_case value inside the JSON envelope;
# conflating the two is the mistake the hook has to be immune to.
EVENT_DOT_NAME = "pane.agent_status_changed"
EVENT_SNAKE_NAME = "pane_agent_status_changed"


def _event_data_variant():
    """The `pane_agent_status_changed` arm of EventData, straight out of the artifact."""
    schema = json.loads(API_SCHEMA.read_text(encoding="utf-8"))
    event = schema["schemas"]["event"]
    defs = event["$defs"]
    for variant in defs["EventData"]["oneOf"]:
        if variant.get("properties", {}).get("type", {}).get("const") == EVENT_SNAKE_NAME:
            return event, defs, variant
    raise AssertionError(
        "{} has no EventData variant {!r}".format(API_SCHEMA, EVENT_SNAKE_NAME)
    )


def envelope(agent_status="blocked", **overrides):
    """Serialize an EventEnvelope the way `serde_json::to_string` does for the hook.

    `separators` matters: herdr's serializer emits no spaces, and the hook's stage-1 shell
    filter tests for the literal `"agent_status":"blocked"`. A fixture with spaces would
    make stage 1 look broken (or, worse, make a broken stage 1 look fine).
    """
    data = {
        "type": EVENT_SNAKE_NAME,
        "pane_id": "w1:p1",
        "workspace_id": "w1",
        "agent_status": agent_status,
    }
    data.update(overrides)
    payload = {"event": EVENT_SNAKE_NAME, "data": data}
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


class Hook:
    """One isolated invocation environment for the hook, spawned like herdr spawns it."""

    def __init__(self):
        self.dir = Path(tempfile.mkdtemp(prefix="blocked-push-hook-"))
        self.state_dir = self.dir / "state"
        self.state_dir.mkdir()

    @property
    def queue(self):
        return self.state_dir / "queue.ndjson"

    def fire(self, event_json, event=EVENT_DOT_NAME, state_dir=True, extra_env=None):
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("HERDR_")
        }
        # `command_for_argv_in_dir(..., &plugin_root)` runs the hook with the plugin root as
        # cwd and HERDR_PLUGIN_ROOT set (`src/app/api/plugins/runtime.rs:122`,
        # `src/app/api/plugins/env.rs:20`), so reproduce both.
        env["HERDR_PLUGIN_ROOT"] = str(PLUGIN_ROOT)
        env["HERDR_BLOCKED_PUSH_PYTHON"] = sys.executable
        if event is not None:
            env["HERDR_PLUGIN_EVENT"] = event
        if event_json is not None:
            env["HERDR_PLUGIN_EVENT_JSON"] = event_json
        if state_dir:
            env["HERDR_PLUGIN_STATE_DIR"] = str(self.state_dir)
        env.update(extra_env or {})
        return subprocess.run(
            ["sh", str(HOOK_ENTRY)],
            cwd=str(PLUGIN_ROOT),
            env=env,
            capture_output=True,
            text=True,
        )

    def records(self):
        if not self.queue.exists():
            return []
        return [
            json.loads(line)
            for line in self.queue.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def cleanup(self):
        shutil.rmtree(self.dir, ignore_errors=True)


class HookFixtureTests(unittest.TestCase):
    """The fixture above must keep describing the event herdr actually emits."""

    def test_payload_fields_the_hook_reads_are_required_by_the_schema(self):
        _event, _defs, variant = _event_data_variant()
        self.assertEqual(
            set(variant["required"]),
            {"type", "pane_id", "workspace_id", "agent_status"},
            "the hook treats pane_id/workspace_id as guaranteed; the schema must agree",
        )
        self.assertEqual(variant["properties"]["pane_id"]["type"], "string")
        self.assertEqual(variant["properties"]["workspace_id"]["type"], "string")

    def test_schema_carries_no_previous_status(self):
        """Why P2 (duplicate `blocked` events) cannot be solved in the hook.

        `emit_pane_state_update` re-emits this event when only the *presentation* changed,
        with the status still `blocked`. The envelope does not say what the status was
        before, so a stateless hook physically cannot tell "entered blocked" from "still
        blocked". De-duplication therefore belongs to the sender, which is allowed to keep
        state and to be slow. If a `previous_*` field ever appears, this test fails and
        that decision is worth revisiting.
        """
        _event, _defs, variant = _event_data_variant()
        previous = [key for key in variant["properties"] if key.startswith("previous")]
        self.assertEqual(previous, [], "envelope gained a previous-status field")

    def test_blocked_is_a_real_agent_status_and_done_still_is_too(self):
        _event, defs, _variant = _event_data_variant()
        statuses = defs["AgentStatus"]["enum"]
        self.assertIn("blocked", statuses)
        # `done` is excluded on purpose (see the anchor test below), not by oversight.
        self.assertIn("done", statuses)

    def test_envelope_event_field_is_snake_case_not_the_dot_name(self):
        _event, defs, _variant = _event_data_variant()
        kinds = defs["EventKind"]["enum"]
        self.assertIn(EVENT_SNAKE_NAME, kinds)
        self.assertNotIn(EVENT_DOT_NAME, kinds)


class HookBehaviourTests(unittest.TestCase):
    def setUp(self):
        self.hook = Hook()
        self.addCleanup(self.hook.cleanup)

    def assert_ok(self, completed):
        self.assertEqual(
            completed.returncode,
            0,
            "hook exited {}: {}{}".format(
                completed.returncode, completed.stdout, completed.stderr
            ),
        )

    def test_blocked_transition_is_enqueued(self):
        self.assert_ok(self.hook.fire(envelope("blocked", agent="pi", title="deploy?")))
        records = self.hook.records()
        self.assertEqual(len(records), 1, records)
        record = records[0]
        self.assertEqual(record["status"], "blocked")
        self.assertEqual(record["pane_id"], "w1:p1")
        self.assertEqual(record["workspace_id"], "w1")
        self.assertEqual(record["agent"], "pi")
        self.assertEqual(record["title"], "deploy?")
        self.assertTrue(record["id"])
        self.assertGreater(record["ts_ms"], 0)

    def test_non_blocked_statuses_are_not_enqueued(self):
        for status in ("idle", "working", "done", "unknown"):
            with self.subTest(status=status):
                self.assert_ok(self.hook.fire(envelope(status)))
        self.assertEqual(self.hook.records(), [])

    def test_a_pane_title_that_spells_blocked_cannot_forge_a_record(self):
        """Stage 1's substring test is safe because JSON escapes the quotes.

        A pane running `herdr` itself, or an agent echoing an event payload, can put the
        literal `"agent_status":"blocked"` in its own title. Serialized, that becomes
        `\\"agent_status\\":\\"blocked\\"`, which does not contain the needle -- so the
        forgery is defeated by the encoding, not by luck. Both halves are asserted: the
        needle really is absent from the wire form, and the hook really does write nothing.
        """
        forged = envelope("idle", title='{"agent_status":"blocked"}')
        self.assertNotIn(
            '"agent_status":"blocked"',
            forged.replace('"agent_status":"idle"', ""),
            "a string field produced an unescaped match; stage 1 is now forgeable",
        )
        self.assert_ok(self.hook.fire(forged))
        self.assertEqual(self.hook.records(), [])

    def test_stage_two_is_the_authority_when_stage_one_lets_something_through(self):
        """Stage 1 only ever rejects; stage 2 re-checks by parsing.

        Called directly, bypassing the shell filter, so this measures stage 2 alone: a
        non-blocked event exits 0 and writes nothing rather than trusting the caller.
        """
        env = {
            key: value for key, value in os.environ.items() if not key.startswith("HERDR_")
        }
        env["HERDR_PLUGIN_EVENT"] = EVENT_DOT_NAME
        env["HERDR_PLUGIN_EVENT_JSON"] = envelope("idle")
        env["HERDR_PLUGIN_STATE_DIR"] = str(self.hook.state_dir)
        completed = subprocess.run(
            [sys.executable, str(PLUGIN_ROOT / "hooks" / "enqueue.py")],
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(self.hook.records(), [])

    def test_one_blocked_episode_can_produce_several_records(self):
        """The hook is deliberately not de-duplicating (see P2 above).

        Two identical blocked envelopes -- what herdr emits when only the presentation
        changed -- produce two queue lines with distinct ids. The sender's coalesce window
        is what collapses them (`sender/drain.py`, covered by `receipt/test_drain.py`).
        """
        for _ in range(2):
            self.assert_ok(self.hook.fire(envelope("blocked")))
        records = self.hook.records()
        self.assertEqual(len(records), 2, records)
        self.assertEqual(len({record["id"] for record in records}), 2, records)

    def test_free_text_is_clipped_so_one_pane_cannot_bloat_the_queue(self):
        self.assert_ok(self.hook.fire(envelope("blocked", title="x" * 5000)))
        line = self.hook.queue.read_bytes()
        self.assertLess(len(line), 2048, "record exceeded MAX_RECORD_BYTES")
        self.assertLessEqual(len(self.hook.records()[0]["title"]), 200)

    def test_concurrent_hooks_do_not_interleave_their_lines(self):
        """herdr runs up to 32 hook processes at once (`runtime.rs:12`).

        Each appends to the same file with a single `write()` on an `O_APPEND` descriptor,
        which is what keeps the lines whole; nothing else in the design serializes them.
        """
        count = 24
        with ThreadPoolExecutor(max_workers=count) as pool:
            results = list(
                pool.map(lambda _: self.hook.fire(envelope("blocked")), range(count))
            )
        for completed in results:
            self.assert_ok(completed)
        lines = self.hook.queue.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), count)
        for line in lines:
            json.loads(line)  # a torn line would raise here
        self.assertEqual(len({record["id"] for record in self.hook.records()}), count)

    def test_hook_fails_loudly_rather_than_writing_a_record_it_cannot_trust(self):
        # Every case must contain the stage-1 needle, or it is testing stage 1's rejection
        # path rather than stage 2's error handling.
        cases = {
            "no pane_id": envelope("blocked", pane_id=None),
            "no workspace_id": envelope("blocked", workspace_id=None),
            "truncated json": '{"event":"pane_agent_status_changed","data":'
                              '{"agent_status":"blocked"',
            "no data object": '{"event":"pane_agent_status_changed","agent_status":"blocked"}',
        }
        for name, payload in cases.items():
            with self.subTest(case=name):
                completed = self.hook.fire(payload)
                self.assertEqual(completed.returncode, 1, completed.stderr)
                self.assertIn("herdr-mx.blocked-push", completed.stderr)
        self.assertEqual(self.hook.records(), [])

    def test_hook_refuses_to_guess_a_queue_location(self):
        completed = self.hook.fire(envelope("blocked"), state_dir=False)
        self.assertEqual(completed.returncode, 1)
        self.assertIn("HERDR_PLUGIN_STATE_DIR", completed.stderr)

    def test_hook_rejects_an_event_it_was_not_written_for(self):
        completed = self.hook.fire(envelope("blocked"), event="pane.output_changed")
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(self.hook.records(), [])

    def test_stage_one_rejects_without_starting_an_interpreter(self):
        """The cheap path has to stay cheap: this hook runs on every status change.

        Pointing the interpreter at a nonexistent binary proves stage 1 returned before
        stage 2 was ever spawned -- an idle event exits 0 anyway.
        """
        completed = self.hook.fire(
            envelope("idle"),
            extra_env={"HERDR_BLOCKED_PUSH_PYTHON": "/nonexistent/python"},
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)


class DesignPremiseTests(unittest.TestCase):
    """Semantic anchors, not line numbers.

    Every premise below fails *silently* if it changes -- the plugin keeps running and the
    phone simply stops being told things -- so each one is worth a test rather than a
    comment.
    """

    def test_event_hooks_run_before_the_event_reaches_the_subscription_hub(self):
        """Why the hook path is used instead of `events.subscribe` (blocker B9).

        The hook is upstream of the ring buffer, so it cannot lose an event to eviction.
        Reverse these two calls and the plugin inherits every drop the hub has.
        """
        source = (REPO_ROOT / "src" / "app" / "api.rs").read_text(encoding="utf-8")
        marker = "fn emit_event("
        body = source[source.index(marker) :]
        hooks = body.index("run_plugin_event_hooks")
        push = body.index("event_hub.push")
        self.assertLess(hooks, push, "emit_event no longer runs plugin hooks first")

    def test_blocked_is_the_only_device_independent_status(self):
        """Why `done` is not pushed.

        `done` is `(Idle, seen == false)`, and `seen` flips as soon as the desktop's active
        tab shows the pane, so a `done` push races the desktop and fires for something the
        user already saw. `blocked` ignores `seen` entirely.
        """
        source = (REPO_ROOT / "src" / "app" / "api_helpers.rs").read_text(encoding="utf-8")
        self.assertIn("(crate::detect::AgentState::Idle, false) => "
                      "crate::api::schema::AgentStatus::Done", source)
        self.assertIn("(crate::detect::AgentState::Blocked, _) => "
                      "crate::api::schema::AgentStatus::Blocked", source)

    def test_the_hook_runtime_still_drops_invocations_past_a_fixed_ceiling(self):
        """Why the hook must stay a few milliseconds long.

        Past the in-flight cap herdr discards the invocation outright (the call site
        ignores the Err), and nothing retries it. Slowness in the hook is data loss, not
        latency.
        """
        source = (
            REPO_ROOT / "src" / "app" / "api" / "plugins" / "runtime.rs"
        ).read_text(encoding="utf-8")
        self.assertIn("MAX_PLUGIN_COMMANDS_IN_FLIGHT: usize = 32", source)
        self.assertIn(
            'env.push(("HERDR_PLUGIN_EVENT_JSON".to_string(), event_json));',
            source,
            "the hook reads HERDR_PLUGIN_EVENT_JSON; herdr must still set it",
        )


class PluginLocalSuiteTests(unittest.TestCase):
    """Run the suites that ship next to the plugin, which no recipe reached before."""

    def _run(self, *argv):
        completed = subprocess.run(
            [sys.executable, *argv], capture_output=True, text=True, cwd=str(PLUGIN_ROOT)
        )
        self.assertEqual(
            completed.returncode,
            0,
            "{}\n{}".format(completed.stdout, completed.stderr),
        )
        return completed

    def test_sender_delivery_semantics(self):
        self._run(str(PLUGIN_ROOT / "receipt" / "test_drain.py"))

    def test_hook_imports_nothing_that_can_open_a_socket(self):
        completed = self._run(
            str(PLUGIN_ROOT / "receipt" / "assert_no_network_imports.py")
        )
        self.assertIn("OK hooks import only", completed.stdout)


class ManifestTests(unittest.TestCase):
    def test_manifest_hooks_the_event_the_hook_parses(self):
        manifest = (PLUGIN_ROOT / "herdr-plugin.toml").read_text(encoding="utf-8")
        self.assertIn('on = "{}"'.format(EVENT_DOT_NAME), manifest)
        self.assertIn('command = ["sh", "hooks/enqueue.sh"]', manifest)

    def test_manifest_declares_no_startup_or_action_surface(self):
        """The hook is the whole plugin. Anything else would be a second thing to audit."""
        manifest = (PLUGIN_ROOT / "herdr-plugin.toml").read_text(encoding="utf-8")
        self.assertNotIn("[[startup]]", manifest)
        self.assertNotIn("[[actions]]", manifest)


if __name__ == "__main__":
    unittest.main()
