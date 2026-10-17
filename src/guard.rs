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
// - Boundary note: this is a best-effort misoperation guard, not a sandbox.
//   Patterns are bypassable by construction (case, splitting, aliases), so
//   critical operations must rely on tool isolation, not on deny-list hits.
// - #29 structured policy is opt-in: only known file tool schemas are classified;
//   shell commands and unknown tools stay blocked rather than guessed.
// - Priority 3 shell hardening: command strings are quote-stripped, tokenized and
//   variable-expanded into bounded candidate texts before the same structural
//   patterns match, and path arguments are folded/resolved against the hook cwd.
//   Candidates only add matches; a pattern never becomes an allow-list.

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
// Priority 3 shell-awareness: deny patterns stay structural (wildcards and
// anchors), not semantic allow-lists (#29). Normalization only adds candidate
// texts that the same wildcard matcher sees, so quoting (r"m" -rf), same-line
// variable assembly (A=rm; $A -rf) and path traversal (/tmp/../important) can
// no longer displace a pattern. Everything is bounded so the PreToolUse hook
// keeps its sub-millisecond budget.

/// Values above this size are matched exactly: no character-by-character
/// normalization, so an oversized payload cannot slow the hook down.
const MAX_NORMALIZED_INPUT: usize = 16 * 1024;
/// Bound on candidate texts derived from one input string.
const MAX_NORMALIZED_CANDIDATES: usize = 16;
/// Bound on shell words kept from one command string.
const MAX_SHELL_WORDS: usize = 512;
/// Bound on filesystem probes (canonicalize) per hook invocation.
const MAX_PATH_PROBES: usize = 8;

/// Split one shell command into words, dropping quotes and treating control
/// operators (semicolon, pipe, ampersand, newline, parentheses, redirections)
/// as segment boundaries. Returns one word list per segment. This is a bounded
/// approximation of shell word splitting, not a full POSIX parser.
fn shell_segments(command: &str) -> Vec<Vec<String>> {
    let mut segments = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut has_word = false;
    let mut single = false;
    let mut double = false;
    let mut backtick = false;
    let mut escaped = false;
    let mut total = 0usize;

    fn flush(words: &mut Vec<String>, word: &mut String, has_word: &mut bool, total: &mut usize) {
        if *has_word {
            *total += 1;
            words.push(std::mem::take(word));
            *has_word = false;
        } else {
            word.clear();
        }
    }

    for ch in command.chars() {
        if escaped {
            word.push(ch);
            has_word = true;
            escaped = false;
            continue;
        }
        if single {
            if ch == '\u{27}' {
                single = false;
            } else {
                word.push(ch);
            }
            continue;
        }
        if backtick {
            if ch == '\u{60}' {
                backtick = false;
            } else {
                word.push(ch);
            }
            continue;
        }
        if double {
            match ch {
                '"' => double = false,
                '\u{5c}' => escaped = true,
                _ => word.push(ch),
            }
            continue;
        }
        match ch {
            '\u{5c}' => {
                escaped = true;
                has_word = true;
            }
            '\u{27}' => {
                single = true;
                has_word = true;
            }
            '"' => {
                double = true;
                has_word = true;
            }
            '\u{60}' => {
                backtick = true;
                has_word = true;
            }
            ';' | '|' | '&' | '(' | ')' | '<' | '>' => {
                flush(&mut words, &mut word, &mut has_word, &mut total);
                if !words.is_empty() {
                    segments.push(std::mem::take(&mut words));
                }
            }
            _ if ch.is_whitespace() => {
                flush(&mut words, &mut word, &mut has_word, &mut total);
            }
            _ => {
                word.push(ch);
                has_word = true;
            }
        }
        if total >= MAX_SHELL_WORDS {
            break;
        }
    }
    flush(&mut words, &mut word, &mut has_word, &mut total);
    if !words.is_empty() {
        segments.push(words);
    }
    segments
}

/// NAME=value at the start of a segment (optionally after a launcher word).
fn split_assignment(word: &str) -> Option<(&str, &str)> {
    let (name, value) = word.split_once('=')?;
    let mut chars = name.chars();
    let first = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    Some((name, value))
}

