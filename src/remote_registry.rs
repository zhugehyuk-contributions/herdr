use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RemoteRegistrySnapshot {
    #[serde(default)]
    pub remotes: Vec<RemoteDefinitionSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RemoteDefinitionSnapshot {
    pub id: String,
    pub name: String,
    pub target: RemoteTargetSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default)]
    pub keybindings: RemoteKeybindingsSnapshot,
    // item 3 (Area 5): a disabled remote stays persisted but is inert in the client supervisor
    // (no SSH bridge, no client stream, no API poll, no reconnect candidate). `#[serde(default)]`
    // makes old snapshots / old API JSON deserialize to `false` (enabled); `skip_serializing_if`
    // keeps enabled remotes serializing byte-identical to today (no golden-file / on-disk churn).
    #[serde(default, skip_serializing_if = "is_false")]
    pub disabled: bool,
    // #61: when true, the multi-remote client auto-updates this remote to the client's OWN build on a
    // detected protocol mismatch (the same reinstall the manual `update` runs, no internet download).
    // Defaults false; `#[serde(default)]` makes old snapshots / old API JSON deserialize to off, and
    // `skip_serializing_if` keeps an off remote serializing byte-identical to today (no on-disk churn).
    #[serde(default, skip_serializing_if = "is_false")]
    pub auto_update: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RemoteTargetSnapshot {
    Ssh {
        /// The ssh destination (`user@host`, host alias, `ssh://…`). Used as the dedup/identity
        /// key, the socket-path key, and the display name. For a full ssh spec this is the last
        /// positional token (the destination); for a bare token it is the token itself.
        target: String,
        /// ssh options that precede the destination (e.g. `-L`, `-J`, `-p`, `-o`). Empty for a
        /// bare-host target. `#[serde(default)]` makes legacy snapshots (only `target`)
        /// deserialize to an empty vec; `skip_serializing_if` keeps bare targets serializing
        /// byte-identical to today (no `args` key on disk).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        args: Vec<String>,
    },
    Local {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session: Option<String>,
    },
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum RemoteKeybindingsSnapshot {
    #[default]
    Local,
    Server,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteRegistryError {
    InvalidTarget,
    InvalidName,
    DuplicateName,
    DuplicateTarget,
    NotFound,
    InvalidSession,
}

impl RemoteRegistryError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidTarget => "invalid_remote_target",
            Self::InvalidName => "invalid_remote_name",
            Self::DuplicateName => "duplicate_remote_name",
            Self::DuplicateTarget => "duplicate_remote_target",
            Self::NotFound => "remote_not_found",
            Self::InvalidSession => "invalid_session_name",
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            Self::InvalidTarget => "remote target is invalid",
            Self::InvalidName => "remote name is invalid",
            Self::DuplicateName => "remote name already exists",
            Self::DuplicateTarget => "remote target already exists",
            Self::NotFound => "remote not found",
            Self::InvalidSession => "session name is invalid",
        }
    }
}

impl RemoteDefinitionSnapshot {
    /// The session this remote attaches to, or `None` for the remote's default session. Single
    /// source of truth: a `Local` remote keeps its session in the target (`local:<name>`), an `Ssh`
    /// remote on the definition (the ssh bridge passes it as `herdr --session <name>`).
    pub fn session_name(&self) -> Option<&str> {
        match &self.target {
            RemoteTargetSnapshot::Local { session } => session.as_deref(),
            RemoteTargetSnapshot::Ssh { .. } => self.session.as_deref(),
        }
    }
}

impl RemoteRegistrySnapshot {
    #[cfg(test)]
    pub fn add(
        &mut self,
        name: Option<String>,
        target: String,
        keybindings: RemoteKeybindingsSnapshot,
    ) -> Result<RemoteDefinitionSnapshot, RemoteRegistryError> {
        self.add_excluding_targets(name, target, None, keybindings, &[])
    }

    /// `session` is the optional session this remote attaches to (`None` = the remote's default
    /// session). Normalized through [`normalize_session`], so an empty/whitespace value or the
    /// literal `"default"` collapses to `None` — matching `RemoteTargetSnapshot::parse`'s
    /// `local:default` handling.
    pub fn add_excluding_targets(
        &mut self,
        name: Option<String>,
        target: String,
        session: Option<String>,
        keybindings: RemoteKeybindingsSnapshot,
        excluded_targets: &[RemoteTargetSnapshot],
    ) -> Result<RemoteDefinitionSnapshot, RemoteRegistryError> {
        // The ONE place the requested (target, session) pair becomes the stored pair — shared with
        // the client's add-remote pre-flight so the two dedup verdicts can never drift.
        let (target, session) = resolve_target_and_session(&target, session)?;
        let name = normalize_name(name.unwrap_or_else(|| target.default_display_name()))?;
        if self.remotes.iter().any(|remote| remote.name == name) {
            return Err(RemoteRegistryError::DuplicateName);
        }

        let target_key = target.canonical_key();
        if excluded_targets
            .iter()
            .any(|excluded| excluded.canonical_key() == target_key)
        {
            return Err(RemoteRegistryError::DuplicateTarget);
        }

        if self
            .remotes
            .iter()
            .any(|remote| remote.target.canonical_key() == target_key)
        {
            return Err(RemoteRegistryError::DuplicateTarget);
        }

        let remote = RemoteDefinitionSnapshot {
            id: self.next_id(),
            name,
            target,
            session,
            keybindings,
            disabled: false,
            auto_update: false,
        };
        self.remotes.push(remote.clone());
        Ok(remote)
    }

