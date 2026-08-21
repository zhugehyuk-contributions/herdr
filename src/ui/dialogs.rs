use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Clear, Paragraph, Wrap},
    Frame,
};

use super::text::{display_width_u16, truncate_end};
use super::widgets::{
    action_button_row_rects, bottom_left_popup_rect, centered_popup_rect, panel_contrast_fg,
    render_action_button, render_modal_header, render_modal_shell, render_panel_shell,
    ActionButtonSpec,
};
use crate::app::state::Palette;
use crate::app::{state::WorktreeOpenState, AppState, Mode};
use crate::terminal::TerminalRuntimeRegistry;

// item 1 (Area 3 / Decision 2): ui-owned view structs for the composited client modals. These
// hold ONLY ui primitives / borrowed strings — they MUST NOT reference any supervisor-model
// type (one-way `ui` <- `client` layering, contradiction 13). The compositor maps the model into
// these views before calling the `render_*_overlay` functions below. The
// `dialogs_does_not_reference_client_supervisor` test enforces this.

/// C1: which add-remote field is focused. A ui-owned copy of the client's `AddRemoteField` — the
/// one-way `ui` <- `client` layering forbids naming the supervisor type here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AddRemoteFieldView {
    Target,
    Name,
    Session,
}

/// View for the add-remote modal. `focused_field` selects which of the three fields draws the
/// focused (filled) style + cursor block.
pub(crate) struct AddRemoteOverlayView<'a> {
    pub target: &'a str,
    pub name: &'a str,
    /// C1: the OPTIONAL session; empty renders blank and means the remote's default session.
    pub session: &'a str,
    pub focused_field: AddRemoteFieldView,
    pub error: Option<&'a str>,
    /// When true, the status row shows an animated "connecting" line instead of an error. Takes
    /// precedence over `error` (the worker clears the error when it starts).
    pub in_progress: bool,
    /// Latest provisioning stage to show on the in-progress row (e.g. "installing herdr on the
    /// remote…"). `None` falls back to the generic "connecting to remote…" (issue #32).
    pub progress: Option<&'a str>,
    /// Current spinner glyph for the in-progress line (advances with the shared animation tick).
    pub spinner: &'a str,
}

/// View for one new-workspace destination row.
pub(crate) struct DestinationView<'a> {
    pub display_name: &'a str,
}

/// item 3 (Area 3/5): ui-owned glyph for a remote's state in the management overlay. This is a
/// ui-local enum, NOT the supervisor `ConnectionState` (the one-way layering rule). The compositor
/// maps the supervisor row state into this before calling `render_remote_manage_overlay`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemoteStateGlyph {
    Connected,
    Connecting,
    Disconnected,
    Disabled,
    ProtocolMismatch,
}

impl RemoteStateGlyph {
    /// The single-cell status glyph drawn at the start of the row.
    fn glyph(self) -> &'static str {
        match self {
            RemoteStateGlyph::Connected => "●",
            RemoteStateGlyph::Connecting => "◐",
            RemoteStateGlyph::Disconnected => "○",
            RemoteStateGlyph::Disabled => "✕",
            RemoteStateGlyph::ProtocolMismatch => "!",
        }
    }
}

/// item 3 (Area 3/5): ui-owned view for one management-overlay row. Holds only ui primitives /
/// borrowed strings (no supervisor type), per the layering rule.
pub(crate) struct RemoteManageRowView<'a> {
    pub glyph: RemoteStateGlyph,
    pub name: &'a str,
    pub target: &'a str,
    pub state_word: &'a str,
    pub disabled: bool,
}

/// #47: ui-owned view for the one client menu (global launcher / workspace context / host context).
/// `title` is the panel header ("menu" / "workspace" / "host"); `subheader` is the optional target
/// line under it (workspace label / host name), `None` for the launcher. `rows` are the menu rows.
/// Holds only borrowed strings (no supervisor type), per the layering rule.
pub(crate) struct ClientMenuView<'a> {
    pub title: &'a str,
    pub subheader: Option<&'a str>,
    pub rows: &'a [ClientMenuRowView<'a>],
    pub selected: usize,
}

/// #47: one ui-owned row of a [`ClientMenuView`]. `selectable` is false for non-actionable rows
/// (the host version readout), which render dimmer.
pub(crate) struct ClientMenuRowView<'a> {
    pub label: &'a str,
    pub selectable: bool,
}

const NEW_LINKED_WORKTREE_POPUP_WIDTH: u16 = 68;
const NEW_LINKED_WORKTREE_POPUP_HEIGHT: u16 = 12;

pub(crate) fn rename_button_rects(inner: Rect) -> (Rect, Rect, Rect) {
    let rects = action_button_row_rects(
        inner,
        &[
            ActionButtonSpec {
                hint: Some("↵"),
                label: "save",
            },
            ActionButtonSpec {
                hint: Some("^c"),
                label: "clear",
            },
            ActionButtonSpec {
                hint: Some("esc"),
                label: "cancel",
            },
        ],
        2,
        3,
    );
    (rects[0], rects[1], rects[2])
}

pub(super) fn render_rename_overlay(app: &AppState, frame: &mut Frame, area: Rect) {
    super::dim_background(frame, area);

    let title = match app.mode {
        Mode::RenameWorkspace if app.pending_workspace_create_cwd.is_some() => "new workspace",
        Mode::RenameWorkspace => "rename workspace",
        Mode::RenameTab if app.creating_new_tab => "new tab",
        Mode::RenameTab => "rename tab",
        Mode::RenamePane => "rename pane",
        _ => return,
    };

    let Some(inner) = render_modal_shell(frame, area, 56, 7, &app.palette) else {
        return;
    };
    if inner.height < 4 {
        return;
    }

    let rows = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(0),
    ])
    .areas::<5>(inner);

    render_modal_header(frame, rows[0], title, &app.palette);

    let input_rect = Rect::new(rows[2].x, rows[2].y, rows[2].width, 1);
    frame.render_widget(Clear, input_rect);
    frame.render_widget(
        Paragraph::new(format!(" {}█", app.name_input)).style(
            Style::default()
                .fg(app.palette.text)
                .bg(app.palette.surface0),
        ),
        input_rect,
    );

    let (save_rect, clear_rect, cancel_rect) = rename_button_rects(inner);

    render_action_button(
        frame,
        save_rect,
        Some("↵"),
        "save",
        Style::default()
            .fg(panel_contrast_fg(&app.palette))
            .bg(app.palette.accent)
            .add_modifier(Modifier::BOLD),
    );
    render_action_button(
        frame,
        clear_rect,
        Some("^c"),
        "clear",
        Style::default()
            .fg(app.palette.text)
            .bg(app.palette.surface0)
            .add_modifier(Modifier::BOLD),
    );
    render_action_button(
        frame,
        cancel_rect,
        Some("esc"),
        "cancel",
        Style::default()
            .fg(app.palette.text)
            .bg(app.palette.surface0)
            .add_modifier(Modifier::BOLD),
    );
}

pub(crate) fn new_linked_worktree_inner_rect(area: Rect) -> Option<Rect> {
    centered_popup_rect(
        area,
        NEW_LINKED_WORKTREE_POPUP_WIDTH,
        NEW_LINKED_WORKTREE_POPUP_HEIGHT,
    )
    .map(|popup| {
        Rect::new(
            popup.x + 1,
            popup.y + 1,
            popup.width.saturating_sub(2),
            popup.height.saturating_sub(2),
        )
    })
}

pub(crate) fn new_linked_worktree_button_rects(inner: Rect) -> (Rect, Rect) {
    let rects = action_button_row_rects(
        inner,
        &[
            ActionButtonSpec {
                hint: Some("↵"),
                label: "create and open",
            },
            ActionButtonSpec {
                hint: Some("esc"),
                label: "cancel",
            },
        ],
        2,
        inner.height.saturating_sub(1),
    );
    (rects[0], rects[1])
}

pub(crate) fn remove_worktree_popup_rect(area: Rect) -> Option<Rect> {
    centered_popup_rect(area, 72, 10)
}

pub(crate) fn remove_worktree_button_rects(inner: Rect, force_confirmation: bool) -> (Rect, Rect) {
    let primary_label = if force_confirmation {
        "delete anyway"
    } else {
        "remove"
    };
    let rects = action_button_row_rects(
        inner,
        &[
            ActionButtonSpec {
                hint: Some("↵"),
                label: primary_label,
            },
            ActionButtonSpec {
                hint: Some("esc"),
                label: "cancel",
            },
        ],
        2,
        inner.height.saturating_sub(1),
    );
    (rects[0], rects[1])
}

pub(crate) fn open_existing_worktree_inner_rect(area: Rect, entry_count: usize) -> Option<Rect> {
    let height = (entry_count as u16)
        .saturating_mul(2)
        .saturating_add(7)
        .clamp(12, 26);
    centered_popup_rect(area, 96, height).map(|popup| {
        Rect::new(
            popup.x + 1,
            popup.y + 1,
            popup.width.saturating_sub(2),
            popup.height.saturating_sub(2),
        )
    })
}

pub(crate) fn open_existing_worktree_max_visible_rows(inner: Rect) -> usize {
    usize::from(inner.height.saturating_sub(5) / 2)
}

pub(crate) fn open_existing_worktree_visible_start(
    open: &WorktreeOpenState,
    max_rows: usize,
) -> usize {
    let filtered = open.filtered_indices();
    let selected = open.selected_entry_index().unwrap_or(open.selected);
    let selected_pos = filtered
        .iter()
        .position(|idx| *idx == selected)
        .unwrap_or(0);
    selected_pos.saturating_sub(max_rows.saturating_sub(1))
}

pub(crate) fn open_existing_worktree_button_rects(inner: Rect) -> (Rect, Rect) {
    let rects = action_button_row_rects(
        inner,
        &[
            ActionButtonSpec {
                hint: Some("↵"),
                label: "open",
            },
            ActionButtonSpec {
                hint: Some("esc"),
                label: "cancel",
            },
        ],
        2,
        inner.height.saturating_sub(1),
    );
    (rects[0], rects[1])
}

