#!/usr/bin/env python3
"""End-to-end receipt for the blocked-push plugin against an ISOLATED herdr server.

Safety, because this machine runs the author's real herdr fleet:
  * The server is spawned by this script and torn down by pid. There is no `pkill`, no
    `killall`, and no pattern match anywhere in this file.
  * Every herdr CLI call is made with an explicit `HERDR_SOCKET_PATH` under this run's
    temp base, plus isolated `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_RUNTIME_DIR`, and
    `HERDR_SESSION`/`HERDR_CLIENT_SOCKET_PATH`/`HERDR_ENV` removed. `plugin link` writes to
    `config_dir()/plugins.json` (`src/persist/plugin_registry.rs:11`), so the isolated
    `XDG_CONFIG_HOME` is what keeps it out of the user's real registry -- asserted below by
    locating the registry file inside the temp base.
  * The user's herdr pid set is sampled before and after and the delta is printed, not
    swallowed.

What it proves:
  1. A plugin linked into a live server fires its `pane.agent_status_changed` hook with no
     server restart, and the hook appends to a queue file.
  2. Only `blocked` lands in the queue, while the server demonstrably passed through
     `working`, `done` and `idle` (each transition is read back from `pane get`).
  3. The hook does all of that with every socket denied by a seatbelt profile.
  4. The drain sender delivers each record exactly once across repeated runs.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import time

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(os.path.dirname(PLUGIN_DIR))
PLUGIN_ID = "herdr-mx.blocked-push"


def log(section, message=""):
    print("[{}] {}".format(section, message))


def user_herdr_pids():
    """Replicates the user's own census command so the numbers are comparable."""
    out = subprocess.run(
        ["ps", "-eo", "pid,comm"], capture_output=True, text=True, check=True
    ).stdout
    pids = set()
    for line in out.splitlines()[1:]:
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        pid, comm = parts
        comm = comm.strip()
        if comm.endswith("/herdr") or comm == "herdr":
            pids.add(int(pid))
    return pids


class Isolated:
    def __init__(self, base):
        self.base = base
        self.config_home = os.path.join(base, "config")
        self.state_home = os.path.join(base, "state")
        self.runtime_dir = os.path.join(base, "run")
        self.socket = os.path.join(self.runtime_dir, "api.sock")
        self.server = None

    def env(self):
        env = dict(os.environ)
        for key in ("HERDR_ENV", "HERDR_SESSION", "HERDR_CLIENT_SOCKET_PATH"):
            env.pop(key, None)
        env["XDG_CONFIG_HOME"] = self.config_home
        env["XDG_STATE_HOME"] = self.state_home
        env["XDG_RUNTIME_DIR"] = self.runtime_dir
        env["HERDR_SOCKET_PATH"] = self.socket
        env["SHELL"] = "/bin/sh"
        return env

    def prepare(self):
        # A debug build namespaces its dirs as `herdr-dev`, a release build as `herdr`
        # (`src/config/io.rs:22-28`). Seed both so this works against either binary.
        for name in ("herdr", "herdr-dev"):
            os.makedirs(os.path.join(self.config_home, name), exist_ok=True)
            with open(os.path.join(self.config_home, name, "config.toml"), "w") as handle:
                handle.write("onboarding = false\n")
        os.makedirs(self.state_home, exist_ok=True)
        os.makedirs(self.runtime_dir, exist_ok=True)

    def start(self, binary):
        assert self.socket.startswith(self.base), "socket escaped the temp base"
        logfile = open(os.path.join(self.base, "server.log"), "wb")
        self.server = subprocess.Popen(
            [binary, "server"],
            env=self.env(),
            stdin=subprocess.DEVNULL,
            stdout=logfile,
            stderr=subprocess.STDOUT,
            cwd=self.base,
        )
        deadline = time.time() + 30
        while time.time() < deadline:
            if self.server.poll() is not None:
                raise SystemExit("server exited early; see {}/server.log".format(self.base))
            if os.path.exists(self.socket):
                return self.server.pid
            time.sleep(0.1)
        raise SystemExit("server socket never appeared at {}".format(self.socket))

    def stop(self):
        if self.server is None or self.server.poll() is not None:
            return
        os.kill(self.server.pid, signal.SIGTERM)
        try:
            self.server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.kill(self.server.pid, signal.SIGKILL)
            self.server.wait(timeout=10)


def cli(iso, binary, *args, **kwargs):
    completed = subprocess.run(
        [binary] + list(args), env=iso.env(), capture_output=True, text=True
    )
    if kwargs.get("check", True) and completed.returncode != 0:
        raise SystemExit(
            "herdr {} failed ({}): {}{}".format(
                " ".join(args), completed.returncode, completed.stdout, completed.stderr
            )
        )
    return completed


def cli_json(iso, binary, *args):
    return json.loads(cli(iso, binary, *args).stdout)