    pub fn remove(&mut self, remote_id: &str) -> Result<String, RemoteRegistryError> {
        let index = self
            .remotes
            .iter()
            .position(|remote| remote.id == remote_id)
            .ok_or(RemoteRegistryError::NotFound)?;
        Ok(self.remotes.remove(index).id)
    }

    pub fn rename(
        &mut self,
        remote_id: &str,
        name: String,
    ) -> Result<RemoteDefinitionSnapshot, RemoteRegistryError> {
        let name = normalize_name(name)?;
        if self
            .remotes
            .iter()
            .any(|remote| remote.id != remote_id && remote.name == name)
        {
            return Err(RemoteRegistryError::DuplicateName);
        }

        let remote = self
            .remotes
            .iter_mut()
            .find(|remote| remote.id == remote_id)
            .ok_or(RemoteRegistryError::NotFound)?;
        remote.name = name;
        Ok(remote.clone())
    }

    /// item 3 (Area 5): flip a remote's enabled flag. `enabled == false` sets `disabled = true`,
    /// keeping the definition persisted (the client supervisor gates it out of all plan
    /// producers). Returns the updated definition clone, or `NotFound` if the id is unknown.
    pub fn set_enabled(
        &mut self,
        remote_id: &str,
        enabled: bool,
    ) -> Result<RemoteDefinitionSnapshot, RemoteRegistryError> {
        let remote = self
            .remotes
            .iter_mut()
            .find(|remote| remote.id == remote_id)
            .ok_or(RemoteRegistryError::NotFound)?;
        remote.disabled = !enabled;
        Ok(remote.clone())
    }

    /// #61: flip a remote's per-remote auto-update flag (push this client's build on a protocol
    /// mismatch). Persisted alongside `disabled`; the client gates its auto-update sweep on it.
    /// Returns the updated definition clone, or `NotFound` if the id is unknown.
    pub fn set_auto_update(
        &mut self,
        remote_id: &str,
        auto_update: bool,
    ) -> Result<RemoteDefinitionSnapshot, RemoteRegistryError> {
        let remote = self
            .remotes
            .iter_mut()
            .find(|remote| remote.id == remote_id)
            .ok_or(RemoteRegistryError::NotFound)?;
        remote.auto_update = auto_update;
        Ok(remote.clone())
    }

    /// mockup #7: switch which side owns this remote's keybindings (`local` = the client's own
    /// bindings, `server` = the remote server's). Persisted on the definition like `auto_update`;
    /// the client supervisor re-applies it from the registry on every sync, so the change takes
    /// effect on the remote's next connection. Returns the updated definition clone, or `NotFound`
    /// if the id is unknown.
    pub fn set_keybindings(
        &mut self,
        remote_id: &str,
        keybindings: RemoteKeybindingsSnapshot,
    ) -> Result<RemoteDefinitionSnapshot, RemoteRegistryError> {
        let remote = self
            .remotes
            .iter_mut()
            .find(|remote| remote.id == remote_id)
            .ok_or(RemoteRegistryError::NotFound)?;
        remote.keybindings = keybindings;
        Ok(remote.clone())
    }

    /// Point a remote at a different session (`None` = the remote's default session).
    ///
    /// A `Local` remote carries its session inside the target (`local:<name>`), so the target is
    /// rewritten and re-checked for collisions against `excluded_targets` (the main server) and the
    /// other remotes — the same duplicate rule `add_excluding_targets` enforces. An `Ssh` remote
    /// carries it on the definition, where the bridge command reads it. The registry is left
    /// unchanged on every error path. Returns the updated definition clone.
    pub fn set_session(
        &mut self,
        remote_id: &str,
        session: Option<String>,
        excluded_targets: &[RemoteTargetSnapshot],
    ) -> Result<RemoteDefinitionSnapshot, RemoteRegistryError> {
        let session = normalize_session(session)?;
        let index = self
            .remotes
            .iter()
            .position(|remote| remote.id == remote_id)
            .ok_or(RemoteRegistryError::NotFound)?;

        if matches!(
            self.remotes[index].target,
            RemoteTargetSnapshot::Local { .. }
        ) {
            let target = RemoteTargetSnapshot::Local {
                session: session.clone(),
            };
            let target_key = target.canonical_key();
            if excluded_targets
                .iter()
                .any(|excluded| excluded.canonical_key() == target_key)
            {
                return Err(RemoteRegistryError::DuplicateTarget);
            }
            if self.remotes.iter().enumerate().any(|(other, remote)| {
                other != index && remote.target.canonical_key() == target_key
            }) {
                return Err(RemoteRegistryError::DuplicateTarget);
            }
            self.remotes[index].target = target;
            // One home per kind: the session now lives in the target, so the definition-level copy
            // must be cleared rather than left as a second, drift-prone source of truth.
            self.remotes[index].session = None;
            return Ok(self.remotes[index].clone());
        }

        let remote = &mut self.remotes[index];
        remote.session = session;
        Ok(remote.clone())
    }

    fn next_id(&self) -> String {
        let mut index = 1;
        loop {
            let id = format!("remote-{index}");
            if self.remotes.iter().all(|remote| remote.id != id) {
                return id;
            }
            index += 1;
        }
    }
}

impl RemoteTargetSnapshot {
    pub fn parse(input: &str) -> Result<Self, RemoteRegistryError> {
        let target = input.trim();
        if target.is_empty() {
            return Err(RemoteRegistryError::InvalidTarget);
        }

        if target == "localhost" {
            return Ok(Self::Local { session: None });
        }

        if let Some(session) = target.strip_prefix("local:") {
            let session = session.trim();
            if session.is_empty() {
                return Err(RemoteRegistryError::InvalidTarget);
            }
            let session = (session != "default").then(|| session.to_string());
            return Ok(Self::Local { session });
        }

        Self::parse_ssh(target)
    }