fn shell_assignments(segments: &[Vec<String>]) -> Vec<(String, String)> {
    let mut variables: Vec<(String, String)> = Vec::new();
    for segment in segments {
        let mut index = 0;
        while let Some(word) = segment.get(index) {
            if matches!(
                word.as_str(),
                "export" | "env" | "command" | "nohup" | "exec" | "time"
            ) {
                index += 1;
                continue;
            }
            let Some((name, value)) = split_assignment(word) else {
                break;
            };
            match variables.iter_mut().find(|(known, _)| known == name) {
                Some(entry) => entry.1 = value.to_owned(),
                None => variables.push((name.to_owned(), value.to_owned())),
            }
            index += 1;
        }
    }
    variables
}

/// Substitute dollar-variable references outside single quotes, bounded to a
/// few rounds so chained same-line assignments (A=rm; B=$A; $B -rf) resolve.
fn expand_variables(command: &str, variables: &[(String, String)]) -> String {
    if variables.is_empty() || !command.contains('$') {
        return command.to_owned();
    }
    let mut current = command.to_owned();
    for _ in 0..4 {
        let next = expand_variables_once(&current, variables);
        if next == current {
            break;
        }
        current = next;
        if current.len() > MAX_NORMALIZED_INPUT {
            break;
        }
    }
    current
}

fn expand_variables_once(input: &str, variables: &[(String, String)]) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut single = false;
    let mut double = false;
    while let Some(ch) = chars.next() {
        match ch {
            '\u{5c}' if !single => {
                output.push(ch);
                if let Some(next) = chars.next() {
                    output.push(next);
                }
            }
            '\u{27}' if !double => {
                single = !single;
                output.push(ch);
            }
            '"' if !single => {
                double = !double;
                output.push(ch);
            }
            '$' if !single => {
                let braced = chars.peek() == Some(&'{');
                if braced {
                    chars.next();
                }
                let mut name = String::new();
                while let Some(&next) = chars.peek() {
                    if next.is_ascii_alphanumeric() || next == '_' {
                        name.push(next);
                        chars.next();
                    } else {
                        break;
                    }
                }
                if braced && chars.peek() != Some(&'}') {
                    output.push('$');
                    output.push('{');
                    output.push_str(&name);
                    continue;
                }
                if braced {
                    chars.next();
                }
                match variables.iter().find(|(known, _)| *known == name) {
                    Some((_, value)) => output.push_str(value),
                    None => {
                        output.push('$');
                        if braced {
                            output.push('{');
                        }
                        output.push_str(&name);
                        if braced {
                            output.push('}');
                        }
                    }
                }
            }
            _ => output.push(ch),
        }
    }
    output
}

fn push_candidate(out: &mut Vec<String>, candidate: String) {
    if candidate.is_empty()
        || out.len() >= MAX_NORMALIZED_CANDIDATES
        || out.iter().any(|existing| existing == &candidate)
    {
        return;
    }
    out.push(candidate);
}

fn push_segment_candidates(out: &mut Vec<String>, segments: &[Vec<String>]) {
    let joined = segments
        .iter()
        .flatten()
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");
    push_candidate(out, joined);
    for segment in segments {
        push_candidate(out, segment.join(" "));
    }
}

/// Fold '.' and '..' segments without touching the filesystem.
fn lexical_normalize_path(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let mut output = String::new();
    if absolute {
        output.push('/');
    }
    output.push_str(&parts.join("/"));
    if path.ends_with('/') && !output.ends_with('/') {
        output.push('/');
    }
    if output.is_empty() {
        output.push(if absolute { '/' } else { '.' });
    }
    output
}