def sandbox_wrapped_manifest(plugin_copy):
    """Rewrites the linked copy's hook command to run under the deny-network profile."""
    path = os.path.join(plugin_copy, "herdr-plugin.toml")
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()
    original = 'command = ["sh", "hooks/enqueue.sh"]'
    replacement = (
        'command = ["/usr/bin/sandbox-exec", "-f", "receipt/no-network.sb", '
        '"sh", "hooks/enqueue.sh"]'
    )
    if original not in text:
        raise SystemExit("manifest hook command changed shape; receipt needs updating")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text.replace(original, replacement))
    return replacement


def find_under(root, filename):
    for dirpath, _dirnames, filenames in os.walk(root):
        if filename in filenames:
            return os.path.join(dirpath, filename)
    return None


def transition(iso, binary, pane_id, state):
    cli(iso, binary, "pane", "report-agent", pane_id, "--source", "receipt",
        "--agent", "pi", "--state", state)
    time.sleep(0.7)
    info = cli_json(iso, binary, "pane", "get", pane_id)
    observed = info["result"]["pane"]["agent_status"]
    log("transition", "reported {:<8} -> server reports agent_status={}".format(state, observed))
    return observed


def run_drain(plugin_copy, state_dir, config_path, queue_path):
    env = dict(os.environ)
    env["HERDR_PLUGIN_STATE_DIR"] = state_dir
    env["HERDR_BLOCKED_PUSH_QUEUE"] = queue_path
    completed = subprocess.run(
        [sys.executable, os.path.join(plugin_copy, "sender", "drain.py"),
         "--state-dir", state_dir, "--config", config_path],
        capture_output=True, text=True, env=env,
    )
    if completed.returncode != 0:
        raise SystemExit("drain failed: {}{}".format(completed.stdout, completed.stderr))
    return json.loads(completed.stdout.strip().splitlines()[-1])


def sandbox_positive_control():
    """Shows the profile in use is not a no-op: a canary connect() under it is denied."""
    canary = (
        "import socket\n"
        "s = socket.socket()\n"
        "s.settimeout(3)\n"
        "s.connect(('1.1.1.1', 53))\n"
        "print('CONNECTED')\n"
    )
    completed = subprocess.run(
        ["/usr/bin/sandbox-exec", "-f", os.path.join(PLUGIN_DIR, "receipt", "no-network.sb"),
         sys.executable, "-c", canary],
        capture_output=True, text=True,
    )
    tail = (completed.stdout + completed.stderr).strip().splitlines()
    return completed.returncode != 0, (tail[-1] if tail else "")


