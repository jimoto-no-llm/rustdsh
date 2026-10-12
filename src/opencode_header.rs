//! Always-on compatibility preload for delegated DSH boots.
//!
//! OpenCode zen endpoints reject requests without the per-conversation
//! `x-opencode-session` header (`400 MissingSessionID`). DSH attaches it only
//! through the built-in `opencode` / `opencode-go` provider wrappers, so any
//! custom pi-ai route that points at an OpenCode endpoint (its own
//! `createProvider` in `@deepseek-ai/dsh-llm-pi-ai`) never gets it. The embedded
//! preload keys the header off the request endpoint instead, so custom routes
//! behave like the built-ins.
//!
//! Set `RDSH_OPENCODE_SESSION_HEADER=0` to opt out.
use std::path::PathBuf;

const PRELOAD: &str = include_str!("../security/opencode-session-header.mjs");

fn enabled() -> bool {
    std::env::var("RDSH_OPENCODE_SESSION_HEADER").map_or(true, |v| v != "0")
}

/// Write the embedded preload to a stable path (content-checked, so it is
/// rewritten only when this build's source changes) and return it.
pub fn preload_path() -> Option<PathBuf> {
    if !enabled() {
        return None;
    }
    let path = std::env::temp_dir().join("rdsh-opencode-session-header.mjs");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(PRELOAD) {
        std::fs::write(&path, PRELOAD).ok()?;
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_embedded_preload() {
        std::env::remove_var("RDSH_OPENCODE_SESSION_HEADER");
        let path = preload_path().expect("preload path");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), PRELOAD);
        assert!(PRELOAD.contains("__RDSH_OPENCODE_SESSION_HEADER__"));
        assert!(PRELOAD.contains("x-opencode-session"));
    }
}
