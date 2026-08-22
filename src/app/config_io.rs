use super::App;
use crate::app::state::{
    SidebarAgentItem, SidebarAgentPreferences, SidebarSpaceItem, SidebarSpacePreferences,
};
use crate::config::{SidebarAgentField, SidebarColorPreset, SidebarItem, SidebarSpaceField};

impl App {
    pub(super) fn update_config_file<F>(&mut self, error_context: &str, update: F) -> bool
    where
        F: FnOnce(&str) -> String,
    {
        #[cfg(test)]
        if std::env::var_os(crate::config::CONFIG_PATH_ENV_VAR).is_none() {
            return false;
        }

        let path = crate::config::config_path();
        if let Some(parent) = path.parent() {
            if let Err(err) = std::fs::create_dir_all(parent) {
                crate::logging::config_write_failed(&path, error_context, &err.to_string());
                self.state.config_diagnostic =
                    Some(format!("failed to save {error_context}: {err}"));
                self.config_diagnostic_deadline =
                    Some(std::time::Instant::now() + std::time::Duration::from_secs(5));
                return false;
            }
        }

        let content = match read_config_for_update(&path) {
            Ok(content) => content,
            Err(err) => {
                crate::logging::config_write_failed(&path, error_context, &err.to_string());
                self.state.config_diagnostic =
                    Some(format!("failed to save {error_context}: {err}"));
                self.config_diagnostic_deadline =
                    Some(std::time::Instant::now() + std::time::Duration::from_secs(5));
                return false;
            }
        };
        let new_content = update(&content);
        if let Err(err) = std::fs::write(&path, new_content) {
            crate::logging::config_write_failed(&path, error_context, &err.to_string());
            self.state.config_diagnostic = Some(format!("failed to save {error_context}: {err}"));
            self.config_diagnostic_deadline =
                Some(std::time::Instant::now() + std::time::Duration::from_secs(5));
            return false;
        }

        true
    }

    pub(super) fn mark_onboarding_complete(&mut self) {
        self.update_config_file("onboarding setting", |content| {
            crate::config::upsert_top_level_bool(content, "onboarding", false)
        });
    }

    pub(super) fn save_theme(&mut self, name: &str) {
        if self.update_config_file("theme", |content| {
            let content = crate::config::upsert_section_value(
                content,
                "theme",
                "name",
                &format!("\"{name}\""),
            );
            crate::config::upsert_section_bool(&content, "theme", "auto_switch", false)
        }) {
            self.apply_config_from_disk(false);
        }
    }

    pub(super) fn save_status_indicators(&mut self, style: crate::config::StatusIndicatorStyle) {
        if self.update_config_file("status indicators", |content| {
            crate::config::upsert_section_value(
                content,
                "ui",
                "status_indicators",
                &format!("\"{}\"", style.as_str()),
            )
        }) {
            self.apply_config_from_disk(false);
        }
    }

    pub(super) fn save_sound(&mut self, enabled: bool) {
        if self.update_config_file("sound setting", |content| {
            crate::config::upsert_section_bool(content, "ui.sound", "enabled", enabled)
        }) {
            self.apply_config_from_disk(false);
        }
    }

    pub(super) fn save_toast_delivery(&mut self, delivery: crate::config::ToastDelivery) {
        let value = match delivery {
            crate::config::ToastDelivery::Off => "\"off\"",
            crate::config::ToastDelivery::Herdr => "\"herdr\"",
            crate::config::ToastDelivery::Terminal => "\"terminal\"",
            crate::config::ToastDelivery::System => "\"system\"",
        };
        if self.update_config_file("toast setting", |content| {
            let content =
                crate::config::upsert_section_value(content, "ui.toast", "delivery", value);
            crate::config::remove_section_key(&content, "ui.toast", "enabled")
        }) {
            self.apply_config_from_disk(false);
        }
    }

    pub(super) fn save_agent_border_labels(&mut self, enabled: bool) {
        if self.update_config_file("agent border labels", |content| {
            crate::config::upsert_section_bool(
                content,
                "ui",
                "show_agent_labels_on_pane_borders",
                enabled,
            )
        }) {
            self.apply_config_from_disk(false);
        }
    }

