//! Web UI payload trim: raise the DSH webserver gzip level from the bundle default
//! (level 1) to a higher level, without touching any other webserver field.
//!
//! Why an overlay instead of editing the profile: the include plugin's patch
//! algorithm assigns a patch entry's `config` as a whole
//! (`cordis-plugin-include`: `target[key] = value`). It does not deep-merge.
//! A patch that names only `compressionLevel` therefore *replaces* the row's
//! config and drops `host`/`port`/`tls`, which fails schema validation with
//! "$.host missing required value". Verified against the installed bundle on
//! this machine:
//!
//! ```text
//! # dsh --profile web --patch <level-only.yml> --dump-config
//! - id: webserver
//!   config:
//!     compressionLevel: 6        # host/port/tls/compression: gone
//! ```
//!
//! The safe shape is to restate every field *verbatim as the composed config
//! already has it* and change only `compressionLevel`. `--dump-config` prints
//! the composed tree with `!!js` tags preserved, so the restated patch is
//! identical to the layer beneath except for the one number:
//!
//! ```text
//! # dsh --profile web --patch <restated.yml> --dump-config
//! - id: webserver
//!   config:
//!     host: !!js ctx.webStartup.host ?? '127.0.0.1'
//!     port: !!js ctx.webStartup.port ?? 3080
//!     tls: !!js ctx.webStartup.tls
//!     compression: gzip
//!     compressionLevel: 6
//!     compressionThresholdBytes: 1024
//! ```
//!
//! Nothing here writes into the profile. The overlay is a separate file passed
//! as an extra `--patch`, so an unreadable or rejected overlay can only cost
//! the optimization, never the boot. A user-supplied `--patch` still wins,
//! because `rdsh` appends the generated overlay *before* the user's own list.

/// Measured default: level 6 captures essentially all of the win.
///
/// On the reference build the four initial-load shell assets moved
/// 549,220 B -> 487,447 B (-61,773 B, -11.2%) from level 1 to level 6, while
/// level 9 saved only a further 2,054 B. Both figures come from wire bytes
/// captured from the running server, and the level-1 total was confirmed to be
/// byte-identical to `zlib.gzipSync(..., { level: 1 })` over the same sources,
/// so these are measurements rather than estimates. Level 6 is the knee;
/// higher levels only cost CPU.
pub const DEFAULT_COMPRESSION_LEVEL: u8 = 6;

/// The schema accepts 0-9 inclusive (`z.number().step(1).min(0).max(9)`).
pub const MAX_COMPRESSION_LEVEL: u8 = 9;

/// The installed bundle ships `compressionLevel: 1`; the schema default is 1.
pub const BUNDLE_COMPRESSION_LEVEL: u8 = 1;

/// The row this module rewrites.
pub const WEBSERVER_ROW_ID: &str = "webserver";

/// The single config key this module is allowed to change.
pub const COMPRESSION_LEVEL_KEY: &str = "compressionLevel";

/// Feature id that gates this optimization.
pub const FEATURE_ID: &str = "web_gzip_level";

/// Environment override, mirroring the other RDSH_* hints: explicit env wins.
pub const ENV_LEVEL: &str = "RDSH_WEB_GZIP_LEVEL";

/// Clamp a requested level into the range the DSH schema accepts.
/// Out-of-range values are pulled to the nearest edge rather than rejected, so
/// a typo in settings can never make the web profile unbootable.
pub fn clamp_level(level: i64) -> u8 {
    if level < 0 {
        0
    } else if level > i64::from(MAX_COMPRESSION_LEVEL) {
        MAX_COMPRESSION_LEVEL
    } else {
        level as u8
    }
}

/// Parse a settings/env value into a level, falling back when it is absent or
/// unparseable. Whitespace is tolerated; anything else is ignored.
pub fn parse_level(raw: Option<&str>, fallback: u8) -> u8 {
    match raw.map(str::trim) {
        Some(s) if !s.is_empty() => match s.parse::<i64>() {
            Ok(n) => clamp_level(n),
            Err(_) => fallback,
        },
        _ => fallback,
    }
}