    /// Parse a generic ssh spec. A single bare token (no leading `-`, not the literal `ssh`)
    /// means `ssh <token>`. Anything else — a leading `ssh`, multiple tokens, or any flag — is
    /// treated as a full ssh argv: the destination is the FIRST non-flag token that is not the value
    /// of a preceding option flag, and the options are preserved (emitted before the destination at
    /// connect time). A second bare token is rejected rather than silently swallowed as an option —
    /// it would be an ssh remote command (herdr supplies its own), and treating it as an option made
    /// `user@host extra` connect to `extra` while passing `user@host` as a flag.
    fn parse_ssh(input: &str) -> Result<Self, RemoteRegistryError> {
        // Single-letter ssh options that consume the following token as their value (e.g. `-p 2222`,
        // `-J jump`, `-L a:b:c`, `-o opt`). Used to tell an option's argument apart from the
        // destination. From ssh(1); the attached form (`-p2222`) carries its value in the same token.
        const SSH_FLAGS_WITH_ARG: &[char] = &[
            'B', 'b', 'c', 'D', 'E', 'e', 'F', 'I', 'i', 'J', 'L', 'l', 'm', 'O', 'o', 'p', 'Q',
            'R', 'S', 'W', 'w',
        ];

        let tokens = shlex::split(input).ok_or(RemoteRegistryError::InvalidTarget)?;
        if tokens.is_empty() {
            return Err(RemoteRegistryError::InvalidTarget);
        }

        if tokens.len() == 1 && tokens[0] != "ssh" && !tokens[0].starts_with('-') {
            return Ok(Self::Ssh {
                target: tokens[0].clone(),
                args: Vec::new(),
            });
        }

        let mut argv = tokens;
        if argv.first().is_some_and(|token| token == "ssh") {
            argv.remove(0);
        }

        let mut options: Vec<String> = Vec::new();
        let mut target: Option<String> = None;
        let mut iter = argv.into_iter();
        while let Some(token) = iter.next() {
            if let Some(flag) = token.strip_prefix('-') {
                let consumes_value = flag
                    .chars()
                    .next()
                    .is_some_and(|c| flag.chars().count() == 1 && SSH_FLAGS_WITH_ARG.contains(&c));
                options.push(token);
                if consumes_value {
                    if let Some(value) = iter.next() {
                        options.push(value);
                    }
                }
                continue;
            }
            if target.is_some() {
                return Err(RemoteRegistryError::InvalidTarget);
            }
            target = Some(token);
        }
        let target = target.ok_or(RemoteRegistryError::InvalidTarget)?;
        Ok(Self::Ssh {
            target,
            args: options,
        })
    }

    pub fn canonical_key(&self) -> String {
        match self {
            Self::Ssh { target, args } if args.is_empty() => format!("ssh:{target}"),
            Self::Ssh { target, args } => {
                // Unit separator keeps two distinct option sets (e.g. different `-L` forwards)
                // from colliding while staying stable across reloads.
                format!("ssh:{target}\u{1f}{}", args.join("\u{1f}"))
            }
            Self::Local { session } => {
                format!("local:{}", session.as_deref().unwrap_or("default"))
            }
        }
    }

    fn default_display_name(&self) -> String {
        match self {
            Self::Local { session } => session.clone().unwrap_or_else(|| "local".to_string()),
            Self::Ssh { target, .. } => ssh_display_name(target),
        }
    }
}

/// Resolve a requested `(target, session)` pair into the pair the registry actually stores.
///
/// This is the single source of truth for the fold, because the DEDUP KEY depends on it: a `Local`
/// remote carries its session INSIDE the target (`local:<name>`), so `localhost` + session `work`
/// is the target `local:work` — NOT `local:default` with a side-car session. Both the registry's
/// [`RemoteRegistrySnapshot::add_excluding_targets`] and the client's add-remote pre-flight call
/// this, so the "is this a duplicate of the main server?" verdict is computed the same way on both
/// sides. (They drifted once: the client rejected `localhost` + `work` as a duplicate of its own
/// `local:default` main server, and the request never reached the API.)
///
/// Precedence matches [`RemoteRegistrySnapshot::set_session`]: an explicit `session` overrides one
/// spelled into a `local:<name>` target; an ABSENT `session` leaves the target alone (that spelling
/// IS the session). `Ssh` targets are never rewritten — their session rides the definition.
///
/// Returns `(target, definition_session)` where `definition_session` is exactly what belongs in
/// [`RemoteDefinitionSnapshot::session`] — **`None` for a `Local` remote**, whose session lives in
/// the target and is read back from there by [`RemoteDefinitionSnapshot::session_name`]. Storing it
/// in both places left a dead second copy that could drift out of sync with the authoritative one.
pub fn resolve_target_and_session(
    target: &str,
    session: Option<String>,
) -> Result<(RemoteTargetSnapshot, Option<String>), RemoteRegistryError> {
    // Classify BEFORE parsing/folding: `normalize_session` alone maps both "no request" and an
    // explicit `"default"` onto `None`, and folding on that collapsed value cannot tell them apart.
    let request = SessionRequest::classify(session)?;
    let target = RemoteTargetSnapshot::parse(target)?;
    match target {
        RemoteTargetSnapshot::Local { session: spelled } => {
            let session = match request {
                // Only a genuinely absent request defers to the `local:<name>` spelling.
                SessionRequest::Unspecified => spelled,
                // An explicit `default` IS a request — for the default session.
                SessionRequest::Default => None,
                SessionRequest::Named(name) => Some(name),
            };
            // One home per kind: a local remote's session IS its target.
            Ok((RemoteTargetSnapshot::Local { session }, None))
        }
        target @ RemoteTargetSnapshot::Ssh { .. } => {
            let session = match request {
                SessionRequest::Unspecified | SessionRequest::Default => None,
                SessionRequest::Named(name) => Some(name),
            };
            Ok((target, session))
        }
    }
}

