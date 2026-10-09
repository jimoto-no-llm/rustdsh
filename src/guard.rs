// rdsh guard: tiny hook command for hooks.json (Claude Code / Codex bridges).
// Scans stdin (hook JSON or raw text) for deny patterns and blocks on match.
// Exit 2 = block with reason on stderr; exit 0 = no deny decision.
//
// Policy notes (Bucket C, issues #29/#30/#32/#33):
// - #29 legacy deny patterns are structural (`a*b`, anchors), not semantic
//   allow-lists; opt-in --policy-file classifies supported file operations.
// - #33 external input: match JSON string values separately so anchors cannot
//   be displaced by metadata. Reject malformed and oversized hook input.
// - #32 credential hygiene: prefer narrow deny globs (e.g. `*.credentials.yaml*`)
//   shared minimally per call, not broad secrets dumped into the prompt.
// - #30 approval ledger: JSON mode emits a block decision or no decision (`{}`).
//   Deny-list misses must never bypass the host's approval policy.
// - #29 structured policy is opt-in: only known file tool schemas are classified;
//   shell commands and unknown tools stay blocked rather than guessed.

use std::path::{Path, PathBuf};

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
    // Empty patterns match everything by definition; ignore them so a
    // misconfigured empty entry (--deny "" or a stray list item) cannot
    // block every hook invocation.
    if matches!(t.as_bytes().first(), Some(b'{') | Some(b'[') | Some(b'"')) {
        let value = serde_json::from_str::<serde_json::Value>(raw)?;
        Ok(deny
            .iter()
            .filter(|p| !p.trim().is_empty())
            .find(|p| matches_value(p, &value)))
    } else {
        Ok(deny
            .iter()
            .filter(|p| !p.trim().is_empty())
            .find(|p| wildcard_match(p, raw)))
    }
}

#[derive(Debug)]
struct PolicyRule {
    id: String,
    tool: String,
    access: &'static str,
    roots: Vec<PathBuf>,
}

#[derive(Debug)]
struct GuardPolicy {
    rules: Vec<PolicyRule>,
}

