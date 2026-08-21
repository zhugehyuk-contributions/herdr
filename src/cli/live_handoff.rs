use std::path::PathBuf;

use crate::api::client::{ApiClient, ConnectionTarget};
use crate::api::schema::{Method, Request, ServerLiveHandoffParams};
use crate::session::{SessionInfo, DEFAULT_SESSION_NAME};

const USAGE: &str = "usage: herdr live-handoff [--json] [--import-exe <path>] [--expected-protocol <n>] [--expected-version <version>]";

/// One session the command will try to hand off, resolved to its own socket so
/// every hop targets that session's server instead of the process-wide active one.
#[derive(Debug, Clone, PartialEq, Eq)]
struct HandoffTarget {
    name: String,
    socket_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HandoffOutcome {
    name: String,
    error: Option<String>,
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
    let targets = select_targets(crate::session::list_sessions()?, restrict_to.as_deref());
    if targets.is_empty() {
        if json {
            println!("{}", render_json(&[]));
        } else {
            println!("{}", empty_target_message(restrict_to.as_deref()));
        }
        return Ok(0);
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

/// A global `--session <name>` keeps its usual meaning: it narrows the run to
/// that one session instead of every running one.
fn restriction_from_active_session() -> Option<String> {
    if !crate::session::explicit_session_requested() {
        return None;
    }
    Some(crate::session::active_name().unwrap_or_else(|| DEFAULT_SESSION_NAME.to_string()))
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
    mut handoff: impl FnMut(&HandoffTarget) -> Result<(), String>,
) -> Vec<HandoffOutcome> {
    targets
        .iter()
        .map(|target| HandoffOutcome {
            name: target.name.clone(),
            error: handoff(target).err(),
        })
        .collect()
}

fn handoff_session(target: &HandoffTarget, params: &ServerLiveHandoffParams) -> Result<(), String> {
    // Live handoff is itself a protocol-mismatch recovery path, so it must
    // reach each server without the normal CLI compatibility guard.
    let client = ApiClient::for_target(ConnectionTarget::SocketPath(target.socket_path.clone()));
    let response = client
        .request_value(&Request {
            id: format!("cli:live-handoff:{}", target.name),
            method: Method::ServerLiveHandoff(params.clone()),
        })
        .map_err(|err| err.to_string())?;
    match response.get("error") {
        Some(error) => Err(response_error_message(error)),
        None => Ok(()),
    }
}

fn response_error_message(error: &serde_json::Value) -> String {
    match error["message"].as_str() {
        Some(message) => message.to_string(),
        None => serde_json::to_string(error)
            .unwrap_or_else(|err| format!("failed to render error response: {err}")),
    }
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

fn render_human_lines(outcomes: &[HandoffOutcome], log_hint: &str) -> Vec<String> {
    let (ok, failed) = counts(outcomes);
    let mut lines: Vec<String> = outcomes
        .iter()
        .map(|outcome| match &outcome.error {
            Some(error) => format!("session {}: failed: {error}", outcome.name),
            None => format!("session {}: ok", outcome.name),
        })
        .collect();
    lines.push(format!(
        "live handoff: {ok} ok, {failed} failed; {log_hint}"
    ));
    lines
}

fn render_json(outcomes: &[HandoffOutcome]) -> serde_json::Value {
    let (ok, failed) = counts(outcomes);
    let sessions: Vec<serde_json::Value> = outcomes
        .iter()
        .map(|outcome| match &outcome.error {
            Some(error) => serde_json::json!({
                "name": outcome.name,
                "ok": false,
                "error": error,
            }),
            None => serde_json::json!({
                "name": outcome.name,
                "ok": true,
            }),
        })
        .collect();
    serde_json::json!({
        "sessions": sessions,
        "ok": ok,
        "failed": failed,
    })
}

fn counts(outcomes: &[HandoffOutcome]) -> (usize, usize) {
    let failed = outcomes
        .iter()
        .filter(|outcome| outcome.error.is_some())
        .count();
    (outcomes.len() - failed, failed)
}

fn exit_code(outcomes: &[HandoffOutcome]) -> i32 {
    i32::from(outcomes.iter().any(|outcome| outcome.error.is_some()))
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
    fn all_sessions_ok_reports_every_session_and_exits_zero() {
        let outcomes = run_handoffs(&targets(&[DEFAULT_SESSION_NAME, "dev"]), |_| Ok(()));

        assert_eq!(
            render_human_lines(&outcomes, "server logs under /cfg"),
            vec![
                "session default: ok".to_string(),
                "session dev: ok".to_string(),
                "live handoff: 2 ok, 0 failed; server logs under /cfg".to_string(),
            ]
        );
        assert_eq!(
            render_json(&outcomes),
            serde_json::json!({
                "sessions": [
                    {"name": "default", "ok": true},
                    {"name": "dev", "ok": true},
                ],
                "ok": 2,
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
                    return Err("handoff stream closed while reading line".to_string());
                }
                Ok(())
            },
        );

        assert_eq!(attempted, vec!["default", "dev", "usage"]);
        assert_eq!(
            render_human_lines(&outcomes, "server logs under /cfg"),
            vec![
                "session default: ok".to_string(),
                "session dev: failed: handoff stream closed while reading line".to_string(),
                "session usage: ok".to_string(),
                "live handoff: 2 ok, 1 failed; server logs under /cfg".to_string(),
            ]
        );
        assert_eq!(
            render_json(&outcomes),
            serde_json::json!({
                "sessions": [
                    {"name": "default", "ok": true},
                    {
                        "name": "dev",
                        "ok": false,
                        "error": "handoff stream closed while reading line",
                    },
                    {"name": "usage", "ok": true},
                ],
                "ok": 2,
                "failed": 1,
            })
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
            serde_json::json!({"sessions": [], "ok": 0, "failed": 0})
        );
        assert_eq!(exit_code(&outcomes), 0);
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
}
