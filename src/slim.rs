// Slim mode: env-only trims. Additive and safe.
// Namespace rule (matches dsh convention: DSH_* is owned by dsh itself,
// so rdsh-private keys live under RDSH_*). The original dsh ignores keys
// it does not know, so these hints cannot break boot.
// NOTE: upstream dsh (0.2.0) does not read any RDSH_* key; they only tune
// rdsh-side behavior. The one env below that the Node runtime itself reads
// is NODE_COMPILE_CACHE (effective on Node >= 22.1; ignored on older).
// ---- feature switches (settings-driven) ----

/// Which slim hints are applied, resolved once per process from
/// `features.*` in rdsh.json. Defaults reproduce the historical hints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlimFeatures {
    pub lazy_plugins: bool,
    pub disable_voice: bool,
    pub disable_auto_review: bool,
    pub node_compile_cache: bool,
}

impl Default for SlimFeatures {
    fn default() -> Self {
        Self {
            lazy_plugins: true,
            disable_voice: true,
            disable_auto_review: true,
            node_compile_cache: true,
        }
    }
}

static FEATURES: std::sync::OnceLock<SlimFeatures> = std::sync::OnceLock::new();

/// Record the settings-derived switches for this process (first call wins).
pub fn configure(cfg: &crate::rdsh_config::RdshSettings) {
    let _ = FEATURES.set(SlimFeatures {
        lazy_plugins: crate::rdsh_config::feature_enabled(cfg, "slim_lazy_plugins"),
        disable_voice: crate::rdsh_config::feature_enabled(cfg, "slim_disable_voice"),
        disable_auto_review: crate::rdsh_config::feature_enabled(cfg, "slim_disable_auto_review"),
        node_compile_cache: crate::rdsh_config::feature_enabled(cfg, "node_compile_cache"),
    });
}

/// Active switches (defaults until configure runs).
pub fn features() -> SlimFeatures {
    *FEATURES.get_or_init(SlimFeatures::default)
}

/// Hints applied to delegated runs, filtered by the feature switches.
pub fn slim_env() -> Vec<(&'static str, &'static str)> {
    let active = features();
    let mut env = vec![("RDSH_SLIM", "1")];
    if active.lazy_plugins {
        env.push(("RDSH_LAZY_PLUGINS", "1"));
    }
    if active.disable_voice {
        env.push(("RDSH_DISABLE_VOICE", "1"));
    }
    if active.disable_auto_review {
        env.push(("RDSH_DISABLE_AUTO_REVIEW", "1"));
    }
    env.push(("RDSH_TOKEN_BUDGET", "8000"));
    env.push(("RDSH_TOOL_RESULT_BUDGET", "4000"));
    env
}

pub fn describe() -> String {
    let mut parts: Vec<String> = slim_env().iter().map(|(k, v)| format!("{k}={v}")).collect();
    if features().node_compile_cache {
        parts.push(
            "NODE_COMPILE_CACHE=<cache-dir> (effective on Node >= 22.1), RDSH_NODE_COMPILE_CACHE=0 to disable"
                .to_string(),
        );
    } else {
        parts.push("NODE_COMPILE_CACHE=off (features.node_compile_cache=false)".to_string());
    }
    parts.join(" ")
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
    if rdsh_hint.is_some_and(|v| v == "0") {
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