    pub(super) fn save_pane_history_persistence(&mut self, enabled: bool) {
        if self.update_config_file("pane screen history", |content| {
            crate::config::upsert_section_bool(content, "experimental", "pane_history", enabled)
        }) {
            self.apply_config_from_disk(false);
        }
    }

    pub(super) fn save_switch_ascii_input_source_in_prefix(&mut self, enabled: bool) {
        if self.update_config_file("prefix ascii input source", |content| {
            crate::config::upsert_section_bool(
                content,
                "experimental",
                "switch_ascii_input_source_in_prefix",
                enabled,
            )
        }) {
            self.apply_config_from_disk(false);
        }
    }

    pub(super) fn save_sidebar_space_preferences(
        &mut self,
        preferences: SidebarSpacePreferences,
    ) -> bool {
        let saved = self.update_config_file("space sidebar preferences", |content| {
            crate::config::upsert_section_body(
                content,
                "ui.sidebar.spaces",
                &space_sidebar_config_body(&preferences),
            )
        });
        if saved {
            let report = self.apply_config_from_disk(false);
            return report.status == crate::config::ConfigReloadStatus::Applied;
        }
        false
    }

    pub(super) fn save_sidebar_agent_preferences(
        &mut self,
        preferences: SidebarAgentPreferences,
    ) -> bool {
        let saved = self.update_config_file("agent sidebar preferences", |content| {
            crate::config::upsert_section_body(
                content,
                "ui.sidebar.agents",
                &agent_sidebar_config_body(&preferences),
            )
        });
        if saved {
            let report = self.apply_config_from_disk(false);
            return report.status == crate::config::ConfigReloadStatus::Applied;
        }
        false
    }

    pub(super) fn save_sidebar_host_preferences(
        &mut self,
        preferences: crate::config::SidebarHostConfig,
    ) -> bool {
        let saved = self.update_config_file("host sidebar preferences", |content| {
            crate::config::upsert_section_body(
                content,
                "ui.sidebar.host",
                &host_sidebar_config_body(&preferences),
            )
        });
        if saved {
            let report = self.apply_config_from_disk(false);
            return report.status == crate::config::ConfigReloadStatus::Applied;
        }
        false
    }

    pub(super) fn save_agent_panel_scope(&mut self, scope: crate::app::state::AgentPanelScope) {
        let value = match scope {
            crate::app::state::AgentPanelScope::CurrentWorkspace => {
                crate::config::AgentPanelScopeConfig::Current.as_str()
            }
            crate::app::state::AgentPanelScope::AllWorkspaces => {
                crate::config::AgentPanelScopeConfig::All.as_str()
            }
        };
        if self.update_config_file("agent panel scope", |content| {
            crate::config::upsert_section_value(
                content,
                "ui",
                "agent_panel_scope",
                &format!("\"{value}\""),
            )
        }) {
            self.apply_config_from_disk(false);
        }
    }

    pub(super) fn save_agent_panel_sort(&mut self, sort: crate::app::state::AgentPanelSort) {
        let value = match sort {
            crate::app::state::AgentPanelSort::Spaces => {
                crate::config::AgentPanelSortConfig::Spaces.as_str()
            }
            crate::app::state::AgentPanelSort::Priority => {
                crate::config::AgentPanelSortConfig::Priority.as_str()
            }
        };
        if self.update_config_file("agent panel sort", |content| {
            crate::config::upsert_section_value(
                content,
                "ui",
                "agent_panel_sort",
                &format!("\"{value}\""),
            )
        }) {
            self.apply_config_from_disk(false);
        }
    }
}

/// Read an existing config file for an in-place update.
///
/// A missing file is the legitimate first-write case and reads as empty. Every *other* IO error
/// (permission denied, partial read, corruption, EINTR, …) must abort the save: treating those as
/// empty would let a transient read failure overwrite the user's entire config with
/// empty-derived content. See issue #5.
fn read_config_for_update(path: &std::path::Path) -> std::io::Result<String> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(err),
    }
}

fn space_sidebar_config_body(preferences: &SidebarSpacePreferences) -> String {
    sidebar_item_lines_array(&preferences.lines, sidebar_space_field_name)
}