pub(super) fn render_new_linked_worktree_overlay(app: &AppState, frame: &mut Frame, area: Rect) {
    let Some(create) = app.worktree_create.as_ref() else {
        return;
    };

    super::dim_background(frame, area);
    let Some(inner) = render_modal_shell(
        frame,
        area,
        NEW_LINKED_WORKTREE_POPUP_WIDTH,
        NEW_LINKED_WORKTREE_POPUP_HEIGHT,
        &app.palette,
    ) else {
        return;
    };
    if inner.height < 9 {
        return;
    }

    let rows = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(3),
        Constraint::Length(1),
        Constraint::Min(0),
    ])
    .areas::<8>(inner);

    render_modal_header(frame, rows[0], "new worktree", &app.palette);

    frame.render_widget(
        Paragraph::new(" branch").style(Style::default().fg(app.palette.overlay0)),
        rows[1],
    );
    let input_rect = Rect::new(rows[2].x, rows[2].y, rows[2].width, 1);
    frame.render_widget(Clear, input_rect);
    frame.render_widget(
        Paragraph::new(format!(" {}█", app.name_input)).style(
            Style::default()
                .fg(app.palette.text)
                .bg(app.palette.surface0),
        ),
        input_rect,
    );

    let checkout = create.checkout_path.display().to_string();
    frame.render_widget(
        Paragraph::new(" checkout").style(Style::default().fg(app.palette.overlay0)),
        rows[3],
    );
    frame.render_widget(
        Paragraph::new(format!(" {checkout}")).style(Style::default().fg(app.palette.subtext0)),
        rows[4],
    );

    if create.creating {
        frame.render_widget(
            Paragraph::new(" creating…").style(Style::default().fg(app.palette.overlay0)),
            rows[5],
        );
    } else if let Some(error) = &create.error {
        frame.render_widget(
            Paragraph::new(format!(" {error}"))
                .style(Style::default().fg(app.palette.red))
                .wrap(Wrap { trim: false }),
            rows[5],
        );
    }

    let (create_rect, cancel_rect) = new_linked_worktree_button_rects(inner);
    render_action_button(
        frame,
        create_rect,
        Some("↵"),
        "create and open",
        Style::default()
            .fg(panel_contrast_fg(&app.palette))
            .bg(app.palette.accent)
            .add_modifier(Modifier::BOLD),
    );
    render_action_button(
        frame,
        cancel_rect,
        Some("esc"),
        "cancel",
        Style::default()
            .fg(app.palette.text)
            .bg(app.palette.surface0)
            .add_modifier(Modifier::BOLD),
    );
}

pub(super) fn render_remove_worktree_overlay(app: &AppState, frame: &mut Frame, area: Rect) {
    let Some(remove) = app.worktree_remove.as_ref() else {
        return;
    };

    super::dim_background(frame, area);
    let Some(popup) = remove_worktree_popup_rect(area) else {
        return;
    };
    let Some(inner) = render_panel_shell(frame, popup, app.palette.red, app.palette.panel_bg)
    else {
        return;
    };

    let rows = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(0),
    ])
    .areas::<8>(inner);

    frame.render_widget(
        Paragraph::new(Line::from(vec![Span::styled(
            " delete worktree checkout?",
            Style::default()
                .fg(app.palette.red)
                .add_modifier(Modifier::BOLD),
        )])),
        rows[0],
    );
    frame.render_widget(
        Paragraph::new(" This removes the checkout folder:")
            .style(Style::default().fg(app.palette.overlay0)),
        rows[1],
    );
    frame.render_widget(
        Paragraph::new(format!(" {}", remove.path.display()))
            .style(Style::default().fg(app.palette.text)),
        rows[2],
    );
    frame.render_widget(
        Paragraph::new(" The branch is not deleted. The Herdr workspace will close.")
            .style(Style::default().fg(app.palette.overlay0)),
        rows[3],
    );
    if remove.force_confirmation {
        frame.render_widget(
            Paragraph::new(" Dirty or untracked files will be permanently deleted.")
                .style(Style::default().fg(app.palette.red)),
            rows[4],
        );
    }
    if remove.removing {
        frame.render_widget(
            Paragraph::new(" removing…").style(Style::default().fg(app.palette.overlay0)),
            rows[5],
        );
    } else if let Some(error) = &remove.error {
        frame.render_widget(
            Paragraph::new(format!(" {error}")).style(Style::default().fg(app.palette.red)),
            rows[5],
        );
    }

    let (remove_rect, cancel_rect) = remove_worktree_button_rects(inner, remove.force_confirmation);
    let remove_label = if remove.force_confirmation {
        "delete anyway"
    } else {
        "remove"
    };
    render_action_button(
        frame,
        remove_rect,
        Some("↵"),
        remove_label,
        Style::default()
            .fg(panel_contrast_fg(&app.palette))
            .bg(app.palette.red)
            .add_modifier(Modifier::BOLD),
    );
    render_action_button(
        frame,
        cancel_rect,
        Some("esc"),
        "cancel",
        Style::default()
            .fg(app.palette.text)
            .bg(app.palette.surface0)
            .add_modifier(Modifier::BOLD),
    );
}

pub(super) fn render_open_existing_worktree_overlay(app: &AppState, frame: &mut Frame, area: Rect) {
    let Some(open) = app.worktree_open.as_ref() else {
        return;
    };

    super::dim_background(frame, area);
    let height = (open.entries.len() as u16)
        .saturating_mul(2)
        .saturating_add(7)
        .clamp(12, 26);
    let Some(inner) = render_modal_shell(frame, area, 96, height, &app.palette) else {
        return;
    };
    if inner.height < 8 {
        return;
    }

    render_modal_header(
        frame,
        Rect::new(inner.x, inner.y, inner.width, 1),
        "open worktree",
        &app.palette,
    );
    render_open_worktree_search(
        app,
        frame,
        Rect::new(inner.x, inner.y + 1, inner.width, 1),
        open,
    );
    frame.render_widget(
        Paragraph::new("─".repeat(inner.width as usize))
            .style(Style::default().fg(app.palette.surface1)),
        Rect::new(inner.x, inner.y.saturating_add(2), inner.width, 1),
    );

    let filtered = open.filtered_indices();
    let max_rows = open_existing_worktree_max_visible_rows(inner);
    let start = open_existing_worktree_visible_start(open, max_rows);
    for (visible_idx, entry_idx) in filtered.iter().skip(start).take(max_rows).enumerate() {
        let Some(entry) = open.entries.get(*entry_idx) else {
            continue;
        };
        let selected = Some(*entry_idx) == open.selected_entry_index();
        let y = inner.y.saturating_add(3 + (visible_idx as u16 * 2));
        let marker = if selected { "›" } else { " " };
        let row_style = if selected {
            Style::default()
                .fg(app.palette.text)
                .bg(app.palette.surface0)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(app.palette.subtext0)
        };
        let path_style = if selected {
            Style::default()
                .fg(app.palette.subtext0)
                .bg(app.palette.surface0)
        } else {
            Style::default().fg(app.palette.overlay0)
        };
        let status = entry.status_label();
        let title_width = inner
            .width
            .saturating_sub(display_width_u16(status))
            .saturating_sub(4) as usize;
        let mut title = format!(
            "{marker} {}",
            truncate_end(&entry.display_name(), title_width)
        );
        if !status.is_empty() {
            let pad = inner
                .width
                .saturating_sub(display_width_u16(&title))
                .saturating_sub(display_width_u16(status))
                .max(1);
            title.push_str(&" ".repeat(pad as usize));
            title.push_str(status);
        }
        frame.render_widget(
            Paragraph::new(truncate_end(&title, inner.width as usize)).style(row_style),
            Rect::new(inner.x, y, inner.width, 1),
        );
        frame.render_widget(
            Paragraph::new(truncate_end(
                &format!("  {}", entry.path.display()),
                inner.width as usize,
            ))
            .style(path_style),
            Rect::new(inner.x, y.saturating_add(1), inner.width, 1),
        );
    }

    if filtered.is_empty() {
        frame.render_widget(
            Paragraph::new(" no matching worktrees")
                .style(Style::default().fg(app.palette.overlay0)),
            Rect::new(inner.x, inner.y.saturating_add(3), inner.width, 1),
        );
    }

    if let Some(error) = &open.error {
        frame.render_widget(
            Paragraph::new(format!(" {error}")).style(Style::default().fg(app.palette.red)),
            Rect::new(
                inner.x,
                inner.y + inner.height.saturating_sub(2),
                inner.width,
                1,
            ),
        );
    }

    let (open_rect, cancel_rect) = open_existing_worktree_button_rects(inner);
    render_action_button(
        frame,
        open_rect,
        Some("↵"),
        "open",
        Style::default()
            .fg(panel_contrast_fg(&app.palette))
            .bg(app.palette.accent)
            .add_modifier(Modifier::BOLD),
    );
    render_action_button(
        frame,
        cancel_rect,
        Some("esc"),
        "cancel",
        Style::default()
            .fg(app.palette.text)
            .bg(app.palette.surface0)
            .add_modifier(Modifier::BOLD),
    );
}

