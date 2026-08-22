pub(crate) fn version_line_matches_current(line: &str) -> bool {
    // Compare against the FULL build version: channel-suffixed builds (mx/preview)
    // report e.g. `herdr 0.6.10-mx.preview-…`, and matching the bare CARGO_PKG_VERSION
    // made them reject binaries at their own exact version (add-remote bridge failure).
    version_line_matches_package(line, crate::build_info::FULL_VERSION)
}

fn version_line_matches_package(line: &str, package_version: &str) -> bool {
    let trimmed = line.trim();
    let exact = format!("herdr {package_version}");
    trimmed == exact
        || trimmed
            .strip_prefix(&(exact + " ("))
            .is_some_and(|suffix| suffix.ends_with(')'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_version_line_allows_commit_suffix() {
        assert!(version_line_matches_package("herdr 0.6.4", "0.6.4"));
        assert!(version_line_matches_package(
            "herdr 0.6.4 (abc123-dirty)",
            "0.6.4"
        ));
        assert!(!version_line_matches_package(
            "herdr 0.6.3 (abc123)",
            "0.6.4"
        ));
        assert!(!version_line_matches_package(
            "other 0.6.4 (abc123)",
            "0.6.4"
        ));
    }

    #[test]
    fn channel_suffixed_versions_match_exactly() {
        let full = "0.6.10-mx.preview-2026-06-11-21b5cc546761";
        assert!(version_line_matches_package(
            "herdr 0.6.10-mx.preview-2026-06-11-21b5cc546761",
            full
        ));
        assert!(!version_line_matches_package("herdr 0.6.10", full));
        assert!(!version_line_matches_package(
            "herdr 0.6.10-mx.preview-2026-06-11-21b5cc546761",
            "0.6.10"
        ));
    }

    #[test]
    fn current_matcher_accepts_this_builds_version_line() {
        assert!(super::version_line_matches_current(&format!(
            "herdr {}",
            crate::build_info::version()
        )));
    }
}