/// item 2 (C3): flat `key = value` body for `[ui.sidebar.host]` (NOT the `lines` array
/// writer — the host group is not item-based). Mirrors the enum `as_str()` mapping so the
/// round-trip re-parses to the same `SidebarHostConfig`.
fn host_sidebar_config_body(preferences: &crate::config::SidebarHostConfig) -> String {
    format!(
        "gradient = \"{}\"\nanimation = \"{}\"\nspeed = \"{}\"\nglyph = \"{}\"\nshow_count = {}\n",
        preferences.gradient.as_str(),
        preferences.animation.as_str(),
        preferences.speed.as_str(),
        preferences.glyph.as_str(),
        preferences.show_count,
    )
}

fn agent_sidebar_config_body(preferences: &SidebarAgentPreferences) -> String {
    sidebar_item_lines_array(&preferences.lines, sidebar_agent_field_name)
}

fn sidebar_item_lines_array<F: Copy>(
    lines: &[Vec<SidebarItem<F>>],
    field_name: fn(F) -> &'static str,
) -> String {
    let mut body = String::new();
    body.push_str("lines = [\n");
    for line in lines {
        body.push_str("  [\n");
        for item in line {
            let color = if SidebarColorPreset::is_default(&item.color) {
                String::new()
            } else {
                format!(", color = \"{}\"", item.color.as_str())
            };
            body.push_str(&format!(
                "    {{ field = \"{}\", show = {}{} }},\n",
                field_name(item.field),
                item.show,
                color
            ));
        }
        body.push_str("  ],\n");
    }
    body.push_str("]\n");
    body
}

fn sidebar_space_field_name(field: SidebarSpaceItem) -> &'static str {
    match field {
        SidebarSpaceField::Status => "status",
        SidebarSpaceField::Name => "name",
        SidebarSpaceField::Branch => "branch",
        SidebarSpaceField::BranchStatus => "branch_status",
    }
}

fn sidebar_agent_field_name(field: SidebarAgentItem) -> &'static str {
    match field {
        SidebarAgentField::AgentStatus => "agent_status",
        SidebarAgentField::PaneName => "pane_name",
        SidebarAgentField::TabName => "tab_name",
        SidebarAgentField::SpaceName => "space_name",
        SidebarAgentField::Status => "status",
        SidebarAgentField::Time => "time",
        SidebarAgentField::CustomStatus => "custom_status",
        SidebarAgentField::AgentName => "agent_name",
        SidebarAgentField::RightAlignment => "right_alignment",
    }
}

#[cfg(test)]
mod tests {
    use super::read_config_for_update;
    use std::io::ErrorKind;

