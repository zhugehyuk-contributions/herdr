//! `herdr pair` — hand a phone an ssh key by putting one on the glass.
//!
//! The mobile client dials an ordinary ssh server; there is no pairing protocol. The only thing a
//! phone cannot practically be given by hand is the **private key**, which is the friction the
//! owner named ("ssh 접속 키 때문에"). So this command mints a *dedicated* ed25519 for the phone
//! and carries it in the code (`mobile/.prd/12-qr-pairing.md`, option B′): a leaked photo of the
//! screen then costs one revocable `authorized_keys` line rather than the user's own key.
//!
//! Two rules this file exists to hold:
//!
//! - **Writing `authorized_keys` is opt-in.** A default run prints the public key and the sentence
//!   that says what to do with it, and touches nothing. Granting shell access is irreversible in
//!   the sense that matters (you cannot un-grant what was used in between), so it cannot be a
//!   side effect of asking for a QR code.
//! - **Key material never survives the process.** `ssh-keygen` writes to a temp dir that a `Drop`
//!   guard removes on every path, success or failure, so a crash between mint and render does not
//!   leave a private key in `/tmp`.
//!
//! The payload schema is owned by the phone (`mobile/src/pairing/pairing-payload.ts`); the tests
//! at the bottom pin this side to it, including that `issuedAt` is epoch **milliseconds** — the
//! phone compares it against `Date.now()` and a seconds value would read as 1970.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::api::schema::{EmptyParams, Method, Request};
use crate::remote_registry::{RemoteDefinitionSnapshot, RemoteTargetSnapshot};

/// Payload version the phone accepts. Anything else is refused there with "update herdr"/"update
/// the app", so this constant moves only together with the parser on the other side.
const PAIRING_PAYLOAD_VERSION: u32 = 1;
const DEFAULT_DEVICE: &str = "phone";
const DEFAULT_SSH_PORT: u16 = 22;
const KEY_COMMENT_PREFIX: &str = "herdr-mobile/";

const USAGE: &str = "usage: herdr pair [<remote-id-or-name>] [--json] [--authorize] [--device NAME] [--host HOST] [--user USER]";

pub(super) fn run_pair_command(args: &[String]) -> std::io::Result<i32> {
    let args = super::expand_equals_args(args, &["--device", "--host", "--user"]);
    let parsed = match parse_pair_args(&args) {
        Ok(parsed) => parsed,
        Err(code) => return Ok(code),
    };

    let target = match resolve_target(&parsed)? {
        Ok(target) => target,
        Err(code) => return Ok(code),
    };

    // The phone dials the *target* host, so the key has to be authorized there. When that host is
    // not this machine we cannot do it for the user, and silently writing this machine's
    // authorized_keys would authorize the wrong box.
    if parsed.authorize && !target.local {
        eprintln!(
            "herdr pair: --authorize can only write this machine's authorized_keys, and this code pairs with {}.",
            target.host
        );
        eprintln!(
            "Run `herdr pair --authorize` on {} instead, or add the printed line to its authorized_keys.",
            target.host
        );
        return Ok(2);
    }

    let device = parsed.device.as_deref().unwrap_or(DEFAULT_DEVICE);
    let key = match mint_pairing_key(device) {
        Ok(key) => key,
        Err(err) => {
            eprintln!("herdr pair: could not mint a key with ssh-keygen: {err}");
            return Ok(1);
        }
    };

    let authorized_keys = authorized_keys_path();
    if parsed.authorize && authorized_keys.is_none() {
        eprintln!(
            "herdr pair: --authorize needs a home directory and none is set; add this line to authorized_keys by hand:"
        );
        eprintln!("{}", key.public_line);
        return Ok(1);
    }

    let payload = build_payload(&target, Some(key.private.clone()));

    crate::platform::begin_cli_output();
    let mut stdout = std::io::stdout().lock();
    let mut stderr = std::io::stderr().lock();
    emit_pairing(
        &PairOutput {
            payload: &payload,
            public_key_line: &key.public_line,
            notes: &target.notes,
            json: parsed.json,
            authorize: parsed.authorize,
            authorized_keys: authorized_keys.as_deref(),
            terminal_width: terminal_width(),
        },
        &mut stdout,
        &mut stderr,
    )
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct PairArgs {
    remote: Option<String>,
    json: bool,
    authorize: bool,
    device: Option<String>,
    host: Option<String>,
    user: Option<String>,
}

fn parse_pair_args(args: &[String]) -> Result<PairArgs, i32> {
    let mut parsed = PairArgs::default();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--json" => parsed.json = true,
            "--authorize" => parsed.authorize = true,
            "--device" | "--host" | "--user" => {
                let flag = args[index].as_str();
                let Some(value) = args.get(index + 1) else {
                    eprintln!("herdr pair: {flag} needs a value");
                    eprintln!("{USAGE}");
                    return Err(2);
                };
                match flag {
                    "--device" => parsed.device = Some(value.clone()),
                    "--host" => parsed.host = Some(value.clone()),
                    _ => parsed.user = Some(value.clone()),
                }
                index += 1;
            }
            "help" | "--help" | "-h" => {
                eprintln!("{USAGE}");
                return Err(0);
            }
            other if other.starts_with('-') => {
                eprintln!("unknown option: {other}");
                eprintln!("{USAGE}");
                return Err(2);
            }
            other if parsed.remote.is_none() => parsed.remote = Some(other.to_string()),
            _ => {
                eprintln!("{USAGE}");
                return Err(2);
            }
        }
        index += 1;
    }
    Ok(parsed)
}