def main():
    binary = os.path.join(REPO_ROOT, "target", "debug", "herdr")
    if not os.path.exists(binary):
        raise SystemExit("build first: rustup run 1.96.1 cargo build --locked --bin herdr")

    before = user_herdr_pids()
    log("safety", "user herdr pids BEFORE: {} -> {}".format(len(before), sorted(before)))

    base = "/tmp/herdr-m5-push-{}-{}".format(os.getpid(), time.time_ns())
    iso = Isolated(base)
    iso.prepare()
    plugin_copy = os.path.join(base, "plugin")
    shutil.copytree(PLUGIN_DIR, plugin_copy)
    wrapped = sandbox_wrapped_manifest(plugin_copy)
    log("setup", "isolated base {}".format(base))
    log("setup", "hook command under test: {}".format(wrapped))

    failures = []
    try:
        pid = iso.start(binary)
        log("safety", "spawned isolated server pid={} (not in BEFORE: {})"
            .format(pid, pid not in before))

        cli(iso, binary, "plugin", "link", plugin_copy)
        listed = cli_json(iso, binary, "plugin", "list", "--json")
        log("link", "isolated registry holds: {}".format(
            [p["plugin_id"] for p in listed["result"]["plugins"]]))
        registry = find_under(iso.config_home, "plugins.json")
        log("link", "registry file: {}".format(registry))
        if not registry or not registry.startswith(base):
            failures.append("plugin registry did not land inside the isolated base")

        target_ws = cli_json(iso, binary, "workspace", "create", "--cwd", base,
                             "--focus")["result"]["workspace"]
        pane_id = cli_json(iso, binary, "pane", "list", "--workspace",
                           target_ws["workspace_id"])["result"]["panes"][0]["pane_id"]
        # Focus a second workspace so the target pane is NOT in the active tab. That is what
        # lets `done` appear at all: `seen` is only left false for a completion transition
        # outside the active tab (`src/app/actions.rs:3113-3117` + `:59-64`), and
        # `pane_agent_status` maps (Idle, seen=false) -> Done (`src/app/api_helpers.rs:104`).
        other_ws = cli_json(iso, binary, "workspace", "create", "--cwd", base,
                            "--focus")["result"]["workspace"]
        log("setup", "target workspace={} pane={} | focus parked on {}".format(
            target_ws["workspace_id"], pane_id, other_ws["workspace_id"]))

        observed = []

        def focus(workspace_id, why):
            cli(iso, binary, "workspace", "focus", workspace_id)
            time.sleep(0.4)
            log("setup", "focus -> {} ({})".format(workspace_id, why))

        # `idle` only appears while the pane's tab IS active; `done` only appears while it
        # is not. Both have to occur for "only blocked is queued" to mean anything, so the
        # run walks through both focus states.
        focus(target_ws["workspace_id"], "so working->idle lands as idle")
        for state in ("working", "idle"):
            observed.append(transition(iso, binary, pane_id, state))
        focus(other_ws["workspace_id"], "so working->idle lands as done")
        for state in ("working", "idle", "working", "blocked",
                      "working", "blocked", "working"):
            observed.append(transition(iso, binary, pane_id, state))
        time.sleep(1.5)

        queue_path = find_under(iso.state_home, "queue.ndjson")
        log("queue", "path: {}".format(queue_path))
        raw = ""
        if queue_path:
            with open(queue_path, "r", encoding="utf-8") as handle:
                raw = handle.read()
        log("queue", "--- raw queue file dump ---")
        print(raw if raw else "(empty)")
        log("queue", "--- end dump ---")

        records = [json.loads(line) for line in raw.splitlines() if line.strip()]
        statuses = sorted({r["status"] for r in records})
        server_statuses = sorted(set(observed))
        log("assert", "server passed through agent_status values: {}".format(server_statuses))
        log("assert", "queue contains statuses: {} across {} records"
            .format(statuses, len(records)))
        if statuses != ["blocked"]:
            failures.append("queue holds non-blocked statuses: {}".format(statuses))
        if len(records) != 2:
            failures.append("expected 2 blocked records, got {}".format(len(records)))
        for wanted in ("done", "working", "idle"):
            if wanted not in server_statuses:
                failures.append(
                    "server never reported {}; the 'only blocked is queued' claim is untested"
                    .format(wanted))

        entries = cli_json(iso, binary, "plugin", "log", "list", "--plugin",
                           PLUGIN_ID)["result"]["logs"]
        log("hook", "hook invocations recorded by herdr: {}".format(len(entries)))
        for entry in entries[-4:]:
            log("hook", "  event={} status={} exit={} stderr={!r}".format(
                entry.get("event"), entry.get("status"), entry.get("exit_code"),
                (entry.get("stderr") or "").strip()[:120]))
        bad = [e for e in entries if e.get("exit_code") not in (0, None)]
        if bad:
            failures.append("{} hook invocations exited nonzero under the sandbox".format(len(bad)))

        denied, denial_line = sandbox_positive_control()
        log("no-network", "positive control (canary connect under the same profile) denied={} | {}"
            .format(denied, denial_line[:140]))
        if not denied:
            failures.append("seatbelt profile did not deny the canary connect; proof is void")

        static = subprocess.run(
            [sys.executable, os.path.join(PLUGIN_DIR, "receipt", "assert_no_network_imports.py")],
            capture_output=True, text=True,
        )
        log("no-network", "static import audit: {}".format(
            (static.stdout + static.stderr).strip()))
        if static.returncode != 0:
            failures.append("static import audit failed")

        notifications = os.path.join(base, "notifications.ndjson")
        config_path = os.path.join(base, "sender.json")
        sender_state = os.path.join(base, "sender-state")
        with open(config_path, "w", encoding="utf-8") as handle:
            json.dump({
                "remote_id": "receipt-remote",
                "adapter": {"type": "file", "path": notifications},
                # 0 so every queued record is observable here; the production default is
                # 300s and exists because herdr re-emits `blocked` on presentation changes
                # (`src/app/api.rs:645-646`).
                "coalesce_seconds": 0,
            }, handle)

        first = run_drain(plugin_copy, sender_state, config_path, queue_path)
        second = run_drain(plugin_copy, sender_state, config_path, queue_path)
        log("drain", "pass 1: {}".format(json.dumps(first, sort_keys=True)))
        log("drain", "pass 2: {}".format(json.dumps(second, sort_keys=True)))
        log("drain", "--- notifications file dump ---")
        with open(notifications, "r", encoding="utf-8") as handle:
            sent = [json.loads(line) for line in handle if line.strip()]
        for payload in sent:
            print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        log("drain", "--- end dump ---")
        if first["notified"] != len(records):
            failures.append("drain pass 1 notified {} of {} records"
                            .format(first["notified"], len(records)))
        if second["notified"] != 0:
            failures.append("drain pass 2 re-notified {} records".format(second["notified"]))
        if len(sent) != len(records):
            failures.append("adapter received {} payloads for {} records"
                            .format(len(sent), len(records)))
        urls = [p["url"] for p in sent]
        log("deeplink", "urls: {}".format(urls))
        if not all(u == "herdr:///h/receipt-remote/pane/w1%3Ap1" for u in urls):
            failures.append("deep link url contract broken: {}".format(urls))
    finally:
        iso.stop()
        after = user_herdr_pids()
        log("safety", "user herdr pids AFTER: {} -> {}".format(len(after), sorted(after)))
        log("safety", "vanished since BEFORE: {} | appeared: {}".format(
            sorted(before - after), sorted(after - before - {iso.server.pid if iso.server else 0})))
        if iso.server and iso.server.pid in after:
            failures.append("isolated server pid {} survived teardown".format(iso.server.pid))
        shutil.rmtree(base, ignore_errors=True)

    if failures:
        for failure in failures:
            print("FAIL {}".format(failure))
        return 1
    print("RECEIPT GREEN")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
