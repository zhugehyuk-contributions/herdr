use std::path::PathBuf;
use std::time::Duration;

use crate::api::client::{ApiClient, ApiClientError, ConnectionTarget};
use crate::api::schema::{Method, Request, ServerLiveHandoffParams};
use crate::session::{SessionInfo, DEFAULT_SESSION_NAME};

const USAGE: &str = "usage: herdr live-handoff [--session <name>] [--json] [--import-exe <path>] [--expected-protocol <n>] [--expected-version <version>]";

/// A real handoff re-execs the server and replays its whole terminal state, so
/// it is legitimately slow; this budget only keeps a server that accepts the
/// connection and then never answers from parking the rest of the sequential
/// run. It is deliberately far above the short status/ping budgets.
const HANDOFF_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// A monolithic (`herdr --no-session`) process binds the same session API
/// socket but answers live handoff with this code: it cannot hand itself off.
const APP_MODE_ERROR_CODE: &str = "unsupported_in_app_mode";

const APP_MODE_SKIP_REASON: &str = "live handoff needs the headless server";

/// One session the command will try to hand off, resolved to its own socket so
/// every hop targets that session's server instead of the process-wide active one.
#[derive(Debug, Clone, PartialEq, Eq)]
struct HandoffTarget {
    name: String,
    socket_path: PathBuf,
}

