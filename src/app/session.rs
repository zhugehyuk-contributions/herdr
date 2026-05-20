use std::time::{Instant, SystemTime, UNIX_EPOCH};

use super::{App, SESSION_SAVE_DEBOUNCE};

impl App {
    pub(super) fn schedule_session_save(&mut self) {
        if !self.no_session {
            self.session_save_deadline = Some(Instant::now() + SESSION_SAVE_DEBOUNCE);
        }
    }

    pub(crate) fn sync_session_save_schedule(&mut self) {
        if self.state.session_dirty {
            self.state.session_dirty = false;
            self.schedule_session_save();
        }
    }

    pub(crate) fn save_session_now(&mut self) {
        self.save_session_now_with_history_disconnected_at(None);
    }

    pub(crate) fn interrupt_agent_jobs_before_shutdown(&self) -> usize {
        let mut interrupted = 0usize;

        for workspace in &self.state.workspaces {
            let mut seen_panes = std::collections::HashSet::new();
            for tab in &workspace.tabs {
                for pane_id in tab.panes.keys().copied() {
                    if !seen_panes.insert(pane_id) {
                        continue;
                    }
                    #[cfg(test)]
                    let runtime = workspace
                        .test_runtimes
                        .get(&pane_id)
                        .or_else(|| tab.runtimes.get(&pane_id));
                    #[cfg(not(test))]
                    let runtime = tab
                        .terminal_id(pane_id)
                        .and_then(|terminal_id| self.state.terminal_runtimes.get(terminal_id));
                    #[cfg(test)]
                    let runtime = runtime.or_else(|| {
                        tab.terminal_id(pane_id)
                            .and_then(|terminal_id| self.state.terminal_runtimes.get(terminal_id))
                    });
                    let Some(runtime) = runtime else { continue };
                    if runtime.interrupt_foreground_agent_for_shutdown() {
                        interrupted = interrupted.saturating_add(1);
                    }
                }
            }
        }

        interrupted
    }

    pub(crate) fn save_session_now_with_history_disconnected_at(
        &mut self,
        history_disconnected_at: Option<SystemTime>,
    ) {
        if self.no_session {
            self.session_save_deadline = None;
            return;
        }

        if self.state.workspaces.is_empty() {
            crate::persist::clear();
        } else {
            let snap = crate::persist::capture_with_history_disconnected_at(
                &self.state.workspaces,
                &self.state.terminals,
                &self.state.terminal_runtimes,
                self.state.active,
                self.state.selected,
                self.state.agent_panel_scope,
                self.state.sidebar_width,
                self.state.sidebar_section_split,
                history_disconnected_at.and_then(epoch_seconds),
            );
            crate::persist::save(&snap);
        }

        self.session_save_deadline = None;
    }
}

fn epoch_seconds(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}
