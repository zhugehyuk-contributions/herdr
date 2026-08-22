//! Build identity helpers.

pub const BASE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The full user-facing version (base + channel/build-id suffix), computed by build.rs
/// so it is available as a compile-time constant. This is exactly what
/// `herdr --version` reports; version-parity checks must compare against this, never
/// against the bare `CARGO_PKG_VERSION` (suffixed builds would reject themselves).
pub const FULL_VERSION: &str = env!("HERDR_FULL_VERSION");

pub fn channel() -> &'static str {
    non_empty(option_env!("HERDR_BUILD_CHANNEL")).unwrap_or("stable")
}

pub fn build_id() -> Option<&'static str> {
    non_empty(option_env!("HERDR_BUILD_ID"))
}

pub fn version() -> String {
    FULL_VERSION.to_string()
}

pub fn is_preview() -> bool {
    channel() == "preview"
}

/// The human-orderable build stamp embedded in a channel-suffixed version —
/// `…-preview-2026-06-11-2357-<sha>` → `2026.06.11.2357`. This is the SAME
/// `YYYY.MM.DD.HHMM` number the brew preview formula uses as its package version,
/// so `herdr status` and `brew list --versions` read as the same build. `None`
/// for stable versions and for preview builds that predate the time-stamped id.
pub fn build_stamp(version: &str) -> Option<String> {
    let parts: Vec<&str> = version.split('-').collect();
    for window in parts.windows(4) {
        let &[year, month, day, hhmm] = window else {
            continue;
        };
        if year.len() == 4
            && month.len() == 2
            && day.len() == 2
            && hhmm.len() == 4
            && [year, month, day, hhmm]
                .iter()
                .all(|part| part.bytes().all(|byte| byte.is_ascii_digit()))
        {
            return Some(format!("{year}.{month}.{day}.{hhmm}"));
        }
    }
    None
}

fn non_empty(value: Option<&'static str>) -> Option<&'static str> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn stable_version_defaults_to_cargo_version() {
        assert!(!super::version().is_empty());
    }

    #[test]
    fn full_version_starts_with_base_version() {
        assert!(super::FULL_VERSION.starts_with(super::BASE_VERSION));
        assert_eq!(super::version(), super::FULL_VERSION);
    }

    #[test]
    fn build_stamp_extracts_brew_style_version_from_timestamped_previews() {
        assert_eq!(
            super::build_stamp("0.6.10-mx.preview-2026-06-11-2357-929525382782").as_deref(),
            Some("2026.06.11.2357")
        );
        // Pre-timestamp preview ids and stable versions carry no stamp.
        assert_eq!(
            super::build_stamp("0.6.10-mx.preview-2026-06-11-21b5cc546761"),
            None
        );
        assert_eq!(super::build_stamp("0.6.10"), None);
        assert_eq!(super::build_stamp("0.6.10-mx.1"), None);
    }
}