/// Resolve one path-like word: lexical dot-dot folding, then canonicalize
/// against the hook's cwd so symlinks point at their real target. The guard's
/// own working directory is never used as the base.
fn normalize_path_word(word: &str, cwd: Option<&Path>, probes: &mut usize) -> Option<String> {
    let mut normalized = None;
    if word.contains('/') {
        let lexical = lexical_normalize_path(word);
        if lexical != word {
            normalized = Some(lexical);
        }
    }
    // Only canonicalize needs a filesystem base. A hook may carry no cwd (plain
    // text) or a cwd this platform rejects as absolute (bash-style "/tmp" on
    // Windows); the lexical fold above must survive either way.
    let Some(base) = cwd else {
        return normalized;
    };
    if *probes >= MAX_PATH_PROBES || word.len() > 4096 {
        return normalized;
    }
    *probes += 1;
    let candidate = if Path::new(word).is_absolute() {
        PathBuf::from(word)
    } else {
        base.join(word)
    };
    if let Ok(resolved) = std::fs::canonicalize(&candidate) {
        if let Some(resolved) = resolved.to_str() {
            if resolved != word {
                normalized = Some(resolved.to_owned());
            }
        }
    }
    normalized
}

/// All normalized forms of one input string, bounded and deduplicated.
fn command_candidates(command: &str, cwd: Option<&Path>, probes: &mut usize) -> Vec<String> {
    let mut out = Vec::new();
    let segments = shell_segments(command);
    push_segment_candidates(&mut out, &segments);

    let variables = shell_assignments(&segments);
    let expanded = if variables.is_empty() {
        segments
    } else {
        shell_segments(&expand_variables(command, &variables))
    };
    if !variables.is_empty() {
        push_segment_candidates(&mut out, &expanded);
    }

    // Command-name normalization: an absolute command scans as its basename.
    for segment in &expanded {
        if out.len() >= MAX_NORMALIZED_CANDIDATES {
            break;
        }
        let Some(first) = segment.first() else {
            continue;
        };
        let Some((_, base)) = first.rsplit_once('/') else {
            continue;
        };
        if base.is_empty() || base == first {
            continue;
        }
        let mut variant = segment.clone();
        variant[0] = base.to_owned();
        push_candidate(&mut out, variant.join(" "));
    }

    // A quoted word can carry a whole nested command (sh -c "rm -rf /",
    // backticks). Re-scan a whitespace-bearing word on its own so the nested
    // command name still sits at the pattern anchor.
    'quoted: for segment in &expanded {
        for word in segment {
            if out.len() >= MAX_NORMALIZED_CANDIDATES {
                break 'quoted;
            }
            if !word.contains(char::is_whitespace) {
                continue;
            }
            push_segment_candidates(&mut out, &shell_segments(word));
        }
    }

    // Path normalization: dot-dot folding plus symlink resolution.
    'segments: for segment in &expanded {
        for (index, word) in segment.iter().enumerate() {
            if out.len() >= MAX_NORMALIZED_CANDIDATES || *probes >= MAX_PATH_PROBES {
                break 'segments;
            }
            if word.is_empty() || word.starts_with('-') || word.contains('=') {
                continue;
            }
            let Some(normalized) = normalize_path_word(word, cwd, probes) else {
                continue;
            };
            let mut variant = segment.clone();
            variant[index] = normalized;
            push_candidate(&mut out, variant.join(" "));
        }
    }
    out
}

