#!/usr/bin/env python3
"""Notification adapters for the drain sender.

The adapter boundary exists so that the queue -> notification half of M5 can be proven
end to end without wiring a real push service (which needs credentials and an outbound
call). `file` is the local adapter the receipt runs against; `command` is the escape hatch
that turns any CLI (`terminal-notifier`, `ntfy`, `curl`, an APNs helper) into an adapter
without changing this file.

An adapter is anything with `.send(payload) -> None` that raises on failure. Raising is
what keeps the record un-acked: the sender only advances its ledger for payloads that were
accepted, so a failing adapter means a retry on the next run rather than a silent drop.
"""

import json
import os
import subprocess


class AdapterError(RuntimeError):
    pass


class FileAdapter:
    """Appends one JSON line per notification. Used by the receipt as the local sink."""

    kind = "file"

    def __init__(self, spec):
        path = spec.get("path")
        if not isinstance(path, str) or not path:
            raise AdapterError("file adapter needs a non-empty `path`")
        self.path = os.path.expanduser(path)

    def send(self, payload):
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        directory = os.path.dirname(self.path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, line.encode("utf-8"))
        finally:
            os.close(fd)


class CommandAdapter:
    """Runs an argv command with the payload on stdin and the fields in the environment.

    This is how a real push service gets attached without this repo holding credentials:
    the command is the user's, so the token/key lives in the user's script, not here.
    """

    kind = "command"

    def __init__(self, spec):
        argv = spec.get("argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
            raise AdapterError("command adapter needs a non-empty argv array of strings")
        self.argv = argv
        self.timeout_seconds = float(spec.get("timeout_seconds", 20))

    def send(self, payload):
        env = dict(os.environ)
        env["HERDR_PUSH_TITLE"] = payload["title"]
        env["HERDR_PUSH_BODY"] = payload["body"]
        env["HERDR_PUSH_URL"] = payload["url"]
        env["HERDR_PUSH_JSON"] = json.dumps(payload, ensure_ascii=False)
        try:
            completed = subprocess.run(
                self.argv,
                input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                timeout=self.timeout_seconds,
            )
        except OSError as err:
            raise AdapterError("could not run {}: {}".format(self.argv[0], err))
        except subprocess.TimeoutExpired:
            raise AdapterError("{} timed out after {}s".format(self.argv[0], self.timeout_seconds))
        if completed.returncode != 0:
            raise AdapterError(
                "{} exited {}: {}".format(
                    self.argv[0],
                    completed.returncode,
                    completed.stderr.decode("utf-8", "replace").strip()[:400],
                )
            )


class NullAdapter:
    """Accepts and discards. `--dry-run` swaps this in so a run can be inspected safely."""

    kind = "null"

    def __init__(self, spec=None):
        self.sent = []

    def send(self, payload):
        self.sent.append(payload)


_ADAPTERS = {
    "file": FileAdapter,
    "command": CommandAdapter,
    "null": NullAdapter,
}


def build(spec):
    if not isinstance(spec, dict):
        raise AdapterError("adapter must be an object")
    kind = spec.get("type")
    factory = _ADAPTERS.get(kind)
    if factory is None:
        raise AdapterError(
            "unknown adapter type {!r}; known: {}".format(kind, ", ".join(sorted(_ADAPTERS)))
        )
    return factory(spec)
