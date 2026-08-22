/// #59: payload for pasting a staged clipboard IMAGE path into an agent pane.
///
/// The staged image path is sent **un-bracketed / raw**. Claude Code (and similar agents) auto-attach
/// a pasted absolute image path, but only when it arrives as ordinary input — bracketed paste
/// (`\x1b[200~…\x1b[201~`) is, by design, treated as literal text, so the staged path showed up
/// verbatim in the prompt instead of attaching (issue #59). A staged temp path carries no control
/// characters, so a raw send is safe.
///
/// (This previously wrapped the path in bracketed paste, like a normal text paste — that wrapping was
/// exactly the bug: it suppressed the agent's path→image auto-attach.)
pub(crate) fn clipboard_image_paste_payload(path: &str) -> String {
    path.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_image_path_is_sent_unbracketed_for_auto_attach() {
        // #59: the staged image path must NEVER be bracketed — bracketed paste is literal text to the
        // agent, suppressing its path->image auto-attach. Guards against a well-meaning "wrap it like
        // a normal paste" regression.
        let path = "/tmp/herdr-clip-abc123.png";
        let payload = clipboard_image_paste_payload(path);
        assert_eq!(payload, path);
        assert!(
            !payload.contains("\x1b[200~") && !payload.contains("\x1b[201~"),
            "image-path paste must not carry bracketed-paste markers, got {payload:?}"
        );
    }
}