/// Skipped is its own state, not a failure: a session that cannot be handed off
/// by design must neither inflate the failed count nor pin the exit code at 1.
#[derive(Debug, Clone, PartialEq, Eq)]
enum HandoffStatus {
    Ok,
    Skipped(String),
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HandoffOutcome {
    name: String,
    status: HandoffStatus,
}

pub(super) fn run_live_handoff_command(args: &[String]) -> std::io::Result<i32> {
    if matches!(
        args.first().map(String::as_str),
        Some("help" | "--help" | "-h")
    ) {
        println!("{USAGE}");
        return Ok(0);
    }

    let Some((json, params)) = parse_args(args) else {
        eprintln!("{USAGE}");
        return Ok(2);
    };
    let params = super::server::live_handoff_params_with_cli_defaults(params)?;

    let restrict_to = restriction_from_active_session();
    let targets = match resolve_targets(crate::session::list_sessions()?, restrict_to.as_deref()) {
        Ok(targets) => targets,
        Err(message) => {
            eprintln!("{message}");
            return Ok(2);
        }
    };
    if targets.is_empty() {
        if json {
            println!("{}", render_json(&[]));
        } else {
            println!("{}", empty_target_message(restrict_to.as_deref()));
        }
        return Ok(0);
    }

    // Name the blast radius before touching anything: the default run hands off
    // every session, not just the one the caller is sitting in.
    if !json {
        println!("{}", blast_radius_line(&targets));
    }

    let outcomes = run_handoffs(&targets, |target| handoff_session(target, &params));

    if json {
        println!("{}", render_json(&outcomes));
    } else {
        for line in render_human_lines(&outcomes, &server_log_hint()) {
            println!("{line}");
        }
    }
    Ok(exit_code(&outcomes))
}

fn restriction_from_active_session() -> Option<String> {
    restriction_from(
        crate::session::explicit_session_requested(),
        crate::session::active_name(),
    )
}

/// Only the explicit `--session <name>` flag narrows this command. Ambient
/// session context must NOT: herdr injects `HERDR_SESSION`/`HERDR_SOCKET_PATH`
/// into every pane it spawns, so a run started from inside a pane would
/// silently degrade to "hand off my own session" — the opposite of this
/// command's contract, which is "hand off every running session in turn".
/// `explicit_session_requested()` is true only for the flag.
fn restriction_from(
    explicit_session_requested: bool,
    active_name: Option<String>,
) -> Option<String> {
    if !explicit_session_requested {
        return None;
    }
    Some(active_name.unwrap_or_else(|| DEFAULT_SESSION_NAME.to_string()))
}

fn parse_args(args: &[String]) -> Option<(bool, ServerLiveHandoffParams)> {
    let mut json = false;
    let mut rest = Vec::with_capacity(args.len());
    for arg in args {
        if arg == "--json" {
            json = true;
            continue;
        }
        rest.push(arg.clone());
    }
    let params = super::server::parse_live_handoff_params(&rest)?;
    Some((json, params))
}

/// `Err` means the requested session does not exist at all, which is a caller
/// mistake (typo) rather than "nothing to do" — scripts gated on the exit code
/// must not read it as success.
fn resolve_targets(
    sessions: Vec<SessionInfo>,
    restrict_to: Option<&str>,
) -> Result<Vec<HandoffTarget>, String> {
    if let Some(name) = restrict_to {
        if !sessions.iter().any(|session| session.name == name) {
            return Err(unknown_session_message(name));
        }
    }
    Ok(select_targets(sessions, restrict_to))
}

fn select_targets(sessions: Vec<SessionInfo>, restrict_to: Option<&str>) -> Vec<HandoffTarget> {
    sessions
        .into_iter()
        .filter(|session| session.running)
        .filter(|session| restrict_to.is_none_or(|name| session.name == name))
        .map(|session| HandoffTarget {
            name: session.name,
            socket_path: PathBuf::from(session.socket_path),
        })
        .collect()
}

/// Sequential by design: each session is handed off through its own socket, and
/// a failure is recorded so the remaining sessions still get their turn.
fn run_handoffs(
    targets: &[HandoffTarget],
    mut handoff: impl FnMut(&HandoffTarget) -> HandoffStatus,
) -> Vec<HandoffOutcome> {
    targets
        .iter()
        .map(|target| HandoffOutcome {
            name: target.name.clone(),
            status: handoff(target),
        })
        .collect()
}

fn handoff_session(target: &HandoffTarget, params: &ServerLiveHandoffParams) -> HandoffStatus {
    // Live handoff is itself a protocol-mismatch recovery path, so it must
    // reach each server without the normal CLI compatibility guard.
    let client = ApiClient::for_target(ConnectionTarget::SocketPath(target.socket_path.clone()));
    let request = Request {
        id: format!("cli:live-handoff:{}", target.name),
        method: Method::ServerLiveHandoff(params.clone()),
    };
    let response = match client.request_value_with_timeout(&request, HANDOFF_REQUEST_TIMEOUT) {
        Ok(response) => response,
        Err(err) => return HandoffStatus::Failed(request_error_message(err, &request.id, &client)),
    };
    match response.get("error") {
        Some(error) => classify_error_response(error),
        None => HandoffStatus::Ok,
    }
}

/// Reuses the single-session mapping so a socket that went stale between
/// listing and dialling reads as the actionable `server_not_running` text
/// instead of a raw `Connection refused (os error 61)`.
fn request_error_message(err: ApiClientError, request_id: &str, client: &ApiClient) -> String {
    super::map_server_not_running_or_io(err, request_id, client).to_string()
}

fn classify_error_response(error: &serde_json::Value) -> HandoffStatus {
    if error["code"].as_str() == Some(APP_MODE_ERROR_CODE) {
        return HandoffStatus::Skipped(APP_MODE_SKIP_REASON.to_string());
    }
    HandoffStatus::Failed(response_error_message(error))
}

fn response_error_message(error: &serde_json::Value) -> String {
    match error["message"].as_str() {
        Some(message) => message.to_string(),
        None => serde_json::to_string(error)
            .unwrap_or_else(|err| format!("failed to render error response: {err}")),
    }
}

fn unknown_session_message(name: &str) -> String {
    format!("unknown session {name}; run `herdr session list` to see the sessions that exist")
}

fn empty_target_message(restrict_to: Option<&str>) -> String {
    match restrict_to {
        Some(name) => format!("session {name} is not running; nothing to hand off"),
        None => "no running sessions; nothing to hand off".to_string(),
    }
}

fn server_log_hint() -> String {
    format!(
        "server logs under {}",
        crate::config::config_dir().display()
    )
}

fn blast_radius_line(targets: &[HandoffTarget]) -> String {
    let names: Vec<&str> = targets.iter().map(|target| target.name.as_str()).collect();
    let plural = if names.len() == 1 { "" } else { "s" };
    format!(
        "live handoff: {} session{plural} ({})",
        names.len(),
        names.join(", ")
    )
}

fn render_human_lines(outcomes: &[HandoffOutcome], log_hint: &str) -> Vec<String> {
    let counts = counts(outcomes);
    let mut lines: Vec<String> = outcomes
        .iter()
        .map(|outcome| match &outcome.status {
            HandoffStatus::Ok => format!("session {}: ok", outcome.name),
            HandoffStatus::Skipped(reason) => {
                format!("session {}: skipped ({reason})", outcome.name)
            }
            HandoffStatus::Failed(error) => format!("session {}: failed: {error}", outcome.name),
        })
        .collect();
    lines.push(format!(
        "live handoff: {} ok, {} skipped, {} failed; {log_hint}",
        counts.ok, counts.skipped, counts.failed
    ));
    lines
}

fn render_json(outcomes: &[HandoffOutcome]) -> serde_json::Value {
    let counts = counts(outcomes);
    let sessions: Vec<serde_json::Value> = outcomes
        .iter()
        .map(|outcome| match &outcome.status {
            HandoffStatus::Ok => serde_json::json!({
                "name": outcome.name,
                "ok": true,
                "status": "ok",
            }),
            HandoffStatus::Skipped(reason) => serde_json::json!({
                "name": outcome.name,
                "ok": false,
                "status": "skipped",
                "reason": reason,
            }),
            HandoffStatus::Failed(error) => serde_json::json!({
                "name": outcome.name,
                "ok": false,
                "status": "failed",
                "error": error,
            }),
        })
        .collect();
    serde_json::json!({
        "sessions": sessions,
        "ok": counts.ok,
        "skipped": counts.skipped,
        "failed": counts.failed,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Counts {
    ok: usize,
    skipped: usize,
    failed: usize,
}

fn counts(outcomes: &[HandoffOutcome]) -> Counts {
    let mut counts = Counts {
        ok: 0,
        skipped: 0,
        failed: 0,
    };
    for outcome in outcomes {
        match outcome.status {
            HandoffStatus::Ok => counts.ok += 1,
            HandoffStatus::Skipped(_) => counts.skipped += 1,
            HandoffStatus::Failed(_) => counts.failed += 1,
        }
    }
    counts
}

fn exit_code(outcomes: &[HandoffOutcome]) -> i32 {
    i32::from(
        outcomes
            .iter()
            .any(|outcome| matches!(outcome.status, HandoffStatus::Failed(_))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(name: &str, running: bool) -> SessionInfo {
        SessionInfo {
            name: name.to_string(),
            default: name == DEFAULT_SESSION_NAME,
            running,
            socket_path: format!("/tmp/herdr-test/{name}/herdr.sock"),
            session_dir: format!("/tmp/herdr-test/{name}"),
        }
    }

    fn targets(names: &[&str]) -> Vec<HandoffTarget> {
        names
            .iter()
            .map(|name| HandoffTarget {
                name: (*name).to_string(),
                socket_path: PathBuf::from(format!("/tmp/herdr-test/{name}/herdr.sock")),
            })
            .collect()
    }

    fn skipped_in_app_mode() -> HandoffStatus {
        HandoffStatus::Skipped(APP_MODE_SKIP_REASON.to_string())
    }

    #[test]
    fn parse_args_extracts_json_flag_and_reuses_server_param_parser() {
        let args = vec![
            "--json".to_string(),
            "--import-exe".to_string(),
            "/usr/local/bin/herdr".to_string(),
            "--expected-protocol=9".to_string(),
        ];

        let (json, params) = parse_args(&args).expect("args");

        assert!(json);
        assert_eq!(params.import_exe.as_deref(), Some("/usr/local/bin/herdr"));
        assert_eq!(params.expected_protocol, Some(9));
    }

    #[test]
    fn parse_args_rejects_unknown_flags() {
        assert!(parse_args(&["--nope".to_string(), "1".to_string()]).is_none());
    }

    #[test]
    fn usage_advertises_the_session_flag() {
        assert!(USAGE.contains("--session <name>"), "usage line: {USAGE}");
    }

    #[test]
    fn select_targets_keeps_running_sessions_in_list_order() {
        let sessions = vec![
            session(DEFAULT_SESSION_NAME, true),
            session("dev", false),
            session("usage", true),
        ];

        let selected = select_targets(sessions, None);

        assert_eq!(
            selected.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            vec![DEFAULT_SESSION_NAME, "usage"]
        );
        assert_eq!(
            selected[1].socket_path,
            PathBuf::from("/tmp/herdr-test/usage/herdr.sock")
        );
    }

    #[test]
    fn select_targets_restricted_to_explicit_session_picks_exactly_one() {
        let sessions = vec![
            session(DEFAULT_SESSION_NAME, true),
            session("dev", true),
            session("usage", true),
        ];

        let selected = select_targets(sessions, Some("dev"));

        assert_eq!(selected, targets(&["dev"]));
    }

    #[test]
    fn select_targets_restricted_to_stopped_session_is_empty() {
        let sessions = vec![session(DEFAULT_SESSION_NAME, true), session("dev", false)];

        assert!(select_targets(sessions, Some("dev")).is_empty());
        assert_eq!(
            empty_target_message(Some("dev")),
            "session dev is not running; nothing to hand off"
        );
    }

    #[test]
    fn ambient_session_env_does_not_narrow_the_target_set() {
        // herdr injects HERDR_SESSION/HERDR_SOCKET_PATH into every pane, so a
        // run started from inside a pane still means "every running session".
        // Only the explicit --session flag narrows it.
        assert_eq!(restriction_from(false, Some("dev".to_string())), None);
        assert_eq!(restriction_from(false, None), None);
        assert_eq!(
            restriction_from(true, Some("dev".to_string())),
            Some("dev".to_string())
        );
        assert_eq!(
            restriction_from(true, None),
            Some(DEFAULT_SESSION_NAME.to_string())
        );

        let sessions = vec![
            session(DEFAULT_SESSION_NAME, true),
            session("dev", true),
            session("usage", true),
        ];
        let ambient = restriction_from(false, Some("dev".to_string()));
        assert_eq!(
            select_targets(sessions, ambient.as_deref()),
            targets(&[DEFAULT_SESSION_NAME, "dev", "usage"])
        );
    }

    #[test]
    fn resolve_targets_rejects_a_session_that_does_not_exist() {
        let sessions = vec![session(DEFAULT_SESSION_NAME, true), session("dev", true)];

        assert_eq!(
            resolve_targets(sessions, Some("devv")),
            Err(
                "unknown session devv; run `herdr session list` to see the sessions that exist"
                    .to_string()
            )
        );
    }

    #[test]
    fn resolve_targets_accepts_an_existing_but_stopped_session() {
        let sessions = vec![session(DEFAULT_SESSION_NAME, true), session("dev", false)];

        assert_eq!(resolve_targets(sessions, Some("dev")), Ok(Vec::new()));
    }

    #[test]
    fn resolve_targets_without_a_restriction_keeps_every_running_session() {
        let sessions = vec![session(DEFAULT_SESSION_NAME, true), session("dev", true)];

        assert_eq!(
            resolve_targets(sessions, None),
            Ok(targets(&[DEFAULT_SESSION_NAME, "dev"]))
        );
    }

    #[test]
    fn blast_radius_line_names_every_session_before_the_run() {
        assert_eq!(
            blast_radius_line(&targets(&[DEFAULT_SESSION_NAME, "dev", "usage"])),
            "live handoff: 3 sessions (default, dev, usage)"
        );
        assert_eq!(
            blast_radius_line(&targets(&["dev"])),
            "live handoff: 1 session (dev)"
        );
    }

    #[test]
    fn all_sessions_ok_reports_every_session_and_exits_zero() {
        let outcomes = run_handoffs(&targets(&[DEFAULT_SESSION_NAME, "dev"]), |_| {
            HandoffStatus::Ok
        });

        assert_eq!(
            render_human_lines(&outcomes, "server logs under /cfg"),
            vec![
                "session default: ok".to_string(),
                "session dev: ok".to_string(),
                "live handoff: 2 ok, 0 skipped, 0 failed; server logs under /cfg".to_string(),
            ]
        );
        assert_eq!(
            render_json(&outcomes),
            serde_json::json!({
                "sessions": [
                    {"name": "default", "ok": true, "status": "ok"},
                    {"name": "dev", "ok": true, "status": "ok"},
                ],
                "ok": 2,
                "skipped": 0,
                "failed": 0,
            })
        );
        assert_eq!(exit_code(&outcomes), 0);
    }

    #[test]
    fn failed_session_does_not_abort_the_remaining_sessions() {
        let mut attempted = Vec::new();
        let outcomes = run_handoffs(
            &targets(&[DEFAULT_SESSION_NAME, "dev", "usage"]),
            |target| {
                attempted.push(target.name.clone());
                if target.name == "dev" {
                    return HandoffStatus::Failed(
                        "handoff stream closed while reading line".to_string(),
                    );
                }
                HandoffStatus::Ok
            },
        );

        assert_eq!(attempted, vec!["default", "dev", "usage"]);
        assert_eq!(
            render_human_lines(&outcomes, "server logs under /cfg"),
            vec![
                "session default: ok".to_string(),
                "session dev: failed: handoff stream closed while reading line".to_string(),
                "session usage: ok".to_string(),
                "live handoff: 2 ok, 0 skipped, 1 failed; server logs under /cfg".to_string(),
            ]
        );
        assert_eq!(
            render_json(&outcomes),
            serde_json::json!({
                "sessions": [
                    {"name": "default", "ok": true, "status": "ok"},
                    {
                        "name": "dev",
                        "ok": false,
                        "status": "failed",
                        "error": "handoff stream closed while reading line",
                    },
                    {"name": "usage", "ok": true, "status": "ok"},
                ],
                "ok": 2,
                "skipped": 0,
                "failed": 1,
            })
        );
        assert_eq!(exit_code(&outcomes), 1);
    }

    #[test]
    fn app_mode_session_is_skipped_instead_of_failed() {
        let outcomes = run_handoffs(&targets(&[DEFAULT_SESSION_NAME, "dev"]), |target| {
            if target.name == "dev" {
                return skipped_in_app_mode();
            }
            HandoffStatus::Ok
        });

        assert_eq!(
            render_human_lines(&outcomes, "server logs under /cfg"),
            vec![
                "session default: ok".to_string(),
                "session dev: skipped (live handoff needs the headless server)".to_string(),
                "live handoff: 1 ok, 1 skipped, 0 failed; server logs under /cfg".to_string(),
            ]
        );
        assert_eq!(
            render_json(&outcomes),
            serde_json::json!({
                "sessions": [
                    {"name": "default", "ok": true, "status": "ok"},
                    {
                        "name": "dev",
                        "ok": false,
                        "status": "skipped",
                        "reason": "live handoff needs the headless server",
                    },
                ],
                "ok": 1,
                "skipped": 1,
                "failed": 0,
            })
        );
        // The whole point: an app-mode session must not pin the exit code at 1.
        assert_eq!(exit_code(&outcomes), 0);
    }

    #[test]
    fn skipped_sessions_stay_out_of_the_failed_count() {
        let outcomes = run_handoffs(&targets(&["a", "b", "c"]), |target| {
            match target.name.as_str() {
                "a" => HandoffStatus::Ok,
                "b" => skipped_in_app_mode(),
                _ => HandoffStatus::Failed("boom".to_string()),
            }
        });

        assert_eq!(
            counts(&outcomes),
            Counts {
                ok: 1,
                skipped: 1,
                failed: 1,
            }
        );
        assert_eq!(exit_code(&outcomes), 1);
    }

    #[test]
    fn zero_running_sessions_is_a_clear_success() {
        let sessions = vec![session(DEFAULT_SESSION_NAME, false), session("dev", false)];
        let selected = select_targets(sessions, None);
        let outcomes = run_handoffs(&selected, |_| panic!("no session should be contacted"));

        assert!(selected.is_empty());
        assert_eq!(
            empty_target_message(None),
            "no running sessions; nothing to hand off"
        );
        assert_eq!(
            render_json(&outcomes),
            serde_json::json!({"sessions": [], "ok": 0, "skipped": 0, "failed": 0})
        );
        assert_eq!(exit_code(&outcomes), 0);
    }

    #[test]
    fn app_mode_error_response_is_classified_as_skipped() {
        assert_eq!(
            classify_error_response(&serde_json::json!({
                "code": "unsupported_in_app_mode",
                "message": "live handoff is only supported by the headless server",
            })),
            skipped_in_app_mode()
        );
    }

    #[test]
    fn other_error_responses_stay_failures() {
        assert_eq!(
            classify_error_response(&serde_json::json!({
                "code": "live_handoff_failed",
                "message": "import binary rejected the handoff",
            })),
            HandoffStatus::Failed("import binary rejected the handoff".to_string())
        );
    }

    #[test]
    fn response_error_message_prefers_the_message_field() {
        assert_eq!(
            response_error_message(&serde_json::json!({
                "code": "live_handoff_failed",
                "message": "import binary rejected the handoff",
            })),
            "import binary rejected the handoff"
        );
        assert_eq!(
            response_error_message(&serde_json::json!({"code": "live_handoff_failed"})),
            "{\"code\":\"live_handoff_failed\"}"
        );
    }

    #[test]
    fn a_stale_socket_reports_the_friendly_server_not_running_text() {
        let target = HandoffTarget {
            name: "dev".to_string(),
            socket_path: PathBuf::from("/tmp/herdr-test/does-not-exist/herdr.sock"),
        };

        let status = handoff_session(&target, &ServerLiveHandoffParams::default());

        let HandoffStatus::Failed(message) = status else {
            panic!("a dead socket should fail: {status:?}");
        };
        assert!(
            message.contains("no herdr server is running at"),
            "raw transport error leaked: {message}"
        );
        assert!(
            !message.contains("os error"),
            "raw transport error leaked: {message}"
        );
    }

    #[test]
    fn handoff_request_timeout_is_generous_enough_for_a_real_handoff() {
        assert_eq!(HANDOFF_REQUEST_TIMEOUT, Duration::from_secs(120));
    }
}