#[derive(Debug, PartialEq, Eq)]
enum PolicyDecision {
    Allow(String),
    Deny(&'static str),
    Unknown(&'static str),
}

fn exact_keys(value: &serde_json::Value, expected: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn safe_rule_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_".contains(&byte))
}

fn tool_access(tool: &str) -> Option<&'static str> {
    match tool {
        "Read" => Some("read"),
        "Write" | "Edit" => Some("write"),
        _ => None,
    }
}

fn valid_tool_input(tool: &str, input: &serde_json::Map<String, serde_json::Value>) -> bool {
    let allowed = match tool {
        "Read" => &["file_path", "limit", "offset"][..],
        "Write" => &["file_path", "content"][..],
        "Edit" => &["file_path", "old_string", "new_string", "replace_all"][..],
        _ => return false,
    };
    if input.keys().any(|key| !allowed.contains(&key.as_str()))
        || input
            .get("file_path")
            .and_then(serde_json::Value::as_str)
            .is_none()
    {
        return false;
    }
    match tool {
        "Read" => ["limit", "offset"]
            .iter()
            .all(|key| input.get(*key).is_none_or(|value| value.as_u64().is_some())),
        "Write" => input
            .get("content")
            .and_then(serde_json::Value::as_str)
            .is_some(),
        "Edit" => {
            input
                .get("old_string")
                .and_then(serde_json::Value::as_str)
                .is_some()
                && input
                    .get("new_string")
                    .and_then(serde_json::Value::as_str)
                    .is_some()
                && input
                    .get("replace_all")
                    .is_none_or(|value| value.as_bool().is_some())
        }
        _ => false,
    }
}

fn parse_policy(bytes: &[u8]) -> anyhow::Result<GuardPolicy> {
    anyhow::ensure!(bytes.len() <= 64 * 1024, "policy too large");
    let value: serde_json::Value = serde_json::from_slice(bytes)?;
    anyhow::ensure!(
        exact_keys(&value, &["schema", "rules"]),
        "invalid policy schema"
    );
    anyhow::ensure!(
        value["schema"].as_u64() == Some(1),
        "unsupported policy schema"
    );
    let rules = value["rules"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("invalid policy rules"))?;
    anyhow::ensure!(rules.len() <= 128, "too many policy rules");
    let mut output = Vec::with_capacity(rules.len());
    let mut ids = std::collections::HashSet::new();
    for rule in rules {
        anyhow::ensure!(
            exact_keys(rule, &["id", "tool", "access", "roots"]),
            "invalid policy rule"
        );
        let id = rule["id"]
            .as_str()
            .filter(|id| safe_rule_id(id))
            .ok_or_else(|| anyhow::anyhow!("invalid policy rule id"))?;
        anyhow::ensure!(ids.insert(id.to_owned()), "duplicate policy rule id");
        let tool = rule["tool"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalid policy tool"))?;
        let access = tool_access(tool).ok_or_else(|| anyhow::anyhow!("unsupported policy tool"))?;
        anyhow::ensure!(
            rule["access"].as_str() == Some(access),
            "policy access mismatch"
        );
        let roots = rule["roots"]
            .as_array()
            .filter(|roots| !roots.is_empty() && roots.len() <= 32)
            .ok_or_else(|| anyhow::anyhow!("invalid policy roots"))?;
        let mut canonical_roots = Vec::with_capacity(roots.len());
        for root in roots {
            let root = root
                .as_str()
                .filter(|root| root.len() <= 4096)
                .ok_or_else(|| anyhow::anyhow!("invalid policy root"))?;
            let root = PathBuf::from(root);
            anyhow::ensure!(root.is_absolute(), "policy roots must be absolute");
            let root = std::fs::canonicalize(root)?;
            anyhow::ensure!(root.is_dir(), "policy root must be a directory");
            if !canonical_roots.contains(&root) {
                canonical_roots.push(root);
            }
        }
        output.push(PolicyRule {
            id: id.to_owned(),
            tool: tool.to_owned(),
            access,
            roots: canonical_roots,
        });
    }
    Ok(GuardPolicy { rules: output })
}

fn read_policy(path: &str) -> anyhow::Result<GuardPolicy> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    anyhow::ensure!(file.metadata()?.len() <= 64 * 1024, "policy too large");
    let mut bytes = Vec::new();
    file.take(64 * 1024 + 1).read_to_end(&mut bytes)?;
    parse_policy(&bytes)
}

fn resolve_target(target: &str, cwd: &Path, access: &str) -> Result<PathBuf, &'static str> {
    let target = PathBuf::from(target);
    if target.as_os_str().is_empty() {
        return Err("path_unresolved");
    }
    let target = if target.is_absolute() {
        target
    } else {
        cwd.join(target)
    };
    match std::fs::symlink_metadata(&target) {
        Ok(_) => std::fs::canonicalize(target).map_err(|_| "path_unresolved"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && access == "write" => {
            let file_name = target.file_name().ok_or("path_unresolved")?;
            let parent = target.parent().ok_or("path_unresolved")?;
            let parent = std::fs::canonicalize(parent).map_err(|_| "path_unresolved")?;
            Ok(parent.join(file_name))
        }
        Err(_) => Err("path_unavailable"),
    }
}

fn classify_operation(raw: &str, policy: &GuardPolicy) -> PolicyDecision {
    let value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => return PolicyDecision::Unknown("invalid_json"),
    };
    let Some(object) = value.as_object() else {
        return PolicyDecision::Unknown("hook_schema_unsupported");
    };
    let Some(tool) = object.get("tool_name").and_then(serde_json::Value::as_str) else {
        return PolicyDecision::Unknown("hook_schema_unsupported");
    };
    let Some(access) = tool_access(tool) else {
        return PolicyDecision::Unknown(if tool == "Bash" {
            "shell_command_parse_unsupported"
        } else {
            "tool_schema_unsupported"
        });
    };
    let Some(cwd) = object.get("cwd").and_then(serde_json::Value::as_str) else {
        return PolicyDecision::Unknown("cwd_unavailable");
    };
    let cwd = PathBuf::from(cwd);
    if !cwd.is_absolute() {
        return PolicyDecision::Unknown("cwd_unavailable");
    }
    let cwd = match std::fs::canonicalize(cwd) {
        Ok(cwd) if cwd.is_dir() => cwd,
        _ => return PolicyDecision::Unknown("cwd_unavailable"),
    };
    let Some(target) = object
        .get("tool_input")
        .and_then(serde_json::Value::as_object)
        .and_then(|input| input.get("file_path"))
        .and_then(serde_json::Value::as_str)
    else {
        return PolicyDecision::Unknown("tool_schema_unsupported");
    };
    let Some(input) = object
        .get("tool_input")
        .and_then(serde_json::Value::as_object)
    else {
        return PolicyDecision::Unknown("tool_schema_unsupported");
    };
    if !valid_tool_input(tool, input) {
        return PolicyDecision::Unknown("tool_schema_unsupported");
    }
    let target = match resolve_target(target, &cwd, access) {
        Ok(target) => target,
        Err(reason) => return PolicyDecision::Unknown(reason),
    };
    let matching_tool = policy
        .rules
        .iter()
        .filter(|rule| rule.tool == tool && rule.access == access)
        .collect::<Vec<_>>();
    if matching_tool.is_empty() {
        return PolicyDecision::Deny("tool_not_allowed");
    }
    if let Some(rule) = matching_tool
        .into_iter()
        .find(|rule| rule.roots.iter().any(|root| target.starts_with(root)))
    {
        PolicyDecision::Allow(rule.id.clone())
    } else {
        PolicyDecision::Deny("path_outside_allowed_root")
    }
}