fn render_open_worktree_search(
    app: &AppState,
    frame: &mut Frame,
    area: Rect,
    open: &WorktreeOpenState,
) {
    let focus_style = if open.search_focused {
        Style::default()
            .fg(app.palette.accent)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(app.palette.overlay0)
    };
    let filtered_count = open.filtered_indices().len();
    let count = if open.query.trim().is_empty() {
        format!("{} checkouts", open.entries.len())
    } else {
        format!("{filtered_count}/{} checkouts", open.entries.len())
    };
    let mut spans = vec![Span::styled(" / ", focus_style)];
    if open.query.trim().is_empty() {
        spans.push(Span::styled(
            "filter worktrees",
            Style::default().fg(app.palette.overlay0),
        ));
    } else {
        spans.push(Span::styled(
            open.query.clone(),
            Style::default().fg(app.palette.text),
        ));
    }
    spans.push(Span::styled(
        format!(
            "{count:>width$}",
            width = area.width.saturating_sub(18) as usize
        ),
        Style::default().fg(app.palette.overlay0),
    ));
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn confirm_close_overlay_text(
    app: &AppState,
    terminal_runtimes: &TerminalRuntimeRegistry,
) -> (String, String) {
    let ws_name = app
        .workspaces
        .get(app.selected)
        .map(|ws| ws.display_name_from(&app.terminals, terminal_runtimes))
        .unwrap_or_else(|| "?".to_string());
    let selected_space = app
        .workspaces
        .get(app.selected)
        .and_then(|ws| ws.worktree_space());
    let group_member_indices = selected_space
        .filter(|space| !space.is_linked_worktree)
        .map(|space| {
            app.workspaces
                .iter()
                .enumerate()
                .filter_map(|(idx, ws)| {
                    ws.worktree_space()
                        .is_some_and(|member| member.key == space.key)
                        .then_some(idx)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let closes_group = group_member_indices.len() > 1;
    let pane_count = if closes_group {
        group_member_indices
            .iter()
            .filter_map(|idx| app.workspaces.get(*idx))
            .map(|ws| ws.layout.pane_count())
            .sum()
    } else {
        app.workspaces
            .get(app.selected)
            .map(|ws| ws.layout.pane_count())
            .unwrap_or(0)
    };

    let pane_text = if pane_count == 1 {
        "1 pane".to_string()
    } else {
        format!("{pane_count} panes")
    };
    let workspace_text = if closes_group {
        let count = group_member_indices.len();
        if count == 1 {
            "1 workspace, ".to_string()
        } else {
            format!("{count} workspaces, ")
        }
    } else {
        String::new()
    };

    let title = if closes_group {
        "Close worktree group?"
    } else {
        "Close workspace?"
    };
    let detail = format!("{ws_name} — {workspace_text}{pane_text}");
    (title.to_string(), detail)
}

pub(super) fn render_confirm_close_overlay(
    app: &AppState,
    terminal_runtimes: &TerminalRuntimeRegistry,
    frame: &mut Frame,
    area: Rect,
) {
    let (title, detail) = confirm_close_overlay_text(app, terminal_runtimes);

    super::dim_background(frame, area);

    let Some(popup) = confirm_close_popup_rect(area) else {
        return;
    };

    let warn = Style::default()
        .fg(app.palette.red)
        .add_modifier(Modifier::BOLD);
    let dim = Style::default().fg(app.palette.overlay0);

    let title_line = Line::from(vec![Span::styled(format!(" {title}"), warn)]);

    let detail_line = Line::from(vec![
        Span::styled(
            format!(" {}", detail.split(" — ").next().unwrap_or(&detail)),
            Style::default()
                .fg(app.palette.text)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            detail
                .split_once(" — ")
                .map(|(_, rest)| format!(" — {rest}"))
                .unwrap_or_default(),
            dim,
        ),
    ]);

    let Some(inner) = render_panel_shell(frame, popup, app.palette.red, app.palette.panel_bg)
    else {
        return;
    };

    if inner.height >= 3 {
        let rows = Layout::vertical([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .areas::<4>(inner);

        frame.render_widget(Paragraph::new(title_line), rows[0]);
        frame.render_widget(Paragraph::new(detail_line), rows[1]);

        let (confirm_rect, cancel_rect) = confirm_close_button_rects(inner);
        render_action_button(
            frame,
            confirm_rect,
            Some("↵"),
            "confirm",
            Style::default()
                .fg(panel_contrast_fg(&app.palette))
                .bg(app.palette.red)
                .add_modifier(Modifier::BOLD),
        );
        render_action_button(
            frame,
            cancel_rect,
            Some("esc"),
            "cancel",
            Style::default()
                .fg(app.palette.text)
                .bg(app.palette.surface0)
                .add_modifier(Modifier::BOLD),
        );
    }
}

pub(crate) fn confirm_close_popup_rect(area: Rect) -> Option<Rect> {
    centered_popup_rect(area, 64, 6)
}

pub(crate) fn confirm_close_button_rects(inner: Rect) -> (Rect, Rect) {
    let rects = action_button_row_rects(
        inner,
        &[
            ActionButtonSpec {
                hint: Some("↵"),
                label: "confirm",
            },
            ActionButtonSpec {
                hint: Some("esc"),
                label: "cancel",
            },
        ],
        2,
        3,
    );
    (rects[0], rects[1])
}

// item 1 (Area 3 / Decision 3): single-source-of-truth geometry for the two composited client
// modals. Both render and `ClientCompositor::hit_test` derive every row/button rect from these
// helpers, so render geometry == hit-test geometry.

/// The outer popup rect for the add-remote overlay — footer-anchored (bottom-left of `area`,
/// opening upward) so it floats over the live content like the global launcher menu. Used by BOTH
/// the renderer and the compositor's content-copy exclusion / hit-test.
pub(crate) fn add_remote_popup_rect(area: Rect) -> Option<Rect> {
    // C1: 10 (was 9) — one more row for the optional `session` field.
    bottom_left_popup_rect(area, 54, 10)
}

/// Fixed inner rect for the add-remote overlay. Returns `None` when the host is too small to fit
/// the overlay, in which case render and hit-test both no-op.
///
/// Test-only oracle: production render/hit-test reads this rect from the view (#53), so the helper
/// is only referenced by unit tests asserting the two geometries agree.
#[cfg(test)]
pub(crate) fn add_remote_inner_rect(area: Rect) -> Option<Rect> {
    add_remote_popup_rect(area).map(|popup| {
        Rect::new(
            popup.x + 1,
            popup.y + 1,
            popup.width.saturating_sub(2),
            popup.height.saturating_sub(2),
        )
    })
}

pub(crate) fn add_remote_button_rects(inner: Rect) -> (Rect, Rect) {
    let rects = action_button_row_rects(
        inner,
        &[
            ActionButtonSpec {
                hint: Some("↵"),
                label: "add",
            },
            ActionButtonSpec {
                hint: Some("esc"),
                label: "cancel",
            },
        ],
        2,
        inner.height.saturating_sub(1),
    );
    (rects[0], rects[1])
}

/// The picker popup height for `count` destinations, derived from the row budget (header, the
/// create-on label, one row per destination, the actions row, and vertical margins) and clamped to
/// a sane band. Used by BOTH the inner-rect helper and the renderer so they cannot diverge.
fn picker_popup_height(count: usize) -> u16 {
    (count as u16).saturating_add(5).clamp(7, 18)
}

/// The outer popup rect for the new-workspace picker — footer-anchored (bottom-left of `area`,
/// opening upward) so it floats over the live content like the global launcher menu. Used by BOTH
/// the renderer and the compositor's content-copy exclusion / hit-test.
pub(crate) fn new_workspace_picker_popup_rect(area: Rect, count: usize) -> Option<Rect> {
    bottom_left_popup_rect(area, 44, picker_popup_height(count))
}

/// Shared inner rect for the new-workspace picker overlay. The popup height is derived from the
/// destination `count` exactly the way `render_new_workspace_picker_overlay` sizes it, mirroring
/// `open_existing_worktree_inner_rect`.
///
/// Test-only oracle (see `add_remote_inner_rect`): production reads this rect from the view (#53).
#[cfg(test)]
pub(crate) fn new_workspace_picker_inner_rect(area: Rect, count: usize) -> Option<Rect> {
    new_workspace_picker_popup_rect(area, count).map(|popup| {
        Rect::new(
            popup.x + 1,
            popup.y + 1,
            popup.width.saturating_sub(2),
            popup.height.saturating_sub(2),
        )
    })
}

/// The rect for destination row `row_index` inside the picker's inner rect. Rows start two lines
/// below the inner top (header + create-on label). Used by BOTH render and hit-test.
pub(crate) fn new_workspace_picker_row_rect(inner: Rect, row_index: usize) -> Rect {
    let y = inner.y.saturating_add(2 + row_index as u16);
    Rect::new(inner.x, y, inner.width, 1)
}

pub(crate) fn new_workspace_picker_button_rects(inner: Rect) -> (Rect, Rect) {
    let rects = action_button_row_rects(
        inner,
        &[
            ActionButtonSpec {
                hint: Some("↵"),
                label: "create",
            },
            ActionButtonSpec {
                hint: Some("esc"),
                label: "cancel",
            },
        ],
        2,
        inner.height.saturating_sub(1),
    );
    (rects[0], rects[1])
}

/// item 1 (Area 3 / Decision 1): render the add-remote form as a centered ratatui modal, visually
/// matching `render_rename_overlay` (accent border, bold header, focused-field fill + cursor block,
/// red inline error, centered action buttons). Cursor stays hidden — the caller forces
/// `frame.cursor = None` while a modal is open.
pub(crate) fn render_add_remote_overlay(
    palette: &Palette,
    view: &AddRemoteOverlayView,
    frame: &mut Frame,
    popup: Rect,
) {
    // #47: the caller passes the (drag-shifted) popup rect directly.
    let Some(inner) = render_panel_shell(frame, popup, palette.accent, palette.panel_bg) else {
        return;
    };
    if inner.height < 6 {
        return;
    }

    let rows = Layout::vertical([
        Constraint::Length(1), // header
        Constraint::Length(1), // target label/input
        Constraint::Length(1), // name label/input
        Constraint::Length(1), // C1: session label/input (optional)
        Constraint::Length(1), // gap
        Constraint::Length(1), // error
        Constraint::Min(0),    // actions live on inner.height - 1
    ])
    .areas::<7>(inner);

    render_modal_header(frame, rows[0], "add remote", palette);

    // The label column stays aligned across all three rows: `render_add_remote_field` pads with two
    // trailing spaces, so the labels are passed pre-padded to a common width.
    render_add_remote_field(
        frame,
        rows[1],
        "target ",
        view.target,
        view.focused_field == AddRemoteFieldView::Target,
        palette,
    );
    render_add_remote_field(
        frame,
        rows[2],
        "name   ",
        view.name,
        view.focused_field == AddRemoteFieldView::Name,
        palette,
    );
    render_add_remote_field(
        frame,
        rows[3],
        "session",
        view.session,
        view.focused_field == AddRemoteFieldView::Session,
        palette,
    );

    if view.in_progress {
        let stage = view.progress.unwrap_or("connecting to remote…");
        frame.render_widget(
            Paragraph::new(format!(" {} {stage}", view.spinner))
                .style(Style::default().fg(palette.accent)),
            rows[5],
        );
    } else if let Some(error) = view.error {
        frame.render_widget(
            Paragraph::new(format!(" {error}")).style(Style::default().fg(palette.red)),
            rows[5],
        );
    }

    let (submit_rect, cancel_rect) = add_remote_button_rects(inner);
    render_action_button(
        frame,
        submit_rect,
        Some("↵"),
        "add",
        Style::default()
            .fg(panel_contrast_fg(palette))
            .bg(palette.accent)
            .add_modifier(Modifier::BOLD),
    );
    render_action_button(
        frame,
        cancel_rect,
        Some("esc"),
        "cancel",
        Style::default()
            .fg(palette.text)
            .bg(palette.surface0)
            .add_modifier(Modifier::BOLD),
    );
}

fn render_add_remote_field(
    frame: &mut Frame,
    row: Rect,
    label: &str,
    value: &str,
    focused: bool,
    palette: &Palette,
) {
    if focused {
        frame.render_widget(Clear, row);
        let line = Line::from(vec![
            Span::styled(
                format!(" {label}  "),
                Style::default().fg(palette.overlay0).bg(palette.surface0),
            ),
            Span::styled(
                format!("{value}█"),
                Style::default().fg(palette.text).bg(palette.surface0),
            ),
        ]);
        frame.render_widget(
            Paragraph::new(line).style(Style::default().bg(palette.surface0)),
            row,
        );
    } else {
        let line = Line::from(vec![
            Span::styled(format!(" {label}  "), Style::default().fg(palette.overlay0)),
            Span::styled(value.to_string(), Style::default().fg(palette.subtext0)),
        ]);
        frame.render_widget(Paragraph::new(line), row);
    }
}

/// item 1 (Area 3 / Decision 1+3): render the new-workspace destination picker as a centered
/// ratatui modal with a selectable list (the `surface0`-filled `›`-marked selected row from the
/// `render_open_existing_worktree_overlay` pattern), a `create on` sub-label, and centered
/// create/cancel buttons. Geometry comes from `new_workspace_picker_inner_rect`/`_row_rect` so it
/// matches `hit_test`.
pub(crate) fn render_new_workspace_picker_overlay(
    palette: &Palette,
    destinations: &[DestinationView],
    selected: usize,
    hovered_row: Option<usize>,
    frame: &mut Frame,
    popup: Rect,
) {
    // #47: the caller passes the (drag-shifted) popup rect directly; inner is its bordered inset, so
    // render geometry == hit-test geometry (both derive from the same popup).
    let Some(inner) = render_panel_shell(frame, popup, palette.accent, palette.panel_bg) else {
        return;
    };
    if inner.height < 4 {
        return;
    }

    render_modal_header(
        frame,
        Rect::new(inner.x, inner.y, inner.width, 1),
        "new workspace",
        palette,
    );
    frame.render_widget(
        Paragraph::new(" create on").style(Style::default().fg(palette.overlay0)),
        Rect::new(inner.x, inner.y.saturating_add(1), inner.width, 1),
    );

    // defensive clamp on the render-time read (per PRD risk: selection out of range).
    let selected = selected.min(destinations.len().saturating_sub(1));
    // rows live between the create-on label and the actions row (inner.height - 1).
    let max_rows = inner.height.saturating_sub(3) as usize;
    for (row_index, destination) in destinations.iter().enumerate().take(max_rows) {
        let is_selected = row_index == selected;
        // item 7 (Area 4): a hovered, non-selected row gets a subtle theme-derived bg lift
        // (selection always wins; hover never bolds).
        let is_hovered = !is_selected && hovered_row == Some(row_index);
        let marker = if is_selected { "›" } else { " " };
        let label = format!("{marker} {}", destination.display_name);
        let style = if is_selected {
            Style::default()
                .fg(palette.text)
                .bg(palette.surface0)
                .add_modifier(Modifier::BOLD)
        } else if is_hovered {
            Style::default().fg(palette.subtext0).bg(palette.hover_bg())
        } else {
            Style::default().fg(palette.subtext0)
        };
        let row = new_workspace_picker_row_rect(inner, row_index);
        frame.render_widget(
            Paragraph::new(truncate_end(&label, inner.width as usize)).style(style),
            row,
        );
    }

    let (confirm_rect, cancel_rect) = new_workspace_picker_button_rects(inner);
    render_action_button(
        frame,
        confirm_rect,
        Some("↵"),
        "create",
        Style::default()
            .fg(panel_contrast_fg(palette))
            .bg(palette.accent)
            .add_modifier(Modifier::BOLD),
    );
    render_action_button(
        frame,
        cancel_rect,
        Some("esc"),
        "cancel",
        Style::default()
            .fg(palette.text)
            .bg(palette.surface0)
            .add_modifier(Modifier::BOLD),
    );
}

/// The manage-overlay popup height for `count` rows, derived from the row budget (header, the
/// column-label row, one row per remote, the footer hint, and vertical margins) clamped to a sane
/// band. Used by BOTH the inner-rect helper and the renderer so they cannot diverge.
fn remote_manage_popup_height(count: usize) -> u16 {
    (count as u16).saturating_add(5).clamp(8, 20)
}

/// item 3 (Area 3/5): the outer popup rect for the management overlay — footer-anchored
/// (bottom-left of `area`, opening upward) so it floats over the live content like the global
/// launcher menu. Width 64, height derived from `count`. Used by BOTH the renderer and the
/// compositor's content-copy exclusion / hit-test.
pub(crate) fn remote_manage_popup_rect(area: Rect, count: usize) -> Option<Rect> {
    bottom_left_popup_rect(area, 64, remote_manage_popup_height(count))
}

/// item 3 (Area 3/5): the SHARED inner rect for the management overlay (render + hit-test). The
/// popup width is 64, height derived from `count` exactly the way `render_remote_manage_overlay`
/// sizes it. Returns `None` when the host is too small to fit.
///
/// Test-only oracle (see `add_remote_inner_rect`): production reads this rect from the view (#53).
#[cfg(test)]
pub(crate) fn remote_manage_inner_rect(area: Rect, count: usize) -> Option<Rect> {
    remote_manage_popup_rect(area, count).map(|popup| {
        Rect::new(
            popup.x + 1,
            popup.y + 1,
            popup.width.saturating_sub(2),
            popup.height.saturating_sub(2),
        )
    })
}

/// The rect for remote row `row_index` inside the manage overlay's inner rect. Rows start two
/// lines below the inner top (header + column-label row). Used by BOTH render and hit-test.
pub(crate) fn remote_manage_row_rect(inner: Rect, row_index: usize) -> Rect {
    let y = inner.y.saturating_add(2 + row_index as u16);
    Rect::new(inner.x, y, inner.width, 1)
}

/// The delete-confirm popup rect (centered, smaller, red panel). Used by render + hit-test.
pub(crate) fn remote_manage_confirm_popup_rect(area: Rect) -> Option<Rect> {
    centered_popup_rect(area, 56, 8)
}

/// The (delete, cancel) button rects inside the delete-confirm popup's inner rect.
pub(crate) fn remote_manage_confirm_button_rects(inner: Rect) -> (Rect, Rect) {
    let rects = action_button_row_rects(
        inner,
        &[
            ActionButtonSpec {
                hint: Some("↵"),
                label: "delete",
            },
            ActionButtonSpec {
                hint: Some("esc"),
                label: "cancel",
            },
        ],
        2,
        inner.height.saturating_sub(1),
    );
    (rects[0], rects[1])
}

/// item 3 (Area 3/5): render the remote-management overlay as a centered ratatui modal — a
/// scrollable selectable list of remotes with per-remote state, plus a footer hint. When
/// `confirm_delete.is_some()` the destructive two-step sub-state is drawn on top as a red
/// `render_panel_shell` popup with delete/cancel buttons. Geometry comes from
/// `remote_manage_inner_rect`/`_row_rect`/`_confirm_*` so it matches `hit_test`. Square corners
/// (`border::PLAIN`). The caller forces `frame.cursor = None` while the modal is open.
pub(crate) fn render_remote_manage_overlay(
    palette: &Palette,
    rows: &[RemoteManageRowView],
    selected: usize,
    scroll: usize,
    confirm_delete: Option<&str>,
    frame: &mut Frame,
    popup: Rect,
    area: Rect,
) {
    // #47: the caller passes the (drag-shifted) main-list popup directly; `area` is kept only for the
    // centered confirm-delete sub-popup, which stays centered (the drag moves the list behind it).
    let Some(inner) = render_panel_shell(frame, popup, palette.accent, palette.panel_bg) else {
        return;
    };
    if inner.height < 4 {
        return;
    }

    render_modal_header(
        frame,
        Rect::new(inner.x, inner.y, inner.width, 1),
        "manage remotes",
        palette,
    );
    frame.render_widget(
        Paragraph::new(" remote                          target              state")
            .style(Style::default().fg(palette.overlay0)),
        Rect::new(inner.x, inner.y.saturating_add(1), inner.width, 1),
    );

    // rows live between the column-label row and the footer hint row (inner.height - 1).
    let max_rows = inner.height.saturating_sub(3) as usize;
    let selected = selected.min(rows.len().saturating_sub(1));
    // clamp the visible window so the selected row stays on screen (shared scroll math).
    let start = scroll
        .min(rows.len().saturating_sub(max_rows.max(1)))
        .min(selected)
        .max(selected.saturating_sub(max_rows.max(1).saturating_sub(1)));
    for (visible_idx, (row_index, row)) in rows
        .iter()
        .enumerate()
        .skip(start)
        .take(max_rows)
        .enumerate()
    {
        let is_selected = row_index == selected;
        let marker = if is_selected { "›" } else { " " };
        let enabled_word = if row.disabled { "off" } else { "on" };
        let label = format!(
            "{marker} {} {:<24} {:<18} {}  [{}]",
            row.glyph.glyph(),
            truncate_end(row.name, 24),
            truncate_end(row.target, 18),
            row.state_word,
            enabled_word
        );
        let base = if row.disabled {
            Style::default().fg(palette.overlay0)
        } else {
            Style::default().fg(palette.subtext0)
        };
        let style = if is_selected {
            Style::default()
                .fg(palette.text)
                .bg(palette.surface0)
                .add_modifier(Modifier::BOLD)
        } else {
            base
        };
        let rect = remote_manage_row_rect(inner, visible_idx);
        frame.render_widget(
            Paragraph::new(truncate_end(&label, inner.width as usize)).style(style),
            rect,
        );
    }

    frame.render_widget(
        Paragraph::new(" space toggle   d delete   a add   esc close")
            .style(Style::default().fg(palette.overlay0)),
        Rect::new(
            inner.x,
            inner.y + inner.height.saturating_sub(1),
            inner.width,
            1,
        ),
    );

    if let Some(remote_id) = confirm_delete {
        render_remote_manage_confirm(palette, rows, selected, remote_id, frame, area);
    }
}

/// Render the destructive delete-confirm sub-state as a red panel popup over the list.
fn render_remote_manage_confirm(
    palette: &Palette,
    rows: &[RemoteManageRowView],
    selected: usize,
    _remote_id: &str,
    frame: &mut Frame,
    area: Rect,
) {
    let Some(popup) = remote_manage_confirm_popup_rect(area) else {
        return;
    };
    let Some(inner) = render_panel_shell(frame, popup, palette.red, palette.panel_bg) else {
        return;
    };
    if inner.height < 4 {
        return;
    }

    let name = rows.get(selected).map(|row| row.name).unwrap_or("remote");
    frame.render_widget(
        Paragraph::new(Line::from(vec![Span::styled(
            " delete remote?",
            Style::default()
                .fg(palette.red)
                .add_modifier(Modifier::BOLD),
        )])),
        Rect::new(inner.x, inner.y, inner.width, 1),
    );
    frame.render_widget(
        Paragraph::new(format!(" {name} will be removed from the registry."))
            .style(Style::default().fg(palette.text)),
        Rect::new(inner.x, inner.y.saturating_add(1), inner.width, 1),
    );
    frame.render_widget(
        Paragraph::new(" Active workspaces on it are not deleted.")
            .style(Style::default().fg(palette.overlay0)),
        Rect::new(inner.x, inner.y.saturating_add(2), inner.width, 1),
    );

    let (delete_rect, cancel_rect) = remote_manage_confirm_button_rects(inner);
    render_action_button(
        frame,
        delete_rect,
        Some("↵"),
        "delete",
        Style::default()
            .fg(panel_contrast_fg(palette))
            .bg(palette.red)
            .add_modifier(Modifier::BOLD),
    );
    render_action_button(
        frame,
        cancel_rect,
        Some("esc"),
        "cancel",
        Style::default()
            .fg(palette.text)
            .bg(palette.surface0)
            .add_modifier(Modifier::BOLD),
    );
}

// ----- #47: the one client menu (launcher / workspace context / host context) geometry/render ----
// Single-source-of-truth geometry, mirroring the add-remote / manage-remotes modals above. Both the
// renderer and `ClientCompositor::hit_test` derive every row rect from these helpers, so render
// geometry == hit-test geometry. `header_rows` is 1 for the launcher (title only) or 2 for the
// context menus (title + target sub-header), so the row offset and popup height track the sub-header.

/// #47: the client-menu popup height for `count` rows + `header_rows` header lines + top/bottom
/// borders, clamped to a sane band. Used by BOTH the inner-rect helper and the renderer so they
/// cannot diverge. For `header_rows == 2` this is the old `count + 4`, preserving the context-menu
/// size; for `header_rows == 1` (launcher) it is `count + 3`.
fn client_menu_popup_height(count: usize, header_rows: u16) -> u16 {
    (count as u16)
        .saturating_add(header_rows)
        .saturating_add(2)
        .clamp(6, 12)
}

/// #47: the outer popup rect for the client menu — anchor-anchored, clamped to the full screen. The
/// popup's top-left sits at the anchor cell (right-click cursor / clicked menu-button cell), shifting
/// left/up near the right/bottom edges so it stays fully visible. Used by BOTH render and hit-test so
/// their geometry stays in lockstep.
pub(crate) fn client_menu_popup_rect_at(
    anchor_col: u16,
    anchor_row: u16,
    count: usize,
    header_rows: u16,
    host_width: u16,
    host_height: u16,
) -> Option<Rect> {
    let popup_w = 34u16.min(host_width.saturating_sub(2));
    let popup_h = client_menu_popup_height(count, header_rows).min(host_height.saturating_sub(1));
    if popup_w < 4 || popup_h < 4 {
        return None;
    }
    let popup_x = anchor_col.min(host_width.saturating_sub(popup_w));
    let popup_y = anchor_row.min(host_height.saturating_sub(popup_h));
    Some(Rect::new(popup_x, popup_y, popup_w, popup_h))
}

/// #47: shared inner rect for the anchor-anchored client menu. Returns `None` when the host is too
/// small for the popup.
///
/// Test-only oracle (see `add_remote_inner_rect`): production reads this rect from the view (#53).
#[cfg(test)]
pub(crate) fn client_menu_inner_rect_at(
    anchor_col: u16,
    anchor_row: u16,
    count: usize,
    header_rows: u16,
    host_width: u16,
    host_height: u16,
) -> Option<Rect> {
    client_menu_popup_rect_at(
        anchor_col,
        anchor_row,
        count,
        header_rows,
        host_width,
        host_height,
    )
    .map(|popup| {
        Rect::new(
            popup.x + 1,
            popup.y + 1,
            popup.width.saturating_sub(2),
            popup.height.saturating_sub(2),
        )
    })
}

/// #47: the rect for menu row `row_index` inside the client menu's inner rect. Rows start
/// `header_rows` lines below the inner top (title [+ target sub-header]). Used by BOTH render and
/// hit-test.
pub(crate) fn client_menu_row_rect(inner: Rect, header_rows: u16, row_index: usize) -> Rect {
    let y = inner.y.saturating_add(header_rows + row_index as u16);
    Rect::new(inner.x, y, inner.width, 1)
}

/// The outer popup rect for the rename overlay — footer-anchored, like add-remote.
pub(crate) fn rename_workspace_popup_rect(area: Rect) -> Option<Rect> {
    bottom_left_popup_rect(area, 48, 7)
}

/// The (save, cancel) button rects inside the rename overlay's inner rect. Mirrors
/// `add_remote_button_rects`.
pub(crate) fn rename_workspace_button_rects(inner: Rect) -> (Rect, Rect) {
    let rects = action_button_row_rects(
        inner,
        &[
            ActionButtonSpec {
                hint: Some("↵"),
                label: "save",
            },
            ActionButtonSpec {
                hint: Some("esc"),
                label: "cancel",
            },
        ],
        2,
        inner.height.saturating_sub(1),
    );
    (rects[0], rects[1])
}

/// The close-confirm popup rect (centered red panel), mirroring `remote_manage_confirm_popup_rect`.
pub(crate) fn confirm_close_workspace_popup_rect(area: Rect) -> Option<Rect> {
    centered_popup_rect(area, 48, 6)
}

/// The (close, cancel) button rects inside the close-confirm popup's inner rect.
pub(crate) fn confirm_close_workspace_button_rects(inner: Rect) -> (Rect, Rect) {
    let rects = action_button_row_rects(
        inner,
        &[
            ActionButtonSpec {
                hint: Some("↵"),
                label: "close",
            },
            ActionButtonSpec {
                hint: Some("esc"),
                label: "cancel",
            },
        ],
        2,
        inner.height.saturating_sub(1),
    );
    (rects[0], rects[1])
}

/// Worktree-menu parity: the outer popup rect for the new-worktree branch input — footer-anchored,
/// like the rename overlay it mirrors.
pub(crate) fn new_worktree_popup_rect(area: Rect) -> Option<Rect> {
    bottom_left_popup_rect(area, 48, 7)
}

/// Worktree-menu parity: render the new-worktree branch input. Mirrors
/// `render_rename_workspace_overlay` (one focused text field + create/cancel hints).
pub(crate) fn render_new_worktree_overlay(
    palette: &Palette,
    branch: &str,
    error: Option<&str>,
    frame: &mut Frame,
    popup: Rect,
) {
    let Some(inner) = render_panel_shell(frame, popup, palette.accent, palette.panel_bg) else {
        return;
    };
    if inner.height < 4 {
        return;
    }

    let rows = Layout::vertical([
        Constraint::Length(1), // header
        Constraint::Length(1), // input
        Constraint::Length(1), // error
        Constraint::Min(0),    // actions live on inner.height - 1
    ])
    .areas::<4>(inner);

    render_modal_header(frame, rows[0], "new worktree", palette);
    render_add_remote_field(frame, rows[1], "branch", branch, true, palette);

    if let Some(error) = error {
        frame.render_widget(
            Paragraph::new(format!(" {error}")).style(Style::default().fg(palette.red)),
            rows[2],
        );
    }

    let (create_rect, cancel_rect) = rename_workspace_button_rects(inner);
    render_action_button(
        frame,
        create_rect,
        Some("↵"),
        "create",
        Style::default()
            .fg(panel_contrast_fg(palette))
            .bg(palette.accent)
            .add_modifier(Modifier::BOLD),
    );
    render_action_button(
        frame,
        cancel_rect,
        Some("esc"),
        "cancel",
        Style::default()
            .fg(palette.text)
            .bg(palette.surface0)
            .add_modifier(Modifier::BOLD),
    );
}

/// Worktree-menu parity: the delete-worktree confirm popup rect (centered red panel).
pub(crate) fn confirm_delete_worktree_popup_rect(area: Rect) -> Option<Rect> {
    centered_popup_rect(area, 56, 7)
}

/// Worktree-menu parity: render the delete-worktree confirmation. Mirrors
/// `render_confirm_close_workspace_overlay`, with the extra "deletes the checkout" warning line.
pub(crate) fn render_confirm_delete_worktree_overlay(
    palette: &Palette,
    label: &str,
    frame: &mut Frame,
    popup: Rect,
) {
    let Some(inner) = render_panel_shell(frame, popup, palette.red, palette.panel_bg) else {
        return;
    };
    if inner.height < 4 {
        return;
    }

    frame.render_widget(
        Paragraph::new(Line::from(vec![Span::styled(
            " delete worktree checkout?",
            Style::default()
                .fg(palette.red)
                .add_modifier(Modifier::BOLD),
        )])),
        Rect::new(inner.x, inner.y, inner.width, 1),
    );
    frame.render_widget(
        Paragraph::new(format!(
            " Delete {}? Closes the space and removes its checkout.",
            truncate_end(label, inner.width.saturating_sub(48) as usize)
        ))
        .style(Style::default().fg(palette.text)),
        Rect::new(inner.x, inner.y.saturating_add(1), inner.width, 1),
    );

    let (delete_rect, cancel_rect) = confirm_close_workspace_button_rects(inner);
    render_action_button(
        frame,
        delete_rect,
        Some("↵"),
        "delete",
        Style::default()
            .fg(panel_contrast_fg(palette))
            .bg(palette.red)
            .add_modifier(Modifier::BOLD),
    );
    render_action_button(
        frame,
        cancel_rect,
        Some("esc"),
        "cancel",
        Style::default()
            .fg(palette.text)
            .bg(palette.surface0)
            .add_modifier(Modifier::BOLD),
    );
}

/// Worktree-menu parity: one ui-owned row of the "open worktree…" picker.
pub(crate) struct WorktreePickerRowView<'a> {
    pub label: &'a str,
    pub path: &'a str,
    /// Already open as a space (selecting it re-focuses instead of re-opening).
    pub open: bool,
}

/// Worktree-menu parity: the picker popup rect — footer-anchored like the manage overlay, sized
/// to the row count (header + rows + status, clamped by `bottom_left_popup_rect`).
pub(crate) fn worktree_picker_popup_rect(area: Rect, count: usize) -> Option<Rect> {
    let height = (count.max(1) as u16).saturating_add(4).min(14);
    bottom_left_popup_rect(area, 64, height)
}

/// Worktree-menu parity: render the "open worktree…" picker — a header, then one row per existing
/// checkout (selected row highlighted), or a loading/error status line. Keyboard-driven
/// (↑/↓ select, ↵ open, esc cancel).
pub(crate) fn render_worktree_picker_overlay(
    palette: &Palette,
    loading: bool,
    error: Option<&str>,
    rows: &[WorktreePickerRowView<'_>],
    selected: usize,
    frame: &mut Frame,
    popup: Rect,
) {
    let Some(inner) = render_panel_shell(frame, popup, palette.accent, palette.panel_bg) else {
        return;
    };
    if inner.height < 2 {
        return;
    }

    render_modal_header(
        frame,
        Rect::new(inner.x, inner.y, inner.width, 1),
        "open worktree",
        palette,
    );

    let body_y = inner.y.saturating_add(1);
    let body_height = inner.height.saturating_sub(2) as usize;
    if loading {
        frame.render_widget(
            Paragraph::new(" loading worktrees…").style(Style::default().fg(palette.overlay0)),
            Rect::new(inner.x, body_y, inner.width, 1),
        );
    } else if let Some(error) = error {
        frame.render_widget(
            Paragraph::new(format!(" {error}")).style(Style::default().fg(palette.red)),
            Rect::new(inner.x, body_y, inner.width, 1),
        );
    } else {
        // Keep the selected row visible: scroll the window so `selected` is always inside it.
        let scroll = selected.saturating_sub(body_height.saturating_sub(1));
        for (row_idx, row) in rows.iter().enumerate().skip(scroll).take(body_height) {
            let y = body_y + (row_idx - scroll) as u16;
            let is_selected = row_idx == selected;
            let marker = if is_selected { "▸" } else { " " };
            let open_suffix = if row.open { "  (open)" } else { "" };
            let text = format!(" {marker} {}{open_suffix}  {}", row.label, row.path);
            let style = if is_selected {
                Style::default()
                    .fg(panel_contrast_fg(palette))
                    .bg(palette.accent)
            } else if row.open {
                Style::default().fg(palette.overlay0)
            } else {
                Style::default().fg(palette.text)
            };
            frame.render_widget(
                Paragraph::new(truncate_end(&text, inner.width as usize)).style(style),
                Rect::new(inner.x, y, inner.width, 1),
            );
        }
    }

    frame.render_widget(
        Paragraph::new(" ↵ open   esc cancel").style(Style::default().fg(palette.overlay0)),
        Rect::new(
            inner.x,
            inner.y + inner.height.saturating_sub(1),
            inner.width,
            1,
        ),
    );
}

/// C4/C5: one ui-owned row of the session picker. The trailing `new session…` row is NOT one of
/// these — the renderer appends it, so it survives the loading and error states (C6).
pub(crate) struct SessionPickerRowView<'a> {
    pub label: &'a str,
    /// A session with a live server on the remote host.
    pub running: bool,
    /// The session this host is attached to right now (marked with a leading `●`).
    pub is_current: bool,
}

/// C4: the picker popup rect — footer-anchored like the worktree picker it mirrors, sized to
/// `row_count` (which ALREADY includes the trailing `new session…` row).
pub(crate) fn session_picker_popup_rect(area: Rect, row_count: usize) -> Option<Rect> {
    let height = (row_count.max(1) as u16).saturating_add(4).min(14);
    bottom_left_popup_rect(area, 48, height)
}

/// C5: the rect of picker row `index` inside `inner`. ONE helper for render and hit-test, so a
/// click lands on the row it is painted on. `None` once the row scrolls past the body.
pub(crate) fn session_picker_row_rect(inner: Rect, index: usize) -> Option<Rect> {
    let body_height = inner.height.saturating_sub(2);
    if index >= body_height as usize {
        return None;
    }
    Some(Rect::new(
        inner.x,
        inner.y.saturating_add(1 + index as u16),
        inner.width,
        1,
    ))
}

/// C4/C5/C6: render the session picker — a header, the remote's sessions (current one marked `●`,
/// running ones flagged), then ALWAYS a trailing `new session…` row. The trailing row is drawn even
/// while `loading` or on `error`, which is what keeps C6 reachable when a remote's server is too old
/// to answer `session.list`. `selected` indexes rows INCLUDING that trailing row.
pub(crate) fn render_session_picker_overlay(
    palette: &Palette,
    loading: bool,
    error: Option<&str>,
    rows: &[SessionPickerRowView<'_>],
    selected: usize,
    frame: &mut Frame,
    popup: Rect,
) {
    let Some(inner) = render_panel_shell(frame, popup, palette.accent, palette.panel_bg) else {
        return;
    };
    if inner.height < 2 {
        return;
    }

    render_modal_header(
        frame,
        Rect::new(inner.x, inner.y, inner.width, 1),
        "session",
        palette,
    );

    let selected_style = Style::default()
        .fg(panel_contrast_fg(palette))
        .bg(palette.accent);
    let new_session_index = rows.len();
    for index in 0..=new_session_index {
        let Some(row_rect) = session_picker_row_rect(inner, index) else {
            break;
        };
        let is_selected = index == selected;
        let text = match rows.get(index) {
            Some(row) => {
                let marker = if row.is_current { "●" } else { " " };
                let running = if row.running { "  (running)" } else { "" };
                format!(" {marker} {}{running}", row.label)
            }
            // The always-present trailing row (C6).
            None => " + new session…".to_string(),
        };
        let style = if is_selected {
            selected_style
        } else if rows.get(index).is_some_and(|row| row.is_current) {
            Style::default()
                .fg(palette.text)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(palette.text)
        };
        frame.render_widget(
            Paragraph::new(truncate_end(&text, inner.width as usize)).style(style),
            row_rect,
        );
    }

    // The status line doubles as the key hint, so a loading/failed list still explains what the
    // trailing row does.
    let status = if loading {
        " loading sessions…".to_string()
    } else if let Some(error) = error {
        format!(" {error}")
    } else {
        " ↵ switch   esc cancel".to_string()
    };
    let status_style = if !loading && error.is_some() {
        Style::default().fg(palette.red)
    } else {
        Style::default().fg(palette.overlay0)
    };
    frame.render_widget(
        Paragraph::new(truncate_end(&status, inner.width as usize)).style(status_style),
        Rect::new(
            inner.x,
            inner.y + inner.height.saturating_sub(1),
            inner.width,
            1,
        ),
    );
}

/// C6: the new-session input popup rect — footer-anchored, mirroring the rename overlay.
pub(crate) fn new_session_popup_rect(area: Rect) -> Option<Rect> {
    bottom_left_popup_rect(area, 48, 7)
}

/// C6: the (switch, cancel) button rects inside the new-session popup's inner rect. Mirrors
/// `rename_workspace_button_rects`.
pub(crate) fn new_session_button_rects(inner: Rect) -> (Rect, Rect) {
    let rects = action_button_row_rects(
        inner,
        &[
            ActionButtonSpec {
                hint: Some("↵"),
                label: "switch",
            },
            ActionButtonSpec {
                hint: Some("esc"),
                label: "cancel",
            },
        ],
        2,
        inner.height.saturating_sub(1),
    );
    (rects[0], rects[1])
}

/// C6: render the new-session text input. Mirrors `render_rename_workspace_overlay` (one focused
/// field + an inline red error + switch/cancel buttons). An empty submit means the default session,
/// which the hint line spells out.
pub(crate) fn render_new_session_overlay(
    palette: &Palette,
    name: &str,
    error: Option<&str>,
    // True while `remote.set_session` is in flight — the overlay stays open across the round-trip
    // so a rejection can replace this line with the reason.
    in_flight: bool,
    frame: &mut Frame,
    popup: Rect,
) {
    let Some(inner) = render_panel_shell(frame, popup, palette.accent, palette.panel_bg) else {
        return;
    };
    if inner.height < 4 {
        return;
    }

    let rows = Layout::vertical([
        Constraint::Length(1), // header
        Constraint::Length(1), // input
        Constraint::Length(1), // error / hint
        Constraint::Min(0),    // actions live on inner.height - 1
    ])
    .areas::<4>(inner);

    render_modal_header(frame, rows[0], "new session", palette);
    render_add_remote_field(frame, rows[1], "session", name, true, palette);

    match (error, in_flight) {
        (Some(error), _) => frame.render_widget(
            Paragraph::new(format!(" {error}")).style(Style::default().fg(palette.red)),
            rows[2],
        ),
        (None, true) => frame.render_widget(
            Paragraph::new(" switching session…").style(Style::default().fg(palette.accent)),
            rows[2],
        ),
        (None, false) => frame.render_widget(
            Paragraph::new(" empty = the remote's default session")
                .style(Style::default().fg(palette.overlay0)),
            rows[2],
        ),
    }

    let (submit_rect, cancel_rect) = new_session_button_rects(inner);
    render_action_button(
        frame,
        submit_rect,
        Some("↵"),
        "switch",
        Style::default()
            .fg(panel_contrast_fg(palette))
            .bg(palette.accent)
            .add_modifier(Modifier::BOLD),
    );
    render_action_button(
        frame,
        cancel_rect,
        Some("esc"),
        "cancel",
        Style::default()
            .fg(palette.text)
            .bg(palette.surface0)
            .add_modifier(Modifier::BOLD),
    );
}

/// #47: render the one client menu (launcher / workspace context / host context) as an
/// anchor-anchored accent panel — a title header, an optional target sub-header, then a selectable
/// list of rows. Geometry comes from `client_menu_inner_rect_at` / `client_menu_row_rect` (the SAME
/// helpers `hit_test` uses) so render == hit-test. `header_rows` is 1 (launcher: title only) or 2
/// (context menus: title + sub-header). Non-selectable rows (the host version readout) render dimmer.
pub(crate) fn render_client_menu_overlay(
    palette: &Palette,
    view: &ClientMenuView,
    frame: &mut Frame,
    popup: Rect,
    header_rows: u16,
) {
    let Some(inner) = render_panel_shell(frame, popup, palette.accent, palette.panel_bg) else {
        return;
    };
    // #33/#47: render and hit-test must derive the SAME inner rect — re-pin the divergence assert at
    // the exact formula `client_menu_inner_rect_at` uses for hit-testing, so the two geometries can
    // never silently diverge again.
    debug_assert_eq!(
        inner,
        Rect::new(
            popup.x + 1,
            popup.y + 1,
            popup.width.saturating_sub(2),
            popup.height.saturating_sub(2),
        ),
        "client menu render and hit-test geometry diverged"
    );
    if inner.height < 4 {
        return;
    }

    render_modal_header(
        frame,
        Rect::new(inner.x, inner.y, inner.width, 1),
        view.title,
        palette,
    );
    if let Some(subheader) = view.subheader {
        frame.render_widget(
            Paragraph::new(format!(
                " {}",
                truncate_end(subheader, inner.width as usize)
            ))
            .style(Style::default().fg(palette.overlay0)),
            Rect::new(inner.x, inner.y.saturating_add(1), inner.width, 1),
        );
    }

    // #56: an out-of-range `selected` (the sentinel the hover-less shell passes) highlights NO row —
    // the per-frame hover overlay paints whichever row the model selects, so the cached shell stays
    // valid across menu-selection changes. A real (in-range) selection still highlights here, which is
    // exactly the baked golden the Seam-1 equivalence test compares the overlay against.
    let max_rows = inner.height.saturating_sub(header_rows) as usize;
    for (row_index, row) in view.rows.iter().enumerate().take(max_rows) {
        let is_selected = row_index == view.selected;
        let marker = if is_selected { "›" } else { " " };
        let text = format!("{marker} {}", row.label);
        let style = if is_selected {
            Style::default()
                .fg(palette.text)
                .bg(palette.surface0)
                .add_modifier(Modifier::BOLD)
        } else if row.selectable {
            Style::default().fg(palette.subtext0)
        } else {
            Style::default().fg(palette.overlay0)
        };
        let row_rect = client_menu_row_rect(inner, header_rows, row_index);
        frame.render_widget(
            Paragraph::new(truncate_end(&text, inner.width as usize)).style(style),
            row_rect,
        );
    }
}

/// #23: render the rename text overlay as a footer-anchored accent panel with a single focused text
/// field + save/cancel buttons. Mirrors `render_add_remote_overlay`. The caller forces
/// `frame.cursor = None` while the modal is open.
pub(crate) fn render_rename_workspace_overlay(
    palette: &Palette,
    label: &str,
    error: Option<&str>,
    frame: &mut Frame,
    popup: Rect,
) {
    // #47: the caller passes the (drag-shifted) popup rect directly; inner is its bordered inset, the
    // SAME `render_panel_shell` inset hit-test derives, so render == hit-test even after a drag.
    let Some(inner) = render_panel_shell(frame, popup, palette.accent, palette.panel_bg) else {
        return;
    };
    if inner.height < 4 {
        return;
    }

    let rows = Layout::vertical([
        Constraint::Length(1), // header
        Constraint::Length(1), // input
        Constraint::Length(1), // error
        Constraint::Min(0),    // actions live on inner.height - 1
    ])
    .areas::<4>(inner);

    render_modal_header(frame, rows[0], "rename workspace", palette);
    render_add_remote_field(frame, rows[1], "label", label, true, palette);

    if let Some(error) = error {
        frame.render_widget(
            Paragraph::new(format!(" {error}")).style(Style::default().fg(palette.red)),
            rows[2],
        );
    }

    let (save_rect, cancel_rect) = rename_workspace_button_rects(inner);
    render_action_button(
        frame,
        save_rect,
        Some("↵"),
        "save",
        Style::default()
            .fg(panel_contrast_fg(palette))
            .bg(palette.accent)
            .add_modifier(Modifier::BOLD),
    );
    render_action_button(
        frame,
        cancel_rect,
        Some("esc"),
        "cancel",
        Style::default()
            .fg(palette.text)
            .bg(palette.surface0)
            .add_modifier(Modifier::BOLD),
    );
}

/// #23: render the close-confirm overlay as a centered red panel ("Close <label>?") with
/// close/cancel buttons. Mirrors `render_remote_manage_confirm`.
pub(crate) fn render_confirm_close_workspace_overlay(
    palette: &Palette,
    label: &str,
    frame: &mut Frame,
    popup: Rect,
) {
    // #47: the caller passes the (drag-shifted) popup rect directly.
    let Some(inner) = render_panel_shell(frame, popup, palette.red, palette.panel_bg) else {
        return;
    };
    if inner.height < 3 {
        return;
    }

    frame.render_widget(
        Paragraph::new(Line::from(vec![Span::styled(
            " close workspace?",
            Style::default()
                .fg(palette.red)
                .add_modifier(Modifier::BOLD),
        )])),
        Rect::new(inner.x, inner.y, inner.width, 1),
    );
    frame.render_widget(
        Paragraph::new(format!(
            " Close {}?",
            truncate_end(label, inner.width.saturating_sub(8) as usize)
        ))
        .style(Style::default().fg(palette.text)),
        Rect::new(inner.x, inner.y.saturating_add(1), inner.width, 1),
    );

    let (close_rect, cancel_rect) = confirm_close_workspace_button_rects(inner);
    render_action_button(
        frame,
        close_rect,
        Some("↵"),
        "close",
        Style::default()
            .fg(panel_contrast_fg(palette))
            .bg(palette.red)
            .add_modifier(Modifier::BOLD),
    );
    render_action_button(
        frame,
        cancel_rect,
        Some("esc"),
        "cancel",
        Style::default()
            .fg(palette.text)
            .bg(palette.surface0)
            .add_modifier(Modifier::BOLD),
    );
}

#[cfg(test)]
mod tests {
    use crate::{
        app::{state::WorktreeCreateState, AppState},
        workspace::Workspace,
    };
    use ratatui::{backend::TestBackend, layout::Rect, Terminal};

    use super::{
        add_remote_button_rects, add_remote_inner_rect, client_menu_inner_rect_at,
        client_menu_popup_rect_at, confirm_close_overlay_text, new_workspace_picker_button_rects,
        new_workspace_picker_inner_rect, new_workspace_picker_row_rect,
        render_new_linked_worktree_overlay,
    };

    fn rects_are_disjoint(a: Rect, b: Rect) -> bool {
        a.x + a.width <= b.x || b.x + b.width <= a.x
    }

    #[test]
    fn workspace_context_menu_anchors_at_cursor() {
        // #33: the popup's top-left sits at the right-click cursor when it fits on screen.
        let popup =
            client_menu_popup_rect_at(10, 4, 2, 2, 80, 24).expect("popup fits on an 80x24 host");
        assert_eq!((popup.x, popup.y), (10, 4), "anchored at the cursor");
    }

    #[test]
    fn workspace_context_menu_clamps_to_screen_near_edges() {
        // #33: a cursor near the right/bottom edge shifts the popup left/up so it stays fully
        // on-screen (matching the server-rendered menu's clamp-to-screen behaviour).
        let popup =
            client_menu_popup_rect_at(79, 23, 2, 2, 80, 24).expect("popup fits on an 80x24 host");
        assert!(
            popup.x + popup.width <= 80,
            "right edge clamped on-screen: {popup:?}"
        );
        assert!(
            popup.y + popup.height <= 24,
            "bottom edge clamped on-screen: {popup:?}"
        );
    }

    #[test]
    fn workspace_context_menu_inner_matches_panel_border_inset() {
        // #33: render and hit-test both derive the inner rect from the SAME popup-at helper, so the
        // inner rect must be exactly the bordered-panel inset (popup + 1 / - 2) — keeping render and
        // hit-test geometry in lockstep now that the divergence debug_assert is gone.
        let popup = client_menu_popup_rect_at(10, 4, 2, 2, 80, 24).unwrap();
        let inner = client_menu_inner_rect_at(10, 4, 2, 2, 80, 24).unwrap();
        assert_eq!(
            inner,
            Rect::new(
                popup.x + 1,
                popup.y + 1,
                popup.width.saturating_sub(2),
                popup.height.saturating_sub(2),
            ),
        );
    }

    #[test]
    fn workspace_context_menu_returns_none_on_tiny_host() {
        // #33: a host too small for the popup yields None, so render draws nothing and hit-test
        // resolves nothing (no clicks land on an unpainted menu).
        assert!(client_menu_popup_rect_at(0, 0, 2, 2, 4, 4).is_none());
    }

    fn rect_within(child: Rect, parent: Rect) -> bool {
        child.x >= parent.x
            && child.y >= parent.y
            && child.x + child.width <= parent.x + parent.width
            && child.y + child.height <= parent.y + parent.height
    }

    #[test]
    fn add_remote_button_rects_lays_out_two_centered_buttons() {
        let area = Rect::new(0, 0, 80, 24);
        let inner = add_remote_inner_rect(area).expect("modal fits");
        let (submit, cancel) = add_remote_button_rects(inner);

        assert_eq!(submit.height, 1);
        assert_eq!(cancel.height, 1);
        assert!(rects_are_disjoint(submit, cancel));
        assert!(rect_within(submit, inner));
        assert!(rect_within(cancel, inner));
        // submit is to the left of cancel.
        assert!(submit.x < cancel.x);
    }

    #[test]
    fn new_workspace_picker_button_rects_lays_out_two_centered_buttons() {
        let area = Rect::new(0, 0, 80, 24);
        let inner = new_workspace_picker_inner_rect(area, 3).expect("modal fits");
        let (confirm, cancel) = new_workspace_picker_button_rects(inner);

        assert_eq!(confirm.height, 1);
        assert_eq!(cancel.height, 1);
        assert!(rects_are_disjoint(confirm, cancel));
        assert!(rect_within(confirm, inner));
        assert!(rect_within(cancel, inner));
        assert!(confirm.x < cancel.x);
    }

    #[test]
    fn new_workspace_picker_inner_rect_is_shared_geometry() {
        let area = Rect::new(0, 0, 80, 24);
        let count = 3usize;
        let inner = new_workspace_picker_inner_rect(area, count).expect("modal fits");

        // every destination row resolves inside the inner rect — the same helper render uses.
        for n in 0..count {
            let row = new_workspace_picker_row_rect(inner, n);
            assert!(
                rect_within(row, inner),
                "row {n} {row:?} not within inner {inner:?}"
            );
        }
        // a row past the count is allowed to spill below; the render-time max_rows clamp guards it.
    }

    #[test]
    fn dialogs_does_not_reference_client_supervisor() {
        // item 1 (Area 3 / contradiction 13): the `ui` layer must not depend on supervisor-model
        // types. `render_*_overlay` take ui-owned view structs only. Build the forbidden path
        // token at runtime so it never appears verbatim in this file (which the guard scans).
        let forbidden = format!("{}::{}::{}", "crate", "client", "supervisor");
        let source = include_str!("dialogs.rs");
        assert!(
            !source.contains(&forbidden),
            "src/ui/dialogs.rs must not reference the supervisor module path"
        );
        // also reject the shorter relative form.
        let forbidden_relative = format!("{}::{}", "client", "supervisor");
        assert!(
            !source.contains(&forbidden_relative),
            "src/ui/dialogs.rs must not reference the supervisor module path"
        );
    }

    #[test]
    fn confirm_close_text_uses_live_workspace_cwd_label() {
        let mut app = AppState::test_new();
        let mut workspace = Workspace::test_new("initial");
        workspace.custom_name = None;
        workspace.identity_cwd = "/projects/original".into();
        let root_pane = workspace.tabs[0].root_pane;
        let terminal_id = workspace.tabs[0].panes[&root_pane]
            .attached_terminal_id
            .clone();
        app.workspaces = vec![workspace];
        app.ensure_test_terminals();
        app.terminals.get_mut(&terminal_id).unwrap().cwd = "/projects/current".into();
        app.selected = 0;

        let terminal_runtimes = crate::terminal::TerminalRuntimeRegistry::new();
        let (title, detail) = confirm_close_overlay_text(&app, &terminal_runtimes);

        assert_eq!(title, "Close workspace?");
        assert_eq!(detail, "current — 1 pane");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn confirm_close_text_prefers_live_runtime_cwd_over_stale_terminal_cwd() {
        let root = std::env::temp_dir().join(format!(
            "herdr-confirm-close-runtime-cwd-{}",
            std::process::id()
        ));
        let stale_cwd = root.join("original");
        let live_cwd = root.join("current");
        std::fs::create_dir_all(&live_cwd).unwrap();

        let mut app = AppState::test_new();
        let mut workspace = Workspace::test_new("initial");
        workspace.custom_name = None;
        workspace.identity_cwd = stale_cwd.clone();
        let root_pane = workspace.tabs[0].root_pane;
        let terminal_id = workspace.tabs[0].panes[&root_pane]
            .attached_terminal_id
            .clone();
        app.workspaces = vec![workspace];
        app.ensure_test_terminals();
        app.selected = 0;

        let (events, _) = tokio::sync::mpsc::channel(4);
        let runtime = crate::terminal::TerminalRuntime::spawn(
            root_pane,
            24,
            80,
            live_cwd,
            0,
            crate::terminal_theme::TerminalTheme::default(),
            None,
            crate::pane::PaneShellConfig::new("/bin/sh", crate::config::ShellModeConfig::NonLogin),
            &crate::pane::PaneLaunchEnv::default(),
            events,
            std::sync::Arc::new(tokio::sync::Notify::new()),
            std::sync::Arc::new(crate::render_signal::RenderSignal::new()),
        )
        .unwrap();
        let mut terminal_runtimes = crate::terminal::TerminalRuntimeRegistry::new();
        terminal_runtimes.insert(terminal_id, runtime);

        let (_, detail) = confirm_close_overlay_text(&app, &terminal_runtimes);

        assert_eq!(detail, "current — 1 pane");

        drop(terminal_runtimes);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn confirm_close_text_uses_selected_custom_name_instead_of_active_workspace_cwd() {
        let mut app = AppState::test_new();
        let active = Workspace::test_new("active");
        let selected = Workspace::test_new("selected");
        let selected_root = selected.tabs[0].root_pane;
        let selected_terminal_id = selected.tabs[0].panes[&selected_root]
            .attached_terminal_id
            .clone();
        app.workspaces = vec![active, selected];
        app.ensure_test_terminals();
        app.terminals.get_mut(&selected_terminal_id).unwrap().cwd = "/projects/current".into();
        app.active = Some(0);
        app.selected = 1;

        let terminal_runtimes = crate::terminal::TerminalRuntimeRegistry::new();
        let (_, detail) = confirm_close_overlay_text(&app, &terminal_runtimes);

        assert_eq!(detail, "selected — 1 pane");
    }

    #[test]
    fn confirm_close_text_reports_parent_group_scope() {
        let mut app = AppState::test_new();
        let mut parent = Workspace::test_new("main");
        parent.worktree_space = Some(crate::workspace::WorktreeSpaceMembership {
            key: "repo-key".into(),
            label: "herdr".into(),
            repo_root: "/repo/herdr".into(),
            checkout_path: "/repo/herdr".into(),
            is_linked_worktree: false,
        });
        let mut child = Workspace::test_new("issue");
        child.worktree_space = Some(crate::workspace::WorktreeSpaceMembership {
            key: "repo-key".into(),
            label: "herdr".into(),
            repo_root: "/repo/herdr".into(),
            checkout_path: "/repo/herdr-issue".into(),
            is_linked_worktree: true,
        });
        app.workspaces = vec![parent, child];
        app.selected = 0;

        let terminal_runtimes = crate::terminal::TerminalRuntimeRegistry::new();
        let (title, detail) = confirm_close_overlay_text(&app, &terminal_runtimes);

        assert_eq!(title, "Close worktree group?");
        assert_eq!(detail, "main — 2 workspaces, 2 panes");
    }

    #[test]
    fn new_worktree_error_renders_fatal_stderr_line() {
        let mut app = AppState::test_new();
        app.name_input = "foo".into();
        app.worktree_create = Some(WorktreeCreateState {
            source_workspace_id: "source".into(),
            source_checkout_path: "/repo/herdr".into(),
            source_existing_membership: None,
            source_repo_root: "/repo/herdr".into(),
            repo_key: "repo-key".into(),
            repo_name: "herdr".into(),
            branch: "foo".into(),
            checkout_path: "/repo/.worktrees/herdr/foo".into(),
            error: Some(
                "Preparing worktree (new branch 'foo')\nfatal: a branch named 'foo' already exists"
                    .into(),
            ),
            creating: false,
        });

        let mut terminal =
            Terminal::new(TestBackend::new(100, 30)).expect("test terminal should initialize");
        terminal
            .draw(|frame| render_new_linked_worktree_overlay(&app, frame, Rect::new(0, 0, 100, 30)))
            .expect("new worktree overlay should render");
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();

        assert!(rendered.contains("fatal: a branch named 'foo' already exists"));
    }

    #[test]
    fn new_worktree_hit_test_geometry_matches_modal_size() {
        let area = Rect::new(0, 0, 100, 30);
        let inner = super::new_linked_worktree_inner_rect(area).unwrap();
        let (create, cancel) = super::new_linked_worktree_button_rects(inner);

        assert_eq!(inner.width, super::NEW_LINKED_WORKTREE_POPUP_WIDTH - 2);
        assert_eq!(inner.height, super::NEW_LINKED_WORKTREE_POPUP_HEIGHT - 2);
        assert_eq!(create.y, inner.y + inner.height - 1);
        assert_eq!(cancel.y, inner.y + inner.height - 1);
    }
}
