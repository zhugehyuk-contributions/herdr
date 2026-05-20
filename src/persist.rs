//! Session persistence — save/restore workspaces, layouts, and working directories.
//!
//! Stored at `~/.config/herdr/session.json`.

mod io;
mod restore;
mod snapshot;

pub use self::io::{clear, load, save};
pub use self::restore::restore;
#[cfg(test)]
pub use self::snapshot::capture;
pub(crate) use self::snapshot::capture_with_history_disconnected_at;
pub use self::snapshot::{
    DirectionSnapshot, LayoutSnapshot, SessionSnapshot, TabSnapshot, WorkspaceSnapshot,
};
