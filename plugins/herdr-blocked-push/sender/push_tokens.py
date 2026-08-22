#!/usr/bin/env python3
"""The push-token registry: one file per device, written by the phone over ssh.

**Nothing in this repo writes these files.** The app does, on every launch, by exec'ing a short
`sh` command over the ssh connection it already authenticated on
(`mobile/src/notifications/push-token-registration.ts` composes it; that file also carries the
argument for why ssh is the delivery channel). The desktop half's only job is to read the directory
and to forget entries the push service says are dead.

Consequences of that arrangement, which are the reason this module is defensive rather than trusting:

* The directory can be **absent**. That is the normal state of a freshly installed plugin, not an
  error, and it must read as "nobody to push to yet" rather than as a crash in a launchd job.
* A file can be **half-written** if the phone's `mv` is ever replaced by a redirect, or **stale**
  from a device that was reinstalled, or **garbage** because something else put a file there. One
  bad entry must not cost the good ones: every file is parsed independently and a rejection is
  reported, not raised.
* An entry can be **dead** — the OS revoked the token when the app was uninstalled. Expo reports
  that as `DeviceNotRegistered`, and the only correct response is to delete the file: retrying is
  guaranteed to fail forever, and leaving it means every future pass wastes a round trip and an
  error line on a device that no longer exists.
"""

import json
import os
import re

#: Must match `TOKENS_DIRNAME` in `mobile/src/notifications/push-token-registration.ts`.
TOKENS_DIRNAME = "push-tokens.d"

#: Must match `DEVICE_ID_PATTERN` there. Checked here too because the filename is attacker-adjacent
#: input from this side's point of view: it decides what `forget()` is allowed to unlink.
DEVICE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")

#: Expo mints both spellings depending on vintage; both are the same kind of address.
TOKEN_RE = re.compile(r"^Exp(?:o|onent)PushToken\[[^\[\]\s]+\]$")

SCHEMA_VERSION = 1


class Registration(object):
    """One device. `path` is kept so a dead token can be forgotten by the thing that read it."""

    __slots__ = ("token", "device_id", "platform", "device_name", "ts_ms", "path")

    def __init__(self, token, device_id, platform, device_name, ts_ms, path):
        self.token = token
        self.device_id = device_id
        self.platform = platform
        self.device_name = device_name
        self.ts_ms = ts_ms
        self.path = path

    def label(self):
        return self.device_name or self.device_id

    def __repr__(self):  # pragma: no cover - diagnostics only
        return "Registration({!r}, {!r})".format(self.device_id, self.token[:24] + "...")


def tokens_dir(base_dir):
    return os.path.join(os.path.expanduser(base_dir), TOKENS_DIRNAME)


def load(directory):
    """Every valid registration in `directory`, and one rejection line per file that was not.

    Returns `(registrations, rejections)`. Sorted by device id so a run's output is stable and two
    passes over the same directory produce the same order of messages.
    """
    registrations = []
    rejections = []
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        # No directory at all: the phone has never registered here. Not a rejection -- there is
        # nothing to reject.
        return [], []
    for name in names:
        if not name.endswith(".json"):
            # `.json.part` is the phone's in-flight write. Skipping it silently is the point of the
            # two-step write; reporting it would make every concurrent registration look like an error.
            continue
        path = os.path.join(directory, name)
        parsed, reason = _parse(path)
        if parsed is None:
            rejections.append("{}: {}".format(name, reason))
        else:
            registrations.append(parsed)
    return registrations, rejections


def forget(path):
    """Deletes one registration. Missing is success -- two passes may both decide a token is dead."""
    try:
        os.remove(path)
        return True
    except OSError:
        return False


def _parse(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            record = json.load(handle)
    except (IOError, OSError) as err:
        return None, "unreadable ({})".format(err)
    except ValueError as err:
        return None, "not JSON ({})".format(err)
    if not isinstance(record, dict):
        return None, "not a JSON object"
    version = record.get("v")
    if version != SCHEMA_VERSION:
        # Forward compatibility is a decision, not an accident: a future app that changes the record
        # shape bumps `v`, and an old sender must skip it loudly rather than send half of it.
        return None, "schema version {!r}, this sender speaks {}".format(version, SCHEMA_VERSION)
    if record.get("type") != "expo":
        return None, "token type {!r} is not `expo`".format(record.get("type"))
    token = record.get("token")
    if not isinstance(token, str) or not TOKEN_RE.match(token):
        return None, "token is not an ExponentPushToken[...]"
    device_id = record.get("device_id")
    if not isinstance(device_id, str) or not DEVICE_ID_RE.match(device_id):
        return None, "device_id is not [a-z0-9][a-z0-9-]{0,62}"
    expected = device_id + ".json"
    if os.path.basename(path) != expected:
        # The filename is the registry key -- it is what makes a re-registration an overwrite rather
        # than a second entry. A record that disagrees with its own filename would be silently
        # duplicated on the next rotation.
        return None, "device_id {!r} does not match the filename".format(device_id)
    return (
        Registration(
            token=token,
            device_id=device_id,
            platform=_optional_str(record.get("platform")),
            device_name=_optional_str(record.get("device_name")),
            ts_ms=record.get("ts_ms") if isinstance(record.get("ts_ms"), int) else 0,
            path=path,
        ),
        None,
    )


def _optional_str(value):
    return value if isinstance(value, str) and value.strip() else None