fn hook_cwd(value: &serde_json::Value) -> Option<PathBuf> {
    value
        .get("cwd")
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn matches_text(pattern: &str, text: &str, cwd: Option<&Path>, probes: &mut usize) -> bool {
    if wildcard_match(pattern, text) {
        return true;
    }
    if text.len() > MAX_NORMALIZED_INPUT {
        return false;
    }
    command_candidates(text, cwd, probes)
        .iter()
        .any(|candidate| wildcard_match(pattern, candidate))
}

fn matches_value(
    pattern: &str,
    value: &serde_json::Value,
    cwd: Option<&Path>,
    probes: &mut usize,
) -> bool {
    match value {
        serde_json::Value::String(s) => matches_text(pattern, s, cwd, probes),
        serde_json::Value::Array(a) => a.iter().any(|v| matches_value(pattern, v, cwd, probes)),
        serde_json::Value::Object(m) => m.values().any(|v| matches_value(pattern, v, cwd, probes)),
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
        let cwd = hook_cwd(&value);
        let mut probes = 0usize;
        Ok(deny
            .iter()
            .filter(|p| !p.trim().is_empty())
            .find(|p| matches_value(p, &value, cwd.as_deref(), &mut probes)))
    } else {
        let mut probes = 0usize;
        Ok(deny
            .iter()
            .filter(|p| !p.trim().is_empty())
            .find(|p| matches_text(p, raw, None, &mut probes)))
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

fn parse_policy(bytes: &[u8], locale: crate::locale::Locale) -> anyhow::Result<GuardPolicy> {
    anyhow::ensure!(
        bytes.len() <= 64 * 1024,
        "{}",
        policy_reason(locale, "policy too large")
    );
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|error| {
        anyhow::anyhow!("{}: {error}", policy_reason(locale, "invalid policy JSON"))
    })?;
    anyhow::ensure!(
        exact_keys(&value, &["schema", "rules"]),
        "{}",
        policy_reason(locale, "invalid policy schema")
    );
    anyhow::ensure!(
        value["schema"].as_u64() == Some(1),
        "{}",
        policy_reason(locale, "unsupported policy schema")
    );
    let rules = value["rules"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("{}", policy_reason(locale, "invalid policy rules")))?;
    anyhow::ensure!(
        rules.len() <= 128,
        "{}",
        policy_reason(locale, "too many policy rules")
    );
    let mut output = Vec::with_capacity(rules.len());
    let mut ids = std::collections::HashSet::new();
    for rule in rules {
        anyhow::ensure!(
            exact_keys(rule, &["id", "tool", "access", "roots"]),
            "{}",
            policy_reason(locale, "invalid policy rule")
        );
        let id = rule["id"]
            .as_str()
            .filter(|id| safe_rule_id(id))
            .ok_or_else(|| {
                anyhow::anyhow!("{}", policy_reason(locale, "invalid policy rule id"))
            })?;
        anyhow::ensure!(
            ids.insert(id.to_owned()),
            "{}",
            policy_reason(locale, "duplicate policy rule id")
        );
        let tool = rule["tool"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("{}", policy_reason(locale, "invalid policy tool")))?;
        let access = tool_access(tool).ok_or_else(|| {
            anyhow::anyhow!("{}", policy_reason(locale, "unsupported policy tool"))
        })?;
        anyhow::ensure!(
            rule["access"].as_str() == Some(access),
            "{}",
            policy_reason(locale, "policy access mismatch")
        );
        let roots = rule["roots"]
            .as_array()
            .filter(|roots| !roots.is_empty() && roots.len() <= 32)
            .ok_or_else(|| anyhow::anyhow!("{}", policy_reason(locale, "invalid policy roots")))?;
        let mut canonical_roots = Vec::with_capacity(roots.len());
        for root in roots {
            let root = root
                .as_str()
                .filter(|root| root.len() <= 4096)
                .ok_or_else(|| {
                    anyhow::anyhow!("{}", policy_reason(locale, "invalid policy root"))
                })?;
            let root = PathBuf::from(root);
            anyhow::ensure!(
                root.is_absolute(),
                "{}",
                policy_reason(locale, "policy roots must be absolute")
            );
            let root = std::fs::canonicalize(&root).map_err(|error| {
                anyhow::anyhow!(
                    "{} {}: {error}",
                    policy_reason(locale, "cannot resolve policy root"),
                    root.display()
                )
            })?;
            anyhow::ensure!(
                root.is_dir(),
                "{}",
                policy_reason(locale, "policy root must be a directory")
            );
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

fn read_policy(path: &str, locale: crate::locale::Locale) -> anyhow::Result<GuardPolicy> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|error| {
        anyhow::anyhow!(
            "{} {path}: {error}",
            policy_reason(locale, "cannot read policy file")
        )
    })?;
    let metadata = file.metadata().map_err(|error| {
        anyhow::anyhow!(
            "{} {path}: {error}",
            policy_reason(locale, "cannot inspect policy file")
        )
    })?;
    anyhow::ensure!(
        metadata.len() <= 64 * 1024,
        "{}",
        policy_reason(locale, "policy too large")
    );
    let mut bytes = Vec::new();
    file.take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            anyhow::anyhow!(
                "{} {path}: {error}",
                policy_reason(locale, "cannot read policy file")
            )
        })?;
    parse_policy(&bytes, locale)
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

fn emit_policy_decision(decision: PolicyDecision, json_out: bool, locale: crate::locale::Locale) {
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
        PolicyDecision::Deny(reason) => emit_policy_block("deny", reason, json_out, locale),
        PolicyDecision::Unknown(reason) => emit_policy_block("unknown", reason, json_out, locale),
    }
}

fn emit_policy_block(
    classification: &str,
    reason: &str,
    json_out: bool,
    locale: crate::locale::Locale,
) {
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
        eprintln!(
            "{}: {}",
            crate::locale::ui_message(locale, crate::locale::UiMessage::Guard),
            policy_reason(locale, reason)
        );
        std::process::exit(2);
    }
}

