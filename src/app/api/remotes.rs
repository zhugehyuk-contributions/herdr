use crate::api::schema::{
    RemoteAddParams, RemoteRemoveParams, RemoteRenameParams, RemoteSetAutoUpdateParams,
    RemoteSetEnabledParams, RemoteSetSessionParams, ResponseResult,
};
use crate::app::App;

use super::responses::{encode_error, encode_success};

impl App {
    pub(super) fn handle_remote_list(&mut self, id: String) -> String {
        encode_success(
            id,
            ResponseResult::RemoteList {
                remotes: self.state.remote_registry.remotes.clone(),
            },
        )
    }

    pub(super) fn handle_remote_add(&mut self, id: String, params: RemoteAddParams) -> String {
        match self.state.remote_registry.add_excluding_targets(
            params.name,
            params.target,
            params.session,
            params.keybindings,
            &main_server_remote_targets(),
        ) {
            Ok(remote) => {
                self.state.mark_session_dirty();
                encode_success(id, ResponseResult::RemoteAdded { remote })
            }
            Err(err) => encode_error(id, err.code(), err.message()),
        }
    }

    pub(super) fn handle_remote_remove(
        &mut self,
        id: String,
        params: RemoteRemoveParams,
    ) -> String {
        match self.state.remote_registry.remove(&params.remote_id) {
            Ok(remote_id) => {
                self.state.mark_session_dirty();
                encode_success(id, ResponseResult::RemoteRemoved { remote_id })
            }
            Err(err) => encode_error(id, err.code(), err.message()),
        }
    }

    pub(super) fn handle_remote_rename(
        &mut self,
        id: String,
        params: RemoteRenameParams,
    ) -> String {
        match self
            .state
            .remote_registry
            .rename(&params.remote_id, params.name)
        {
            Ok(remote) => {
                self.state.mark_session_dirty();
                encode_success(id, ResponseResult::RemoteRenamed { remote })
            }
            Err(err) => encode_error(id, err.code(), err.message()),
        }
    }

    pub(super) fn handle_remote_set_enabled(
        &mut self,
        id: String,
        params: RemoteSetEnabledParams,
    ) -> String {
        match self
            .state
            .remote_registry
            .set_enabled(&params.remote_id, params.enabled)
        {
            Ok(remote) => {
                self.state.mark_session_dirty();
                encode_success(id, ResponseResult::RemoteEnabledChanged { remote })
            }
            Err(err) => encode_error(id, err.code(), err.message()),
        }
    }

    /// #61: persist a remote's per-remote auto-update flag. Mirrors `handle_remote_set_enabled`;
    /// reuses the `RemoteEnabledChanged` success body (it just carries the updated definition — the
    /// client re-syncs the flag off the periodic `remote.list`, not this response).
    pub(super) fn handle_remote_set_auto_update(
        &mut self,
        id: String,
        params: RemoteSetAutoUpdateParams,
    ) -> String {
        match self
            .state
            .remote_registry
            .set_auto_update(&params.remote_id, params.auto_update)
        {
            Ok(remote) => {
                self.state.mark_session_dirty();
                encode_success(id, ResponseResult::RemoteEnabledChanged { remote })
            }
            Err(err) => encode_error(id, err.code(), err.message()),
        }
    }

    /// Point a remote at a different session. Mirrors `handle_remote_set_auto_update`; the excluded
    /// targets are the main server's own target, so re-pointing a local remote can't collide with
    /// the session this server is running.
    pub(super) fn handle_remote_set_session(
        &mut self,
        id: String,
        params: RemoteSetSessionParams,
    ) -> String {
        match self.state.remote_registry.set_session(
            &params.remote_id,
            params.session,
            &main_server_remote_targets(),
        ) {
            Ok(remote) => {
                self.state.mark_session_dirty();
                encode_success(id, ResponseResult::RemoteEnabledChanged { remote })
            }
            Err(err) => encode_error(id, err.code(), err.message()),
        }
    }
}

fn main_server_remote_targets() -> Vec<crate::remote_registry::RemoteTargetSnapshot> {
    if let Ok(target) = std::env::var(crate::remote::MAIN_REMOTE_TARGET_ENV_VAR) {
        return crate::remote_registry::RemoteTargetSnapshot::parse(&target)
            .ok()
            .into_iter()
            .collect();
    }

    vec![crate::remote_registry::RemoteTargetSnapshot::Local {
        session: crate::session::active_name(),
    }]
}

#[cfg(test)]
mod tests {
    use crate::api::schema::{ErrorResponse, Request};
    use crate::app::App;
    use crate::config::Config;
    use std::ffi::OsString;

