#!/bin/sh
# herdr event hook for `pane.agent_status_changed`.
#
# Stage 1 of two. This runs on EVERY agent-status change on every pane, so it has to be
# cheap: a shell builtin `case` over the raw event JSON, no fork, no interpreter start.
# It only ever *rejects*; a match falls through to stage 2, which re-checks the status by
# actually parsing the JSON. That asymmetry is what makes the substring test safe -- a pane
# whose title happens to contain the literal `"agent_status":"blocked"` gets past stage 1
# and is then dropped by stage 2.
#
# Payload shape (verified, not assumed): herdr serializes `EventEnvelope`
# (`src/api/schema/events.rs:365-368`) with serde `rename_all = "snake_case"`, so
# `HERDR_PLUGIN_EVENT_JSON` is
#   {"event":"pane_agent_status_changed","data":{"type":"pane_agent_status_changed",
#    "pane_id":...,"workspace_id":...,"agent_status":"blocked",...}}
# and `AgentStatus` is snake_case too (`src/api/schema/common.rs:149-157`).
# serde_json::to_string emits no spaces, so `"agent_status":"blocked"` is exact.
#
# Neither stage opens a network socket. See ../README.md#no-network for how that is proven.
set -u

case "${HERDR_PLUGIN_EVENT_JSON-}" in
*'"agent_status":"blocked"'*) ;;
*) exit 0 ;;
esac

exec "${HERDR_BLOCKED_PUSH_PYTHON:-python3}" "${HERDR_PLUGIN_ROOT:-.}/hooks/enqueue.py"
