//! Shared wire protocol and presentation encoding code.

pub mod abi;
pub(crate) mod render_ansi;
mod wire;
#[cfg(all(test, not(windows)))]
mod wire_fixtures;

pub use wire::*;
