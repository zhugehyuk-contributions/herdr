use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::api;
use crate::api::client::{ApiClient, ApiClientError};
use crate::session::SessionInfo;

/// Per-session status probes must never stall `herdr status`; matches the
/// server autodetect probe budget.
const SESSION_STATUS_TIMEOUT: Duration = Duration::from_secs(2);

pub(super) fn run_status_command(args: &[String]) -> std::io::Result<i32> {
    let Some((scope, json)) = parse_status_args(args) else {
        return Ok(2);
    };

    match scope {
        StatusScope::Full => print_full_status(json),
        StatusScope::Server => print_server_status(json),
        StatusScope::Client => {
            print_client_status(json)?;
            Ok(0)
        }
        StatusScope::Help => {
            print_status_help();
            Ok(0)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatusScope {
    Full,
    Server,
    Client,
    Help,
}

fn parse_status_args(args: &[String]) -> Option<(StatusScope, bool)> {
    match args.first().map(|arg| arg.as_str()) {
        None => Some((StatusScope::Full, false)),
        Some("--json") if args.len() == 1 => Some((StatusScope::Full, true)),
        Some("server") => {
            parse_status_scope_args(args, StatusScope::Server, "herdr status server [--json]")
        }
        Some("client") => {
            parse_status_scope_args(args, StatusScope::Client, "herdr status client [--json]")
        }
        Some("help" | "--help" | "-h") => {
            if args.len() > 1 {
                print_status_help();
                return None;
            }
            Some((StatusScope::Help, false))
        }
        Some(_) => {
            print_status_help();
            None
        }
    }
}

fn parse_status_scope_args(
    args: &[String],
    scope: StatusScope,
    usage: &str,
) -> Option<(StatusScope, bool)> {
    match args.get(1).map(|arg| arg.as_str()) {
        None => Some((scope, false)),
        Some("--json") if args.len() == 2 => Some((scope, true)),
        _ => {
            eprintln!("usage: {usage}");
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ServerRuntimeStatus {
    Running {
        version: Option<String>,
        protocol: Option<u32>,
        capabilities: Option<crate::api::schema::ServerCapabilities>,
    },
    NotRunning,
}

fn print_full_status(json: bool) -> std::io::Result<i32> {
    let server = read_server_runtime_status()?;
    let sessions = collect_session_status_rows();

    if json {
        print_json(&FullStatusJson {
            client: client_status_json(),
            server: server_status_json(&server),
            sessions: session_status_json(&sessions),
            update: update_status_json(&server),
        })?;
        return Ok(0);
    }

    println!("client:");
    println!("  version: {}", crate::build_info::version());
    if let Some(stamp) = crate::build_info::build_stamp(&crate::build_info::version()) {
        println!("  build: {stamp}");
    }
    println!(
        "  channel: {}",
        crate::config::Config::load().config.update.channel.as_str()
    );
    println!("  protocol: {}", crate::protocol::PROTOCOL_VERSION);
    println!();
    println!("server:");
    print_server_status_body(&server, "  ");
    println!();
    println!("{SESSION_TABLE_HEADING}");
    for line in render_session_table(&sessions) {
        println!("{line}");
    }
    println!();
    println!("update:");
    println!("  restart_needed: {}", restart_needed_label(&server));

    Ok(0)
}

fn print_server_status(json: bool) -> std::io::Result<i32> {
    let server = read_server_runtime_status()?;
    if json {
        print_json(&server_status_json(&server))?;
        return Ok(0);
    }
    print_server_status_body(&server, "");
    Ok(0)
}

fn print_client_status(json: bool) -> std::io::Result<()> {
    if json {
        print_json(&client_status_json())?;
        return Ok(());
    }

    println!("version: {}", crate::build_info::version());
    if let Some(stamp) = crate::build_info::build_stamp(&crate::build_info::version()) {
        println!("build: {stamp}");
    }
    println!(
        "channel: {}",
        crate::config::Config::load().config.update.channel.as_str()
    );
    println!("protocol: {}", crate::protocol::PROTOCOL_VERSION);
    println!("binary: {}", current_exe_label());
    Ok(())
}

fn print_server_status_body(server: &ServerRuntimeStatus, indent: &str) {
    match server {
        ServerRuntimeStatus::Running {
            version, protocol, ..
        } => {
            println!("{indent}status: running");
            println!("{indent}version: {}", option_label(version.as_deref()));
            if let Some(stamp) = version.as_deref().and_then(crate::build_info::build_stamp) {
                println!("{indent}build: {stamp}");
            }
            println!("{indent}protocol: {}", protocol_label(*protocol));
            println!("{indent}compatible: {}", compatibility_label(*protocol));
            println!("{indent}socket: {}", api::socket_path().display());
        }
        ServerRuntimeStatus::NotRunning => {
            println!("{indent}status: not running");
            println!("{indent}socket: {}", api::socket_path().display());
        }
    }
}

fn read_server_runtime_status() -> std::io::Result<ServerRuntimeStatus> {
    match ApiClient::local().status() {
        Ok(status) => Ok(ServerRuntimeStatus::Running {
            version: status.version,
            protocol: status.protocol,
            capabilities: status.capabilities,
        }),
        Err(ApiClientError::Io(err)) if super::server_not_running_error(&err) => {
            Ok(ServerRuntimeStatus::NotRunning)
        }
        Err(err) => Err(api_client_error_to_io(err)),
    }
}

fn api_client_error_to_io(err: ApiClientError) -> std::io::Error {
    match err {
        ApiClientError::Io(err) => err,
        err => std::io::Error::other(err),
    }
}

fn option_label(value: Option<&str>) -> &str {
    value.unwrap_or("unknown")
}

fn protocol_label(protocol: Option<u32>) -> String {
    protocol
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn compatibility_label(protocol: Option<u32>) -> &'static str {
    match protocol {
        Some(protocol) if protocol == crate::protocol::PROTOCOL_VERSION => "yes",
        Some(_) => "no",
        None => "unknown",
    }
}

fn restart_needed_label(server: &ServerRuntimeStatus) -> &'static str {
    match server {
        ServerRuntimeStatus::Running { version, .. } => match version.as_deref() {
            Some(version) if version == crate::build_info::version() => "no",
            Some(_) => "yes",
            None => "unknown",
        },
        ServerRuntimeStatus::NotRunning => "no",
    }
}

const SESSION_TABLE_HEADING: &str = "sessions: (* = active)";
/// The version column is last because release strings vary wildly in length;
/// keeping it ragged keeps every other column aligned.
const SESSION_TABLE_HEADERS: [&str; 5] = ["name", "status", "protocol", "compatible", "version"];
const SESSION_TABLE_GUTTER: usize = 2;

/// One already-probed session, so rendering and JSON shaping stay pure.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionStatusRow {
    name: String,
    default: bool,
    active: bool,
    running: bool,
    version: Option<String>,
    protocol: Option<u32>,
    socket_path: String,
}

fn collect_session_status_rows() -> Vec<SessionStatusRow> {
    let Ok(sessions) = crate::session::list_sessions() else {
        return Vec::new();
    };
    let active_socket = api::socket_path();
    sessions
        .iter()
        .map(|session| {
            let runtime = if session.running {
                read_session_runtime_status(Path::new(&session.socket_path))
            } else {
                None
            };
            session_status_row(session, &active_socket, runtime.as_ref())
        })
        .collect()
}

/// A session that stops answering must degrade to unknown, never abort `herdr status`.
fn read_session_runtime_status(socket_path: &Path) -> Option<api::RuntimeStatus> {
    api::read_runtime_status_at(socket_path, SESSION_STATUS_TIMEOUT)
        .ok()
        .flatten()
}

fn session_status_row(
    session: &SessionInfo,
    active_socket: &Path,
    runtime: Option<&api::RuntimeStatus>,
) -> SessionStatusRow {
    SessionStatusRow {
        name: session.name.clone(),
        default: session.default,
        active: Path::new(&session.socket_path) == active_socket,
        running: session.running,
        version: runtime.and_then(|runtime| runtime.version.clone()),
        protocol: runtime.and_then(|runtime| runtime.protocol),
        socket_path: session.socket_path.clone(),
    }
}

fn session_table_cells(row: &SessionStatusRow) -> [String; 5] {
    if !row.running {
        return [
            row.name.clone(),
            "stopped".to_string(),
            "-".to_string(),
            "-".to_string(),
            "-".to_string(),
        ];
    }
    [
        row.name.clone(),
        "running".to_string(),
        protocol_label(row.protocol),
        compatibility_label(row.protocol).to_string(),
        option_label(row.version.as_deref()).to_string(),
    ]
}

fn render_session_table(rows: &[SessionStatusRow]) -> Vec<String> {
    if rows.is_empty() {
        return vec![format!("{:width$}none", "", width = SESSION_TABLE_GUTTER)];
    }

    let cells: Vec<[String; 5]> = rows.iter().map(session_table_cells).collect();
    let mut widths = SESSION_TABLE_HEADERS.map(str::len);
    for row in &cells {
        for (width, cell) in widths.iter_mut().zip(row) {
            *width = (*width).max(cell.chars().count());
        }
    }

    let mut lines = Vec::with_capacity(cells.len() + 1);
    lines.push(render_session_table_line(
        "",
        &SESSION_TABLE_HEADERS.map(str::to_string),
        &widths,
    ));
    for (row, cells) in rows.iter().zip(&cells) {
        lines.push(render_session_table_line(
            if row.active { "*" } else { "" },
            cells,
            &widths,
        ));
    }
    lines
}

fn render_session_table_line(marker: &str, cells: &[String; 5], widths: &[usize; 5]) -> String {
    let mut line = format!("{marker:<width$}", width = SESSION_TABLE_GUTTER);
    for (index, (cell, width)) in cells.iter().zip(widths).enumerate() {
        if index + 1 == cells.len() {
            line.push_str(cell);
        } else {
            line.push_str(&format!("{cell:<width$}  "));
        }
    }
    line
}

fn session_status_json(rows: &[SessionStatusRow]) -> Vec<SessionStatusJson> {
    rows.iter()
        .map(|row| SessionStatusJson {
            name: row.name.clone(),
            default: row.default,
            active: row.active,
            running: row.running,
            version: row.version.clone(),
            protocol: row.protocol,
            compatible: if row.running {
                row.protocol
                    .map(|protocol| protocol == crate::protocol::PROTOCOL_VERSION)
            } else {
                None
            },
            socket_path: row.socket_path.clone(),
        })
        .collect()
}

#[derive(Serialize)]
struct SessionStatusJson {
    name: String,
    default: bool,
    active: bool,
    running: bool,
    version: Option<String>,
    protocol: Option<u32>,
    compatible: Option<bool>,
    socket_path: String,
}

#[derive(Serialize)]
struct FullStatusJson {
    client: ClientStatusJson,
    server: ServerStatusJson,
    sessions: Vec<SessionStatusJson>,
    update: UpdateStatusJson,
}

#[derive(Serialize)]
struct ClientStatusJson {
    version: String,
    channel: &'static str,
    protocol: u32,
    binary: String,
    session: Option<String>,
}

#[derive(Serialize)]
struct ServerStatusJson {
    status: &'static str,
    running: bool,
    version: Option<String>,
    protocol: Option<u32>,
    capabilities: Option<ServerCapabilitiesJson>,
    compatible: Option<bool>,
    socket: String,
    session: Option<String>,
    restart_needed: Option<bool>,
}

#[derive(Serialize)]
struct ServerCapabilitiesJson {
    live_handoff: bool,
    detached_server_daemon: bool,
}

#[derive(Serialize)]
struct UpdateStatusJson {
    restart_needed: Option<bool>,
}

fn client_status_json() -> ClientStatusJson {
    ClientStatusJson {
        version: crate::build_info::version(),
        channel: crate::config::Config::load().config.update.channel.as_str(),
        protocol: crate::protocol::PROTOCOL_VERSION,
        binary: current_exe_label(),
        session: crate::session::active_name(),
    }
}

fn server_status_json(server: &ServerRuntimeStatus) -> ServerStatusJson {
    match server {
        ServerRuntimeStatus::Running {
            version,
            protocol,
            capabilities,
        } => ServerStatusJson {
            status: "running",
            running: true,
            version: version.clone(),
            protocol: *protocol,
            capabilities: capabilities
                .as_ref()
                .map(|capabilities| ServerCapabilitiesJson {
                    live_handoff: capabilities.live_handoff,
                    detached_server_daemon: capabilities.detached_server_daemon,
                }),
            compatible: protocol.map(|value| value == crate::protocol::PROTOCOL_VERSION),
            socket: api::socket_path().display().to_string(),
            session: crate::session::active_name(),
            restart_needed: restart_needed_bool(server),
        },
        ServerRuntimeStatus::NotRunning => ServerStatusJson {
            status: "not_running",
            running: false,
            version: None,
            protocol: None,
            capabilities: None,
            compatible: None,
            socket: api::socket_path().display().to_string(),
            session: crate::session::active_name(),
            restart_needed: Some(false),
        },
    }
}

fn update_status_json(server: &ServerRuntimeStatus) -> UpdateStatusJson {
    UpdateStatusJson {
        restart_needed: restart_needed_bool(server),
    }
}

fn restart_needed_bool(server: &ServerRuntimeStatus) -> Option<bool> {
    match server {
        ServerRuntimeStatus::Running { version, .. } => match version.as_deref() {
            Some(version) if version == crate::build_info::version() => Some(false),
            Some(_) => Some(true),
            None => None,
        },
        ServerRuntimeStatus::NotRunning => Some(false),
    }
}

fn print_json(value: &impl Serialize) -> std::io::Result<()> {
    println!("{}", serde_json::to_string(value)?);
    Ok(())
}

fn current_exe_label() -> String {
    std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|err| format!("unknown ({err})"))
}

fn print_status_help() {
    eprintln!("herdr status commands:");
    eprintln!(
        "  herdr status [--json]         show local client, active server and all session status"
    );
    eprintln!("  herdr status server [--json]  show running server status");
    eprintln!("  herdr status client [--json]  show local client binary status");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(name: &str, running: bool) -> SessionInfo {
        SessionInfo {
            name: name.to_string(),
            default: name == crate::session::DEFAULT_SESSION_NAME,
            running,
            socket_path: format!("/tmp/herdr-status-test/{name}/herdr.sock"),
            session_dir: format!("/tmp/herdr-status-test/{name}"),
        }
    }

    fn runtime(version: &str, protocol: u32) -> api::RuntimeStatus {
        api::RuntimeStatus {
            version: Some(version.to_string()),
            protocol: Some(protocol),
            capabilities: None,
        }
    }

    fn mixed_rows() -> Vec<SessionStatusRow> {
        let current = crate::protocol::PROTOCOL_VERSION;
        let active = session("dev", true);
        let active_socket = std::path::PathBuf::from(&active.socket_path);
        vec![
            session_status_row(&session("default", false), &active_socket, None),
            session_status_row(&active, &active_socket, Some(&runtime("0.8.0", current))),
            session_status_row(
                &session("usage", true),
                &active_socket,
                Some(&runtime("0.7.1", current - 1)),
            ),
        ]
    }

    #[test]
    fn session_table_renders_running_stopped_and_active_rows() {
        let current = crate::protocol::PROTOCOL_VERSION;
        let older = current - 1;

        assert_eq!(
            render_session_table(&mixed_rows()),
            vec![
                "  name     status   protocol  compatible  version".to_string(),
                "  default  stopped  -         -           -".to_string(),
                format!("* dev      running  {current:<8}  yes         0.8.0"),
                format!("  usage    running  {older:<8}  no          0.7.1"),
            ]
        );
    }

    #[test]
    fn session_table_marks_only_the_socket_backing_the_server_block_as_active() {
        let rows = mixed_rows();
        let active: Vec<_> = rows
            .iter()
            .filter(|row| row.active)
            .map(|row| row.name.as_str())
            .collect();

        assert_eq!(active, vec!["dev"]);
    }

    #[test]
    fn unreachable_running_session_degrades_to_unknown() {
        let row = session_status_row(
            &session("dev", true),
            std::path::Path::new("/tmp/herdr-status-test/other/herdr.sock"),
            None,
        );

        assert!(row.running);
        assert_eq!(row.version, None);
        assert_eq!(row.protocol, None);
        assert!(!row.active);
        assert_eq!(
            render_session_table(std::slice::from_ref(&row)),
            vec![
                "  name  status   protocol  compatible  version".to_string(),
                "  dev   running  unknown   unknown     unknown".to_string(),
            ]
        );
        assert_eq!(session_status_json(&[row])[0].compatible, None);
    }

    #[test]
    fn session_table_without_sessions_renders_none() {
        assert_eq!(render_session_table(&[]), vec!["  none".to_string()]);
    }

    #[test]
    fn session_status_json_reports_every_session() {
        let current = crate::protocol::PROTOCOL_VERSION;
        let json = serde_json::to_value(session_status_json(&mixed_rows())).unwrap();

        assert_eq!(
            json,
            serde_json::json!([
                {
                    "name": "default",
                    "default": true,
                    "active": false,
                    "running": false,
                    "version": null,
                    "protocol": null,
                    "compatible": null,
                    "socket_path": "/tmp/herdr-status-test/default/herdr.sock",
                },
                {
                    "name": "dev",
                    "default": false,
                    "active": true,
                    "running": true,
                    "version": "0.8.0",
                    "protocol": current,
                    "compatible": true,
                    "socket_path": "/tmp/herdr-status-test/dev/herdr.sock",
                },
                {
                    "name": "usage",
                    "default": false,
                    "active": false,
                    "running": true,
                    "version": "0.7.1",
                    "protocol": current - 1,
                    "compatible": false,
                    "socket_path": "/tmp/herdr-status-test/usage/herdr.sock",
                },
            ])
        );
    }
}