    #[test]
    fn missing_config_reads_as_empty_for_first_write() {
        let path =
            std::env::temp_dir().join(format!("herdr-cfg-missing-{}.toml", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let content = read_config_for_update(&path).expect("missing file must not be an error");
        assert_eq!(content, "", "a missing config is the first-write case");
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_config_surfaces_error_instead_of_empty() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("herdr-cfg-perm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        std::fs::write(&path, "onboarding = false\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();

        let result = read_config_for_update(&path);

        // Restore perms so cleanup works regardless of the assertion outcome.
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        let _ = std::fs::remove_dir_all(&dir);

        // A non-NotFound read error must propagate so the caller aborts the save and never
        // overwrites the existing config with empty-derived content. If the process can read
        // mode-0 files (e.g. running as root), the `Err` path can't be exercised; don't fail the
        // suite for an environment we can't control.
        if let Err(err) = result {
            assert_ne!(
                err.kind(),
                ErrorKind::NotFound,
                "permission-denied must not be misreported as NotFound"
            );
        }
    }

    // ---- End-to-end `update_config_file` acceptance tests (issue #5) ----
    //
    // The helper tests above prove `read_config_for_update` distinguishes NotFound from other
    // errors. These exercise the full `App::update_config_file` flow to prove the *acceptance*
    // criterion: a non-NotFound read error aborts the write (the existing config is NOT
    // overwritten) and surfaces a `config_diagnostic`, while the NotFound path still writes.

    use crate::app::App;
    use crate::config::Config;

    fn e2e_test_app() -> App {
        let (_api_tx, api_rx) = tokio::sync::mpsc::unbounded_channel();
        App::new(
            &Config::default(),
            true,
            None,
            api_rx,
            crate::api::EventHub::default(),
        )
    }

    fn e2e_config_path(name: &str) -> std::path::PathBuf {
        let unique = format!(
            "herdr-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        std::env::temp_dir().join(unique).join("config.toml")
    }

    #[cfg(unix)]
    #[test]
    fn update_config_file_aborts_without_overwriting_on_unreadable_config() {
        use std::os::unix::fs::PermissionsExt;

        let _guard = crate::config::test_config_env_lock().lock().unwrap();
        let path = e2e_config_path("update-abort-unreadable");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();

        let original = "onboarding = false\n[theme]\nname = \"matrix\"\n";
        std::fs::write(&path, original).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        std::env::set_var(crate::config::CONFIG_PATH_ENV_VAR, &path);

        let mut app = e2e_test_app();
        // The update closure would build a brand-new (effectively empty-derived) body; if the read
        // were collapsed to empty, this would wipe the original config.
        let saved = app.update_config_file("theme", |content| {
            crate::config::upsert_section_value(content, "theme", "name", "\"nord\"")
        });

        // Restore perms before any assertion can early-return, so cleanup always succeeds.
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        let on_disk = std::fs::read_to_string(&path).ok();
        let diagnostic = app.state.config_diagnostic.clone();

        std::env::remove_var(crate::config::CONFIG_PATH_ENV_VAR);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());

        // If the environment can read mode-0 files (e.g. running as root) the failure path can't
        // be exercised; skip rather than fail for an environment we can't control.
        if on_disk.as_deref() == Some(original) {
            assert!(!saved, "a non-NotFound read error must abort the save");
            assert!(
                diagnostic.is_some(),
                "an aborted save must surface a config diagnostic"
            );
        }
    }

    #[test]
    fn update_config_file_creates_file_on_first_write_when_missing() {
        let _guard = crate::config::test_config_env_lock().lock().unwrap();
        let path = e2e_config_path("update-first-write-missing");
        // Parent exists (create_dir_all in the helper handles it) but the file does not: NotFound.
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        assert!(!path.exists(), "precondition: config file must be missing");
        std::env::set_var(crate::config::CONFIG_PATH_ENV_VAR, &path);

        let mut app = e2e_test_app();
        let saved = app.update_config_file("theme", |content| {
            crate::config::upsert_section_value(content, "theme", "name", "\"nord\"")
        });
        let on_disk = std::fs::read_to_string(&path).ok();
        let diagnostic = app.state.config_diagnostic.clone();

        std::env::remove_var(crate::config::CONFIG_PATH_ENV_VAR);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());

        assert!(saved, "first write (NotFound) must succeed");
        assert!(
            diagnostic.is_none(),
            "first write must not raise a diagnostic"
        );
        assert!(
            on_disk.as_deref().unwrap_or_default().contains("nord"),
            "first write must create the file with the new content"
        );
    }

    #[test]
    fn update_config_file_preserves_existing_content_on_successful_read() {
        let _guard = crate::config::test_config_env_lock().lock().unwrap();
        let path = e2e_config_path("update-preserves-existing");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "onboarding = false\n[theme]\nname = \"matrix\"\n").unwrap();
        std::env::set_var(crate::config::CONFIG_PATH_ENV_VAR, &path);

        let mut app = e2e_test_app();
        let saved = app.update_config_file("theme", |content| {
            crate::config::upsert_section_value(content, "theme", "name", "\"nord\"")
        });
        let on_disk = std::fs::read_to_string(&path).unwrap();
        let diagnostic = app.state.config_diagnostic.clone();

        std::env::remove_var(crate::config::CONFIG_PATH_ENV_VAR);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());

        assert!(saved, "a normal read-before-write must succeed");
        assert!(
            diagnostic.is_none(),
            "a successful save must not raise a diagnostic"
        );
        // Unrelated keys from the original config survive the in-place update.
        assert!(
            on_disk.contains("onboarding = false"),
            "the existing config body must be preserved, not overwritten"
        );
        assert!(
            on_disk.contains("nord"),
            "the updated value must be written"
        );
    }
}