    fn test_app() -> App {
        let (_api_tx, api_rx) = tokio::sync::mpsc::unbounded_channel();
        App::new(
            &Config::default(),
            true,
            None,
            api_rx,
            crate::api::EventHub::default(),
        )
    }

    fn call(app: &mut App, json: &str) -> serde_json::Value {
        let request: Request = serde_json::from_str(json).unwrap();
        let response = app.handle_api_request(request);
        serde_json::from_str(&response).unwrap()
    }

    fn error_code(app: &mut App, json: &str) -> String {
        let request: Request = serde_json::from_str(json).unwrap();
        let response = app.handle_api_request(request);
        let error: ErrorResponse = serde_json::from_str(&response).unwrap();
        error.error.code
    }

    fn capture_snapshot(app: &App) -> crate::persist::SessionSnapshot {
        crate::persist::capture(
            &app.state.workspaces,
            &app.state.terminals,
            &app.terminal_runtimes,
            app.state.active,
            app.state.selected,
            app.state.agent_panel_scope,
            app.state.sidebar_width,
            app.state.sidebar_section_split,
            app.state.collapsed_space_keys.clone(),
            app.state.remote_registry.clone(),
            &app.state.pane_id_aliases,
        )
    }

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<OsString>,
    }

    impl EnvVarGuard {
        fn remove(key: &'static str) -> Self {
            let previous = std::env::var_os(key);
            std::env::remove_var(key);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(value) = self.previous.take() {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    #[test]
    fn remote_add_lists_definition_without_connection_state() {
        let mut app = test_app();

        let add = call(
            &mut app,
            r#"{"id":"add","method":"remote.add","params":{"name":"x","target":"user@x","keybindings":"local"}}"#,
        );

        assert_eq!(add["result"]["type"], "remote_added");
        assert_eq!(add["result"]["remote"]["id"], "remote-1");
        assert_eq!(add["result"]["remote"]["name"], "x");
        assert_eq!(add["result"]["remote"]["target"]["type"], "ssh");
        assert_eq!(add["result"]["remote"]["target"]["target"], "user@x");
        assert!(add["result"]["remote"].get("connection_state").is_none());
        assert!(add["result"]["remote"].get("socket").is_none());

        let list = call(
            &mut app,
            r#"{"id":"list","method":"remote.list","params":{}}"#,
        );

        assert_eq!(list["result"]["type"], "remote_list");
        assert_eq!(list["result"]["remotes"].as_array().unwrap().len(), 1);
        assert_eq!(list["result"]["remotes"][0]["name"], "x");
        assert!(list["result"]["remotes"][0]
            .get("connection_state")
            .is_none());
        assert!(list["result"]["remotes"][0].get("socket").is_none());

        let snapshot = capture_snapshot(&app);
        assert!(app.state.session_dirty);
        assert_eq!(snapshot.remote_registry.remotes.len(), 1);
        assert_eq!(snapshot.remote_registry.remotes[0].name, "x");
    }

    #[test]
    fn remote_add_rejects_duplicate_names_and_targets() {
        let mut app = test_app();

        call(
            &mut app,
            r#"{"id":"add","method":"remote.add","params":{"name":"x","target":"user@x"}}"#,
        );

        assert_eq!(
            error_code(
                &mut app,
                r#"{"id":"dup_name","method":"remote.add","params":{"name":"x","target":"user@y"}}"#,
            ),
            "duplicate_remote_name"
        );
        assert_eq!(
            error_code(
                &mut app,
                r#"{"id":"dup_target","method":"remote.add","params":{"name":"y","target":"user@x"}}"#,
            ),
            "duplicate_remote_target"
        );
    }

    #[test]
    fn remote_add_rejects_current_main_local_target() {
        let _session_env = EnvVarGuard::remove(crate::session::SESSION_ENV_VAR);
        let _main_remote_env = EnvVarGuard::remove(crate::remote::MAIN_REMOTE_TARGET_ENV_VAR);
        let mut app = test_app();

        assert_eq!(
            error_code(
                &mut app,
                r#"{"id":"add","method":"remote.add","params":{"name":"local","target":"localhost"}}"#
            ),
            "duplicate_remote_target"
        );
    }

    #[test]
    fn remote_remove_and_rename_update_only_the_registry() {
        let mut app = test_app();

        let add = call(
            &mut app,
            r#"{"id":"add","method":"remote.add","params":{"name":"x","target":"local:dev"}}"#,
        );
        let remote_id = add["result"]["remote"]["id"].as_str().unwrap();
        let rename = format!(
            r#"{{"id":"rename","method":"remote.rename","params":{{"remote_id":"{remote_id}","name":"dev"}}}}"#
        );

        let renamed = call(&mut app, &rename);

        assert_eq!(renamed["result"]["type"], "remote_renamed");
        assert_eq!(renamed["result"]["remote"]["id"], remote_id);
        assert_eq!(renamed["result"]["remote"]["name"], "dev");
        assert_eq!(renamed["result"]["remote"]["target"]["type"], "local");
        assert_eq!(renamed["result"]["remote"]["target"]["session"], "dev");

        let remove = format!(
            r#"{{"id":"remove","method":"remote.remove","params":{{"remote_id":"{remote_id}"}}}}"#
        );
        let removed = call(&mut app, &remove);

        assert_eq!(removed["result"]["type"], "remote_removed");
        assert_eq!(removed["result"]["remote_id"], remote_id);

        let list = call(
            &mut app,
            r#"{"id":"list","method":"remote.list","params":{}}"#,
        );
        assert!(list["result"]["remotes"].as_array().unwrap().is_empty());
    }

    #[test]
    fn remote_set_enabled_flips_marks_dirty_and_lists() {
        let mut app = test_app();

        let add = call(
            &mut app,
            r#"{"id":"add","method":"remote.add","params":{"name":"x","target":"user@x"}}"#,
        );
        let remote_id = add["result"]["remote"]["id"].as_str().unwrap().to_string();
        app.state.session_dirty = false;

        let disable = format!(
            r#"{{"id":"disable","method":"remote.set_enabled","params":{{"remote_id":"{remote_id}","enabled":false}}}}"#
        );
        let response = call(&mut app, &disable);

        assert_eq!(response["result"]["type"], "remote_enabled_changed");
        assert_eq!(response["result"]["remote"]["id"], remote_id);
        assert_eq!(response["result"]["remote"]["disabled"], true);
        assert!(app.state.session_dirty);

        let snapshot = capture_snapshot(&app);
        assert_eq!(snapshot.remote_registry.remotes.len(), 1);
        assert!(snapshot.remote_registry.remotes[0].disabled);

        let list = call(
            &mut app,
            r#"{"id":"list","method":"remote.list","params":{}}"#,
        );
        assert_eq!(list["result"]["remotes"][0]["disabled"], true);
    }

    #[test]
    fn remote_set_enabled_unknown_id_returns_not_found() {
        let mut app = test_app();
        assert_eq!(
            error_code(
                &mut app,
                r#"{"id":"set","method":"remote.set_enabled","params":{"remote_id":"missing","enabled":false}}"#,
            ),
            "remote_not_found"
        );
    }

    #[test]
    fn remote_set_auto_update_persists_marks_dirty_and_lists() {
        // #61: toggling auto-update flips the persisted flag, marks the session dirty, and the flag
        // round-trips through `remote.list`.
        let mut app = test_app();
        let add = call(
            &mut app,
            r#"{"id":"add","method":"remote.add","params":{"name":"x","target":"user@x"}}"#,
        );
        let remote_id = add["result"]["remote"]["id"].as_str().unwrap().to_string();
        app.state.session_dirty = false;

        let enable = format!(
            r#"{{"id":"au","method":"remote.set_auto_update","params":{{"remote_id":"{remote_id}","auto_update":true}}}}"#
        );
        let response = call(&mut app, &enable);
        assert_eq!(response["result"]["type"], "remote_enabled_changed");
        assert_eq!(response["result"]["remote"]["id"], remote_id);
        assert_eq!(response["result"]["remote"]["auto_update"], true);
        assert!(app.state.session_dirty);

        let snapshot = capture_snapshot(&app);
        assert!(snapshot.remote_registry.remotes[0].auto_update);

        let list = call(
            &mut app,
            r#"{"id":"list","method":"remote.list","params":{}}"#,
        );
        assert_eq!(list["result"]["remotes"][0]["auto_update"], true);
    }

    #[test]
    fn remote_set_auto_update_unknown_id_returns_not_found() {
        let mut app = test_app();
        assert_eq!(
            error_code(
                &mut app,
                r#"{"id":"set","method":"remote.set_auto_update","params":{"remote_id":"missing","auto_update":true}}"#,
            ),
            "remote_not_found"
        );
    }

    #[test]
    fn remote_add_persists_the_requested_session() {
        let mut app = test_app();

        let add = call(
            &mut app,
            r#"{"id":"add","method":"remote.add","params":{"name":"x","target":"user@x","session":"work"}}"#,
        );

        assert_eq!(add["result"]["type"], "remote_added");
        assert_eq!(add["result"]["remote"]["session"], "work");

        let list = call(
            &mut app,
            r#"{"id":"list","method":"remote.list","params":{}}"#,
        );
        assert_eq!(list["result"]["remotes"][0]["session"], "work");

        let snapshot = capture_snapshot(&app);
        assert_eq!(
            snapshot.remote_registry.remotes[0].session.as_deref(),
            Some("work")
        );
    }

    #[test]
    fn remote_add_treats_default_and_empty_sessions_as_the_default_session() {
        let mut app = test_app();

        let explicit_default = call(
            &mut app,
            r#"{"id":"add","method":"remote.add","params":{"name":"x","target":"user@x","session":"default"}}"#,
        );
        assert!(explicit_default["result"]["remote"]
            .get("session")
            .is_none());

        let empty = call(
            &mut app,
            r#"{"id":"add2","method":"remote.add","params":{"name":"y","target":"user@y","session":""}}"#,
        );
        assert!(empty["result"]["remote"].get("session").is_none());

        let snapshot = capture_snapshot(&app);
        assert_eq!(snapshot.remote_registry.remotes[0].session, None);
        assert_eq!(snapshot.remote_registry.remotes[1].session, None);
    }

    #[test]
    fn remote_add_rejects_an_invalid_session_name() {
        let mut app = test_app();

        assert_eq!(
            error_code(
                &mut app,
                r#"{"id":"add","method":"remote.add","params":{"name":"x","target":"user@x","session":"bad name!"}}"#,
            ),
            "invalid_session_name"
        );
        assert!(app.state.remote_registry.remotes.is_empty());
    }

    #[test]
    fn remote_set_session_persists_marks_dirty_and_lists() {
        let mut app = test_app();
        let add = call(
            &mut app,
            r#"{"id":"add","method":"remote.add","params":{"name":"x","target":"user@x"}}"#,
        );
        let remote_id = add["result"]["remote"]["id"].as_str().unwrap().to_string();
        app.state.session_dirty = false;

        let set = format!(
            r#"{{"id":"sess","method":"remote.set_session","params":{{"remote_id":"{remote_id}","session":"work"}}}}"#
        );
        let response = call(&mut app, &set);

        assert_eq!(response["result"]["type"], "remote_enabled_changed");
        assert_eq!(response["result"]["remote"]["id"], remote_id);
        assert_eq!(response["result"]["remote"]["session"], "work");
        assert!(app.state.session_dirty);

        let snapshot = capture_snapshot(&app);
        assert_eq!(
            snapshot.remote_registry.remotes[0].session.as_deref(),
            Some("work")
        );

        let list = call(
            &mut app,
            r#"{"id":"list","method":"remote.list","params":{}}"#,
        );
        assert_eq!(list["result"]["remotes"][0]["session"], "work");
    }

    #[test]
    fn remote_set_session_invalid_name_leaves_the_registry_unchanged() {
        let mut app = test_app();
        let add = call(
            &mut app,
            r#"{"id":"add","method":"remote.add","params":{"name":"x","target":"user@x","session":"work"}}"#,
        );
        let remote_id = add["result"]["remote"]["id"].as_str().unwrap().to_string();
        app.state.session_dirty = false;

        let set = format!(
            r#"{{"id":"sess","method":"remote.set_session","params":{{"remote_id":"{remote_id}","session":"bad name!"}}}}"#
        );
        assert_eq!(error_code(&mut app, &set), "invalid_session_name");
        assert!(!app.state.session_dirty);
        assert_eq!(
            app.state.remote_registry.remotes[0].session.as_deref(),
            Some("work")
        );
    }

    #[test]
    fn remote_set_session_unknown_id_returns_not_found() {
        let mut app = test_app();
        assert_eq!(
            error_code(
                &mut app,
                r#"{"id":"sess","method":"remote.set_session","params":{"remote_id":"missing","session":"work"}}"#,
            ),
            "remote_not_found"
        );
    }

    #[test]
    fn enabled_remote_list_json_omits_disabled_key() {
        let mut app = test_app();
        call(
            &mut app,
            r#"{"id":"add","method":"remote.add","params":{"name":"x","target":"user@x"}}"#,
        );

        let list = call(
            &mut app,
            r#"{"id":"list","method":"remote.list","params":{}}"#,
        );
        assert!(list["result"]["remotes"][0].get("disabled").is_none());
    }
}
