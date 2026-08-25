//! herdr-mx additions to the socket API schema.
//!
//! Upstream refactored `schema.rs` into per-area submodules. These types are
//! herdr-mx-only (multi-remote management, the `workspace.reorder` action, and the
//! UI-settings readout the multi-remote client renders), so they live in their own
//! submodule instead of being scattered into the upstream files.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RemoteAddParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub target: String,
    /// Optional session to attach to on the remote. Absent/empty/`"default"` = the remote's
    /// default session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default)]
    pub keybindings: crate::remote_registry::RemoteKeybindingsSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RemoteRemoveParams {
    pub remote_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RemoteRenameParams {
    pub remote_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RemoteSetAutoUpdateParams {
    pub remote_id: String,
    pub auto_update: bool,
}

/// Point an existing remote at a different session. Absent/empty/`"default"` = the remote's
/// default session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RemoteSetSessionParams {
    pub remote_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

/// mockup #7: switch which side owns an existing remote's keybindings. Same `local`/`server`
/// semantics `RemoteAddParams::keybindings` carries at add time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RemoteSetKeybindingsParams {
    pub remote_id: String,
    pub keybindings: crate::remote_registry::RemoteKeybindingsSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RemoteSetEnabledParams {
    pub remote_id: String,
    pub enabled: bool,
}

/// #19: move `workspace_id` so it sits at `insert_index` in the server's workspace list. The index
/// is an insert position into the list as it stands *before* the move (0..=len), matching the
/// monolithic `AppState::move_workspace` contract. Clamped server-side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct WorkspaceReorderParams {
    pub workspace_id: String,
    pub insert_index: usize,
}

/// Present when the workspace's checkout is a git repo even WITHOUT worktree-space
/// membership (from the workspace's cached git metadata) — the signal client menus
/// need to offer worktree actions on a plain git workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct WorkspaceGitInfo {
    pub repo_key: String,
    pub is_linked_worktree: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct UiSettingsInfo {
    pub sidebar_width: u16,
    pub sidebar_default_width: u16,
    pub sidebar_min_width: u16,
    pub sidebar_max_width: u16,
    pub sidebar_section_split_per_mille: u16,
    // mx sidebar config types carry hand-written serde impls; omit them from the
    // generated upstream API schema doc instead of deriving JsonSchema through them.
    #[schemars(skip)]
    pub sidebar_spaces: crate::config::SidebarSpacesConfig,
    // mx sidebar config types carry hand-written serde impls; omit them from the
    // generated upstream API schema doc instead of deriving JsonSchema through them.
    #[schemars(skip)]
    pub sidebar_agents: crate::config::SidebarAgentsConfig,
    // mx sidebar config types carry hand-written serde impls; omit them from the
    // generated upstream API schema doc instead of deriving JsonSchema through them.
    #[schemars(skip)]
    pub sidebar_host: crate::config::SidebarHostConfig,
}

impl Default for UiSettingsInfo {
    fn default() -> Self {
        let ui = crate::config::Config::default().ui;
        Self {
            sidebar_width: ui.sidebar_width,
            sidebar_default_width: ui.sidebar_width,
            sidebar_min_width: ui.sidebar_min_width,
            sidebar_max_width: ui.sidebar_max_width,
            sidebar_section_split_per_mille: 500,
            sidebar_spaces: ui.sidebar.spaces,
            sidebar_agents: ui.sidebar.agents,
            sidebar_host: ui.sidebar.host,
        }
    }
}

impl UiSettingsInfo {
    pub(crate) fn sidebar_section_split(&self) -> f32 {
        (self.sidebar_section_split_per_mille as f32 / 1000.0).clamp(0.1, 0.9)
    }
}