/// Where the phone should dial, and what we had to guess to say so.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedTarget {
    name: Option<String>,
    host: String,
    port: u16,
    user: String,
    session: Option<String>,
    /// True when the code points at the machine running this command, which is the only case where
    /// `--authorize` can do anything real.
    local: bool,
    notes: Vec<String>,
}

fn resolve_target(args: &PairArgs) -> std::io::Result<Result<ResolvedTarget, i32>> {
    let Some(query) = args.remote.as_deref() else {
        return Ok(
            resolve_local(args, None, None, env_user(), crate::platform::hostname()).map_err(
                |message| {
                    eprintln!("{message}");
                    2
                },
            ),
        );
    };

    let remotes = match remote_definitions()? {
        Ok(remotes) => remotes,
        Err(code) => return Ok(Err(code)),
    };
    let Some(remote) = remotes
        .iter()
        .find(|remote| remote.id == query)
        .or_else(|| remotes.iter().find(|remote| remote.name == query))
    else {
        eprintln!("herdr pair: no remote named {query}.");
        if remotes.is_empty() {
            eprintln!("This server has no remotes; run `herdr pair` with no argument to pair with this machine.");
        } else {
            eprintln!("Known remotes:");
            for remote in &remotes {
                eprintln!("  {} ({})", remote.name, remote.id);
            }
        }
        return Ok(Err(2));
    };

    Ok(
        resolve_remote(remote, args, env_user(), crate::platform::hostname()).map_err(|message| {
            eprintln!("{message}");
            2
        }),
    )
}

/// The remotes this desktop already knows, straight from the running server — the same list the
/// sidebar shows. `Err(code)` is a server that answered with an error, which is not the same thing
/// as "no remotes" and must not be reported as one.
fn remote_definitions() -> std::io::Result<Result<Vec<RemoteDefinitionSnapshot>, i32>> {
    let response = super::send_request(&Request {
        id: "cli:pair:remote:list".into(),
        method: Method::RemoteList(EmptyParams::default()),
    })?;
    if let Some(error) = response.get("error") {
        eprintln!("{error}");
        return Ok(Err(1));
    }
    serde_json::from_value(response["result"]["remotes"].clone())
        .map(Ok)
        .map_err(std::io::Error::other)
}

/// The local target. `host`/`user` are genuinely unknowable here — herdr does not know which of
/// this machine's addresses the phone can route to — so a guess is made and *said out loud* rather
/// than presented as fact.
fn resolve_local(
    args: &PairArgs,
    name: Option<String>,
    session: Option<String>,
    env_user: Option<String>,
    hostname: Option<String>,
) -> Result<ResolvedTarget, String> {
    let mut notes = Vec::new();
    let mut guessed = Vec::new();

    let host = match args.host.clone() {
        Some(host) => host,
        None => {
            let Some(host) = hostname else {
                return Err(
                    "herdr pair: cannot determine this machine's hostname; pass --host <address the phone can reach>".into(),
                );
            };
            guessed.push(format!("host={host} (this machine's hostname)"));
            host
        }
    };
    let user = match args.user.clone() {
        Some(user) => user,
        None => {
            let Some(user) = env_user else {
                return Err(
                    "herdr pair: cannot determine the login user; pass --user <name>".into(),
                );
            };
            guessed.push(format!("user={user} ($USER)"));
            user
        }
    };
    if !guessed.is_empty() {
        notes.push(format!(
            "herdr pair: guessed {} — herdr cannot tell whether the phone can reach that address; pass --host/--user if it cannot.",
            guessed.join(", ")
        ));
    }

    Ok(ResolvedTarget {
        name,
        host,
        port: DEFAULT_SSH_PORT,
        user,
        session,
        local: true,
        notes,
    })
}