/// True when raising the level is worth an overlay. Level 1 is what the bundle
/// already sets, so restating it would add a layer for no gain.
pub fn is_worth_applying(target: u8) -> bool {
    target > BUNDLE_COMPRESSION_LEVEL
}

/// Rewrite one `compressionLevel:` line in a block of YAML text.
///
/// Only lines inside the webserver config block are eligible: the caller
/// passes just that slice. The replacement keeps the original indentation and
/// any trailing comment, so the overlay stays readable next to the dump.
/// Returns `None` when no uncommented `compressionLevel` key is present,
/// which means the composed config does not set it and the bundle default
/// applies.
pub fn rewrite_level_line(block: &str, level: u8) -> Option<String> {
    let mut out: Vec<String> = Vec::new();
    let mut replaced = false;
    for line in block.lines() {
        let indent_len = line.len() - line.trim_start().len();
        let indent = &line[..indent_len];
        let body = line.trim_start();
        // Commented-out keys are documentation, not config.
        if body.starts_with('#') {
            out.push(line.to_string());
            continue;
        }
        let Some(rest) = body.strip_prefix(COMPRESSION_LEVEL_KEY) else {
            out.push(line.to_string());
            continue;
        };
        // Require the key to be exactly followed by ':' so a future
        // `compressionLevelOverride`-style key is not silently rewritten.
        let Some(rest) = rest.strip_prefix(':') else {
            out.push(line.to_string());
            continue;
        };
        let comment = match rest.find('#') {
            Some(at) => format!(" {}", &rest[at..]),
            None => String::new(),
        };
        out.push(format!("{indent}{COMPRESSION_LEVEL_KEY}: {level}{comment}"));
        replaced = true;
    }
    if !replaced {
        return None;
    }
    let mut text = out.join("\n");
    if block.ends_with('\n') {
        text.push('\n');
    }
    Some(text)
}

/// Split a composed `--dump-config` listing into top-level entry blocks.
///
/// Entries start with `- id: <name>` at column 0; everything up to the next
/// such line belongs to the preceding entry, and lines before the first entry
/// (layer banners, comments) are dropped. Pure, so extraction is testable
/// without running `dsh`.
pub fn split_entries(composed: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in composed.lines() {
        // A layer banner ends the entry above it as firmly as a new id does.
        if line.starts_with("# ==") {
            out.push(String::new());
            continue;
        }
        if line.starts_with("- id: ") {
            out.push(String::new());
        }
        if let Some(last) = out.last_mut() {
            last.push_str(line);
            last.push('\n');
        }
    }
    out.retain(|b| b.starts_with("- id: "));
    out
}

/// Extract the `webserver` entry block from a composed config dump.
pub fn extract_webserver_entry(composed: &str) -> Option<String> {
    let marker = format!("- id: {WEBSERVER_ROW_ID}\n");
    split_entries(composed)
        .into_iter()
        .find(|block| block.starts_with(&marker))
}

/// Return the indentation of a `config:` key and its body.
///
/// The body is what `rewrite_level_line` operates on. Returning the indent
/// lets the caller re-emit the block with the same shape it came in with.
pub fn config_block(entry: &str) -> Option<(String, String)> {
    let mut body = String::new();
    let mut config_indent: Option<String> = None;
    let mut in_config = false;
    for line in entry.lines() {
        if !in_config {
            let trimmed = line.trim_start();
            // A nested `config:` (unlikely on this row) must not win over the
            // real one, so the first match is taken and reading stops after.
            if trimmed == "config:" {
                let indent_len = line.len() - trimmed.len();
                config_indent = Some(line[..indent_len].to_string());
                in_config = true;
            }
            continue;
        }
        if line.trim().is_empty() {
            body.push_str(line);
            body.push('\n');
            continue;
        }
        let Some(config_len) = config_indent.as_ref().map(String::len) else {
            break;
        };
        let indent_len = line.len() - line.trim_start().len();
        if indent_len <= config_len {
            break;
        }
        body.push_str(line);
        body.push('\n');
    }
    config_indent.map(|indent| (indent, body))
}

