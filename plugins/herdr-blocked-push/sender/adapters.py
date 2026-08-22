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
import sys
import urllib.error
import urllib.parse
import urllib.request

import push_tokens


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


#: Expo's push endpoint. https, and there is no unauthenticated variant -- see the class below on
#: what that does and does not protect.
EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send"

#: Ticket errors that cannot succeed on a retry, per device. Everything else is treated as transient
#: and re-raised, because a wedged queue that prints an error every 15 seconds is a *visible*
#: failure, while a dropped notification is not.
EXPO_PERMANENT_TICKET_ERRORS = frozenset(
    {
        # The app was uninstalled or the OS revoked the token. The registry entry is deleted.
        "DeviceNotRegistered",
        # >4KiB. Retrying the identical payload cannot make it smaller.
        "MessageTooBig",
    }
)


class ExpoPushAdapter:
    """Sends one notification to every registered device through Expo's push service.

    **Why Expo and not APNs/FCM directly, or ntfy.** Three constraints decided this, and only one of
    them is convenience:

    1. *This file's runtime.* The sender is stdlib-only Python by design (`README.md`, "Requirements:
       a POSIX `sh` and `python3` ... stdlib only") because it has to run on every machine the user
       runs herdr on, with no install step. APNs needs an ES256-signed JWT and FCM v1 needs an
       RS256-signed one; neither signature is expressible in the standard library. Expo's endpoint
       is a single JSON POST that `urllib.request` makes. That is not a preference, it is the
       difference between a dependency-free drop-in and a `pip install cryptography` on N hosts.
    2. *The tap has to land in this app.* ntfy/Pushover/Gotify need no app work at all, and that is
       exactly their problem: the notification belongs to their client, so tapping it opens their
       app and the deep link -- the entire second half of M5's acceptance criterion, "탭 → 해당 pane
       도달" -- is gone.
    3. *The token has to reach here somehow.* Whatever service is chosen, the phone's address must
       arrive on these machines. That is the ssh registration
       (`mobile/src/notifications/push-token-registration.ts`), and it works the same for an Expo
       token as for a raw APNs one -- so this choice is reversible: swapping in an APNs adapter later
       changes this class and the app's `getExpoPushTokenAsync` call, and nothing else.

    **What it costs, stated rather than hidden.** Expo's servers see the title, the body and the
    `data` block of every push -- which here means pane titles and agent names. So do Apple and
    Google, on any path that is not a self-hosted relay; Expo is one more hop, not a new category.
    The mitigation available today is that the payload carries identifiers and a title, never
    terminal contents. `access_token` (Expo's "push security" setting) is supported below and should
    be set: without it, anyone who learns a token can send *to this device* pretending to be herdr.
    """

    kind = "expo"

    def __init__(self, spec, post=None):
        directory = spec.get("tokens_dir")
        if not isinstance(directory, str) or not directory:
            raise AdapterError(
                "expo adapter needs `tokens_dir` -- the directory the phone registers into, "
                "normally `$(herdr plugin config-dir herdr-mx.blocked-push)/{}`".format(
                    push_tokens.TOKENS_DIRNAME
                )
            )
        self.tokens_dir = os.path.expanduser(directory)
        self.endpoint = spec.get("endpoint") or EXPO_PUSH_ENDPOINT
        self.access_token = spec.get("access_token") or os.environ.get("EXPO_ACCESS_TOKEN")
        self.timeout_seconds = float(spec.get("timeout_seconds", 20))
        self.channel_id = spec.get("channel_id", "blocked")
        # Seconds Expo/APNs/FCM may keep trying. An hour matches the sender's own `max_age_seconds`
        # default: past that the record would have been dropped as stale here anyway, and a
        # notification about a block the user resolved 90 minutes ago is noise.
        self.ttl_seconds = int(spec.get("ttl_seconds", 3600))
        self._post = post or self._post_json

    def send(self, payload):
        registrations, rejections = push_tokens.load(self.tokens_dir)
        for rejection in rejections:
            sys.stderr.write("drain: ignoring token file {}\n".format(rejection))
        if not registrations:
            # Raised, not swallowed: the phone has not registered yet (or its files are all
            # unreadable), and a record acked here is a notification the user never gets. Raising
            # keeps the queue where it is; `max_age_seconds` is what eventually retires the backlog,
            # so this cannot wedge forever.
            raise AdapterError(
                "no push token registered in {} -- open the app once while it can reach this "
                "host".format(self.tokens_dir)
            )

        messages = [self._message(payload, entry) for entry in registrations]
        tickets = self._post(messages)
        retryable = []
        for entry, ticket in zip(registrations, tickets):
            if not isinstance(ticket, dict) or ticket.get("status") == "ok":
                continue
            detail = ticket.get("details") or {}
            code = detail.get("error") if isinstance(detail, dict) else None
            message = ticket.get("message") or code or "unknown error"
            if code in EXPO_PERMANENT_TICKET_ERRORS:
                sys.stderr.write(
                    "drain: dropping device {} ({}): {}\n".format(entry.device_id, code, message)
                )
                if code == "DeviceNotRegistered":
                    push_tokens.forget(entry.path)
                continue
            retryable.append("{}: {}".format(entry.device_id, message))
        if retryable:
            # At-least-once, as documented: a device that already got this one will get it again
            # when the retry succeeds for the others. The alternative -- acking a record because
            # *some* device took it -- silently drops the notification for the device the user
            # actually has in their pocket.
            raise AdapterError("; ".join(retryable))

    def _message(self, payload, entry):
        record = payload.get("record") or {}
        return {
            "to": entry.token,
            "title": payload["title"],
            "body": payload["body"],
            "data": {
                "url": payload["url"],
                "status": record.get("status"),
                "pane_id": record.get("pane_id"),
                "workspace_id": record.get("workspace_id"),
                # Not the hostname: the id the *phone* uses for this machine, which is what the deep
                # link is built from (`drain.build_payload`).
                "remote_id": _remote_id_of(payload["url"]),
                "host": record.get("host"),
            },
            "sound": "default",
            # Both are needed and neither is redundant: Android reads heads-up behaviour off the
            # channel's importance (the app creates `blocked` at HIGH --
            # `mobile/src/notifications/use-blocked-push.ts`), and iOS reads `priority`.
            "channelId": self.channel_id,
            "priority": "high",
            "ttl": self.ttl_seconds,
        }

    def _post_json(self, messages):
        body = json.dumps(messages, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(self.endpoint, data=body, method="POST")
        request.add_header("content-type", "application/json")
        request.add_header("accept", "application/json")
        # Expo compresses by default and `urllib` does not decompress; asking for identity is
        # cheaper than carrying a gzip branch for a response measured in hundreds of bytes.
        request.add_header("accept-encoding", "identity")
        if self.access_token:
            request.add_header("authorization", "Bearer {}".format(self.access_token))
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                raw = response.read()
        except urllib.error.HTTPError as err:
            detail = ""
            try:
                detail = err.read().decode("utf-8", "replace")[:400]
            except Exception:  # pragma: no cover - the error body is best effort
                pass
            raise AdapterError("expo push returned HTTP {}: {}".format(err.code, detail))
        except urllib.error.URLError as err:
            raise AdapterError("expo push unreachable: {}".format(err.reason))
        except OSError as err:
            raise AdapterError("expo push failed: {}".format(err))
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except ValueError as err:
            raise AdapterError("expo push returned non-JSON: {}".format(err))
        if isinstance(parsed, dict) and parsed.get("errors"):
            # A request-level rejection (bad credentials, malformed body). Every message failed.
            raise AdapterError("expo push rejected the request: {}".format(parsed["errors"]))
        tickets = parsed.get("data") if isinstance(parsed, dict) else None
        if not isinstance(tickets, list):
            raise AdapterError("expo push returned no ticket array: {!r}".format(parsed)[:400])
        return tickets


def _remote_id_of(url):
    """`herdr:///h/<remote_id>/pane/<pane_id>` -> the decoded remote id, or `None`.

    Read back out of the URL rather than threaded through as a second argument so that the URL stays
    the single definition of the link (`README.md#deep-link`) and the `data` block cannot disagree
    with the thing the app falls back to parsing.
    """
    segments = [segment for segment in url.split("/") if segment]
    if len(segments) >= 4 and segments[1] == "h" and segments[3] == "pane":
        return urllib.parse.unquote(segments[2])
    return None


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
    "expo": ExpoPushAdapter,
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