fn policy_reason(locale: crate::locale::Locale, reason: &str) -> &str {
    if locale == crate::locale::Locale::English {
        return reason;
    }
    match (locale, reason) {
        (crate::locale::Locale::Chinese, "policy_unavailable") => "策略不可用",
        (crate::locale::Locale::Japanese, "policy_unavailable") => "ポリシーを利用できません",
        (crate::locale::Locale::Chinese, "policy too large") => "策略过大",
        (crate::locale::Locale::Japanese, "policy too large") => "ポリシーが大きすぎます",
        (crate::locale::Locale::Chinese, "invalid policy JSON") => "无效的策略 JSON",
        (crate::locale::Locale::Japanese, "invalid policy JSON") => "無効なポリシー JSON",
        (crate::locale::Locale::Chinese, "invalid policy schema") => "无效的策略架构",
        (crate::locale::Locale::Japanese, "invalid policy schema") => "無効なポリシースキーマ",
        (crate::locale::Locale::Chinese, "unsupported policy schema") => "不支持的策略架构",
        (crate::locale::Locale::Japanese, "unsupported policy schema") => {
            "未対応のポリシースキーマ"
        }
        (crate::locale::Locale::Chinese, "invalid policy rules") => "无效的策略规则",
        (crate::locale::Locale::Japanese, "invalid policy rules") => "無効なポリシールール",
        (crate::locale::Locale::Chinese, "too many policy rules") => "策略规则过多",
        (crate::locale::Locale::Japanese, "too many policy rules") => "ポリシールールが多すぎます",
        (crate::locale::Locale::Chinese, "invalid policy rule") => "无效的策略规则",
        (crate::locale::Locale::Japanese, "invalid policy rule") => "無効なポリシールール",
        (crate::locale::Locale::Chinese, "invalid policy rule id") => "无效的策略规则 ID",
        (crate::locale::Locale::Japanese, "invalid policy rule id") => "無効なポリシールール ID",
        (crate::locale::Locale::Chinese, "duplicate policy rule id") => "重复的策略规则 ID",
        (crate::locale::Locale::Japanese, "duplicate policy rule id") => {
            "重複したポリシールール ID"
        }
        (crate::locale::Locale::Chinese, "invalid policy tool") => "无效的策略工具",
        (crate::locale::Locale::Japanese, "invalid policy tool") => "無効なポリシーツール",
        (crate::locale::Locale::Chinese, "unsupported policy tool") => "不支持的策略工具",
        (crate::locale::Locale::Japanese, "unsupported policy tool") => "未対応のポリシーツール",
        (crate::locale::Locale::Chinese, "policy access mismatch") => "策略访问权限不匹配",
        (crate::locale::Locale::Japanese, "policy access mismatch") => {
            "ポリシーアクセスが一致しません"
        }
        (crate::locale::Locale::Chinese, "invalid policy roots") => "无效的策略根目录",
        (crate::locale::Locale::Japanese, "invalid policy roots") => "無効なポリシールート",
        (crate::locale::Locale::Chinese, "invalid policy root") => "无效的策略根目录",
        (crate::locale::Locale::Japanese, "invalid policy root") => "無効なポリシールート",
        (crate::locale::Locale::Chinese, "policy roots must be absolute") => {
            "策略根目录必须为绝对路径"
        }
        (crate::locale::Locale::Japanese, "policy roots must be absolute") => {
            "ポリシールートは絶対パスである必要があります"
        }
        (crate::locale::Locale::Chinese, "cannot resolve policy root") => "无法解析策略根目录",
        (crate::locale::Locale::Japanese, "cannot resolve policy root") => {
            "ポリシールートを解決できません"
        }
        (crate::locale::Locale::Chinese, "policy root must be a directory") => {
            "策略根目录必须是目录"
        }
        (crate::locale::Locale::Japanese, "policy root must be a directory") => {
            "ポリシールートはディレクトリである必要があります"
        }
        (crate::locale::Locale::Chinese, "cannot read policy file") => "无法读取策略文件",
        (crate::locale::Locale::Japanese, "cannot read policy file") => {
            "ポリシーファイルを読み込めません"
        }
        (crate::locale::Locale::Chinese, "cannot inspect policy file") => "无法检查策略文件",
        (crate::locale::Locale::Japanese, "cannot inspect policy file") => {
            "ポリシーファイルを確認できません"
        }
        (crate::locale::Locale::Chinese, "input_unavailable_or_oversized") => "输入不可用或过大",
        (crate::locale::Locale::Japanese, "input_unavailable_or_oversized") => {
            "入力を利用できないか大きすぎます"
        }
        (crate::locale::Locale::Chinese, "invalid_json") => "无效的 JSON",
        (crate::locale::Locale::Japanese, "invalid_json") => "無効な JSON",
        (crate::locale::Locale::Chinese, "hook_schema_unsupported") => "不支持的 Hook 架构",
        (crate::locale::Locale::Japanese, "hook_schema_unsupported") => {
            "Hook スキーマに対応していません"
        }
        (crate::locale::Locale::Chinese, "shell_command_parse_unsupported") => {
            "不支持的 shell 命令解析"
        }
        (crate::locale::Locale::Japanese, "shell_command_parse_unsupported") => {
            "shell コマンド解析に対応していません"
        }
        (crate::locale::Locale::Chinese, "tool_schema_unsupported") => "不支持的工具架构",
        (crate::locale::Locale::Japanese, "tool_schema_unsupported") => {
            "ツールスキーマに対応していません"
        }
        (crate::locale::Locale::Chinese, "cwd_unavailable") => "当前目录不可用",
        (crate::locale::Locale::Japanese, "cwd_unavailable") => {
            "現在のディレクトリを利用できません"
        }
        (crate::locale::Locale::Chinese, "path_unresolved") => "无法解析路径",
        (crate::locale::Locale::Japanese, "path_unresolved") => "パスを解決できません",
        (crate::locale::Locale::Chinese, "path_unavailable") => "路径不可用",
        (crate::locale::Locale::Japanese, "path_unavailable") => "パスを利用できません",
        (crate::locale::Locale::Chinese, "tool_not_allowed") => "不允许该工具",
        (crate::locale::Locale::Japanese, "tool_not_allowed") => "このツールは許可されていません",
        (crate::locale::Locale::Chinese, "path_outside_allowed_root") => "路径不在允许的根目录内",
        (crate::locale::Locale::Japanese, "path_outside_allowed_root") => {
            "パスが許可されたルート外です"
        }
        _ => reason,
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
    locale: crate::locale::Locale,
) -> anyhow::Result<()> {
    use std::io::Read;
    const MAX_INPUT: u64 = 1024 * 1024;
    if deny.iter().all(|p| p.trim().is_empty()) {
        eprintln!("[rdsh guard] warning: no deny patterns configured; this hook is a best-effort aid, not a security boundary");
    }
    let policy = match policy_file {
        Some(path) => match read_policy(&path, locale) {
            Ok(policy) => Some(policy),
            Err(error) => {
                if json_out {
                    emit_policy_block("unknown", "policy_unavailable", true, locale);
                } else {
                    eprintln!(
                        "{}: {error:#}",
                        crate::locale::ui_message(locale, crate::locale::UiMessage::Guard)
                    );
                    std::process::exit(2);
                }
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
            emit_policy_block(
                "unknown",
                "input_unavailable_or_oversized",
                json_out,
                locale,
            );
        } else {
            let message_locale = if json_out {
                crate::locale::Locale::English
            } else {
                locale
            };
            block(
                &format!(
                    "{}: {}",
                    crate::locale::ui_message(message_locale, crate::locale::UiMessage::Guard),
                    crate::locale::ui_message(
                        message_locale,
                        crate::locale::UiMessage::UnreadableOrOversizedInput
                    )
                ),
                json_out,
            );
        }
        return Ok(());
    }
    let hit = match denied_pattern(&raw, &deny) {
        Ok(hit) => hit,
        Err(_) if policy.is_some() => {
            emit_policy_block("unknown", "invalid_json", json_out, locale);
            return Ok(());
        }
        Err(_) => {
            let message_locale = if json_out {
                crate::locale::Locale::English
            } else {
                locale
            };
            block(
                &format!(
                    "{}: {}",
                    crate::locale::ui_message(message_locale, crate::locale::UiMessage::Guard),
                    crate::locale::ui_message(
                        message_locale,
                        crate::locale::UiMessage::InvalidJsonInput
                    )
                ),
                json_out,
            );
            return Ok(());
        }
    };
    match hit {
        Some(p) => {
            let msg = reason.unwrap_or_else(|| {
                if json_out {
                    "blocked by rdsh guard".to_owned()
                } else {
                    match locale {
                        crate::locale::Locale::English => "blocked by rdsh guard".to_owned(),
                        crate::locale::Locale::Chinese => "被 rdsh guard 阻止".to_owned(),
                        crate::locale::Locale::Japanese => {
                            "rdsh guard によりブロックされました".to_owned()
                        }
                    }
                }
            });
            eprintln!(
                "[{}] {}: {p}",
                crate::locale::ui_message(locale, crate::locale::UiMessage::Guard),
                crate::locale::ui_message(locale, crate::locale::UiMessage::PatternHit)
            );
            block(&msg, json_out);
            Ok(())
        }
        None => {
            if let Some(policy) = policy {
                emit_policy_decision(classify_operation(&raw, &policy), json_out, locale);
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

    // Priority 3: shell quoting must not displace an anchored deny pattern.
    #[test]
    fn quoted_command_name_cannot_bypass_deny_patterns() {
        let double =
            r#"{"cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"r\"m\" -rf / x"}}"#;
        assert!(denied_pattern(double, &["rm -rf /*".into()])
            .unwrap()
            .is_some());
        let single = r#"{"cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"r'm' -rf / x"}}"#;
        assert!(denied_pattern(single, &["rm -rf /*".into()])
            .unwrap()
            .is_some());
        for command in ["sh -c \"rm -rf /\"", "echo `rm -rf /`"] {
            let raw = serde_json::json!({
                "cwd": "/tmp",
                "tool_name": "Bash",
                "tool_input": { "command": command }
            })
            .to_string();
            assert!(
                denied_pattern(&raw, &["rm -rf /*".into()])
                    .unwrap()
                    .is_some(),
                "{command}"
            );
        }
        let escaped =
            r#"{"cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"r\\m -rf / x"}}"#;
        assert!(denied_pattern(escaped, &["rm -rf /*".into()])
            .unwrap()
            .is_some());
    }

    // Priority 3: same-line variable assembly resolves before matching.
    #[test]
    fn variable_assembly_cannot_bypass_deny_patterns() {
        for command in [
            "A=rm; $A -rf / x",
            "A=rm; B=$A; $B -rf / x",
            "C=\"rm -rf /\"; ${C} x",
        ] {
            let raw = serde_json::json!({
                "cwd": "/tmp",
                "tool_name": "Bash",
                "tool_input": { "command": command }
            })
            .to_string();
            assert!(
                denied_pattern(&raw, &["rm -rf /*".into()])
                    .unwrap()
                    .is_some(),
                "{command}"
            );
        }
    }

    // Priority 3: absolute command paths and dot-dot paths match the
    // effective path, not the literal text.
    #[test]
    fn path_normalization_cannot_bypass_deny_patterns() {
        let absolute = serde_json::json!({
            "cwd": "/tmp",
            "tool_name": "Bash",
            "tool_input": { "command": "/bin/rm -rf / x" }
        })
        .to_string();
        assert!(denied_pattern(&absolute, &["rm -rf /*".into()])
            .unwrap()
            .is_some());
        let traversal = serde_json::json!({
            "cwd": "/tmp",
            "tool_name": "Bash",
            "tool_input": { "command": "rm -rf /tmp/../important/x" }
        })
        .to_string();
        assert!(denied_pattern(&traversal, &["rm -rf /important*".into()])
            .unwrap()
            .is_some());
        // A plain-text payload carries no cwd at all, and Windows rejects a
        // bash-style "/tmp" as absolute. Dot-dot folding must not depend on
        // either: it is lexical, so it applies on every platform.
        assert!(
            denied_pattern("rm -rf /tmp/../important/x", &["rm -rf /important*".into()])
                .unwrap()
                .is_some()
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_targets_are_matched_through_the_hook_cwd() {
        use std::os::unix::fs::symlink;
        let tree = TestTree::new();
        std::fs::write(tree.path().join("secret.txt"), "never report this").unwrap();
        symlink(tree.path().join("secret.txt"), tree.path().join("safe.txt")).unwrap();
        let raw = serde_json::json!({
            "cwd": tree.path().to_string_lossy(),
            "tool_name": "Bash",
            "tool_input": { "command": "cat safe.txt" }
        })
        .to_string();
        assert!(denied_pattern(&raw, &["*secret.txt*".into()])
            .unwrap()
            .is_some());
    }

    // Structural semantics stay structural: a plain argument that merely
    // mentions the pattern inside one command is still not an anchored hit.
    #[test]
    fn anchored_pattern_does_not_match_plain_argument_text() {
        let raw = r#"{"cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"echo rm -rf / x"}}"#;
        assert!(denied_pattern(raw, &["rm -rf /*".into()])
            .unwrap()
            .is_none());
    }

    #[test]
    fn shell_segments_remove_quotes_and_split_operators() {
        assert_eq!(
            shell_segments("r\"m\" -rf / x"),
            vec![vec!["rm".to_string(), "-rf".into(), "/".into(), "x".into()]]
        );
        assert_eq!(
            shell_segments("a && b | c"),
            vec![vec!["a".to_string()], vec!["b".into()], vec!["c".into()]]
        );
        assert_eq!(
            shell_segments("echo 'a b' \"c d\""),
            vec![vec!["echo".to_string(), "a b".into(), "c d".into()]]
        );
    }

    #[test]
    fn lexical_path_normalization_folds_dot_segments() {
        assert_eq!(
            lexical_normalize_path("/tmp/../important/x"),
            "/important/x"
        );
        assert_eq!(lexical_normalize_path("./a/./b/"), "a/b/");
        assert_eq!(lexical_normalize_path("../a"), "../a");
        assert_eq!(lexical_normalize_path("/e/../.."), "/");
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
            crate::locale::Locale::English,
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
        assert!(parse_policy(unknown, crate::locale::Locale::English).is_err());
        let relative = br#"{"schema":1,"rules":[{"id":"bad","tool":"Read","access":"read","roots":["relative"]}]}"#;
        assert!(parse_policy(relative, crate::locale::Locale::English).is_err());
        let unsupported =
            br#"{"schema":1,"rules":[{"id":"shell","tool":"Bash","access":"read","roots":["/"]}]}"#;
        assert!(parse_policy(unsupported, crate::locale::Locale::English).is_err());
    }
}