/// The three distinguishable things a caller can ask for in a `session` field.
///
/// Modeled as an enum rather than an `Option<String>` because the last two states are what
/// [`normalize_session`] deliberately collapses: it answers "which session?" (`None` = the default),
/// which is the right shape for STORAGE but loses "did the user ask at all?" — the bit the `Local`
/// fold needs. Conflating them silently turned `{target: "local:dev", session: "default"}` into
/// `local:dev`, i.e. the opposite of what was asked. Keeping three variants makes the third case
/// impossible to forget at the match.
enum SessionRequest {
    /// No session field, or an empty/whitespace one (the add-remote form sends `None` for a blank
    /// field, and a blank must not clobber a spelled `local:<name>` target either).
    Unspecified,
    /// Explicitly the default session; stored as `None`.
    Default,
    /// An explicitly named session, already trimmed and validated.
    Named(String),
}

impl SessionRequest {
    fn classify(session: Option<String>) -> Result<Self, RemoteRegistryError> {
        let Some(raw) = session else {
            return Ok(Self::Unspecified);
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Ok(Self::Unspecified);
        }
        if trimmed == crate::session::DEFAULT_SESSION_NAME {
            return Ok(Self::Default);
        }
        crate::session::validate_name(trimmed).map_err(|_| RemoteRegistryError::InvalidSession)?;
        Ok(Self::Named(trimmed.to_string()))
    }
}

/// Normalize a requested session name: an empty/whitespace value or the literal `"default"`
/// means the default session (`None`), anything else must pass the session-name rules
/// (`crate::session::validate_name`).
pub fn normalize_session(session: Option<String>) -> Result<Option<String>, RemoteRegistryError> {
    let Some(session) = session else {
        return Ok(None);
    };
    let session = session.trim();
    if session.is_empty() || session == "default" {
        return Ok(None);
    }
    crate::session::validate_name(session).map_err(|_| RemoteRegistryError::InvalidSession)?;
    Ok(Some(session.to_string()))
}

fn normalize_name(name: String) -> Result<String, RemoteRegistryError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(RemoteRegistryError::InvalidName);
    }
    Ok(name.to_string())
}