/// Build the `--patch` overlay that raises the webserver compression level.
///
/// Returns `None` when the source dump has no `webserver` entry carrying a
/// `compressionLevel` key: an overlay would then have to invent fields, which
/// is exactly the unsafe shape this module exists to avoid.
pub fn overlay_for(composed: &str, level: u8) -> Option<String> {
    let entry = extract_webserver_entry(composed)?;
    let (config_indent, body) = config_block(&entry)?;
    let rewritten = rewrite_level_line(&body, level)?;
    let mut out = String::new();
    out.push_str(&format!("- id: {WEBSERVER_ROW_ID}\n"));
    out.push_str(&format!("{config_indent}config:\n"));
    out.push_str(&rewritten);
    Some(out)
}

/// Resolve the level to apply: explicit env beats settings, both clamped.
pub fn resolve_level(env: Option<&str>, configured: u8) -> u8 {
    parse_level(env, clamp_level(i64::from(configured)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact shape `dsh --profile web --dump-config` prints on the
    /// reference machine, trimmed to the two rows around `webserver`.
    /// A raw string keeps the indentation: a `\\`-newline continuation would
    /// strip the leading spaces of every following line and silently flatten
    /// the YAML nesting this module depends on.
    const COMPOSED: &str = r#"- id: web-startup
  name: '@deepseek-ai/dsh-web-app/startup'
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject:
    - webStartup
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
    tls: !!js ctx.webStartup.tls
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
- id: web-runtime
  name: '@deepseek-ai/dsh-web-app'
  config:
    openBrowser: !!js ctx.webStartup.openBrowser
"#;

    #[test]
    fn overlay_preserves_host_port_tls_and_compression() {
        let overlay = overlay_for(COMPOSED, 6).expect("webserver row is present");
        // The whole point: every field the bundle layer set survives.
        for kept in [
            "host: !!js ctx.webStartup.host ?? '127.0.0.1'",
            "port: !!js ctx.webStartup.port ?? 3080",
            "tls: !!js ctx.webStartup.tls",
            "compression: gzip",
            "compressionThresholdBytes: 1024",
        ] {
            assert!(
                overlay.contains(kept),
                "overlay dropped {kept:?}:\n{overlay}"
            );
        }
        assert!(overlay.contains("compressionLevel: 6"), "{overlay}");
        // And the stale level must be gone, or the last value would win.
        assert!(!overlay.contains("compressionLevel: 1"), "{overlay}");
    }

    #[test]
    fn overlay_is_scoped_to_the_webserver_row() {
        let overlay = overlay_for(COMPOSED, 6).unwrap();
        assert!(overlay.starts_with("- id: webserver\n"));
        // Neighbouring rows must not leak into the patch list.
        assert!(!overlay.contains("web-runtime"), "{overlay}");
        assert!(!overlay.contains("web-startup"), "{overlay}");
        assert!(!overlay.contains("openBrowser"), "{overlay}");
        assert_eq!(overlay.matches("- id: ").count(), 1);
    }

    #[test]
    fn overlay_keeps_indentation_and_trailing_comment() {
        let composed = r#"- id: webserver
  config:
    host: h
    compressionLevel: 1        # bundle value
"#;
        let overlay = overlay_for(composed, 9).unwrap();
        assert!(
            overlay.contains("    compressionLevel: 9 # bundle value"),
            "{overlay}"
        );
        assert!(overlay.contains("    host: h\n"), "{overlay}");
    }

    #[test]
    fn missing_webserver_row_yields_no_overlay() {
        let composed = "- id: other\n  config:\n    compressionLevel: 1\n";
        assert_eq!(overlay_for(composed, 6), None);
    }

    #[test]
    fn missing_compression_level_yields_no_overlay() {
        // No key means the bundle default applies; inventing one would create
        // the field-dropping hazard this module avoids.
        let composed = "- id: webserver\n  config:\n    host: h\n    port: 3080\n";
        assert_eq!(overlay_for(composed, 6), None);
    }

    #[test]
    fn config_block_stops_at_the_next_key() {
        let entry = "- id: webserver\n  config:\n    a: 1\n  inject:\n    - webStartup\n";
        let (indent, body) = config_block(entry).unwrap();
        assert_eq!(indent, "  ");
        assert_eq!(body, "    a: 1\n");
    }

    #[test]
    fn commented_key_is_not_rewritten() {
        // A commented-out example must survive untouched, and must not count
        // as a replacement.
        let block = "    # compressionLevel: 1\n    host: h\n";
        assert_eq!(rewrite_level_line(block, 6), None);
    }

    #[test]
    fn similar_prefix_key_is_not_rewritten() {
        let block = "    compressionLevelOverride: 1\n";
        assert_eq!(rewrite_level_line(block, 6), None);
    }

    #[test]
    fn every_matching_key_in_the_block_is_rewritten() {
        let block = "    compressionLevel: 1\n    x: 2\n    compressionLevel: 3\n";
        let out = rewrite_level_line(block, 6).unwrap();
        assert_eq!(
            out,
            "    compressionLevel: 6\n    x: 2\n    compressionLevel: 6\n"
        );
    }

    #[test]
    fn clamp_pulls_into_the_schema_range() {
        assert_eq!(clamp_level(-5), 0);
        assert_eq!(clamp_level(0), 0);
        assert_eq!(clamp_level(6), 6);
        assert_eq!(clamp_level(9), 9);
        // Schema max is 9; 10 would be rejected by z.number().max(9).
        assert_eq!(clamp_level(10), 9);
        assert_eq!(clamp_level(i64::MAX), 9);
    }

    #[test]
    fn parse_level_falls_back_on_junk_and_blank() {
        assert_eq!(parse_level(None, 6), 6);
        assert_eq!(parse_level(Some(""), 6), 6);
        assert_eq!(parse_level(Some("   "), 6), 6);
        assert_eq!(parse_level(Some("abc"), 6), 6);
        assert_eq!(parse_level(Some("6.5"), 6), 6);
        assert_eq!(parse_level(Some(" 6 "), 6), 6);
        assert_eq!(parse_level(Some("9"), 6), 9);
        assert_eq!(parse_level(Some("99"), 6), 9);
        assert_eq!(parse_level(Some("-1"), 6), 0);
    }

    #[test]
    fn env_overrides_the_configured_level() {
        assert_eq!(resolve_level(Some("9"), 6), 9);
        assert_eq!(resolve_level(Some("2"), 6), 2);
        // No env: the configured value, clamped.
        assert_eq!(resolve_level(None, 6), 6);
        assert_eq!(resolve_level(None, 200), 9);
    }

    #[test]
    fn applying_is_pointless_at_or_below_the_bundle_level() {
        assert!(!is_worth_applying(0));
        // Level 1 is already what the bundle sets.
        assert!(!is_worth_applying(BUNDLE_COMPRESSION_LEVEL));
        assert!(is_worth_applying(6));
        assert!(is_worth_applying(9));
    }

    #[test]
    fn overlay_of_a_real_dump_round_trips_through_the_parser() {
        // Extract-and-rewrite over the full fixture, then confirm the overlay
        // is a valid single-entry patch list and the composed values survive.
        let overlay = overlay_for(COMPOSED, DEFAULT_COMPRESSION_LEVEL).unwrap();
        let entries = split_entries(&overlay);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].starts_with("- id: webserver\n"));
        let (_, body) = config_block(&entries[0]).unwrap();
        let keys: Vec<&str> = body
            .lines()
            .filter_map(|l| l.trim_start().split(':').next())
            .collect();
        assert_eq!(
            keys,
            vec![
                "host",
                "port",
                "tls",
                "compression",
                "compressionLevel",
                "compressionThresholdBytes"
            ]
        );
    }
}