fn resolve_remote(
    remote: &RemoteDefinitionSnapshot,
    args: &PairArgs,
    env_user: Option<String>,
    hostname: Option<String>,
) -> Result<ResolvedTarget, String> {
    match &remote.target {
        // A `local` remote is this same box under another name, so it resolves exactly like the
        // no-argument case — including that `--authorize` stays meaningful.
        RemoteTargetSnapshot::Local { session } => resolve_local(
            args,
            Some(remote.name.clone()),
            remote.session.clone().or_else(|| session.clone()),
            env_user,
            hostname,
        ),
        RemoteTargetSnapshot::Ssh { target, args: ssh } => {
            let Some(destination) = parse_ssh_destination(target, ssh) else {
                return Err(format!(
                    "herdr pair: cannot read a host out of remote target {target}; pass --host/--user"
                ));
            };
            let mut notes = Vec::new();
            let host = args.host.clone().unwrap_or(destination.host);
            let user = match args.user.clone().or(destination.user) {
                Some(user) => user,
                None => {
                    let Some(user) = env_user else {
                        return Err(format!(
                            "herdr pair: remote target {target} names no user and $USER is unset; pass --user <name>"
                        ));
                    };
                    // `ssh z-box` may resolve its user from ~/.ssh/config, which herdr does not
                    // read. Saying so beats shipping a code that logs in as the wrong account.
                    notes.push(format!(
                        "herdr pair: remote target {target} names no user; guessed user={user} ($USER), which ssh config may override — pass --user if it does."
                    ));
                    user
                }
            };
            Ok(ResolvedTarget {
                name: Some(remote.name.clone()),
                host,
                port: destination.port.unwrap_or(DEFAULT_SSH_PORT),
                user,
                session: remote.session.clone(),
                local: false,
                notes,
            })
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SshDestination {
    user: Option<String>,
    host: String,
    port: Option<u16>,
}

/// Reads `user@host` / `ssh://user@host:port` plus a `-p` in the stored ssh options. Anything
/// fancier (`-o Port=`, a `Host` alias resolved by ssh config) is left to `--host`/`--user`; a
/// wrong guess here would produce a code that scans fine and connects nowhere.
fn parse_ssh_destination(target: &str, ssh_args: &[String]) -> Option<SshDestination> {
    let target = target.trim();
    let rest = target.strip_prefix("ssh://").unwrap_or(target);
    let (user, hostport) = match rest.rsplit_once('@') {
        Some((user, hostport)) if !user.is_empty() => (Some(user.to_string()), hostport),
        _ => (None, rest),
    };

    let (host, uri_port) = split_host_port(hostport)?;
    if host.is_empty() {
        return None;
    }

    Some(SshDestination {
        user,
        host,
        port: uri_port.or_else(|| port_from_ssh_args(ssh_args)),
    })
}

fn split_host_port(hostport: &str) -> Option<(String, Option<u16>)> {
    if let Some(rest) = hostport.strip_prefix('[') {
        // Bracketed IPv6: `[::1]` or `[::1]:2222`.
        let (host, tail) = rest.split_once(']')?;
        let port = match tail.strip_prefix(':') {
            Some(port) => Some(port.parse().ok()?),
            None => None,
        };
        return Some((host.to_string(), port));
    }
    match hostport.split_once(':') {
        // A bare `host:port` is only a port when the tail parses as one; an unbracketed IPv6
        // literal has several colons and no port.
        Some((host, port)) if !port.contains(':') => match port.parse::<u16>() {
            Ok(port) => Some((host.to_string(), Some(port))),
            Err(_) => Some((hostport.to_string(), None)),
        },
        _ => Some((hostport.to_string(), None)),
    }
}

fn port_from_ssh_args(ssh_args: &[String]) -> Option<u16> {
    let mut index = 0;
    while index < ssh_args.len() {
        let arg = ssh_args[index].as_str();
        if arg == "-p" {
            return ssh_args.get(index + 1)?.parse().ok();
        }
        if let Some(value) = arg.strip_prefix("-p") {
            return value.parse().ok();
        }
        index += 1;
    }
    None
}

fn env_user() -> Option<String> {
    std::env::var("USER")
        .ok()
        .or_else(|| std::env::var("USERNAME").ok())
        .filter(|user| !user.is_empty())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct PairingPayload {
    v: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    host: String,
    port: u16,
    user: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    key: Option<String>,
    /// Epoch **milliseconds** (`Date.now()` on the other side). The phone warns past 10 minutes so
    /// a photographed code announces itself as one.
    #[serde(rename = "issuedAt")]
    issued_at: u64,
}

fn build_payload(target: &ResolvedTarget, key: Option<String>) -> PairingPayload {
    PairingPayload {
        v: PAIRING_PAYLOAD_VERSION,
        name: target.name.clone(),
        host: target.host.clone(),
        port: target.port,
        user: target.user.clone(),
        session: target.session.clone(),
        key,
        issued_at: now_ms(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(0)
}

struct MintedKey {
    private: String,
    public_line: String,
}

/// Mints the phone's key with `ssh-keygen` rather than a crypto crate: the key has to be readable
/// by every ssh implementation involved (the phone's sshj, the local sshd), and openssh's own tool
/// is the definition of that format.
fn mint_pairing_key(device: &str) -> std::io::Result<MintedKey> {
    let dir = TempKeyDir::create()?;
    let key_path = dir.path().join("id_ed25519");
    let comment = key_comment(device);

    let output = std::process::Command::new("ssh-keygen")
        .arg("-t")
        .arg("ed25519")
        .arg("-N")
        .arg("")
        .arg("-C")
        .arg(&comment)
        .arg("-f")
        .arg(&key_path)
        .arg("-q")
        .output()?;
    if !output.status.success() {
        return Err(std::io::Error::other(format!(
            "ssh-keygen exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }

    let private = std::fs::read_to_string(&key_path)?;
    let public_line = std::fs::read_to_string(key_path.with_extension("pub"))?
        .trim()
        .to_string();
    Ok(MintedKey {
        private,
        public_line,
    })
    // `dir` drops here and takes both files with it, on this path and on every `?` above.
}

fn key_comment(device: &str) -> String {
    let device: String = device
        .chars()
        .map(|ch| if ch.is_whitespace() { '-' } else { ch })
        .collect();
    let device = device.trim_matches('-');
    if device.is_empty() {
        format!("{KEY_COMMENT_PREFIX}{DEFAULT_DEVICE}")
    } else {
        format!("{KEY_COMMENT_PREFIX}{device}")
    }
}

/// Owns the directory `ssh-keygen` writes into so the private key cannot outlive this process:
/// `Drop` runs on the error paths too, which is the whole reason this is a type and not two
/// `remove_file` calls at the end of the happy path.
struct TempKeyDir(PathBuf);

impl TempKeyDir {
    fn create() -> std::io::Result<Self> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.subsec_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("herdr-pair-{}-{nanos}", std::process::id()));
        // `create_dir` (not `create_dir_all`) fails if the path exists, so we never mint into a
        // directory somebody else can already read.
        std::fs::create_dir(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempKeyDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn authorized_keys_path() -> Option<PathBuf> {
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
    } else {
        std::env::var_os("HOME")
    }?;
    if home.is_empty() {
        return None;
    }
    Some(PathBuf::from(home).join(".ssh").join("authorized_keys"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthorizeOutcome {
    Added,
    AlreadyPresent,
}

/// The text to append, or `None` when this device already has a line. Pure so the "never rewrite
/// what is already there" rule is testable without a filesystem: the return value is an *addition*
/// and there is no code path that produces a replacement.
fn authorized_keys_addition(existing: &str, line: &str) -> Option<String> {
    let line = line.trim();
    let comment = key_line_comment(line);
    let duplicate = existing.lines().any(|present| {
        present.trim() == line || (comment.is_some() && key_line_comment(present) == comment)
    });
    if duplicate {
        return None;
    }

    let mut addition = String::new();
    if !existing.is_empty() && !existing.ends_with('\n') {
        addition.push('\n');
    }
    addition.push_str(line);
    addition.push('\n');
    Some(addition)
}

/// The comment field of an `authorized_keys` line (`<type> <blob> <comment>`), which is what makes
/// a device revocable by name. Lines carrying openssh *options* before the type parse as something
/// else here; that only costs a duplicate of our own line, never a lost one.
fn key_line_comment(line: &str) -> Option<&str> {
    let mut rest = line.trim();
    if rest.is_empty() || rest.starts_with('#') {
        return None;
    }
    for _ in 0..2 {
        let (_, tail) = rest.split_once(char::is_whitespace)?;
        rest = tail.trim_start();
    }
    if rest.is_empty() {
        None
    } else {
        Some(rest)
    }
}

/// Appends, and only appends. The file is opened in append mode so nothing that is already in it
/// can be lost; `mode(0o600)` applies only when we create it, so an existing file keeps whatever
/// permissions the user gave it.
fn append_authorized_key(path: &Path, line: &str) -> std::io::Result<AuthorizeOutcome> {
    let existing = match std::fs::read_to_string(path) {
        Ok(existing) => existing,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(err),
    };
    let Some(addition) = authorized_keys_addition(&existing, line) else {
        return Ok(AuthorizeOutcome::AlreadyPresent);
    };

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
            }
        }
    }

    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(addition.as_bytes())?;
    Ok(AuthorizeOutcome::Added)
}

struct PairOutput<'a> {
    payload: &'a PairingPayload,
    public_key_line: &'a str,
    notes: &'a [String],
    json: bool,
    authorize: bool,
    /// `None` only when there is no home directory to hang `.ssh/authorized_keys` off.
    authorized_keys: Option<&'a Path>,
    terminal_width: Option<u16>,
}

/// Everything after "which machine, which key" — split out so the tests can drive a full run
/// against a temp path and assert what was and was not written.
fn emit_pairing(
    output: &PairOutput<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> std::io::Result<i32> {
    for note in output.notes {
        writeln!(err, "{note}")?;
    }

    let authorized_keys_display = output
        .authorized_keys
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "~/.ssh/authorized_keys".to_string());

    if output.authorize {
        let Some(path) = output.authorized_keys else {
            writeln!(
                err,
                "herdr pair: --authorize needs a home directory and none is set"
            )?;
            return Ok(1);
        };
        match append_authorized_key(path, output.public_key_line) {
            Ok(AuthorizeOutcome::Added) => writeln!(
                err,
                "herdr pair: appended {} to {authorized_keys_display}; delete that line to revoke.",
                key_line_comment(output.public_key_line).unwrap_or("the key")
            )?,
            Ok(AuthorizeOutcome::AlreadyPresent) => writeln!(
                err,
                "herdr pair: {authorized_keys_display} already has a line for {}; left it alone.",
                key_line_comment(output.public_key_line).unwrap_or("this device")
            )?,
            Err(error) => {
                writeln!(
                    err,
                    "herdr pair: could not write {authorized_keys_display}: {error}"
                )?;
                return Ok(1);
            }
        }
    } else {
        // Deliberately not stdout in --json mode: that stream is the payload and nothing else.
        let notice: &mut dyn Write = if output.json { err } else { out };
        writeln!(
            notice,
            "herdr pair: nothing was written. Add this line to {authorized_keys_display}, or run again with --authorize:"
        )?;
        writeln!(notice, "{}", output.public_key_line)?;
    }

    let payload = serde_json::to_string(output.payload).map_err(std::io::Error::other)?;
    if output.json {
        writeln!(out, "{payload}")?;
        return Ok(0);
    }

    let rendered = match render_qr(&payload) {
        Ok(rendered) => rendered,
        Err(error) => {
            writeln!(
                err,
                "herdr pair: could not encode this payload as a QR code ({error}); run `herdr pair --json` and carry it another way."
            )?;
            return Ok(1);
        }
    };
    let width = rendered_width(&rendered);
    writeln!(out, "{rendered}")?;
    writeln!(
        out,
        "Scan with the herdr app: {} — {}@{}:{}",
        output.payload.name.as_deref().unwrap_or("this machine"),
        output.payload.user,
        output.payload.host,
        output.payload.port
    )?;
    writeln!(
        err,
        "herdr pair: this code carries a private key — anything that photographs the screen gets a shell as {}@{}. Close it when the phone has scanned.",
        output.payload.user, output.payload.host
    )?;
    if let Some(columns) = output.terminal_width {
        if width > usize::from(columns) {
            writeln!(
                err,
                "herdr pair: the code is {width} columns wide but this terminal is {columns}; it is cut off and will not scan. Widen the window, shrink the font, or use `herdr pair --json`."
            )?;
        }
    }
    Ok(0)
}

/// Half-block rendering: one text row per two QR rows, so a version-20-ish code (which is what a
/// payload carrying a private key needs) is ~53 rows instead of ~105. Width is unavoidably one
/// column per module, which is what the too-wide warning above exists for.
fn render_qr(text: &str) -> Result<String, qrcode::types::QrError> {
    use qrcode::render::unicode;
    use qrcode::{EcLevel, QrCode};

    // Lowest error correction on purpose: this code lives on a screen for seconds at arm's length,
    // not on a printed sticker, and every level up costs modules the terminal has to fit.
    let code = QrCode::with_error_correction_level(text, EcLevel::L)?;
    Ok(code
        .render::<unicode::Dense1x2>()
        .quiet_zone(true)
        .module_dimensions(1, 1)
        .build())
}

fn rendered_width(rendered: &str) -> usize {
    rendered
        .lines()
        .map(|line| line.chars().count())
        .max()
        .unwrap_or(0)
}

fn terminal_width() -> Option<u16> {
    crossterm::terminal::size()
        .ok()
        .map(|(columns, _)| columns)
        .filter(|columns| *columns > 0)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::{
        AuthorizeOutcome, PairArgs, PairOutput, PairingPayload, ResolvedTarget, SshDestination,
    };

    /// A real `ssh-keygen -t ed25519` output, kept as a fixture so the payload tests do not depend
    /// on spawning a process (and so they still pin the shape on a box without openssh).
    const FIXTURE_PRIVATE_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----\n";
    const FIXTURE_PUBLIC_LINE: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAbCdEfGhIjKlMnOpQrStUvWxYz herdr-mobile/phone";

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("herdr-pair-test-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn target() -> ResolvedTarget {
        ResolvedTarget {
            name: Some("iq-64".into()),
            host: "10.0.2.2".into(),
            port: 2222,
            user: "z".into(),
            session: Some("work".into()),
            local: true,
            notes: Vec::new(),
        }
    }

    // --- required test 1: the payload the phone parses ---------------------------------------

    #[test]
    fn payload_matches_the_schema_the_phone_parses() {
        let payload = super::build_payload(&target(), Some(FIXTURE_PRIVATE_KEY.to_string()));
        let value: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&payload).unwrap()).unwrap();

        // `v` is a fixed 1: the phone refuses anything else outright.
        assert_eq!(value["v"], 1);
        // host/user are required on the other side; port/name/session/key are optional but we send
        // them, and the phone reads exactly these names.
        assert_eq!(value["host"], "10.0.2.2");
        assert_eq!(value["user"], "z");
        assert_eq!(value["port"], 2222);
        assert_eq!(value["name"], "iq-64");
        assert_eq!(value["session"], "work");
        assert!(value["key"]
            .as_str()
            .expect("key is a string")
            .starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));

        // Epoch MILLISECONDS: the phone compares against Date.now(), so a seconds value would date
        // every code to 1970 and never warn. 1e12 ms = 2001, 1e12 s = year 33658.
        let issued_at = value["issuedAt"].as_u64().expect("issuedAt is a number");
        assert!(
            issued_at >= 1_000_000_000_000,
            "issuedAt {issued_at} is not epoch milliseconds"
        );
        assert!(
            issued_at < 100_000_000_000_000,
            "issuedAt {issued_at} is not epoch milliseconds"
        );
    }

    #[test]
    fn payload_omits_absent_optionals_instead_of_sending_null() {
        let payload = super::build_payload(
            &ResolvedTarget {
                name: None,
                session: None,
                ..target()
            },
            None,
        );
        let value: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&payload).unwrap()).unwrap();
        assert!(value.get("name").is_none());
        assert!(value.get("session").is_none());
        assert!(value.get("key").is_none());
    }

    // --- required test 2: authorized_keys append ----------------------------------------------

    #[test]
    fn authorize_appends_without_touching_what_is_already_there() {
        let dir = temp_dir();
        let path = dir.join("authorized_keys");
        let existing = "ssh-rsa AAAAexisting z@laptop\n";
        std::fs::write(&path, existing).unwrap();

        assert_eq!(
            super::append_authorized_key(&path, FIXTURE_PUBLIC_LINE).unwrap(),
            AuthorizeOutcome::Added
        );
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(
            after.starts_with(existing),
            "existing content must survive byte-for-byte, got {after:?}"
        );
        assert!(after.contains(FIXTURE_PUBLIC_LINE));
        assert!(after.ends_with('\n'));
    }

    #[test]
    fn authorize_does_not_add_the_same_device_twice() {
        let dir = temp_dir();
        let path = dir.join("authorized_keys");
        super::append_authorized_key(&path, FIXTURE_PUBLIC_LINE).unwrap();
        let after_first = std::fs::read_to_string(&path).unwrap();

        // A second run mints a *different* key with the same comment; the device is what is
        // revocable, so a second line for it would make revocation a hunt.
        let second_line =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIZzZzZzZzZzZzZzZzZzZzZz herdr-mobile/phone";
        assert_eq!(
            super::append_authorized_key(&path, second_line).unwrap(),
            AuthorizeOutcome::AlreadyPresent
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), after_first);
    }

    #[test]
    fn authorize_starts_a_new_line_when_the_file_lacks_a_trailing_newline() {
        let dir = temp_dir();
        let path = dir.join("authorized_keys");
        std::fs::write(&path, "ssh-rsa AAAAexisting z@laptop").unwrap();
        super::append_authorized_key(&path, FIXTURE_PUBLIC_LINE).unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            after,
            format!("ssh-rsa AAAAexisting z@laptop\n{FIXTURE_PUBLIC_LINE}\n")
        );
    }

    // --- required test 3: a default run writes nothing -----------------------------------------

    fn run_emit(authorize: bool, path: &std::path::Path) -> (String, String, i32) {
        let payload = super::build_payload(&target(), Some(FIXTURE_PRIVATE_KEY.to_string()));
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = super::emit_pairing(
            &PairOutput {
                payload: &payload,
                public_key_line: FIXTURE_PUBLIC_LINE,
                notes: &[],
                json: true,
                authorize,
                authorized_keys: Some(path),
                terminal_width: Some(200),
            },
            &mut out,
            &mut err,
        )
        .unwrap();
        (
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
            code,
        )
    }

    #[test]
    fn a_run_without_authorize_never_creates_authorized_keys() {
        let dir = temp_dir();
        let path = dir.join(".ssh").join("authorized_keys");

        let (out, err, code) = run_emit(false, &path);

        assert_eq!(code, 0);
        assert!(
            !path.exists(),
            "a default run must not create {}",
            path.display()
        );
        assert!(
            !path.parent().expect("parent").exists(),
            "a default run must not create the .ssh directory either"
        );
        // The public key still reaches the user, just not the file.
        assert!(err.contains(FIXTURE_PUBLIC_LINE));
        assert!(err.contains("--authorize"));
        // --json keeps stdout to the payload alone.
        assert!(out.trim_start().starts_with('{'));
        assert!(!out.contains(FIXTURE_PUBLIC_LINE));
    }

    #[test]
    fn a_run_without_authorize_never_modifies_an_existing_authorized_keys() {
        let dir = temp_dir();
        let path = dir.join("authorized_keys");
        let existing = "ssh-rsa AAAAexisting z@laptop\n";
        std::fs::write(&path, existing).unwrap();

        let (_out, _err, code) = run_emit(false, &path);

        assert_eq!(code, 0);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), existing);
    }

    #[test]
    fn authorize_writes_the_file_the_default_run_left_alone() {
        // The mirror of the two tests above: without this one they would also pass if --authorize
        // were broken.
        let dir = temp_dir();
        let path = dir.join(".ssh").join("authorized_keys");
        let (_out, err, code) = run_emit(true, &path);
        assert_eq!(code, 0);
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains(FIXTURE_PUBLIC_LINE));
        assert!(err.contains("revoke"));
    }

    // --- argument parsing ----------------------------------------------------------------------

    #[test]
    fn parses_flags_and_a_single_positional_remote() {
        let args: Vec<String> = ["iq-64", "--json", "--authorize", "--device", "z-phone"]
            .iter()
            .map(|arg| (*arg).to_string())
            .collect();
        assert_eq!(
            super::parse_pair_args(&args).unwrap(),
            PairArgs {
                remote: Some("iq-64".into()),
                json: true,
                authorize: true,
                device: Some("z-phone".into()),
                host: None,
                user: None,
            }
        );
    }

    #[test]
    fn rejects_unknown_options_and_second_positionals() {
        assert_eq!(
            super::parse_pair_args(&["--nope".to_string()]).unwrap_err(),
            2
        );
        assert_eq!(
            super::parse_pair_args(&["a".to_string(), "b".to_string()]).unwrap_err(),
            2
        );
        assert_eq!(
            super::parse_pair_args(&["--device".to_string()]).unwrap_err(),
            2
        );
        assert_eq!(
            super::parse_pair_args(&["--help".to_string()]).unwrap_err(),
            0
        );
    }

    #[test]
    fn defaults_to_no_remote_no_flags() {
        assert_eq!(super::parse_pair_args(&[]).unwrap(), PairArgs::default());
    }

    // --- target resolution ---------------------------------------------------------------------

    #[test]
    fn local_target_says_out_loud_what_it_guessed() {
        let resolved = super::resolve_local(
            &PairArgs::default(),
            None,
            None,
            Some("z".into()),
            Some("fable.local".into()),
        )
        .unwrap();
        assert_eq!(resolved.host, "fable.local");
        assert_eq!(resolved.user, "z");
        assert_eq!(resolved.port, 22);
        assert!(resolved.local);
        assert_eq!(resolved.notes.len(), 1);
        assert!(resolved.notes[0].contains("guessed"));
    }

    #[test]
    fn explicit_host_and_user_win_and_are_not_announced() {
        let resolved = super::resolve_local(
            &PairArgs {
                host: Some("192.168.0.9".into()),
                user: Some("ops".into()),
                ..PairArgs::default()
            },
            None,
            None,
            Some("z".into()),
            Some("fable.local".into()),
        )
        .unwrap();
        assert_eq!(resolved.host, "192.168.0.9");
        assert_eq!(resolved.user, "ops");
        assert!(resolved.notes.is_empty());
    }

    #[test]
    fn local_target_fails_loudly_when_nothing_can_be_guessed() {
        let error = super::resolve_local(&PairArgs::default(), None, None, None, None).unwrap_err();
        assert!(error.contains("--host"));
    }

    #[test]
    fn ssh_remote_supplies_user_host_and_port() {
        let remote = crate::remote_registry::RemoteDefinitionSnapshot {
            id: "r1".into(),
            name: "iq-64".into(),
            target: crate::remote_registry::RemoteTargetSnapshot::Ssh {
                target: "z@10.0.2.2".into(),
                args: vec!["-p".into(), "2222".into()],
            },
            session: Some("work".into()),
            keybindings: crate::remote_registry::RemoteKeybindingsSnapshot::Local,
            disabled: false,
            auto_update: false,
        };
        let resolved =
            super::resolve_remote(&remote, &PairArgs::default(), Some("local".into()), None)
                .unwrap();
        assert_eq!(resolved.host, "10.0.2.2");
        assert_eq!(resolved.user, "z");
        assert_eq!(resolved.port, 2222);
        assert_eq!(resolved.session.as_deref(), Some("work"));
        assert_eq!(resolved.name.as_deref(), Some("iq-64"));
        assert!(!resolved.local, "an ssh remote is not this machine");
        assert!(resolved.notes.is_empty());
    }

    #[test]
    fn parses_ssh_destinations() {
        assert_eq!(
            super::parse_ssh_destination("z@10.0.2.2", &[]),
            Some(SshDestination {
                user: Some("z".into()),
                host: "10.0.2.2".into(),
                port: None,
            })
        );
        assert_eq!(
            super::parse_ssh_destination("ssh://z@box:2222", &[]),
            Some(SshDestination {
                user: Some("z".into()),
                host: "box".into(),
                port: Some(2222),
            })
        );
        assert_eq!(
            super::parse_ssh_destination("box", &["-p2222".to_string()]),
            Some(SshDestination {
                user: None,
                host: "box".into(),
                port: Some(2222),
            })
        );
        assert_eq!(
            super::parse_ssh_destination("[fe80::1]:2222", &[]),
            Some(SshDestination {
                user: None,
                host: "fe80::1".into(),
                port: Some(2222),
            })
        );
    }

    // --- key comment and rendering -------------------------------------------------------------

    #[test]
    fn key_comment_names_the_device_and_survives_junk() {
        assert_eq!(super::key_comment("z phone"), "herdr-mobile/z-phone");
        assert_eq!(super::key_comment(""), "herdr-mobile/phone");
    }

    #[test]
    fn qr_render_fits_a_key_carrying_payload_and_reports_its_width() {
        let payload = super::build_payload(&target(), Some(FIXTURE_PRIVATE_KEY.to_string()));
        let json = serde_json::to_string(&payload).unwrap();
        let rendered = super::render_qr(&json).expect("a payload this size must encode");
        let width = super::rendered_width(&rendered);
        assert!(width > 0);
        // Every row is the same width, which is what makes the terminal-width warning meaningful.
        assert!(rendered
            .lines()
            .all(|line| line.chars().count() == width || line.is_empty()));
    }

    #[test]
    fn payload_serialization_is_what_gets_encoded() {
        // Guards the seam between the two halves of this file: whatever the phone parses is the
        // exact string the QR carries.
        let payload = PairingPayload {
            v: 1,
            name: None,
            host: "h".into(),
            port: 22,
            user: "u".into(),
            session: None,
            key: None,
            issued_at: 1_756_000_000_000,
        };
        assert_eq!(
            serde_json::to_string(&payload).unwrap(),
            r#"{"v":1,"host":"h","port":22,"user":"u","issuedAt":1756000000000}"#
        );
    }
}
