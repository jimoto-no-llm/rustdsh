// rdsh guard: tiny hook command for hooks.json (Claude Code / Codex bridges).
// Scans stdin (hook JSON or raw text) for deny patterns and blocks on match.
// Exit 2 = block with reason on stderr; exit 0 = no deny decision.
//
// Policy notes (Bucket C, issues #29/#30/#32/#33):
// - #29 operation structure: deny patterns are structural (`a*b`, anchors),
//   not semantic allow-lists; unanchored text matches as substring.
// - #33 external input: match JSON string values separately so anchors cannot
//   be displaced by metadata. Reject malformed and oversized hook input.
// - #32 credential hygiene: prefer narrow deny globs (e.g. `*.credentials.yaml*`)
//   shared minimally per call, not broad secrets dumped into the prompt.
// - #30 approval ledger: JSON mode emits a block decision or no decision (`{}`).
//   Deny-list misses must never bypass the host's approval policy.

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
fn matches_value(pattern: &str, value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(s) => wildcard_match(pattern, s),
        serde_json::Value::Array(a) => a.iter().any(|v| matches_value(pattern, v)),
        serde_json::Value::Object(m) => m.values().any(|v| matches_value(pattern, v)),
        _ => false,
    }
}

fn denied_pattern<'a>(raw: &str, deny: &'a [String]) -> anyhow::Result<Option<&'a String>> {
    let t = raw.trim_start();
    if matches!(t.as_bytes().first(), Some(b'{') | Some(b'[') | Some(b'"')) {
        let value = serde_json::from_str::<serde_json::Value>(raw)?;
        Ok(deny.iter().find(|p| matches_value(p, &value)))
    } else {
        Ok(deny.iter().find(|p| wildcard_match(p, raw)))
    }
}

fn block(msg: &str, json_out: bool) {
    if json_out {
        println!(
            "{}",
            serde_json::json!({"decision": "block", "reason": msg})
        );
    } else {
        eprintln!("{msg}");
        std::process::exit(2);
    }
}

pub fn cmd_guard(deny: Vec<String>, reason: Option<String>, json_out: bool) -> anyhow::Result<()> {
    use std::io::Read;
    const MAX_INPUT: u64 = 1024 * 1024;
    let mut raw = String::new();
    if std::io::stdin()
        .take(MAX_INPUT + 1)
        .read_to_string(&mut raw)
        .is_err()
        || raw.len() as u64 > MAX_INPUT
    {
        block("rdsh guard: unreadable or oversized input", json_out);
        return Ok(());
    }
    let hit = match denied_pattern(&raw, &deny) {
        Ok(hit) => hit,
        Err(_) => {
            block("rdsh guard: invalid JSON input", json_out);
            return Ok(());
        }
    };
    match hit {
        Some(p) => {
            let msg = reason.unwrap_or_else(|| "blocked by rdsh guard".to_owned());
            eprintln!("[rdsh guard] pattern hit: {}", p);
            block(&msg, json_out);
            Ok(())
        }
        None => {
            if json_out {
                // A deny-list miss is not authority to bypass the host's approval policy.
                println!("{{}}");
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
        assert!(denied_pattern("plain text here", &["plain*".into()])
            .unwrap()
            .is_some());
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

    // #33 external input: JSON string values match; keys/scalars never match.
    #[test]
    fn collect_nested_json_values_only() {
        let raw = r#"{"tool_input": {"cmd": ["run", "rm -rf / x"]}, "n": 42}"#;
        assert!(denied_pattern(raw, &["rm -rf /*".into()])
            .unwrap()
            .is_some());
        for pattern in ["tool_input", "42"] {
            assert!(denied_pattern(raw, &[pattern.into()]).unwrap().is_none());
        }
    }

    #[test]
    fn anchored_pattern_matches_command_inside_hook_payload() {
        let raw = r#"{"cwd":"/tmp/example","tool_name":"Bash","tool_input":{"description":"List files","command":"rm -rf / example"}}"#;
        assert!(denied_pattern(raw, &["rm -rf /*".into()])
            .unwrap()
            .is_some());
    }
}