fn ssh_display_name(target: &str) -> String {
    let without_scheme = target.strip_prefix("ssh://").unwrap_or(target);
    let without_user = without_scheme
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(without_scheme);
    let host = without_user
        .split([':', '/'])
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or(target);
    host.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh(target: &str, args: &[&str]) -> RemoteTargetSnapshot {
        RemoteTargetSnapshot::Ssh {
            target: target.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn parses_bare_host_as_ssh_without_args() {
        let target = RemoteTargetSnapshot::parse("iq-64").unwrap();
        assert_eq!(target, ssh("iq-64", &[]));
    }

    #[test]
    fn parses_user_at_host_as_bare_ssh_without_args() {
        let target = RemoteTargetSnapshot::parse("user@iq-64").unwrap();
        assert_eq!(target, ssh("user@iq-64", &[]));
    }

    #[test]
    fn strips_leading_ssh_program_for_bare_destination() {
        let explicit = RemoteTargetSnapshot::parse("ssh iq-64").unwrap();
        assert_eq!(explicit, ssh("iq-64", &[]));
        // "iq-64" and "ssh iq-64" describe the same connection.
        let bare = RemoteTargetSnapshot::parse("iq-64").unwrap();
        assert_eq!(explicit.canonical_key(), bare.canonical_key());
    }

    #[test]
    fn parses_full_ssh_command_with_flags() {
        // `-L` and `-J` each consume their following value; `icedac` is the single destination.
        let target =
            RemoteTargetSnapshot::parse("ssh -L 9000:localhost:9000 -J jump icedac").unwrap();
        assert_eq!(
            target,
            ssh("icedac", &["-L", "9000:localhost:9000", "-J", "jump"])
        );
    }

    #[test]
    fn rejects_ambiguous_double_destination_ssh_spec() {
        // R1: a stray non-flag token must not be silently absorbed as an option (which connected to
        // the wrong host). A second bare token — `user@host extra`, or a trailing remote command —
        // is rejected; herdr builds its own remote command.
        assert_eq!(
            RemoteTargetSnapshot::parse("user@host extra").unwrap_err(),
            RemoteRegistryError::InvalidTarget
        );
        assert_eq!(
            RemoteTargetSnapshot::parse("ssh -p 2222 host run-something").unwrap_err(),
            RemoteRegistryError::InvalidTarget
        );
    }

    #[test]
    fn parses_full_ssh_command_with_port_and_user() {
        let target = RemoteTargetSnapshot::parse("ssh -p 2222 user@host").unwrap();
        assert_eq!(target, ssh("user@host", &["-p", "2222"]));
    }

    #[test]
    fn full_spec_without_leading_ssh_is_still_accepted() {
        // A multi-token / flagged input is treated as a full ssh argv even without a leading `ssh`.
        let target = RemoteTargetSnapshot::parse("-p 2222 host").unwrap();
        assert_eq!(target, ssh("host", &["-p", "2222"]));
    }

    #[test]
    fn preserves_quoted_option_values_as_single_token() {
        let target =
            RemoteTargetSnapshot::parse("ssh -o 'ProxyCommand=ssh -W %h:%p bastion' iq-64")
                .unwrap();
        assert_eq!(
            target,
            ssh("iq-64", &["-o", "ProxyCommand=ssh -W %h:%p bastion"])
        );
    }

    #[test]
    fn rejects_ssh_spec_without_a_destination() {
        assert_eq!(
            RemoteTargetSnapshot::parse("ssh -v").unwrap_err(),
            RemoteRegistryError::InvalidTarget
        );
        assert_eq!(
            RemoteTargetSnapshot::parse("ssh").unwrap_err(),
            RemoteRegistryError::InvalidTarget
        );
    }

    #[test]
    fn canonical_key_distinguishes_ssh_options() {
        let plain = RemoteTargetSnapshot::parse("ssh iq-64").unwrap();
        let forwarded = RemoteTargetSnapshot::parse("ssh -L 9000:localhost:9000 iq-64").unwrap();
        let other_forward =
            RemoteTargetSnapshot::parse("ssh -L 9100:localhost:9100 iq-64").unwrap();

        assert_ne!(plain.canonical_key(), forwarded.canonical_key());
        assert_ne!(forwarded.canonical_key(), other_forward.canonical_key());
    }

    #[test]
    fn full_spec_display_name_uses_destination() {
        let mut registry = RemoteRegistrySnapshot::default();
        let remote = registry
            .add(
                None,
                "ssh -L 9000:localhost:9000 -J jump you@iq-64".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();
        assert_eq!(remote.name, "iq-64");
    }

    #[test]
    fn full_spec_ssh_target_serializes_args_and_round_trips() {
        let mut registry = RemoteRegistrySnapshot::default();
        registry
            .add(
                Some("fwd".into()),
                "ssh -L 9000:localhost:9000 iq-64".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();

        let json = serde_json::to_string(&registry).unwrap();
        assert!(
            json.contains("\"args\""),
            "full spec must persist args: {json}"
        );

        let restored: RemoteRegistrySnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, registry);
    }

    #[test]
    fn bare_ssh_target_does_not_serialize_args_key() {
        let mut registry = RemoteRegistrySnapshot::default();
        registry
            .add(
                Some("bare".into()),
                "iq-64".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();
        let json = serde_json::to_string(&registry).unwrap();
        assert!(
            !json.contains("args"),
            "bare target must not emit args key: {json}"
        );
    }

    #[test]
    fn legacy_ssh_snapshot_without_args_deserializes_to_empty() {
        let json = r#"{"remotes":[{"id":"remote-1","name":"dev","target":{"type":"ssh","target":"user@dev"}}]}"#;
        let registry: RemoteRegistrySnapshot = serde_json::from_str(json).unwrap();
        assert_eq!(registry.remotes[0].target, ssh("user@dev", &[]));
    }

    #[test]
    fn parses_local_default_targets_to_the_same_canonical_key() {
        let localhost = RemoteTargetSnapshot::parse("localhost").unwrap();
        let local_default = RemoteTargetSnapshot::parse("local:default").unwrap();

        assert_eq!(localhost, RemoteTargetSnapshot::Local { session: None });
        assert_eq!(local_default, RemoteTargetSnapshot::Local { session: None });
        assert_eq!(localhost.canonical_key(), "local:default");
        assert_eq!(local_default.canonical_key(), "local:default");
    }

    #[test]
    fn parses_named_local_session_targets() {
        let target = RemoteTargetSnapshot::parse("local:dev").unwrap();

        assert_eq!(
            target,
            RemoteTargetSnapshot::Local {
                session: Some("dev".into())
            }
        );
        assert_eq!(target.canonical_key(), "local:dev");
    }

    #[test]
    fn derives_default_display_name_from_ssh_url_host() {
        let mut registry = RemoteRegistrySnapshot::default();

        let remote = registry
            .add(
                None,
                "ssh://you@example.test:2222".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();

        assert_eq!(remote.name, "example.test");
    }

    #[test]
    fn rejects_duplicate_local_default_targets() {
        let mut registry = RemoteRegistrySnapshot::default();

        registry
            .add(
                Some("local".into()),
                "localhost".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();
        let duplicate = registry
            .add(
                Some("default".into()),
                "local:default".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap_err();

        assert_eq!(duplicate, RemoteRegistryError::DuplicateTarget);
    }

    #[test]
    fn rejects_targets_excluded_by_the_caller() {
        let mut registry = RemoteRegistrySnapshot::default();
        let excluded = vec![RemoteTargetSnapshot::Local { session: None }];

        let duplicate = registry
            .add_excluding_targets(
                Some("local".into()),
                "localhost".into(),
                None,
                RemoteKeybindingsSnapshot::Local,
                &excluded,
            )
            .unwrap_err();

        assert_eq!(duplicate, RemoteRegistryError::DuplicateTarget);
        assert!(registry.remotes.is_empty());
    }

    #[test]
    fn disabled_defaults_to_false_for_new_remote() {
        let mut registry = RemoteRegistrySnapshot::default();
        let remote = registry
            .add(
                Some("dev".into()),
                "user@dev".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();

        assert!(!remote.disabled);
        assert!(!registry.remotes[0].disabled);
    }

    #[test]
    fn enabled_remote_serializes_without_disabled_key() {
        let mut registry = RemoteRegistrySnapshot::default();
        registry
            .add(
                Some("dev".into()),
                "user@dev".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();

        let json = serde_json::to_string(&registry).unwrap();
        assert!(
            !json.contains("disabled"),
            "enabled remote must not serialize the disabled key: {json}"
        );
    }

    #[test]
    fn disabled_remote_serializes_the_key() {
        let mut registry = RemoteRegistrySnapshot::default();
        let remote = registry
            .add(
                Some("dev".into()),
                "user@dev".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();
        registry.set_enabled(&remote.id, false).unwrap();

        let json = serde_json::to_string(&registry).unwrap();
        assert!(
            json.contains("\"disabled\":true"),
            "disabled remote must serialize the key: {json}"
        );
    }

    #[test]
    fn missing_disabled_key_deserializes_false() {
        let json = r#"{"remotes":[{"id":"remote-1","name":"dev","target":{"type":"ssh","target":"user@dev"}}]}"#;
        let registry: RemoteRegistrySnapshot = serde_json::from_str(json).unwrap();

        assert_eq!(registry.remotes.len(), 1);
        assert!(!registry.remotes[0].disabled);
    }

    #[test]
    fn set_enabled_toggles_disabled() {
        let mut registry = RemoteRegistrySnapshot::default();
        let remote = registry
            .add(
                Some("dev".into()),
                "user@dev".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();

        let disabled = registry.set_enabled(&remote.id, false).unwrap();
        assert!(disabled.disabled);
        assert!(registry.remotes[0].disabled);

        let enabled = registry.set_enabled(&remote.id, true).unwrap();
        assert!(!enabled.disabled);
        assert!(!registry.remotes[0].disabled);
    }

    #[test]
    fn set_enabled_missing_id_returns_not_found() {
        let mut registry = RemoteRegistrySnapshot::default();
        assert_eq!(
            registry.set_enabled("missing", false).unwrap_err(),
            RemoteRegistryError::NotFound
        );
    }

    #[test]
    fn auto_update_defaults_off_and_round_trips() {
        // #61: new remotes default to auto-update OFF, an off remote serializes byte-identical to
        // today (no `auto_update` key), an on remote serializes the key, and a missing key reads off.
        let mut registry = RemoteRegistrySnapshot::default();
        let remote = registry
            .add(
                Some("dev".into()),
                "user@dev".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();
        assert!(!remote.auto_update);

        let off_json = serde_json::to_string(&registry).unwrap();
        assert!(
            !off_json.contains("auto_update"),
            "an auto-update-off remote must not serialize the key: {off_json}"
        );

        let on = registry.set_auto_update(&remote.id, true).unwrap();
        assert!(on.auto_update);
        assert!(registry.remotes[0].auto_update);
        let on_json = serde_json::to_string(&registry).unwrap();
        assert!(
            on_json.contains("\"auto_update\":true"),
            "an auto-update-on remote must serialize the key: {on_json}"
        );

        // Toggling back off, and a legacy snapshot with no key, both read false.
        assert!(
            !registry
                .set_auto_update(&remote.id, false)
                .unwrap()
                .auto_update
        );
        let legacy = r#"{"remotes":[{"id":"remote-1","name":"dev","target":{"type":"ssh","target":"user@dev"}}]}"#;
        let parsed: RemoteRegistrySnapshot = serde_json::from_str(legacy).unwrap();
        assert!(!parsed.remotes[0].auto_update);
    }

    #[test]
    fn set_auto_update_missing_id_returns_not_found() {
        let mut registry = RemoteRegistrySnapshot::default();
        assert_eq!(
            registry.set_auto_update("missing", true).unwrap_err(),
            RemoteRegistryError::NotFound
        );
    }

    #[test]
    fn set_keybindings_flips_the_persisted_side_and_round_trips() {
        // mockup #7: a remote added with `local` keybindings can be switched to `server`, the flag
        // is what serializes, and switching back reads `local` again.
        let mut registry = RemoteRegistrySnapshot::default();
        let remote = registry
            .add(
                Some("dev".into()),
                "user@dev".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();
        assert_eq!(remote.keybindings, RemoteKeybindingsSnapshot::Local);

        let switched = registry
            .set_keybindings(&remote.id, RemoteKeybindingsSnapshot::Server)
            .unwrap();
        assert_eq!(switched.keybindings, RemoteKeybindingsSnapshot::Server);
        assert_eq!(
            registry.remotes[0].keybindings,
            RemoteKeybindingsSnapshot::Server
        );
        let json = serde_json::to_string(&registry).unwrap();
        assert!(
            json.contains("\"keybindings\":\"server\""),
            "a server-keybindings remote must serialize the side: {json}"
        );

        assert_eq!(
            registry
                .set_keybindings(&remote.id, RemoteKeybindingsSnapshot::Local)
                .unwrap()
                .keybindings,
            RemoteKeybindingsSnapshot::Local
        );
    }

    #[test]
    fn set_keybindings_missing_id_returns_not_found() {
        let mut registry = RemoteRegistrySnapshot::default();
        assert_eq!(
            registry
                .set_keybindings("missing", RemoteKeybindingsSnapshot::Server)
                .unwrap_err(),
            RemoteRegistryError::NotFound
        );
    }

    #[test]
    fn normalize_session_collapses_empty_and_default_to_none() {
        assert_eq!(normalize_session(None).unwrap(), None);
        assert_eq!(normalize_session(Some("".into())).unwrap(), None);
        assert_eq!(normalize_session(Some("   ".into())).unwrap(), None);
        assert_eq!(normalize_session(Some("default".into())).unwrap(), None);
        assert_eq!(
            normalize_session(Some("  work  ".into())).unwrap(),
            Some("work".to_string())
        );
    }

    #[test]
    fn normalize_session_rejects_invalid_names() {
        assert_eq!(
            normalize_session(Some("bad name!".into())).unwrap_err(),
            RemoteRegistryError::InvalidSession
        );
        assert_eq!(
            normalize_session(Some("..".into())).unwrap_err(),
            RemoteRegistryError::InvalidSession
        );
    }

    #[test]
    fn resolve_target_and_session_distinguishes_absent_from_explicit_default() {
        // REGRESSION: `normalize_session` collapses BOTH "absent" and an explicit "default" to
        // `None`, so folding on the normalized value could not tell them apart — asking for the
        // default session on a `local:dev` target silently kept `dev`. The three request states
        // (unspecified / explicitly-default / named) must stay distinguishable AT the fold.
        //
        // Matrix: target x {absent, "", "default", "work"} -> resulting target.
        let key = |target: &str, session: Option<&str>| {
            resolve_target_and_session(target, session.map(str::to_string))
                .unwrap()
                .0
                .canonical_key()
        };

        // A spelled `local:<name>` target: only an EXPLICIT request overrides it.
        assert_eq!(key("local:dev", None), "local:dev");
        assert_eq!(
            key("local:dev", Some("")),
            "local:dev",
            "empty = unspecified"
        );
        assert_eq!(
            key("local:dev", Some("   ")),
            "local:dev",
            "blank = unspecified"
        );
        assert_eq!(
            key("local:dev", Some("default")),
            "local:default",
            "an explicit `default` means the DEFAULT session, not 'leave dev alone'"
        );
        assert_eq!(key("local:dev", Some("work")), "local:work");

        // A bare `localhost` target has nothing spelled in, so every request lands the same way.
        assert_eq!(key("localhost", None), "local:default");
        assert_eq!(key("localhost", Some("")), "local:default");
        assert_eq!(key("localhost", Some("default")), "local:default");
        assert_eq!(key("localhost", Some("work")), "local:work");

        // An ssh target is never rewritten; only its definition-level session varies.
        let ssh = |session: Option<&str>| {
            resolve_target_and_session("user@dev", session.map(str::to_string)).unwrap()
        };
        let ssh_target = RemoteTargetSnapshot::Ssh {
            target: "user@dev".into(),
            args: Vec::new(),
        };
        assert_eq!(ssh(None), (ssh_target.clone(), None));
        assert_eq!(ssh(Some("")), (ssh_target.clone(), None));
        assert_eq!(ssh(Some("default")), (ssh_target.clone(), None));
        assert_eq!(ssh(Some("work")), (ssh_target, Some("work".to_string())));
    }

    #[test]
    fn resolve_target_and_session_is_the_one_fold_rule() {
        // The shared SSOT behind BOTH the registry add and the client's add-remote pre-flight.
        // A local target absorbs the session (that is its dedup identity)…
        // …and the definition-level copy stays `None` for Local: the target IS the single home.
        assert_eq!(
            resolve_target_and_session("localhost", Some("work".into())).unwrap(),
            (
                RemoteTargetSnapshot::Local {
                    session: Some("work".into())
                },
                None
            )
        );
        // …an explicit session overrides one spelled into the target…
        assert_eq!(
            resolve_target_and_session("local:dev", Some("work".into()))
                .unwrap()
                .0
                .canonical_key(),
            "local:work"
        );
        // …an absent session leaves `local:<name>` alone…
        assert_eq!(
            resolve_target_and_session("local:dev", None)
                .unwrap()
                .0
                .canonical_key(),
            "local:dev"
        );
        // …blank/"default" collapse to the default session…
        for blank in [
            Some("".to_string()),
            Some("  ".to_string()),
            Some("default".to_string()),
        ] {
            assert_eq!(
                resolve_target_and_session("localhost", blank).unwrap(),
                (RemoteTargetSnapshot::Local { session: None }, None)
            );
        }
        // …an ssh target is NEVER rewritten (its session rides the definition)…
        assert_eq!(
            resolve_target_and_session("user@dev", Some("work".into())).unwrap(),
            (
                RemoteTargetSnapshot::Ssh {
                    target: "user@dev".into(),
                    args: Vec::new()
                },
                Some("work".to_string())
            )
        );
        // …and an invalid session name is rejected before any dedup work.
        assert_eq!(
            resolve_target_and_session("localhost", Some("bad name!".into())).unwrap_err(),
            RemoteRegistryError::InvalidSession
        );
    }

    #[test]
    fn add_folds_the_session_into_a_local_target() {
        // `session_name()` reads the TARGET for a local remote, so `add` must fold the requested
        // session into it — otherwise the add-remote session field silently did nothing locally.
        let mut registry = RemoteRegistrySnapshot::default();
        let remote = registry
            .add_excluding_targets(
                Some("work".into()),
                "localhost".into(),
                Some("work".into()),
                RemoteKeybindingsSnapshot::Local,
                &[],
            )
            .unwrap();

        assert_eq!(
            remote.target,
            RemoteTargetSnapshot::Local {
                session: Some("work".into())
            }
        );
        assert_eq!(remote.session_name(), Some("work"));
        // ONE home per kind: stored in the target, NOT duplicated onto the definition.
        assert_eq!(remote.session, None);

        // …and the folded target participates in the dedup key, so `local:work` can't be added twice.
        assert_eq!(
            registry
                .add_excluding_targets(
                    Some("work-again".into()),
                    "local:work".into(),
                    None,
                    RemoteKeybindingsSnapshot::Local,
                    &[],
                )
                .unwrap_err(),
            RemoteRegistryError::DuplicateTarget
        );
    }

    #[test]
    fn add_persists_the_requested_session() {
        let mut registry = RemoteRegistrySnapshot::default();
        let remote = registry
            .add_excluding_targets(
                Some("dev".into()),
                "user@dev".into(),
                Some("work".into()),
                RemoteKeybindingsSnapshot::Local,
                &[],
            )
            .unwrap();

        assert_eq!(remote.session.as_deref(), Some("work"));
        assert_eq!(remote.session_name(), Some("work"));
        assert_eq!(registry.remotes[0].session.as_deref(), Some("work"));
    }

    #[test]
    fn add_with_invalid_session_leaves_registry_unchanged() {
        let mut registry = RemoteRegistrySnapshot::default();
        let err = registry
            .add_excluding_targets(
                Some("dev".into()),
                "user@dev".into(),
                Some("bad name!".into()),
                RemoteKeybindingsSnapshot::Local,
                &[],
            )
            .unwrap_err();

        assert_eq!(err, RemoteRegistryError::InvalidSession);
        assert!(registry.remotes.is_empty());
    }

    #[test]
    fn session_name_reads_the_target_for_local_remotes() {
        let mut registry = RemoteRegistrySnapshot::default();
        let named = registry
            .add(
                Some("dev".into()),
                "local:dev".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();
        assert_eq!(named.session_name(), Some("dev"));

        let default = registry
            .add(
                Some("local".into()),
                "localhost".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();
        assert_eq!(default.session_name(), None);
    }

    #[test]
    fn set_session_updates_ssh_definition_and_clears_back_to_default() {
        let mut registry = RemoteRegistrySnapshot::default();
        let remote = registry
            .add(
                Some("dev".into()),
                "user@dev".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();

        let updated = registry
            .set_session(&remote.id, Some("work".into()), &[])
            .unwrap();
        assert_eq!(updated.session_name(), Some("work"));
        assert_eq!(registry.remotes[0].session.as_deref(), Some("work"));

        let cleared = registry
            .set_session(&remote.id, Some("default".into()), &[])
            .unwrap();
        assert_eq!(cleared.session_name(), None);
        assert_eq!(registry.remotes[0].session, None);
    }

    #[test]
    fn set_session_rewrites_the_local_target() {
        let mut registry = RemoteRegistrySnapshot::default();
        let remote = registry
            .add(
                Some("local".into()),
                "local:dev".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();

        let updated = registry
            .set_session(&remote.id, Some("work".into()), &[])
            .unwrap();

        assert_eq!(
            updated.target,
            RemoteTargetSnapshot::Local {
                session: Some("work".into())
            }
        );
        assert_eq!(updated.session_name(), Some("work"));
        assert_eq!(registry.remotes[0].target.canonical_key(), "local:work");
        // ONE home per kind: a local remote's session lives in the target, so the definition-level
        // field must stay `None` rather than becoming a second, drift-prone copy.
        assert_eq!(updated.session, None);
        assert_eq!(registry.remotes[0].session, None);
    }

    #[test]
    fn set_session_rejects_a_local_target_collision_without_mutating() {
        let mut registry = RemoteRegistrySnapshot::default();
        let first = registry
            .add(
                Some("one".into()),
                "local:dev".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();
        registry
            .add(
                Some("two".into()),
                "local:work".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();

        let err = registry
            .set_session(&first.id, Some("work".into()), &[])
            .unwrap_err();

        assert_eq!(err, RemoteRegistryError::DuplicateTarget);
        assert_eq!(registry.remotes[0].target.canonical_key(), "local:dev");
        assert_eq!(registry.remotes[0].session, None);
    }

    #[test]
    fn set_session_rejects_an_excluded_local_target_without_mutating() {
        let mut registry = RemoteRegistrySnapshot::default();
        let remote = registry
            .add(
                Some("one".into()),
                "local:dev".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();
        let excluded = vec![RemoteTargetSnapshot::Local { session: None }];

        let err = registry
            .set_session(&remote.id, None, &excluded)
            .unwrap_err();

        assert_eq!(err, RemoteRegistryError::DuplicateTarget);
        assert_eq!(registry.remotes[0].target.canonical_key(), "local:dev");
    }

    #[test]
    fn set_session_keeping_its_own_local_target_is_allowed() {
        let mut registry = RemoteRegistrySnapshot::default();
        let remote = registry
            .add(
                Some("one".into()),
                "local:dev".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();

        let updated = registry
            .set_session(&remote.id, Some("dev".into()), &[])
            .unwrap();

        assert_eq!(updated.session_name(), Some("dev"));
    }

    #[test]
    fn set_session_invalid_name_and_missing_id_are_rejected() {
        let mut registry = RemoteRegistrySnapshot::default();
        let remote = registry
            .add(
                Some("dev".into()),
                "user@dev".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();

        assert_eq!(
            registry
                .set_session(&remote.id, Some("bad name!".into()), &[])
                .unwrap_err(),
            RemoteRegistryError::InvalidSession
        );
        assert_eq!(registry.remotes[0].session, None);
        assert_eq!(
            registry
                .set_session("missing", Some("work".into()), &[])
                .unwrap_err(),
            RemoteRegistryError::NotFound
        );
    }

    #[test]
    fn default_session_remote_serializes_without_the_session_key() {
        let mut registry = RemoteRegistrySnapshot::default();
        registry
            .add(
                Some("dev".into()),
                "user@dev".into(),
                RemoteKeybindingsSnapshot::Local,
            )
            .unwrap();

        let json = serde_json::to_string(&registry).unwrap();
        assert!(
            !json.contains("session"),
            "a default-session remote must not serialize the key: {json}"
        );
    }
}