fn emit_policy_decision(decision: PolicyDecision, json_out: bool) {
    match decision {
        PolicyDecision::Allow(rule_id) => {
            if json_out {
                println!(
                    "{}",
                    serde_json::json!({
                        "classification": "allow",
                        "reason": "structured_policy_match",
                        "rule_id": rule_id
                    })
                );
            }
        }
        PolicyDecision::Deny(reason) => emit_policy_block("deny", reason, json_out),
        PolicyDecision::Unknown(reason) => emit_policy_block("unknown", reason, json_out),
    }
}

fn emit_policy_block(classification: &str, reason: &str, json_out: bool) {
    if json_out {
        println!(
            "{}",
            serde_json::json!({
                "decision": "block",
                "classification": classification,
                "reason": reason
            })
        );
    } else {
        eprintln!("rdsh guard: {reason}");
        std::process::exit(2);
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

pub fn cmd_guard(
    deny: Vec<String>,
    reason: Option<String>,
    json_out: bool,
    policy_file: Option<String>,
) -> anyhow::Result<()> {
    use std::io::Read;
    const MAX_INPUT: u64 = 1024 * 1024;
    let policy = match policy_file {
        Some(path) => match read_policy(&path) {
            Ok(policy) => Some(policy),
            Err(_) => {
                emit_policy_block("unknown", "policy_unavailable", json_out);
                return Ok(());
            }
        },
        None => None,
    };
    let mut raw = String::new();
    if std::io::stdin()
        .take(MAX_INPUT + 1)
        .read_to_string(&mut raw)
        .is_err()
        || raw.len() as u64 > MAX_INPUT
    {
        if policy.is_some() {
            emit_policy_block("unknown", "input_unavailable_or_oversized", json_out);
        } else {
            block("rdsh guard: unreadable or oversized input", json_out);
        }
        return Ok(());
    }
    let hit = match denied_pattern(&raw, &deny) {
        Ok(hit) => hit,
        Err(_) if policy.is_some() => {
            emit_policy_block("unknown", "invalid_json", json_out);
            return Ok(());
        }
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
            if let Some(policy) = policy {
                emit_policy_decision(classify_operation(&raw, &policy), json_out);
            } else if json_out {
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

    #[test]
    fn empty_patterns_never_match() {
        for pattern in ["", "   "] {
            assert!(denied_pattern("anything at all", &[pattern.into()])
                .unwrap()
                .is_none());
            assert!(denied_pattern(r#"{"a":"b"}"#, &[pattern.into()])
                .unwrap()
                .is_none());
        }
    }

    struct TestTree(PathBuf);

    impl TestTree {
        fn new() -> Self {
            use std::sync::atomic::{AtomicUsize, Ordering};
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "rdsh-guard-policy-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn test_policy(root: &Path) -> GuardPolicy {
        parse_policy(
            &serde_json::json!({
                "schema": 1,
                "rules": [{
                    "id": "project-read",
                    "tool": "Read",
                    "access": "read",
                    "roots": [root.to_string_lossy()]
                }]
            })
            .to_string()
            .into_bytes(),
        )
        .unwrap()
    }

    #[test]
    fn structured_policy_uses_tool_path_and_cwd_not_matching_text() {
        let tree = TestTree::new();
        let project = tree.path().join("project");
        let outside = tree.path().join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(project.join("same.txt"), "same operation text").unwrap();
        std::fs::write(outside.join("same.txt"), "same operation text").unwrap();
        let policy = test_policy(&project);
        let hook = |cwd: &Path, tool: &str, file: &str| {
            let tool_input = if tool == "Write" {
                serde_json::json!({ "file_path": file, "content": "same operation text" })
            } else {
                serde_json::json!({ "file_path": file })
            };
            serde_json::json!({
                "cwd": cwd,
                "description": "same operation text",
                "tool_name": tool,
                "tool_input": tool_input
            })
            .to_string()
        };
        assert_eq!(
            classify_operation(&hook(&project, "Read", "same.txt"), &policy),
            PolicyDecision::Allow("project-read".into())
        );
        let paged_read = serde_json::json!({
            "cwd": project.to_string_lossy(),
            "description": "same operation text",
            "tool_name": "Read",
            "tool_input": { "file_path": "same.txt", "offset": 4, "limit": 12 }
        })
        .to_string();
        assert_eq!(
            classify_operation(&paged_read, &policy),
            PolicyDecision::Allow("project-read".into())
        );
        let denied = classify_operation(&hook(&outside, "Read", "same.txt"), &policy);
        assert_eq!(denied, PolicyDecision::Deny("path_outside_allowed_root"));
        let write = classify_operation(&hook(&project, "Write", "same.txt"), &policy);
        assert_eq!(write, PolicyDecision::Deny("tool_not_allowed"));
        assert!(!format!("{denied:?}").contains(outside.to_string_lossy().as_ref()));
    }

    #[test]
    fn structured_policy_denies_relative_escape() {
        let tree = TestTree::new();
        let project = tree.path().join("project");
        let outside = tree.path().join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "never report this path").unwrap();
        let policy = test_policy(&project);
        let project_cwd = project.to_string_lossy().to_string();
        let operation = |file: &str| {
            serde_json::json!({
                "cwd": project_cwd,
                "tool_name": "Read",
                "tool_input": { "file_path": file }
            })
            .to_string()
        };
        assert_eq!(
            classify_operation(&operation("../outside/secret.txt"), &policy),
            PolicyDecision::Deny("path_outside_allowed_root")
        );
    }

    #[cfg(unix)]
    #[test]
    fn structured_policy_denies_symlinks_outside_root() {
        use std::os::unix::fs::symlink;
        let tree = TestTree::new();
        let project = tree.path().join("project");
        let outside = tree.path().join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "never report this path").unwrap();
        symlink(outside.join("secret.txt"), project.join("escape.txt")).unwrap();
        let policy = test_policy(&project);
        let project_cwd = project.to_string_lossy().to_string();
        let operation = |file: &str| {
            serde_json::json!({
                "cwd": project_cwd,
                "tool_name": "Read",
                "tool_input": { "file_path": file }
            })
            .to_string()
        };
        assert_eq!(
            classify_operation(&operation("escape.txt"), &policy),
            PolicyDecision::Deny("path_outside_allowed_root")
        );
    }

    #[test]
    fn unsupported_shell_and_malformed_hook_do_not_become_allows() {
        let tree = TestTree::new();
        let policy = test_policy(tree.path());
        let shell = serde_json::json!({
            "cwd": tree.path().to_string_lossy(),
            "tool_name": "Bash",
            "tool_input": { "command": "cat secret.txt" }
        })
        .to_string();
        assert_eq!(
            classify_operation(&shell, &policy),
            PolicyDecision::Unknown("shell_command_parse_unsupported")
        );
        assert_eq!(
            classify_operation("{broken", &policy),
            PolicyDecision::Unknown("invalid_json")
        );
        let unknown = serde_json::json!({
            "cwd": tree.path().to_string_lossy(),
            "tool_name": "network_fetch",
            "tool_input": { "url": "https://example.invalid" }
        })
        .to_string();
        assert_eq!(
            classify_operation(&unknown, &policy),
            PolicyDecision::Unknown("tool_schema_unsupported")
        );
        let unknown_argument = serde_json::json!({
            "cwd": tree.path().to_string_lossy(),
            "tool_name": "Read",
            "tool_input": { "file_path": "secret.txt", "command": "cat secret.txt" }
        })
        .to_string();
        assert_eq!(
            classify_operation(&unknown_argument, &policy),
            PolicyDecision::Unknown("tool_schema_unsupported")
        );
        let relative_cwd = serde_json::json!({
            "cwd": ".",
            "tool_name": "Read",
            "tool_input": { "file_path": "secret.txt" }
        })
        .to_string();
        assert_eq!(
            classify_operation(&relative_cwd, &policy),
            PolicyDecision::Unknown("cwd_unavailable")
        );
    }

    #[test]
    fn invalid_policy_fields_and_roots_are_rejected() {
        let unknown = br#"{"schema":1,"rules":[],"default":"allow"}"#;
        assert!(parse_policy(unknown).is_err());
        let relative = br#"{"schema":1,"rules":[{"id":"bad","tool":"Read","access":"read","roots":["relative"]}]}"#;
        assert!(parse_policy(relative).is_err());
        let unsupported =
            br#"{"schema":1,"rules":[{"id":"shell","tool":"Bash","access":"read","roots":["/"]}]}"#;
        assert!(parse_policy(unsupported).is_err());
    }
}
