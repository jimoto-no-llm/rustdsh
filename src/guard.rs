// rdsh guard: tiny hook command for hooks.json (Claude Code / Codex bridges).
// Scans stdin (hook JSON or raw text) for deny patterns and blocks on match.
// Exit 2 = block with reason on stderr; anything else = allow. ~1ms startup.
//
// Policy notes (Bucket C, issues #29/#30/#32/#33) — behavior unchanged:
// - #29 operation structure: deny patterns are structural (`a*b`, anchors),
//   not semantic allow-lists; unanchored text matches as substring.
// - #33 external input: JSON hook payloads are flattened to string values only
//   (`collect_text`); keys/numbers/bools never match, raw text stays borrowed.
// - #32 credential hygiene: prefer narrow deny globs (e.g. `*.credentials.yaml*`)
//   shared minimally per call, not broad secrets dumped into the prompt.
// - #30 approval ledger: JSON mode prints `{"decision": ...}` for ledgering;
//   text mode exits 2 with the reason on stderr.

pub fn wildcard_match(pattern: &str, text: &str) -> bool {
    if pattern == "*" || pattern.is_empty() {
        return true;
    }
    // No allocation: scan `*`-separated parts without collecting them.
    if !pattern.contains('*') {
        return text.contains(pattern);
    }
    if pattern.bytes().all(|b| b == b'*') {
        return true;
    }
    let starts_star = pattern.starts_with('*');
    let ends_star = pattern.ends_with('*');
    let mut rest = text;
    let mut first = true;
    let mut parts = pattern.split('*').filter(|p| !p.is_empty()).peekable();
    while let Some(part) = parts.next() {
        let last = parts.peek().is_none();
        if first && !starts_star {
            if !rest.starts_with(part) {
                return false;
            }
            rest = &rest[part.len()..];
        } else if last && !ends_star {
            if !rest.ends_with(part) {
                return false;
            }
        } else if let Some(pos) = rest.find(part) {
            rest = &rest[pos + part.len()..];
        } else {
            return false;
        }
        first = false;
    }
    true
}
fn collect_text(raw: &str) -> std::borrow::Cow<'_, str> {
    // Fast path: plain text never parses as the JSON shapes we care about
    // (object/array/string roots), so borrow it without parsing or copying.
    // Other scalar roots (numbers/bool/null) hold no strings, and fall back
    // to `raw` below just the same.
    let t = raw.trim_start();
    let try_parse = matches!(t.as_bytes().first(), Some(b'{') | Some(b'[') | Some(b'"'));
    if !try_parse {
        return std::borrow::Cow::Borrowed(raw);
    }
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(v) => {
            let mut out = String::with_capacity(raw.len());
            push_strings(&v, &mut out);
            if out.is_empty() {
                std::borrow::Cow::Borrowed(raw)
            } else {
                std::borrow::Cow::Owned(out)
            }
        }
        Err(_) => std::borrow::Cow::Borrowed(raw),
    }
}

fn push_strings(v: &serde_json::Value, out: &mut String) {
    match v {
        serde_json::Value::String(s) => {
            out.push_str(s);
            out.push('\n');
        }
        serde_json::Value::Array(a) => {
            for x in a {
                push_strings(x, out);
            }
        }
        serde_json::Value::Object(m) => {
            for x in m.values() {
                push_strings(x, out);
            }
        }
        _ => {}
    }
}

pub fn cmd_guard(deny: Vec<String>, reason: Option<String>, json_out: bool) -> anyhow::Result<()> {
    use std::io::Read;
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw)?;
    let text = collect_text(&raw);
    let hit = deny.iter().find(|p| wildcard_match(p, &text));
    match hit {
        Some(p) => {
            let msg = reason.unwrap_or_else(|| "blocked by rdsh guard".to_owned());
            eprintln!("[rdsh guard] pattern hit: {}", p);
            if json_out {
                println!(
                    "{}",
                    serde_json::json!({"decision": "block", "reason": msg})
                );
                Ok(())
            } else {
                eprintln!("{msg}");
                std::process::exit(2);
            }
        }
        None => {
            if json_out {
                println!("{}", serde_json::json!({"decision": "approve"}));
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wild_basic() {
        assert!(wildcard_match("*", "anything"));
        assert!(wildcard_match("rm", "run rm now"));
        assert!(!wildcard_match("zzz", "hello"));
    }

    #[test]
    fn wild_anchors() {
        assert!(wildcard_match("rm -rf /*", "rm -rf / x"));
        assert!(!wildcard_match("rm -rf /*", "echo rm -rf / x"));
        assert!(wildcard_match("a*", "abc"));
        assert!(!wildcard_match("a*", "xbc"));
        assert!(wildcard_match("*end", "the end"));
    }

    #[test]
    fn wild_middle() {
        assert!(wildcard_match("*evil*", "x evil y"));
        assert!(wildcard_match("a*b", "axxb"));
        assert!(!wildcard_match("a*b", "axxc"));
    }

    #[test]
    fn collect_json_strings() {
        let t = collect_text("plain text here");
        assert_eq!(t, "plain text here");
    }

    // #29 operation structure: multi-star order + anchor edges.
    #[test]
    fn wild_multi_star_order() {
        assert!(wildcard_match("a*b*c", "axbxc"));
        assert!(!wildcard_match("a*b*c", "axcxb"));
        assert!(wildcard_match("**", "anything"));
        assert!(wildcard_match("", "anything"));
        assert!(!wildcard_match("*end", "the ending"));
    }

    // #32 credential hygiene: narrow deny globs catch leaks, miss clean text.
    #[test]
    fn deny_credential_globs() {
        assert!(wildcard_match(
            "*.credentials.yaml*",
            "read $DSH_HOME/.credentials.yaml now"
        ));
        assert!(wildcard_match("*AKIA*", "key AKIAIOSFODNN7EXAMPLE here"));
        assert!(!wildcard_match(
            "*.credentials.yaml*",
            "read the setup guide now"
        ));
    }

    // #33 external input: JSON values flatten, keys/scalars never match.
    #[test]
    fn collect_nested_json_values_only() {
        let raw = r#"{"tool_input": {"cmd": ["run", "rm -rf / x"]}, "n": 42}"#;
        let t = collect_text(raw);
        assert!(t.contains("rm -rf / x"));
        assert!(!t.contains("tool_input"));
        assert!(!t.contains("42"));
        assert!(wildcard_match("rm -rf /*", &t) || wildcard_match("*rm -rf*", &t));
        for scalar in ["123", "true", "null"] {
            assert_eq!(collect_text(scalar), scalar);
        }
    }
}
