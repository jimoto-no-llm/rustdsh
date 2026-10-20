// Slim mode: env-only trims. Additive and safe.
// Telemetry stays off by default for every delegated run (not only slim);
// see telemetry_env below and docs/PRIVACY.md.
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
    /// Opt-in: when true, delegated runs leave upstream DSH telemetry alone.
    pub telemetry: bool,
}

impl Default for SlimFeatures {
    fn default() -> Self {
        Self {
            lazy_plugins: true,
            disable_voice: true,
            disable_auto_review: true,
            node_compile_cache: true,
            telemetry: false,
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
        telemetry: crate::rdsh_config::feature_enabled(cfg, "telemetry")
            || telemetry_opt_in(std::env::var("RDSH_TELEMETRY").ok().as_deref()),
    });
}

/// Active switches (defaults until configure runs).
pub fn features() -> SlimFeatures {
    *FEATURES.get_or_init(SlimFeatures::default)
}

/// True when RDSH_TELEMETRY asks for one run to keep upstream telemetry on.
/// Only an affirmative word counts; everything else keeps the default (off).
pub fn telemetry_opt_in(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("on" | "1" | "true" | "yes")
    )
}

/// The default-off telemetry hint for delegated DSH runs, or None when the
/// run opted in or the user already set DSH_TELEMETRY_DISABLED themselves
/// (upstream treats any non-empty value, including `0`/`false`, as off).
pub fn telemetry_env(
    enabled: bool,
    existing: Option<&str>,
) -> Option<(&'static str, &'static str)> {
    if enabled || existing.is_some_and(|value| !value.is_empty()) {
        return None;
    }
    Some(("DSH_TELEMETRY_DISABLED", "1"))
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
            "NODE_COMPILE_CACHE=<cache-dir> (effective on Node >= 22.1), RDSH_NODE_COMPILE_CACHE=0 to disable, RDSH_NODE_COMPILE_CACHE=<dir> to relocate"
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
// - rdsh_hint of Some(<path>) places the cache at that dir instead of the
//   default (RDSH_NODE_COMPILE_CACHE=1 keeps the default).
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
    if rdsh_hint.is_some_and(|v| !v.is_empty() && v != "1") {
        return Some(rdsh_hint.unwrap().to_string());
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
    fn hint_directory_overrides_default() {
        // RDSH_NODE_COMPILE_CACHE=<dir> places the cache at the given dir.
        assert_eq!(
            resolve_node_compile_cache(Some("/data/rdsh-ncc"), None, "/c"),
            Some("/data/rdsh-ncc".to_string())
        );
        // Opt-out still wins over a directory check order (0 is handled first).
        assert_eq!(resolve_node_compile_cache(Some("0"), None, "/c"), None);
        // An explicit user NODE_COMPILE_CACHE still wins.
        assert_eq!(
            resolve_node_compile_cache(Some("/data/rdsh-ncc"), Some("/user/dir"), "/c"),
            None
        );
        // RDSH_NODE_COMPILE_CACHE=1 keeps the default dir.
        assert_eq!(
            resolve_node_compile_cache(Some("1"), None, "/c"),
            Some("/c".to_string())
        );
        // An empty hint counts as unset.
        assert_eq!(
            resolve_node_compile_cache(Some(""), None, "/c"),
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

    #[test]
    fn telemetry_is_disabled_by_default_and_opt_in_removes_the_hint() {
        assert!(!SlimFeatures::default().telemetry);
        assert_eq!(
            telemetry_env(false, None),
            Some(("DSH_TELEMETRY_DISABLED", "1"))
        );
        // features.telemetry=true / RDSH_TELEMETRY=on leave the child env alone.
        assert_eq!(telemetry_env(true, None), None);
        // A value the user set is left untouched: upstream treats any
        // non-empty value, including "0"/"false", as an opt-out.
        assert_eq!(telemetry_env(false, Some("0")), None);
        assert_eq!(telemetry_env(false, Some("1")), None);
        // An empty value counts as unset, like the compile-cache hint.
        assert_eq!(
            telemetry_env(false, Some("")),
            Some(("DSH_TELEMETRY_DISABLED", "1"))
        );
    }

    #[test]
    fn telemetry_opt_in_accepts_only_affirmative_words() {
        for value in ["on", "ON", "1", "true", "yes", " on "] {
            assert!(telemetry_opt_in(Some(value)), "{value}");
        }
        for value in [None, Some("off"), Some("0"), Some("false"), Some("")] {
            assert!(!telemetry_opt_in(value), "{value:?}");
        }
    }
}
