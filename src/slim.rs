// Slim mode: env-only trims. Additive and safe.
// Namespace rule (matches dsh convention: DSH_* is owned by dsh itself,
// so rdsh-private keys live under RDSH_*). The original dsh ignores keys
// it does not know, so these hints cannot break boot.
// NOTE: upstream dsh (0.2.0) does not read any RDSH_* key; they only tune
// rdsh-side behavior. The one env below that the Node runtime itself reads
// is NODE_COMPILE_CACHE (effective on Node >= 22.1; ignored on older).
pub fn slim_env() -> Vec<(String, String)> {
    vec![
        ("RDSH_SLIM".into(), "1".into()),
        ("RDSH_LAZY_PLUGINS".into(), "1".into()),
        ("RDSH_DISABLE_VOICE".into(), "1".into()),
        ("RDSH_DISABLE_AUTO_REVIEW".into(), "1".into()),
        ("RDSH_TOKEN_BUDGET".into(), "8000".into()),
        ("RDSH_TOOL_RESULT_BUDGET".into(), "4000".into()),
    ]
}

pub fn describe() -> String {
    "RDSH_SLIM=1 RDSH_LAZY_PLUGINS=1 RDSH_DISABLE_VOICE=1 RDSH_DISABLE_AUTO_REVIEW=1 NODE_COMPILE_CACHE=<cache-dir> (effective on Node >= 22.1), RDSH_NODE_COMPILE_CACHE=0 to disable".to_string()
}

// Default on-disk dir for the Node compile cache (V8 code cache for the
// delegated dsh process). Takes home explicitly so tests stay hermetic.
pub fn default_cache_dir_for(home: &str) -> String {
    format!("{home}/.cache/rdsh-node-compile-cache")
}

// Process-home version of default_cache_dir_for.
pub fn default_compile_cache_dir() -> Option<String> {
    crate::inspect::home_dir().map(|h| default_cache_dir_for(&h))
}

// Pure decision for NODE_COMPILE_CACHE: returns the dir to set, or None
// to leave the child env alone.
// - rdsh_hint of Some(0) opts out entirely.
// - an existing non-empty user value wins (we never override it).
pub fn resolve_node_compile_cache(
    rdsh_hint: Option<&str>,
    existing: Option<&str>,
    default_dir: &str,
) -> Option<String> {
    if rdsh_hint == Some("0") {
        return None;
    }
    if existing.is_some_and(|v| !v.is_empty()) {
        return None;
    }
    if default_dir.is_empty() {
        return None;
    }
    Some(default_dir.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opt_out_disables() {
        assert_eq!(resolve_node_compile_cache(Some("0"), None, "/c"), None);
        assert_eq!(
            resolve_node_compile_cache(Some("0"), Some("user"), "/c"),
            None
        );
    }

    #[test]
    fn existing_user_value_wins() {
        assert_eq!(
            resolve_node_compile_cache(None, Some("/user/dir"), "/c"),
            None
        );
        assert_eq!(
            resolve_node_compile_cache(Some("1"), Some("/user/dir"), "/c"),
            None
        );
    }

    #[test]
    fn default_used_when_unset() {
        assert_eq!(
            resolve_node_compile_cache(None, None, "/c"),
            Some("/c".to_string())
        );
        assert_eq!(
            resolve_node_compile_cache(Some("1"), None, "/c"),
            Some("/c".to_string())
        );
        // Empty existing counts as unset.
        assert_eq!(
            resolve_node_compile_cache(None, Some(""), "/c"),
            Some("/c".to_string())
        );
    }

    #[test]
    fn default_dir_shape() {
        assert_eq!(
            default_cache_dir_for("/home/u"),
            "/home/u/.cache/rdsh-node-compile-cache"
        );
    }
}
