//! Context engine (v3): rebuild per-turn context from local files.
//!
//! Single source of truth is `$DSH_HOME/rdsh.json` (`context` section).
//! The old `rdsh-context.json` is read-only fallback and only applies when
//! `rdsh.json` has no `context` key (handled inside `rdsh_config::load`).
//!
//! Improvements over the prototype:
//! - multi-term scored retrieval (filename bonus, coverage bonus, word-boundary,
//!   CJK bigram recall, per-file diversity, deterministic ranked walk)
//! - gitignore-aware traversal (root .gitignore + common build-dir skips)
//! - session ranking by score + real recency bonus (mtime-ordered walk)
//! - budget-aware assemble (list caps, head+tail file excerpts, explicit no-hits)
//! - staged packer (shrink before drop, goal/constraints preserved)
//! - git snapshot with staged stat + untracked count; verifier flags dirs/outside-root
//! - priority packing (goal first, retrieved first to drop)
//! - richer git snapshot (branch + status + diff stat)
//! - verifier warnings (missing files surface explicitly)

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::file_security::open_beneath;

const SCHEMA: u32 = 3;
const DEFAULT_BUDGET: usize = 4000;
const DEFAULT_CODE_HITS: usize = 20;
const DEFAULT_SESSIONS: usize = 0;

#[derive(Debug, Clone)]
pub struct ContextConfig {
    pub token_budget: usize,
    pub enable_retriever: bool,
    pub enable_packer: bool,
    pub enable_verifier: bool,
    pub goal: String,
    pub decisions: Vec<String>,
    pub constraints: Vec<String>,
    pub working_files: Vec<String>,
    pub open_tasks: Vec<String>,
    pub max_code_hits: usize,
    pub max_sessions: usize,
    pub include_git_diff: bool,
    pub inject_budget: usize,
    pub inject_deadline_ms: usize,
    pub inject_sessions: bool,
    pub inject_session_count: usize,
    /// `features.dep_graph`: when off, no index is read and no tree is walked.
    pub dep_graph: bool,
}

impl Default for ContextConfig {
    fn default() -> Self {
        Self {
            token_budget: DEFAULT_BUDGET,
            enable_retriever: true,
            enable_packer: true,
            enable_verifier: true,
            goal: String::new(),
            decisions: vec![],
            constraints: vec![],
            working_files: vec![],
            open_tasks: vec![],
            max_code_hits: DEFAULT_CODE_HITS,
            max_sessions: DEFAULT_SESSIONS,
            include_git_diff: true,
            inject_budget: 1200,
            inject_deadline_ms: 1200,
            inject_sessions: true,
            inject_session_count: 2,
            dep_graph: true,
        }
    }
}

impl From<crate::rdsh_config::ContextSection> for ContextConfig {
    fn from(c: crate::rdsh_config::ContextSection) -> Self {
        Self {
            token_budget: c.token_budget.clamp(500, 200_000),
            enable_retriever: c.enable_retriever,
            enable_packer: c.enable_packer,
            enable_verifier: c.enable_verifier,
            goal: c.goal,
            decisions: c.decisions,
            constraints: c.constraints,
            working_files: c.working_files,
            open_tasks: c.open_tasks,
            max_code_hits: c.max_code_hits.clamp(1, 100),
            max_sessions: c.max_sessions.clamp(0, 100),
            include_git_diff: c.include_git_diff,
            inject_budget: c.inject_budget.clamp(200, 8000),
            inject_deadline_ms: c.inject_deadline_ms.clamp(100, 10000),
            inject_sessions: c.inject_sessions,
            inject_session_count: c.inject_session_count.min(10),
            // The switch lives outside the context section; callers that have
            // the whole settings document set it explicitly.
            dep_graph: true,
        }
    }
}

pub fn config_path() -> String {
    // Single source going forward.
    crate::rdsh_config::settings_path()
}

pub fn legacy_path() -> String {
    format!("{}/rdsh-context.json", crate::inspect::dsh_home())
}

pub fn load_config() -> ContextConfig {
    let settings = crate::rdsh_config::load();
    config_from(&settings)
}

/// Context settings plus the feature switches that steer the engine.
fn config_from(settings: &crate::rdsh_config::RdshSettings) -> ContextConfig {
    let mut cfg = ContextConfig::from(settings.context.clone());
    cfg.dep_graph = crate::rdsh_config::feature_enabled(settings, "dep_graph");
    cfg
}

fn estimate(s: &str) -> usize {
    crate::tokens::estimate_tokens(s)
}

// ---- durable memory (schema 1, no inferred facts) ----

const MEMORY_CAP: usize = 4 * 1024 * 1024;
const MEMORY_KINDS: &[&str] = &["goal", "decision", "constraint", "task", "file", "note"];

#[derive(Clone, Debug)]
struct MemoryEntry {
    id: String,
    kind: String,
    text: String,
    source: String,
    created_at_unix: u64,
    superseded_by: Option<String>,
    seen: u64,
}

#[derive(Clone, Debug, Default)]
struct MemoryStore {
    revision: u64,
    updated_at_unix: u64,
    entries: Vec<MemoryEntry>,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn memory_path() -> PathBuf {
    Path::new(&crate::inspect::dsh_home()).join("rdsh-context-memory.json")
}

fn normalize_memory(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

impl MemoryEntry {
    fn value(&self) -> serde_json::Value {
        serde_json::json!({"id": self.id, "kind": self.kind, "text": self.text,
            "source": self.source, "created_at_unix": self.created_at_unix,
            "superseded_by": self.superseded_by, "seen": self.seen})
    }
}

impl MemoryStore {
    fn value(&self) -> serde_json::Value {
        serde_json::json!({"schema": 1, "revision": self.revision,
            "updated_at_unix": self.updated_at_unix,
            "entries": self.entries.iter().map(MemoryEntry::value).collect::<Vec<_>>()})
    }

    fn parse(bytes: &[u8]) -> anyhow::Result<Self> {
        let v: serde_json::Value = serde_json::from_slice(bytes)?;
        anyhow::ensure!(v["schema"].as_u64() == Some(1), "memory schema: unknown");
        let number = |v: &serde_json::Value, k: &str| -> anyhow::Result<u64> {
            v[k].as_u64()
                .ok_or_else(|| anyhow::anyhow!("memory {k}: unknown"))
        };
        let string = |v: &serde_json::Value, k: &str| -> anyhow::Result<String> {
            v[k].as_str()
                .map(str::to_owned)
                .ok_or_else(|| anyhow::anyhow!("memory {k}: unknown"))
        };
        let mut store = Self {
            revision: number(&v, "revision")?,
            updated_at_unix: number(&v, "updated_at_unix")?,
            entries: Vec::new(),
        };
        let entries = v["entries"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("memory entries: unknown"))?;
        anyhow::ensure!(entries.len() <= 10000, "memory entry limit exceeded");
        let mut ids = BTreeSet::new();
        for e in entries {
            let id = string(e, "id")?;
            anyhow::ensure!(
                id.starts_with("mem_")
                    && id.len() == 16
                    && id[4..].bytes().all(|b| b.is_ascii_hexdigit())
                    && ids.insert(id.clone()),
                "memory id: unknown"
            );
            let kind = string(e, "kind")?;
            anyhow::ensure!(
                MEMORY_KINDS.contains(&kind.as_str()),
                "memory kind: unknown"
            );
            let text = string(e, "text")?;
            anyhow::ensure!(
                !text.trim().is_empty() && text.chars().count() <= 8000,
                "memory text: unknown"
            );
            let superseded_by = if e["superseded_by"].is_null() && e.get("superseded_by").is_some()
            {
                None
            } else {
                Some(string(e, "superseded_by")?)
            };
            store.entries.push(MemoryEntry {
                id,
                kind,
                text,
                source: string(e, "source")?,
                created_at_unix: number(e, "created_at_unix")?,
                superseded_by,
                seen: number(e, "seen")?,
            });
        }
        Ok(store)
    }

    fn load(path: &Path) -> anyhow::Result<Self> {
        match std::fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e.into()),
            Ok(m) => anyhow::ensure!(
                m.is_file() && !m.file_type().is_symlink(),
                "memory file: unknown"
            ),
        }
        let bytes = read_small_regular(path, path.parent().unwrap_or(Path::new(".")), MEMORY_CAP)
            .ok_or_else(|| anyhow::anyhow!("memory unreadable or over limit: unknown"))?;
        Self::parse(&bytes)
    }

    fn save(&self, path: &Path) -> anyhow::Result<()> {
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("memory parent: unknown"))?;
        std::fs::create_dir_all(parent)?;
        let bytes = serde_json::to_vec(&self.value())?;
        anyhow::ensure!(bytes.len() <= MEMORY_CAP, "memory size limit exceeded");
        let tmp = parent.join(format!(
            ".rdsh-context-memory-{}.tmp",
            crate::local_http::random_token()?
        ));
        let result = (|| -> anyhow::Result<()> {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut f = options.open(&tmp)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
            std::fs::rename(&tmp, path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result
    }

    fn remember(
        &mut self,
        text: &str,
        kind: &str,
        source: &str,
        supersede: bool,
        now: u64,
    ) -> anyhow::Result<(String, Vec<String>)> {
        anyhow::ensure!(MEMORY_KINDS.contains(&kind), "unknown memory kind");
        let text = text.trim();
        anyhow::ensure!(
            !text.is_empty() && text.chars().count() <= 8000,
            "memory text must contain 1..8000 characters"
        );
        let normalized = normalize_memory(text);
        if let Some(e) = self
            .entries
            .iter_mut()
            .find(|e| e.superseded_by.is_none() && normalize_memory(&e.text) == normalized)
        {
            e.seen = e.seen.saturating_add(1);
            self.revision = self.revision.saturating_add(1);
            self.updated_at_unix = now;
            return Ok((e.id.clone(), Vec::new()));
        }
        anyhow::ensure!(self.entries.len() < 10000, "memory entry limit exceeded");
        use sha2::{Digest, Sha256};
        let mut nonce = self.revision;
        let id = loop {
            let digest = Sha256::digest(format!("{kind}\n{normalized}\n{nonce}"));
            let id = format!(
                "mem_{}",
                digest
                    .iter()
                    .take(6)
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            );
            if self.entries.iter().all(|e| e.id != id) {
                break id;
            }
            nonce = nonce
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("memory id space: unknown"))?;
        };
        let tokens = memory_tokens(text);
        let mut warnings = Vec::new();
        let retract = has_retraction(text);
        let mut overlaps: Vec<(usize, usize, usize)> = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, e)| e.superseded_by.is_none())
            .map(|(i, e)| {
                let old = memory_tokens(&e.text);
                (
                    i,
                    tokens.intersection(&old).count(),
                    tokens.len().max(old.len()).max(1),
                )
            })
            .collect();
        // A retraction targets the strongest lexical match, never unrelated memories.
        overlaps.sort_by(|a, b| (b.1 * a.2).cmp(&(a.1 * b.2)).then(b.0.cmp(&a.0)));
        let retract_target = overlaps
            .first()
            .filter(|(_, n, _)| *n > 0)
            .map(|(i, _, _)| *i);
        if supersede {
            for (i, common, total) in overlaps {
                let old = &mut self.entries[i];
                if common * 100 >= total * 60 || (retract && retract_target == Some(i)) {
                    old.superseded_by = Some(id.clone());
                } else if common > 0 && (old.kind == kind || retract) {
                    warnings.push(format!(
                        "conflict: {} and {id}; resolution unknown (<60% overlap)",
                        old.id
                    ));
                }
            }
            if retract && retract_target.is_none() {
                warnings.push(
                    "conflict: retraction target unknown; active history retained".to_string(),
                );
            }
        }
        warnings.sort();
        self.entries.push(MemoryEntry {
            id: id.clone(),
            kind: kind.to_string(),
            text: text.to_string(),
            source: source.to_string(),
            created_at_unix: now,
            superseded_by: None,
            seen: 1,
        });
        self.revision = self.revision.saturating_add(1);
        self.updated_at_unix = now;
        Ok((id, warnings))
    }
}

const RETRACTION_MARKERS: &[&str] = &[
    "撤回",
    "やめる",
    "やめた",
    "取り消し",
    "無効",
    "代わりに",
    "revert",
];
const CONSTRAINT_MARKERS: &[&str] = &[
    "必ず",
    "してはいけない",
    "しないこと",
    "禁止",
    "never",
    "must not",
    "do not",
];
const DECISION_MARKERS: &[&str] = &["方針", "決定", "とする", "採用", "instead", "decided"];
const TASK_MARKERS: &[&str] = &["todo", "未対応", "次は", "remaining", "やる"];

fn has_retraction(text: &str) -> bool {
    let lower = text.to_lowercase();
    RETRACTION_MARKERS.iter().any(|m| lower.contains(m))
}

fn memory_tokens(text: &str) -> BTreeSet<String> {
    let mut lower = normalize_memory(text);
    for marker in RETRACTION_MARKERS
        .iter()
        .chain(CONSTRAINT_MARKERS)
        .chain(DECISION_MARKERS)
        .chain(TASK_MARKERS)
    {
        lower = lower.replace(marker, " ");
    }
    let mut tokens = BTreeSet::new();
    for word in lower.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '/') {
        if word.is_empty() {
            continue;
        }
        if word.chars().any(is_cjk) {
            let chars: Vec<char> = word.chars().collect();
            if chars.len() == 1 {
                tokens.insert(word.to_string());
            }
            for pair in chars.windows(2) {
                tokens.insert(pair.iter().collect());
            }
        } else {
            tokens.insert(word.to_string());
        }
    }
    tokens
}

#[derive(Debug)]
struct MemoryCandidate {
    kind: &'static str,
    text: String,
}

fn content_text(value: &serde_json::Value) -> Option<String> {
    if let Some(s) = value.as_str() {
        return Some(s.to_string());
    }
    let parts: Vec<&str> = value
        .as_array()?
        .iter()
        .filter(|v| v["type"].as_str() == Some("text"))
        .filter_map(|v| v["text"].as_str())
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

fn is_hook_generated(value: &serde_json::Value) -> bool {
    value
        .get("source")
        .or_else(|| value.get("data").and_then(|data| data.get("source")))
        .and_then(|source| source.get("kind"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|kind| kind.starts_with("hooks-"))
}

fn user_texts(value: &serde_json::Value) -> Vec<String> {
    if value["role"].as_str() == Some("assistant") {
        return Vec::new();
    }
    match value["type"].as_str() {
        Some("user/message") => {
            if is_hook_generated(value) {
                return Vec::new();
            }
            content_text(&value["data"]["content"])
                .into_iter()
                .collect()
        }
        Some("agent/inbox/spliced") => value["data"]["inserted"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|message| !is_hook_generated(message))
            .filter(|message| message["role"].as_str() != Some("assistant"))
            .filter(|message| {
                !message["type"]
                    .as_str()
                    .is_some_and(|kind| kind == "assistant" || kind.starts_with("assistant/"))
            })
            .filter_map(|message| content_text(&message["content"]))
            .collect(),
        Some(kind) if kind == "assistant" || kind.starts_with("assistant/") => Vec::new(),
        _ => {
            let message = value.get("message").unwrap_or(value);
            if message["role"].as_str().or_else(|| value["role"].as_str()) != Some("user") {
                return Vec::new();
            }
            message
                .get("content")
                .or_else(|| message.get("text"))
                .and_then(content_text)
                .into_iter()
                .collect()
        }
    }
}

fn distill_candidates(transcript: &str) -> Vec<MemoryCandidate> {
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for line in transcript.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        for text in user_texts(&value) {
            for sentence in text.split(['\n', '。', '！', '？']) {
                let text = sentence.trim();
                if text.is_empty() {
                    continue;
                }
                let lower = text.to_lowercase();
                let kind = if CONSTRAINT_MARKERS.iter().any(|m| lower.contains(m)) {
                    "constraint"
                } else if DECISION_MARKERS.iter().any(|m| lower.contains(m))
                    || (lower.contains("use ") && lower.contains(" rather"))
                {
                    "decision"
                } else if TASK_MARKERS.iter().any(|m| lower.contains(m)) {
                    "task"
                } else if has_retraction(text) {
                    "decision"
                } else {
                    continue;
                };
                if seen.insert(normalize_memory(text)) {
                    out.push(MemoryCandidate {
                        kind,
                        text: text.chars().take(8000).collect(),
                    });
                }
            }
        }
    }
    out
}

// ---- query terms ----

fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}'
        | '\u{f900}'..='\u{faff}' | '\u{ff00}'..='\u{ffef}' | '\u{20000}'..='\u{2ebef}')
}

/// CJK bigram（2文字ともCJK）か。ノイズ抑制の弱加点・除外判定に使う。
/// バイト数ではなく文字数とis_cjkで判定する（CJK2文字はUTF-8で6bytesのため）。
/// ASCIIの2文字語（CI/UI/Goなど）は含まない。
fn is_cjk_bigram(term: &str) -> bool {
    term.chars().count() == 2 && term.chars().all(is_cjk)
}

fn push_term(terms: &mut Vec<String>, t: &str) {
    if t.is_empty() || terms.len() >= 16 {
        return;
    }
    if !terms.iter().any(|x| x.as_str() == t) {
        terms.push(t.to_string());
    }
}

fn query_terms(query: &str) -> Vec<String> {
    // camelCase境界で事前分割してから小文字化する（fooBar -> foo Bar）。
    let mut spaced = String::with_capacity(query.len() + 8);
    let mut prev: Option<char> = None;
    for c in query.chars() {
        if let Some(p) = prev {
            let camel = p.is_lowercase() && c.is_uppercase();
            let digit = p.is_ascii_digit() != c.is_ascii_digit()
                && p.is_alphanumeric()
                && c.is_alphanumeric();
            if camel || digit {
                spaced.push(' ');
            }
        }
        spaced.push(c);
        prev = Some(c);
    }
    let mut terms: Vec<String> = Vec::new();
    for raw in spaced
        .to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-' || c == '/'))
    {
        let t = raw
            .trim()
            .trim_matches(|c| c == '_' || c == '-' || c == '/');
        if t.is_empty() {
            continue;
        }
        let nchars = t.chars().count();
        let has_cjk = t.chars().any(is_cjk);
        // ASCIIは2文字未満を落とす。CJKを含む語は1文字から残す。
        if !has_cjk && nchars < 2 {
            continue;
        }
        // よくある英単語・日本語助詞のノイズだけ落とす
        if matches!(
            t,
            "the"
                | "and"
                | "for"
                | "with"
                | "this"
                | "that"
                | "from"
                | "into"
                | "are"
                | "was"
                | "were"
                | "have"
                | "has"
                | "will"
                | "こと"
                | "これ"
                | "それ"
                | "ため"
                | "よう"
                | "もの"
                | "なか"
        ) {
            continue;
        }
        push_term(&mut terms, t);
        // CJKを含む長い語は2-gramも併せて登録し、部分一致の想起率を上げる。
        // 例: "互換性を維持する" -> "互換" "換性" ... でも拾える。
        if has_cjk && nchars >= 4 && terms.len() < 16 {
            let chars: Vec<char> = t.chars().collect();
            for w in chars.windows(2) {
                let bi: String = w.iter().collect();
                if bi.chars().any(is_cjk) {
                    push_term(&mut terms, &bi);
                    if terms.len() >= 16 {
                        break;
                    }
                }
            }
        }
        if terms.len() >= 16 {
            break;
        }
    }
    // 先頭8語を優先しつつ上限16語まで（本文の要約に寄与する）。
    terms.truncate(16);
    terms
}

fn score_line(line_lower: &str, terms: &[String]) -> usize {
    let mut score = 0usize;
    let mut matched = 0usize;
    let line_chars: Vec<char> = line_lower.chars().collect();
    for t in terms {
        if is_cjk_bigram(t) {
            // CJK bigramは弱めに加点（ノイズ抑制）
            if line_lower.contains(t) {
                score += 3;
                matched += 1;
            }
            continue;
        }
        if line_lower.contains(t) {
            // 長い語ほど確度が高い（バイト長ではなく文字数で評価し、CJK過重を防ぐ）
            let w = 2 + t.chars().count().min(12);
            score += w;
            matched += 1;
            // 単語境界一致はさらに加点
            if has_word_boundary(line_lower, &line_chars, t) {
                score += 2;
            }
        }
    }
    if matched > 1 {
        // 複数語をカバーした行を優遇（AND寄りの順位付け）
        score += matched * 4;
    }
    if matched == terms.len() && !terms.is_empty() {
        score += 15;
    }
    score
}

fn has_word_boundary(line_lower: &str, line_chars: &[char], term: &str) -> bool {
    let tlen = term.chars().count();
    if tlen == 0 {
        return false;
    }
    let tchars: Vec<char> = term.chars().collect();
    if line_chars.len() < tlen {
        return false;
    }
    for i in 0..=(line_chars.len() - tlen) {
        if line_chars[i..i + tlen] != tchars[..] {
            continue;
        }
        let left_ok = i == 0 || !is_word_char(line_chars[i - 1]);
        let right_ok = i + tlen >= line_chars.len() || !is_word_char(line_chars[i + tlen]);
        if left_ok && right_ok {
            return true;
        }
    }
    let _ = line_lower;
    false
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

// ---- file helpers ----

fn truncate_utf8_to_bytes(text: &str, cap: usize) -> &str {
    let mut end = cap.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn read_bounded(path: &str, cap: usize) -> Option<String> {
    use std::io::Read;
    let root = std::fs::canonicalize(".").ok()?;
    let target = std::fs::canonicalize(path).ok()?;
    if !target.starts_with(&root) {
        return None;
    }
    // Open every path component relative to directory fds with O_NOFOLLOW.
    // This closes the check/open race for both final files and parent dirs.
    let file = open_beneath(&root, &target)?;
    let mut bytes = Vec::new();
    file.take(cap as u64).read_to_end(&mut bytes).ok()?;
    if bytes.contains(&0) {
        return None; // binary
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Some(truncate_utf8_to_bytes(&text, cap).to_string())
}

/// working_files 1件分の読み結果。失敗理由を区別して検証メモに回す。
fn read_working_file(path: &str, cap: usize) -> Result<String, &'static str> {
    let root = std::fs::canonicalize(".").map_err(|_| "missing")?;
    let target = std::fs::canonicalize(path).map_err(|_| "missing")?;
    if !target.starts_with(&root) {
        return Err("outside-root");
    }
    if let Ok(meta) = std::fs::metadata(&target) {
        if !meta.is_file() {
            return Err("not-a-file");
        }
    }
    read_bounded(path, cap).ok_or("binary-or-unreadable")
}

/// 長文を先頭＋末尾で残す。戻り値は (本文, 省略あり)。
fn head_tail(text: &str, head_chars: usize, tail_chars: usize) -> (String, bool) {
    let n = text.chars().count();
    if n <= head_chars + tail_chars {
        return (text.to_string(), false);
    }
    let head: String = text.chars().take(head_chars).collect();
    let tail: String = text
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let omitted = n.saturating_sub(head_chars + tail_chars);
    (
        format!("{head}\n...[rdsh truncated {omitted} chars]...\n{tail}"),
        true,
    )
}

/// 箇条書きリストを件数＋文字数で切る。戻り値は (本文, 省略件数)。
fn truncate_list(items: &[String], max_items: usize, max_chars: usize) -> (String, usize) {
    if items.is_empty() {
        return (String::new(), 0);
    }
    let mut kept: Vec<&str> = Vec::new();
    let mut chars = 0usize;
    for it in items.iter().take(max_items) {
        let len = it.chars().count();
        if chars + len > max_chars && !kept.is_empty() {
            break;
        }
        chars += len + 1;
        kept.push(it.as_str());
    }
    let omitted = items.len().saturating_sub(kept.len());
    let mut body = kept.join("\n");
    if omitted > 0 {
        body.push_str(&format!("\n...[rdsh {omitted} more omitted]..."));
    }
    (body, omitted)
}

fn read_small_regular(path: &std::path::Path, root: &Path, cap: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    let root = std::fs::canonicalize(root).ok()?;
    let target = std::fs::canonicalize(path).ok()?;
    if !target.starts_with(&root) {
        return None;
    }
    let file = open_beneath(&root, &target)?;
    let mut bytes = Vec::new();
    file.take(cap as u64 + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() <= cap).then_some(bytes)
}

fn expired(deadline: Option<Instant>) -> bool {
    deadline.is_some_and(|d| Instant::now() >= d)
}

// Drain stdout concurrently, so a large git status cannot fill a pipe while
// try_wait is enforcing the hook deadline. Git output itself is bounded.
fn git_output(args: &[&str], deadline: Option<Instant>) -> Option<String> {
    git_output_in(None, args, deadline)
}

fn git_output_in(cwd: Option<&Path>, args: &[&str], deadline: Option<Instant>) -> Option<String> {
    use std::process::{Command, Stdio};
    if expired(deadline) {
        return None;
    }
    let mut command = Command::new("git");
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = command
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(1024 * 1024 + 1).read_to_end(&mut bytes);
        let bytes = result
            .ok()
            .filter(|_| bytes.len() <= 1024 * 1024)
            .map(|_| bytes);
        let _ = sender.send(bytes);
    });
    let limit = deadline.unwrap_or_else(|| Instant::now() + std::time::Duration::from_secs(10));
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < limit => {
                std::thread::sleep(std::time::Duration::from_millis(2))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    if !success {
        return None;
    }
    // A child may leave descendants holding its stdout pipe open. Never join
    // a drain thread beyond the deadline, even after the git process exited.
    let bytes = receiver
        .recv_timeout(limit.saturating_duration_since(Instant::now()))
        .ok()??;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn git_dirty_paths(status: &str) -> BTreeMap<String, String> {
    let mut paths = BTreeMap::new();
    let mut records = status.split('\0').filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        if let Some(path) = record.get(3..) {
            let state = record.get(..2).unwrap_or("??").to_string();
            paths.insert(path.to_string(), state.clone());
            if state.contains('R') || state.contains('C') {
                if let Some(old) = records.next() {
                    paths.insert(old.to_string(), state);
                }
            }
        }
    }
    paths
}

fn git_index_content_signature(path: &Path, deadline: Option<Instant>) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    const MAX_INDEX_BYTES: u64 = 64 * 1024 * 1024;
    if expired(deadline) {
        return None;
    }
    let parent = std::fs::canonicalize(path.parent()?).ok()?;
    let root = crate::file_security::Root::new(&parent)?;
    let index = root.open(&parent.join(path.file_name()?))?;
    let metadata = index.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_INDEX_BYTES {
        return None;
    }
    let mut input = index.take(MAX_INDEX_BYTES + 1);
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 8192];
    loop {
        if expired(deadline) {
            return None;
        }
        let read = input.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > MAX_INDEX_BYTES {
            return None;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    Some(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn git_dirty_content_signature(
    cwd: &Path,
    dirty: Option<&BTreeMap<String, String>>,
    deadline: Option<Instant>,
) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let repo_paths = git_output_in(
        Some(cwd),
        &["rev-parse", "--absolute-git-dir", "--show-toplevel"],
        deadline,
    )?;
    let mut repo_paths = repo_paths.lines();
    let git_dir = PathBuf::from(repo_paths.next()?);
    let worktree = repo_paths.next()?;
    if !git_dir.is_absolute() || worktree.is_empty() {
        return None;
    }
    let index_path = git_dir.join("index");
    let index_before = git_index_content_signature(&index_path, deadline)?;
    let diff = git_output_in(
        Some(cwd),
        &[
            "diff",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
            "HEAD",
            "--",
        ],
        deadline,
    )?;
    let mut hasher = Sha256::new();
    hasher.update(b"tracked\0");
    hasher.update(diff.as_bytes());

    let dirty = dirty?;
    let untracked: Vec<_> = dirty
        .iter()
        .filter(|(_, state)| state.as_str() == "??")
        .collect();
    if untracked.len() > 1000 {
        return None;
    }
    if expired(deadline) {
        return None;
    }
    let worktree = std::fs::canonicalize(worktree).ok()?;
    let root = crate::file_security::Root::new(&worktree)?;
    let mut remaining = 4 * 1024 * 1024usize;
    for (path, _) in untracked {
        if expired(deadline) {
            return None;
        }
        let file = root.open(&worktree.join(path))?;
        let size = usize::try_from(file.metadata().ok()?.len()).ok()?;
        if size > remaining {
            return None;
        }
        let mut bytes = Vec::with_capacity(size);
        file.take((remaining + 1) as u64)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > remaining {
            return None;
        }
        hasher.update(b"untracked\0");
        hasher.update(path.as_bytes());
        hasher.update(b"\0");
        hasher.update(&bytes);
        remaining -= bytes.len();
    }
    let index_after = git_index_content_signature(&index_path, deadline)?;
    if index_before != index_after {
        return None;
    }
    hasher.update(b"index\0");
    hasher.update(index_after.as_bytes());
    let digest = hasher.finalize();
    Some(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn git_snapshot(deadline: Option<Instant>) -> String {
    let branch = git_output(&["rev-parse", "--abbrev-ref", "HEAD"], deadline)
        .map(|s| s.trim().chars().take(120).collect::<String>())
        .unwrap_or_else(|| "unknown".to_string());
    let status = git_output(&["status", "--short", "--", "."], deadline)
        .map(|s| {
            if s.trim().is_empty() {
                "(clean)".to_string()
            } else {
                s.lines()
                    .take(15)
                    .collect::<Vec<_>>()
                    .join("\n")
                    .chars()
                    .take(1200)
                    .collect()
            }
        })
        .unwrap_or_else(|| "(git unavailable: unknown)".to_string());
    let stat = |args: &[&str], empty: &str| {
        git_output(args, deadline)
            .map(|s| {
                if s.trim().is_empty() {
                    empty.to_string()
                } else {
                    s.trim().chars().take(1500).collect()
                }
            })
            .unwrap_or_else(|| "(git unavailable: unknown)".to_string())
    };
    let diff = stat(&["diff", "--stat", "--", "."], "(no unstaged diff)");
    let staged = stat(
        &["diff", "--cached", "--stat", "--", "."],
        "(no staged diff)",
    );
    let untracked = status.lines().filter(|l| l.starts_with("??")).count();
    format!("branch: {branch} (untracked: {untracked})\n--- status ---\n{status}\n--- diff --stat (unstaged) ---\n{diff}\n--- diff --cached --stat (staged) ---\n{staged}")
}

#[derive(Debug, Default, PartialEq, Eq)]
struct GitState {
    head: Option<String>,
    branch: Option<String>,
    dirty: Option<BTreeMap<String, String>>,
    dirty_content: Option<String>,
}

impl GitState {
    fn capture(deadline: Option<Instant>) -> Self {
        let head = git_output(&["rev-parse", "HEAD"], deadline).map(|s| s.trim().to_string());
        let branch = git_output(&["rev-parse", "--abbrev-ref", "HEAD"], deadline)
            .map(|s| s.trim().to_string());
        let dirty = git_output(
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            deadline,
        )
        .map(|s| git_dirty_paths(&s));
        let dirty_content = std::env::current_dir()
            .ok()
            .and_then(|cwd| git_dirty_content_signature(&cwd, dirty.as_ref(), deadline));
        Self {
            head,
            branch,
            dirty,
            dirty_content,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileStamp {
    size: u64,
    modified: SystemTime,
}

fn file_stamp(path: &Path) -> Option<FileStamp> {
    let m = std::fs::metadata(path).ok()?;
    m.is_file().then_some(FileStamp {
        size: m.len(),
        modified: m.modified().ok()?,
    })
}

struct SnapshotTracker {
    git: GitState,
    files: BTreeMap<PathBuf, Option<FileStamp>>,
    changed: BTreeSet<String>,
}

#[derive(Debug)]
struct Snapshot {
    head: String,
    branch: String,
    stable: bool,
    changed_files: Vec<String>,
    checked_files: usize,
    unknown: Vec<String>,
}

impl Snapshot {
    fn value(&self) -> serde_json::Value {
        serde_json::json!({"head": self.head, "branch": self.branch, "stable": self.stable,
            "changed_files": self.changed_files, "checked_files": self.checked_files, "unknown": self.unknown})
    }
    fn line(&self) -> String {
        if self.stable {
            "[snapshot: stable]".to_string()
        } else if !self.changed_files.is_empty() {
            format!(
                "[snapshot: CHANGED during build: {}]",
                self.changed_files.join(", ")
            )
        } else {
            format!("[snapshot: unknown: {}]", self.unknown.join(", "))
        }
    }
}

impl SnapshotTracker {
    fn start(deadline: Option<Instant>) -> Self {
        Self {
            git: GitState::capture(deadline),
            files: BTreeMap::new(),
            changed: BTreeSet::new(),
        }
    }
    fn label(path: &Path) -> String {
        std::env::current_dir()
            .ok()
            .and_then(|r| path.strip_prefix(r).ok().map(Path::to_path_buf))
            .unwrap_or_else(|| path.to_path_buf())
            .to_string_lossy()
            .replace('\\', "/")
    }
    fn record(&mut self, path: &Path) {
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir().unwrap_or_default().join(path)
        };
        let stamp = file_stamp(&absolute);
        if let Some(old) = self.files.get(&absolute) {
            if *old != stamp {
                self.changed.insert(Self::label(&absolute));
            }
        } else {
            self.files.insert(absolute, stamp);
        }
    }
    fn finish(mut self, deadline: Option<Instant>) -> Snapshot {
        let after = GitState::capture(deadline);
        let mut unknown = Vec::new();
        for (name, before, after) in [
            ("git HEAD", &self.git.head, &after.head),
            ("git branch", &self.git.branch, &after.branch),
        ] {
            if before.is_none() || after.is_none() {
                unknown.push(name.to_string());
            }
            if before.is_some() && after.is_some() && before != after {
                self.changed.insert(name.to_string());
            }
        }
        match (&self.git.dirty, &after.dirty) {
            (Some(before), Some(after)) => {
                for path in before.keys().chain(after.keys()) {
                    if before.get(path) != after.get(path) {
                        self.changed.insert(path.clone());
                    }
                }
            }
            _ => unknown.push("git dirty paths".to_string()),
        }
        match (&self.git.dirty_content, &after.dirty_content) {
            (Some(before), Some(after)) if before != after => {
                self.changed.insert("git dirty content".to_string());
            }
            (None, _) | (_, None) => unknown.push("git dirty content".to_string()),
            _ => (),
        }
        for (path, before) in &self.files {
            if *before != file_stamp(path) {
                self.changed.insert(Self::label(path));
            }
            if before.is_none() {
                unknown.push(format!("file metadata: {}", Self::label(path)));
            }
        }
        Snapshot {
            head: self.git.head.unwrap_or_else(|| "unknown".to_string()),
            branch: self.git.branch.unwrap_or_else(|| "unknown".to_string()),
            stable: self.changed.is_empty() && unknown.is_empty(),
            changed_files: self.changed.into_iter().collect(),
            checked_files: self.files.len(),
            unknown,
        }
    }
}

// ---- sessions ----

fn mtime_secs(p: &std::path::Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn is_jsonl_session(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e == "jsonl" || e == "ndjson")
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".jsonl.zstd"))
}

fn session_files_sorted(limit_dirs: usize) -> Vec<PathBuf> {
    let root = Path::new(&crate::inspect::dsh_home()).join("sessions");
    let mut stack = vec![(root, 0usize)];
    let mut files = Vec::new();
    let mut visited = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        let mut entries = std::fs::read_dir(&dir)
            .map(|e| e.filter_map(Result::ok).collect::<Vec<_>>())
            .unwrap_or_default();
        entries.sort_by_key(|e| (std::cmp::Reverse(mtime_secs(&e.path())), e.path()));
        let mut dirs = Vec::new();
        for e in entries {
            visited += 1;
            if visited > 10000 || files.len() >= 400 {
                break;
            }
            let Ok(kind) = e.file_type() else {
                continue;
            };
            let p = e.path();
            if kind.is_dir() && depth < 3 {
                let limit = if depth == 0 { 40 } else { limit_dirs.max(1) };
                if dirs.len() < limit {
                    dirs.push((p, depth + 1));
                }
            } else if kind.is_file()
                && (is_jsonl_session(&p)
                    || p.extension()
                        .and_then(|s| s.to_str())
                        .is_some_and(|s| matches!(s, "json" | "txt")))
            {
                let modified = std::fs::metadata(&p)
                    .and_then(|m| m.modified())
                    .unwrap_or(UNIX_EPOCH);
                files.push((modified, p));
            }
        }
        if visited > 10000 || files.len() >= 400 {
            break;
        }
        stack.extend(dirs.into_iter().rev());
    }
    files.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    files.into_iter().map(|(_, p)| p).collect()
}

fn recent_sessions(query: &str, limit: usize) -> Vec<String> {
    if limit == 0 {
        return vec![];
    }
    let terms = query_terms(query);
    if terms.is_empty() {
        // クエリなしは新着順の素朴な一覧（上限まで）
        return session_files_sorted(3)
            .into_iter()
            .take(limit)
            .map(|p| format!("[session] {}", short_session(&p)))
            .collect();
    }
    let mut scored: Vec<(usize, u64, String)> = Vec::new();
    for p in session_files_sorted(4).into_iter().take(120) {
        let bytes = read_small_regular(
            &p,
            &std::path::PathBuf::from(format!("{}/sessions", crate::inspect::dsh_home())),
            256 * 1024,
        )
        .unwrap_or_default();
        if bytes.is_empty() || bytes.len() > 256 * 1024 || bytes.contains(&0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let lower = text.to_lowercase();
        let mut score = 0usize;
        let mut matched = 0usize;
        let mut snippet = String::new();
        let mut best_snippet_score = 0usize;
        for t in &terms {
            // CJK bigramは弱めに加点（ノイズ抑制）。ASCIIの2文字語は通常加点する。
            let weak = is_cjk_bigram(t);
            if lower.contains(t) {
                if weak {
                    score += 3;
                } else {
                    score += 3 + t.chars().count().min(12);
                }
                matched += 1;
                // その語を含む最良行をスニペットにする
                for line in text.lines().take(400) {
                    let ll = line.to_lowercase();
                    let ls = score_line(&ll, std::slice::from_ref(t));
                    if ls > best_snippet_score {
                        best_snippet_score = ls;
                        snippet = line.chars().take(140).collect();
                    }
                    if ls > 0 && snippet.is_empty() {
                        snippet = line.chars().take(140).collect();
                    }
                }
            }
        }
        if score == 0 {
            continue;
        }
        if matched > 1 {
            score += matched * 4;
        }
        // 新しさボーナス（最大+5）：スコアに実際に加算する
        let mtime = mtime_secs(&p);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(mtime);
        let age_days = now.saturating_sub(mtime) / 86400;
        if age_days <= 7 {
            score += 5;
        } else if age_days <= 30 {
            score += 3;
        } else if age_days <= 90 {
            score += 1;
        }
        let label = if snippet.is_empty() {
            format!("[session] {}", short_session(&p))
        } else {
            format!("[session] {} :: {}", short_session(&p), snippet.trim())
        };
        scored.push((score, mtime, label));
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2)));
    scored.into_iter().take(limit).map(|(_, _, s)| s).collect()
}

fn short_session(p: &std::path::Path) -> String {
    // .../sessions/<proj>/<id>/<file> -> proj/id:file
    let comps: Vec<String> = p
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if comps.len() >= 3 {
        let n = comps.len();
        format!("{}/{}:{}", comps[n - 3], comps[n - 2], comps[n - 1])
    } else {
        p.display().to_string()
    }
}

// ---- code search (scored) ----

const CODE_EXTS: &[&str] = &[
    "rs", "js", "mjs", "cjs", "ts", "mts", "cts", "tsx", "jsx", "vue", "svelte", "py", "go",
    "java", "rb", "php", "c", "h", "hpp", "cs", "swift", "kt", "scala", "sql", "proto", "tf", "md",
    "mdx", "yml", "yaml", "toml", "json", "jsonc", "sh", "bash", "zsh", "ps1", "html", "css",
    "scss",
];

/// 拡張子がなくてもコード扱いするファイル名。
const CODE_FILENAMES: &[&str] = &[
    "dockerfile",
    "makefile",
    "justfile",
    "taskfile",
    "gemfile",
    "rakefile",
];

/// 常に走査から外すディレクトリ。
const SKIP_DIRS: &[&str] = &[
    "target",
    "node_modules",
    "dist",
    "build",
    ".git",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    "coverage",
    ".coverage",
];

/// 1ファイルあたりの最大ヒット（多様性を保つため上限を絞る）。
const MAX_PER_FILE: usize = 3;

fn load_gitignore_patterns(root: &std::path::Path) -> Vec<String> {
    let mut pats: Vec<String> = Vec::new();
    for cand in [root.join(".gitignore"), root.join(".git/info/exclude")] {
        let Some(bytes) = read_small_regular(&cand, root, 64 * 1024) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        for line in text.lines().take(200) {
            let l = line.trim();
            if l.is_empty() || l.starts_with('#') {
                continue;
            }
            // 否定(!)は簡易実装では扱わずスキップ
            if l.starts_with('!') {
                continue;
            }
            pats.push(l.to_string());
            if pats.len() >= 100 {
                break;
            }
        }
    }
    pats
}

fn gitignored(rel: &str, is_dir: bool, pats: &[String]) -> bool {
    // 簡易gitignoreマッチャ（*, **, 末尾/ に対応）。完全互換ではない。
    let rel = rel.trim_start_matches('/');
    for pat in pats {
        let mut p = pat.as_str().trim();
        if p.is_empty() {
            continue;
        }
        // 先頭/ はroot相対の意味だが簡易的に無視
        p = p.trim_start_matches('/');
        let dir_only = p.ends_with('/');
        let p = p.trim_end_matches('/');
        if dir_only && !is_dir {
            // ディレクトリ指定は配下パスにも適用
            if rel == p || rel.starts_with(&format!("{p}/")) {
                return true;
            }
            continue;
        }
        if p.contains("**") {
            let parts: Vec<&str> = p.split("**").collect();
            let mut idx = 0usize;
            let mut ok = true;
            for (i, part) in parts.iter().enumerate() {
                let part = part.trim_matches('/');
                if part.is_empty() {
                    continue;
                }
                if i == 0 && !p.starts_with("**") {
                    if !(rel == part || rel.starts_with(&format!("{part}/"))) {
                        // 先頭部分の簡易前方一致
                        if let Some(found) = rel.find(part) {
                            idx = found + part.len();
                        } else {
                            ok = false;
                            break;
                        }
                    } else {
                        idx = part.len();
                    }
                } else if let Some(found) = rel[idx..].find(part) {
                    idx += found + part.len();
                } else {
                    ok = false;
                    break;
                }
            }
            if ok {
                return true;
            }
            continue;
        }
        if p.contains('*') {
            // 単純なワイルドカードをセグメント単位で照合
            for seg in rel.split('/') {
                if simple_glob_match(p.trim_start_matches("*/"), seg) {
                    return true;
                }
            }
            if simple_glob_match(p, rel) {
                return true;
            }
            continue;
        }
        // 素朴な部分一致：完全一致 or パス境界での一致
        if rel == p || rel.starts_with(&format!("{p}/")) || rel.ends_with(&format!("/{p}")) {
            return true;
        }
    }
    false
}

fn simple_glob_match(pat: &str, s: &str) -> bool {
    // '*' のみ対応の簡易マッチャ
    if !pat.contains('*') {
        return pat == s;
    }
    let parts: Vec<&str> = pat.split('*').collect();
    if parts.is_empty() {
        return true;
    }
    let mut rest = s;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if i == 0 {
            if !rest.starts_with(*part) {
                return false;
            }
            rest = &rest[part.len()..];
        } else if i == parts.len() - 1 {
            if !rest.ends_with(*part) {
                return false;
            }
        } else if let Some(found) = rest.find(*part) {
            rest = &rest[found + part.len()..];
        } else {
            return false;
        }
    }
    true
}

fn is_code_file(p: &std::path::Path) -> bool {
    if p.file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|name| CODE_FILENAMES.contains(&name.to_lowercase().as_str()))
    {
        return true;
    }
    p.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|x| CODE_EXTS.contains(&x.to_lowercase().as_str()))
}

fn code_hits(query: &str, max: usize) -> Vec<String> {
    code_hits_tracked(query, max, None, None)
}

fn code_hits_tracked(
    query: &str,
    max: usize,
    mut tracker: Option<&mut SnapshotTracker>,
    deadline: Option<Instant>,
) -> Vec<String> {
    let terms = query_terms(query);
    if terms.is_empty() {
        return vec![];
    }
    let root = std::fs::canonicalize(".").ok();
    let Some(root) = root else {
        return vec![];
    };
    if let Some(t) = tracker.as_mut() {
        for p in [root.join(".gitignore"), root.join(".git/info/exclude")] {
            if p.is_file() {
                t.record(&p);
            }
        }
    }
    let ignore_pats = load_gitignore_patterns(&root);
    let mut scored: Vec<(usize, String)> = Vec::new();
    let mut stack = vec![root.clone()];
    let mut files_seen = 0usize;
    // 決定的な走査順にするためディレクトリ・ファイルとも名前順に処理する。
    while let Some(dir) = stack.pop() {
        if expired(deadline) {
            return Vec::new();
        }
        let mut entries = std::fs::read_dir(&dir)
            .map(|e| e.filter_map(Result::ok).collect::<Vec<_>>())
            .unwrap_or_default();
        entries.sort_by_key(|e| e.file_name());
        let mut subdirs: Vec<std::path::PathBuf> = Vec::new();
        for e in entries {
            if expired(deadline) {
                return Vec::new();
            }
            let name = e.file_name().to_string_lossy().into_owned();
            // 隠しパスは原則スキップ（.gitignore がある主要 .github も含め速度優先）
            if name.starts_with('.') {
                continue;
            }
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            let p = e.path();
            let kind = match e.file_type() {
                Ok(kind) if !kind.is_symlink() => kind,
                _ => continue,
            };
            if kind.is_dir() {
                if let Ok(rel) = p.strip_prefix(&root) {
                    let rel_s = rel.to_string_lossy().replace('\\', "/");
                    if gitignored(&rel_s, true, &ignore_pats) {
                        continue;
                    }
                }
                subdirs.push(p);
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            if !is_code_file(&p) {
                continue;
            }
            if let Ok(rel) = p.strip_prefix(&root) {
                let rel_s = rel.to_string_lossy().replace('\\', "/");
                if gitignored(&rel_s, false, &ignore_pats) {
                    continue;
                }
            }
            files_seen += 1;
            if files_seen > 4000 {
                break;
            }
            if let Some(t) = tracker.as_mut() {
                t.record(&p);
            }
            let bytes = match read_small_regular(&p, &root, 256 * 1024) {
                Some(b) => b,
                None => continue,
            };
            if bytes.is_empty() || bytes.len() > 256 * 1024 || bytes.contains(&0) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            let path_lower = p.display().to_string().to_lowercase();
            let mut file_bonus = 0usize;
            for t in &terms {
                // CJK bigramはファイル名加点の対象外（ノイズ抑制）。
                // ASCIIの2文字語は通常どおり加点する。
                if is_cjk_bigram(t) {
                    continue;
                }
                if path_lower.contains(t) {
                    file_bonus += 6;
                }
            }
            // 拡張子による弱い事前重み（ドキュメントよりコードを優遇しすぎない程度）
            let ext_bonus = match p
                .extension()
                .and_then(|s| s.to_str())
                .map(|x| x.to_lowercase())
            {
                Some(e) if e == "md" => 0usize,
                Some(_) => 1usize,
                None => 1usize,
            };
            // 全行を採点し、行番号が若い順のバイアスを排して上位だけ残す。
            let mut best: Vec<(usize, usize, String)> = Vec::new();
            for (i, line) in text.lines().enumerate().take(2000) {
                if expired(deadline) {
                    return Vec::new();
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let ll = line.to_lowercase();
                let s = score_line(&ll, &terms);
                if s > 0 {
                    best.push((s, i, line.chars().take(200).collect()));
                }
            }
            if best.is_empty() {
                continue;
            }
            best.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
            best.truncate(MAX_PER_FILE);
            let display = p
                .strip_prefix(&root)
                .map(|r| format!("./{}", r.display()))
                .unwrap_or_else(|_| p.display().to_string());
            for (s, i, snippet) in best {
                // 長い行の語ほど過大評価になるのを抑える
                let len_penalty = snippet.chars().count() / 120;
                let total = s.saturating_sub(len_penalty) + file_bonus + ext_bonus;
                scored.push((total, format!("{display}:{}:{}", i + 1, snippet.trim())));
            }
            if scored.len() >= max * 10 {
                break;
            }
        }
        // 深さ優先だが名前順が保たれるよう逆順で積む
        subdirs.sort_by_key(|p| {
            p.file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
        for d in subdirs.into_iter().rev() {
            if files_seen <= 4000 {
                stack.push(d);
            }
        }
        if scored.len() >= max * 10 {
            break;
        }
        if files_seen > 4000 {
            break;
        }
    }
    // 重複除去して点数順。同点はパス順で安定化。
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.dedup_by(|a, b| a.1 == b.1);
    scored.into_iter().take(max).map(|(_, s)| s).collect()
}

// ---- assemble + priority pack ----

struct Section {
    name: &'static str,
    body: String,
}

/// 優先度（高い順）。retrieved は最初に削る。
fn priority_order() -> Vec<&'static str> {
    vec![
        "goal",
        "constraints",
        "memory",
        "related_files",
        "git_diff",
        "decisions",
        "open_tasks",
        "retrieved",
        "sessions",
    ]
}

struct Assembled {
    sections: Vec<Section>,
    snapshot: Snapshot,
    retrieval_skipped: bool,
}

fn memory_lines(memory: &MemoryStore, kind: &str) -> Vec<String> {
    memory
        .entries
        .iter()
        .filter(|e| e.superseded_by.is_none() && e.kind == kind)
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|e| {
            format!(
                "[mem] {}",
                e.text
                    .replace(['\r', '\n'], " ")
                    .chars()
                    .take(200)
                    .collect::<String>()
            )
        })
        .collect()
}

fn append_memory(body: &mut String, memory: &MemoryStore, kind: &str) {
    let lines = memory_lines(memory, kind);
    if !lines.is_empty() {
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str(&lines.join("\n"));
    }
}

fn assemble(query: &str, cfg: &ContextConfig) -> Assembled {
    assemble_at(query, cfg, None, 0)
}

fn assemble_at(
    query: &str,
    cfg: &ContextConfig,
    deadline: Option<Instant>,
    carry_sessions: usize,
) -> Assembled {
    let mut tracker = SnapshotTracker::start(deadline);
    let path = memory_path();
    if path.exists() {
        tracker.record(&path);
    }
    let root = std::fs::canonicalize(".").ok();
    for f in cfg.working_files.iter().take(12) {
        if std::fs::canonicalize(f)
            .ok()
            .is_some_and(|p| root.as_ref().is_some_and(|r| p.starts_with(r)) && p.is_file())
        {
            tracker.record(Path::new(f));
        }
    }
    let loaded = MemoryStore::load(&path);
    // An unreadable store degrades to settings-only; it is reported as a section
    // rather than failing the assembly.
    let memory_unknown = loaded.is_err();
    let memory = loaded.unwrap_or_default();
    let mut secs = assemble_sections(query, cfg, &memory, &mut tracker, deadline);
    if memory_unknown {
        secs.push(Section {
            name: "memory",
            body: "(memory unreadable: unknown; using settings)".to_string(),
        });
    }
    if carry_sessions > 0 && !expired(deadline) {
        let body = inherited_sessions(query, carry_sessions.min(10), &mut tracker, deadline);
        if !body.is_empty() {
            secs.push(Section {
                name: "sessions",
                body,
            });
        }
    }
    let retrieval_skipped = expired(deadline);
    if retrieval_skipped {
        secs.retain(|s| s.name != "retrieved");
    }
    let order = priority_order();
    secs.sort_by_key(|s| order.iter().position(|n| *n == s.name).unwrap_or(99));
    let snapshot = tracker.finish(deadline);
    Assembled {
        sections: secs,
        snapshot,
        retrieval_skipped: retrieval_skipped || expired(deadline),
    }
}

fn assemble_sections(
    query: &str,
    cfg: &ContextConfig,
    memory: &MemoryStore,
    tracker: &mut SnapshotTracker,
    deadline: Option<Instant>,
) -> Vec<Section> {
    let mut secs = Vec::new();
    let goal = if cfg.goal.trim().is_empty() {
        memory_lines(memory, "goal").pop().unwrap_or_else(|| {
            "(unset — set with: rdsh settings set context.goal \"...\")".to_string()
        })
    } else {
        cfg.goal.clone()
    };
    secs.push(Section {
        name: "goal",
        body: goal,
    });
    for (name, kind, items) in [
        ("constraints", "constraint", &cfg.constraints),
        ("decisions", "decision", &cfg.decisions),
        ("open_tasks", "task", &cfg.open_tasks),
    ] {
        let (mut body, _) = truncate_list(items, 20, 2000);
        append_memory(&mut body, memory, kind);
        if !body.is_empty() {
            secs.push(Section { name, body });
        }
    }
    let mut notes = memory_lines(memory, "file");
    notes.extend(memory_lines(memory, "note"));
    if !notes.is_empty() {
        secs.push(Section {
            name: "memory",
            body: notes.join("\n"),
        });
    }
    if !cfg.working_files.is_empty() {
        let mut parts = Vec::new();
        for f in cfg.working_files.iter().take(12) {
            match read_working_file(f, 8000) {
                Ok(t) => {
                    tracker.record(Path::new(f));
                    let lines = t.lines().count();
                    let tok = estimate(&t);
                    let (snippet, cut) = head_tail(&t, 2000, 1000);
                    let flag = if cut { ", truncated" } else { "" };
                    parts.push(format!(
                        "## {f} ({lines} lines, ~{tok}tok{flag})\n{snippet}"
                    ));
                }
                Err(reason) => {
                    let hint = match reason {
                        "outside-root" => "outside repo root — not read",
                        "not-a-file" => "not a regular file",
                        _ => "missing or binary",
                    };
                    parts.push(format!("## {f}\n({hint} — verify before trusting)"));
                }
            }
        }
        secs.push(Section {
            name: "related_files",
            body: parts.join("\n\n"),
        });
    }
    if cfg.include_git_diff && !expired(deadline) {
        secs.push(Section {
            name: "git_diff",
            body: git_snapshot(deadline),
        });
    }
    if cfg.enable_retriever && !expired(deadline) {
        let q = query.trim();
        let mut parts = code_hits_tracked(q, cfg.max_code_hits, Some(tracker), deadline);
        if !expired(deadline) {
            let mut seeds: Vec<String> = parts
                .iter()
                .filter_map(|h| {
                    h.split_once(':')
                        .map(|(p, _)| p.trim_start_matches("./").to_string())
                })
                .collect();
            seeds.sort();
            seeds.dedup();
            if !seeds.is_empty() {
                let mut neighbours = if cfg.dep_graph {
                    crate::deps::related_files(&seeds, 5)
                } else {
                    Vec::new()
                };
                neighbours.sort();
                neighbours.dedup();
                for f in neighbours.into_iter().take(5) {
                    if expired(deadline) {
                        break;
                    }
                    tracker.record(Path::new(&f));
                    match read_working_file(&f, 64 * 1024) {
                        Ok(text) => {
                            let excerpt = text.lines().take(40).collect::<Vec<_>>().join("\n");
                            let excerpt = crate::tokens::prune_to_budget(&excerpt, 1200);
                            parts.push(format!("## {f} ({})\n{excerpt}", dep_reason(&seeds)));
                        }
                        Err(_) => parts.push(format!(
                            "## {f} ({})\n(content: unknown)",
                            dep_reason(&seeds)
                        )),
                    }
                }
            }
            if parts.is_empty() && !q.is_empty() {
                parts.push(format!("(no hits for query {q:?})"));
            }
            // Cheap presence check: graph_summary() would walk the whole tree
            // here, and this runs on the per-turn injection path.
            if !cfg.dep_graph {
                parts.push("(dependency graph: off via features.dep_graph)".to_string());
            } else if !crate::deps::index_present() {
                parts.push("(dependencies: unknown; run rdsh deps build)".to_string());
            }
        }
        if !parts.is_empty() && !expired(deadline) {
            secs.push(Section {
                name: "retrieved",
                body: parts.join("\n"),
            });
        }
    }
    let order = priority_order();
    secs.sort_by_key(|s| order.iter().position(|n| *n == s.name).unwrap_or(99));
    secs
}

// Carry one user utterance per recent session, at most 400 tokens in total.
// Unknown project ownership is omitted: other projects are not inferred local.
fn read_inherited_session(path: &Path, root: &Path, deadline: Option<Instant>) -> Option<Vec<u8>> {
    if expired(deadline) {
        return None;
    }
    if !path.extension().is_some_and(|e| e == "zstd") {
        return read_small_regular(path, root, 256 * 1024);
    }
    let root = std::fs::canonicalize(root).ok()?;
    let source = std::fs::canonicalize(path).ok()?;
    // Pass the validated handle through to the decompressor. Reopening the
    // canonical path here would allow it to be replaced after this check.
    let file = open_beneath(&root, &source)?;
    let (bytes, limited) =
        read_zstd_session_from_file(&source, file, 256 * 1024, usize::MAX, deadline).ok()?;
    (!limited).then_some(bytes)
}

fn inherited_sessions(
    query: &str,
    limit: usize,
    tracker: &mut SnapshotTracker,
    deadline: Option<Instant>,
) -> String {
    let root = Path::new(&crate::inspect::dsh_home()).join("sessions");
    let cwd = std::fs::canonicalize(".").ok();
    let terms = query_terms(query);
    let mut seen_sessions = BTreeSet::new();
    let mut lines = Vec::new();
    for p in session_files_sorted(4).into_iter().take(120) {
        if expired(deadline) || lines.len() >= limit {
            break;
        }
        let session = p.parent().unwrap_or(&p).to_path_buf();
        if seen_sessions.contains(&session) {
            continue;
        }
        tracker.record(&p);
        let Some(bytes) = read_inherited_session(&p, &root, deadline) else {
            continue;
        };
        let mut best: Option<(usize, usize, String)> = None;
        let mut session_cwd: Option<PathBuf> = None;
        for (index, line) in String::from_utf8_lossy(&bytes).lines().enumerate() {
            if expired(deadline) {
                break;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if let Some(owner) = v["cwd"].as_str().or_else(|| v["message"]["cwd"].as_str()) {
                session_cwd = std::fs::canonicalize(owner).ok();
            }
            if session_cwd.is_none() || session_cwd.as_ref() != cwd.as_ref() {
                continue;
            }
            for text in user_texts(&v) {
                let score = score_line(&text.to_lowercase(), &terms);
                if !terms.is_empty() && score == 0 {
                    continue;
                }
                let snippet: String = text
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(240)
                    .collect();
                if best
                    .as_ref()
                    .is_none_or(|(s, i, _)| (score, index) > (*s, *i))
                {
                    best = Some((score, index, snippet));
                }
            }
        }
        if let Some((_, _, snippet)) = best {
            seen_sessions.insert(session);
            lines.push(format!("[session] {} :: {snippet}", short_session(&p)));
        }
    }
    crate::tokens::prune_to_budget(&lines.join("\n"), 400)
}

/// 本文を行単位で割合だけ残す（順位順の先頭を優先）。
fn shrink_lines(body: &str, frac: f64) -> String {
    if frac >= 1.0 {
        return body.to_string();
    }
    if frac <= 0.0 {
        return String::new();
    }
    let lines: Vec<&str> = body.lines().collect();
    let keep = ((lines.len() as f64) * frac) as usize;
    lines
        .into_iter()
        .take(keep.max(1))
        .collect::<Vec<_>>()
        .join("\n")
}

fn pack_by_priority(sections: Vec<Section>, budget: usize) -> String {
    let full = render(&sections);
    if estimate(&full) <= budget {
        return full;
    }
    // 低優先度から削る：retrieved -> open_tasks -> decisions -> git_diff -> related_files
    // goal と constraints は最後まで残す
    let mut kept: Vec<Section> = sections;
    // 1) 低優先度3節を段階的に縮小（落とす前に半分→1/4を試す）
    for frac in [0.5, 0.25] {
        let mut trial = Vec::with_capacity(kept.len());
        for s in &kept {
            if matches!(
                s.name,
                "retrieved" | "sessions" | "open_tasks" | "decisions"
            ) {
                trial.push(Section {
                    name: s.name,
                    body: shrink_lines(&s.body, frac),
                });
            } else {
                trial.push(Section {
                    name: s.name,
                    body: s.body.clone(),
                });
            }
        }
        if estimate(&render(&trial)) <= budget {
            return render(&trial);
        }
        kept = trial;
    }
    // 2) それでも超過なら低優先度節から順に落とす
    for drop in [
        "retrieved",
        "sessions",
        "open_tasks",
        "decisions",
        "git_diff",
        "related_files",
    ] {
        if estimate(&render(&kept)) <= budget {
            break;
        }
        kept.retain(|s| s.name != drop);
    }
    if estimate(&render(&kept)) <= budget {
        return render(&kept);
    }
    // 3) 最終手段：goal/constraints は温存し、残りだけ予算内に刈る
    prune_keep_goal(&kept, budget)
}

/// goal と constraints を温存したまま残りを予算に収める。
fn prune_keep_goal(sections: &[Section], budget: usize) -> String {
    let mut head = String::new();
    let mut rest: Vec<&Section> = Vec::new();
    for s in sections {
        if matches!(s.name, "goal" | "constraints" | "memory") {
            head.push_str(&format!("# {}\n{}\n\n", s.name, s.body));
        } else {
            rest.push(s);
        }
    }
    let head_tokens = estimate(&head);
    if head_tokens >= budget {
        // goal単体で超過の異常系のみ全体刈り（通常は到達しない）
        return crate::tokens::prune_to_budget(&render(sections), budget);
    }
    let mut tail = String::new();
    for s in rest {
        tail.push_str(&format!("# {}\n{}\n\n", s.name, s.body));
    }
    let leftover = budget.saturating_sub(head_tokens);
    head.push_str(&crate::tokens::prune_to_budget(&tail, leftover));
    head
}

/// pack 後の本文を節ごとに割って実測トークンを付ける。
fn packed_breakdown(packed: &str) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut name = String::new();
    let mut body = String::new();
    let flush = |name: &mut String, body: &mut String, out: &mut Vec<serde_json::Value>| {
        if name.is_empty() {
            return;
        }
        out.push(serde_json::json!({"name": name.clone(), "tokens": estimate(body)}));
        name.clear();
        body.clear();
    };
    for line in packed.lines() {
        if let Some(rest) = line.strip_prefix("# ") {
            flush(&mut name, &mut body, &mut out);
            name = rest.trim().to_string();
        } else {
            body.push_str(line);
            body.push('\n');
        }
    }
    flush(&mut name, &mut body, &mut out);
    out
}

fn render(sections: &[Section]) -> String {
    let mut s = String::new();
    for sec in sections {
        s.push_str(&format!("# {}\n{}\n\n", sec.name, sec.body));
    }
    s
}

fn missing_files(cfg: &ContextConfig) -> Vec<String> {
    let root = std::fs::canonicalize(".").ok();
    let mut out: Vec<String> = Vec::new();
    for f in &cfg.working_files {
        let bad = match std::fs::metadata(f) {
            Err(_) => true,
            Ok(m) if !m.is_file() => true,
            Ok(_) => match (&root, std::fs::canonicalize(f)) {
                (Some(r), Ok(t)) => !t.starts_with(r),
                (_, Err(_)) => true,
                _ => false,
            },
        };
        if bad {
            out.push(f.clone());
        }
        if out.len() >= 20 {
            break;
        }
    }
    out.sort();
    out.dedup();
    out
}

pub fn cmd_status(json: bool) -> anyhow::Result<()> {
    let cfg = load_config();
    let wm = format!(
        "goal={} constraints={} decisions={} files={} tasks={}",
        cfg.goal.chars().count(),
        cfg.constraints.len(),
        cfg.decisions.len(),
        cfg.working_files.len(),
        cfg.open_tasks.len()
    );
    let wm_tokens = estimate(&cfg.goal)
        + estimate(&cfg.decisions.join("\n"))
        + estimate(&cfg.constraints.join("\n"))
        + estimate(&cfg.open_tasks.join("\n"));
    let missing = missing_files(&cfg);
    let legacy_exists = std::path::Path::new(&legacy_path()).exists();
    let memory = MemoryStore::load(&memory_path());
    let summary = if cfg.dep_graph {
        crate::deps::graph_summary()
    } else {
        String::new()
    };
    let memory_status = match &memory {
        Ok(m) => {
            serde_json::json!({"active": m.entries.iter().filter(|e| e.superseded_by.is_none()).count(),
            "superseded": m.entries.iter().filter(|e| e.superseded_by.is_some()).count(), "updated_at_unix": m.updated_at_unix})
        }
        Err(_) => {
            serde_json::json!({"active": null, "superseded": null, "updated_at_unix": null, "status": "unknown"})
        }
    };
    if json {
        let v = serde_json::json!({
            "schema": SCHEMA,
            "token_budget": cfg.token_budget,
            "enable_retriever": cfg.enable_retriever,
            "enable_packer": cfg.enable_packer,
            "enable_verifier": cfg.enable_verifier,
            "max_code_hits": cfg.max_code_hits,
            "max_sessions": cfg.max_sessions,
            "include_git_diff": cfg.include_git_diff,
            "goal": cfg.goal,
            "constraints": cfg.constraints,
            "decisions": cfg.decisions.len(),
            "open_tasks": cfg.open_tasks.len(),
            "working_memory": wm,
            "working_memory_tokens": wm_tokens,
            "missing_files": missing,
            "config_path": config_path(),
            "legacy_path": legacy_path(),
            "legacy_present": legacy_exists,
            "priority": priority_order(),
            "memory": memory_status,
            "deps": {"summary": summary, "index_present": !summary.is_empty()},
            "dependency_graph": {"enabled": cfg.dep_graph},
            "inject": {"budget": cfg.inject_budget, "deadline_ms": cfg.inject_deadline_ms,
                "sessions": if cfg.inject_sessions { cfg.inject_session_count } else { 0 }},
        });
        println!("{}", serde_json::to_string_pretty(&v)?);
        return Ok(());
    }
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    writeln!(out, "[rdsh context: v{SCHEMA}]")?;
    writeln!(out, "config: {} (legacy: {})", config_path(), legacy_path())?;
    writeln!(out, "budget: {} tokens", cfg.token_budget)?;
    writeln!(
        out,
        "dependency_graph: {}",
        if cfg.dep_graph {
            "enabled"
        } else {
            "disabled via features.dep_graph"
        }
    )?;
    writeln!(
        out,
        "retriever/packer/verifier: {}/{}/{}",
        cfg.enable_retriever, cfg.enable_packer, cfg.enable_verifier
    )?;
    writeln!(
        out,
        "code_hits={} sessions={} git_diff={}",
        cfg.max_code_hits,
        cfg.max_sessions,
        if cfg.include_git_diff { "on" } else { "off" }
    )?;
    writeln!(out, "working memory: {wm} (~{wm_tokens} tokens)")?;
    if cfg.goal.trim().is_empty() {
        writeln!(
            out,
            "goal: (unset — rdsh settings set context.goal \"...\")"
        )?;
    } else {
        writeln!(out, "goal: {}", cfg.goal)?;
    }
    if !missing.is_empty() {
        writeln!(out, "warn: missing files: {}", missing.join(", "))?;
    }
    if legacy_exists {
        writeln!(
            out,
            "note: legacy {} exists (ignored when rdsh.json has context)",
            legacy_path()
        )?;
    }
    out.flush()?;
    Ok(())
}

/// Options for [`cmd_build`].
#[derive(Debug, Clone, Default)]
pub struct BuildOptions {
    pub query: Option<String>,
    pub budget: Option<usize>,
    /// Overrides `context.max_sessions` for this call (past-session carryover).
    pub sessions: Option<usize>,
    /// Exit 3 when git state or a read file changed while the context was built.
    pub require_stable: bool,
    pub json: bool,
}

pub fn cmd_build(opts: BuildOptions) -> anyhow::Result<()> {
    let mut cfg = load_config();
    if let Some(n) = opts.sessions {
        cfg.max_sessions = n.clamp(0, 100);
    }
    let q = opts.query.unwrap_or_default();
    let budget = opts.budget.unwrap_or(cfg.token_budget).clamp(500, 200_000);
    let as_json = opts.json;
    // `--sessions N` lands in cfg.max_sessions; assemble() hardcodes 0, so the
    // carryover count has to be passed through explicitly.
    let assembled = assemble_at(&q, &cfg, None, cfg.max_sessions);
    let snapshot = assembled.snapshot;
    let sections = assembled.sections;
    let full = render(&sections);
    let before = estimate(&full);
    // JSON用の節内訳は pack 前に確保（pack が所有権を奪うため）
    let sections_summary: Vec<serde_json::Value> = sections
        .iter()
        .map(|s| serde_json::json!({"name": s.name, "tokens": estimate(&s.body)}))
        .collect();
    let packed = if cfg.enable_packer {
        pack_by_priority(sections, budget)
    } else {
        full
    };
    let after = estimate(&packed);
    if as_json {
        // sections は pack 前の内訳、packed_sections は pack 後の実測内訳。
        let packed_sections = packed_breakdown(&packed);
        let v = serde_json::json!({
            "query": q,
            "budget": budget,
            "max_code_hits": cfg.max_code_hits,
            "max_sessions": cfg.max_sessions,
            "include_git_diff": cfg.include_git_diff,
            "tokens_before": before,
            "tokens_after": after,
            "priority": priority_order(),
            "missing_files": missing_files(&cfg),
            "sections": sections_summary,
            "packed_sections": packed_sections,
            "context": packed,
            "snapshot": snapshot.value(),
        });
        println!("{}", serde_json::to_string_pretty(&v)?);
        if opts.require_stable && !snapshot.stable {
            std::process::exit(3);
        }
        return Ok(());
    }
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    writeln!(out, "{}", snapshot.line())?;
    out.write_all(packed.as_bytes())?;
    if !packed.ends_with('\n') {
        out.write_all(b"\n")?;
    }
    out.flush()?;
    eprintln!("[rdsh context build] {before}->{after} tokens (budget {budget})");
    if opts.require_stable && !snapshot.stable {
        std::process::exit(3);
    }
    Ok(())
}

pub fn cmd_search(query: String, max: usize) -> anyhow::Result<()> {
    let max = max.clamp(1, 100);
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    let code = code_hits(&query, max);
    writeln!(out, "# code ({})", code.len())?;
    if code.is_empty() {
        writeln!(out, "(no hits)")?;
    }
    for (i, h) in code.iter().enumerate() {
        writeln!(out, "{}: {h}", i + 1)?;
    }
    let sess = recent_sessions(&query, max.min(20));
    writeln!(out, "# sessions ({})", sess.len())?;
    if sess.is_empty() {
        writeln!(out, "(no hits)")?;
    }
    for (i, s) in sess.iter().enumerate() {
        writeln!(out, "{}: {s}", i + 1)?;
    }
    out.flush()?;
    eprintln!(
        "[rdsh context search] query={query:?} terms={:?}",
        query_terms(&query)
    );
    Ok(())
}

pub fn cmd_explain(query: Option<String>, budget: Option<usize>) -> anyhow::Result<()> {
    let cfg = load_config();
    let q = query.unwrap_or_default();
    let budget = budget.unwrap_or(cfg.token_budget).clamp(500, 200_000);
    let assembled = assemble(&q, &cfg);
    let sections = assembled.sections;
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    writeln!(out, "[rdsh context explain: v{SCHEMA}]")?;
    writeln!(out, "priority: {}", priority_order().join(" > "))?;
    writeln!(out, "budget: {budget} tokens")?;
    writeln!(
        out,
        "limits: code_hits={} sessions={} git_diff={}",
        cfg.max_code_hits,
        cfg.max_sessions,
        if cfg.include_git_diff { "on" } else { "off" }
    )?;
    if !q.trim().is_empty() {
        writeln!(out, "terms: {:?}", query_terms(&q))?;
    }
    for s in &sections {
        let t = estimate(&s.body);
        let why = match s.name {
            "goal" => "always first: settings win; latest active [mem] goal is fallback (never dropped)",
            "constraints" => "must-not-break rules; active [mem] constraints follow settings (kept until the end)",
            "related_files" => "working set from settings (missing files warn)",
            "git_diff" => "branch + status + diff stat (fresh, not from memory)",
            "decisions" => "reused past decisions; active [mem] decisions follow settings",
            "open_tasks" => "unresolved work only; active [mem] tasks appended after settings",
            "memory" => "active [mem] notes/files only; superseded history is excluded",
            "sessions" => "recent matching user utterances from the current project, capped at 400 tokens",
            "retrieved" => "scored hits: coverage + boundary + filename bonus, CJK bigram recall, per-file top3, ranked (first to trim)",
            _ => "",
        };
        writeln!(out, "- {}: ~{} tokens - {}", s.name, t, why)?;
    }
    writeln!(
        out,
        "- snapshot: {} (git HEAD/branch/dirty and size+mtime of read files)",
        assembled.snapshot.line()
    )?;
    if cfg.dep_graph {
        writeln!(out, "- dependencies: retrieved seed importers/imports, at most 5 files; unresolved references stay unknown")?;
    } else {
        writeln!(out, "- dependencies: disabled via features.dep_graph")?;
    }
    writeln!(
        out,
        "- inject: budget={} deadline_ms={} sessions={} (retrieval skipped past deadline)",
        cfg.inject_budget,
        cfg.inject_deadline_ms,
        if cfg.inject_sessions {
            cfg.inject_session_count
        } else {
            0
        }
    )?;
    if !cfg.enable_verifier {
        writeln!(out, "note: verifier is OFF (summaries are trusted as-is)")?;
    } else {
        writeln!(
            out,
            "note: verifier is ON - re-open source file/git/session before acting"
        )?;
    }
    let missing = missing_files(&cfg);
    if !missing.is_empty() {
        writeln!(out, "warn: missing files: {}", missing.join(", "))?;
    }
    out.flush()?;
    Ok(())
}

// ---- context v3 entry points ----

// Serialize writers without replacing existing history after a failed read.
struct MemoryLock {
    _lock: crate::file_lock::FileLock,
}

impl MemoryLock {
    fn acquire(path: &Path) -> anyhow::Result<Self> {
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("memory parent: unknown"))?;
        std::fs::create_dir_all(parent)?;
        let target = parent.join(".rdsh-context-memory");
        Ok(Self {
            _lock: crate::file_lock::FileLock::exclusive_for(&target)?,
        })
    }
}

fn hook_value(event: &str, context: &str) -> Option<serde_json::Value> {
    if context.trim().is_empty() {
        return None;
    }
    Some(serde_json::json!({"hookSpecificOutput": {
        "hookEventName": if event == "session-start" { "SessionStart" } else { "UserPromptSubmit" },
        "additionalContext": context}, "suppressOutput": true}))
}

fn silent_hook_line(result: anyhow::Result<Option<serde_json::Value>>) -> Option<String> {
    result
        .ok()
        .flatten()
        .and_then(|value| serde_json::to_string(&value).ok())
}

fn hook_stdin(deadline: Instant) -> anyhow::Result<serde_json::Value> {
    use std::io::IsTerminal;
    if std::io::stdin().is_terminal() {
        return Ok(serde_json::json!({}));
    }
    #[cfg(unix)]
    {
        // The hook bridge writes the payload after spawning us, so a writer that
        // has not reached its write yet must not be mistaken for "no payload":
        // that silently drops the prompt and the whole retrieval. Wait a short,
        // deadline-bounded grace before giving up on stdin.
        let grace = deadline
            .saturating_duration_since(Instant::now())
            .min(std::time::Duration::from_millis(250))
            .as_millis()
            .min(i32::MAX as u128) as libc::c_int;
        let mut fd = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut fd, 1, grace) };
        anyhow::ensure!(ready >= 0, "hook stdin: unknown");
        if ready == 0 {
            return Ok(serde_json::json!({}));
        }
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = std::io::stdin()
            .lock()
            .take(256 * 1024 + 1)
            .read_to_end(&mut bytes);
        let _ = sender.send(result.map(|_| bytes));
    });
    let bytes = receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))??;
    if bytes.len() > 256 * 1024 {
        // Truncated payload: the goal, constraints and memory do not depend on
        // the prompt, so inject without it instead of going silent.
        return Ok(serde_json::json!({}));
    }
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(serde_json::json!({}));
    }
    let v: serde_json::Value = serde_json::from_slice(&bytes)?;
    anyhow::ensure!(v.is_object(), "hook stdin must be an object");
    Ok(v)
}

// All failures are represented by None before anything reaches stdout.
/// Explain why a graph neighbour was added without inventing the exact edge.
fn dep_reason(seeds: &[String]) -> String {
    match seeds {
        [only] => format!("dep: related to {only}"),
        _ => format!(
            "dep: graph neighbour of {} retrieved file(s); exact edge: unknown",
            seeds.len()
        ),
    }
}

// All failures are represented by None before anything reaches stdout.
fn inject_context(
    event: &str,
    query: &str,
    cfg: &ContextConfig,
    sessions: usize,
    deadline: Instant,
    json: bool,
) -> anyhow::Result<Option<serde_json::Value>> {
    // An unreadable memory store is reported as a section and the injection
    // continues with settings only; it must never silence the whole hook.
    let mut assembled = assemble_at(query, cfg, Some(deadline), sessions);
    let mut pinned = Vec::new();
    for section in &mut assembled.sections {
        if matches!(section.name, "goal" | "constraints" | "memory") {
            continue;
        }
        let mut ordinary = Vec::new();
        for line in section.body.lines() {
            if line.starts_with("[mem] ") {
                pinned.push(line.to_string());
            } else {
                ordinary.push(line);
            }
        }
        section.body = ordinary.join("\n");
    }
    if !pinned.is_empty() {
        if let Some(memory) = assembled.sections.iter_mut().find(|s| s.name == "memory") {
            memory.body.push('\n');
            memory.body.push_str(&pinned.join("\n"));
        } else {
            assembled.sections.push(Section {
                name: "memory",
                body: pinned.join("\n"),
            });
        }
    }
    assembled.sections.retain(|s| {
        !s.body.trim().is_empty()
            && !(s.name == "goal" && s.body.starts_with("(unset —"))
            && !(s.name == "git_diff" && assembled.snapshot.branch == "unknown")
            && !(s.name == "retrieved" && query.trim().is_empty())
    });
    let order = priority_order();
    assembled
        .sections
        .sort_by_key(|s| order.iter().position(|n| *n == s.name).unwrap_or(99));
    let mut suffix = String::new();
    if assembled.retrieval_skipped {
        assembled.sections.retain(|s| s.name != "retrieved");
        suffix.push_str("\n(retrieval skipped: deadline)\n");
    }
    if !assembled.snapshot.changed_files.is_empty() {
        suffix.push_str("\n(warning: repo changed while building context)\n");
    }
    if !assembled.snapshot.unknown.is_empty() {
        suffix.push_str("\n(snapshot: unknown)\n");
    }
    if assembled.sections.is_empty() {
        return Ok(None);
    }
    let mut context = pack_by_priority(
        assembled.sections,
        cfg.inject_budget.saturating_sub(estimate(&suffix) + 1),
    );
    context.push_str(&suffix);
    let mut value = hook_value(event, &context);
    if json {
        if let Some(value) = &mut value {
            value["rdsh"] = serde_json::json!({
                "sections": packed_breakdown(&context),
                "tokens": estimate(&context),
                "budget": cfg.inject_budget,
                "retrieval_skipped": assembled.retrieval_skipped,
                "snapshot_stable": assembled.snapshot.stable,
                "sessions": sessions,
            });
        }
    }
    Ok(value)
}

/// DSH hook: one JSON line or silence, with every local error swallowed.
pub fn cmd_inject(
    event: &str,
    query: Option<String>,
    sessions: Option<usize>,
    json: bool,
) -> anyhow::Result<()> {
    let result = (|| -> anyhow::Result<Option<serde_json::Value>> {
        let settings = crate::rdsh_config::try_load()?;
        if !crate::rdsh_config::feature_enabled(&settings, "context_engine") {
            return Ok(None);
        }
        let cfg = config_from(&settings);
        let deadline =
            Instant::now() + std::time::Duration::from_millis(cfg.inject_deadline_ms as u64);
        let payload = hook_stdin(deadline)?;
        let prompt = payload.get("prompt").and_then(content_text);
        if let Some(cwd) = payload["cwd"].as_str() {
            anyhow::ensure!(
                std::fs::canonicalize(cwd).ok() == std::fs::canonicalize(".").ok(),
                "hook cwd mismatch: unknown"
            );
        }
        let q = query.as_deref().or(prompt.as_deref()).unwrap_or_default();
        let count = sessions
            .map(|n| n.min(10))
            .unwrap_or(if cfg.inject_sessions {
                cfg.inject_session_count
            } else {
                0
            });
        inject_context(event, q, &cfg, count, deadline, json)
    })();
    if let Some(line) = silent_hook_line(result) {
        let _ = writeln!(std::io::stdout().lock(), "{line}");
    }
    Ok(())
}

/// Append one remembered item. Normalized duplicates increment `seen`.
pub fn cmd_remember(text: String, kind: Option<String>, json: bool) -> anyhow::Result<()> {
    let path = memory_path();
    let _lock = MemoryLock::acquire(&path)?;
    let mut memory = MemoryStore::load(&path)?;
    let (id, _) = memory.remember(
        &text,
        kind.as_deref().unwrap_or("note"),
        "manual",
        false,
        now_unix(),
    )?;
    memory.save(&path)?;
    let entry = memory
        .entries
        .iter()
        .find(|e| e.id == id)
        .expect("remembered entry");
    if json {
        println!(
            "{}",
            serde_json::json!({"schema": 1, "revision": memory.revision, "entry": entry.value(), "id": id})
        );
    } else {
        println!("{id} [{}] {} (seen={})", entry.kind, entry.text, entry.seen);
    }
    Ok(())
}

pub fn cmd_memory(json: bool) -> anyhow::Result<()> {
    let memory = MemoryStore::load(&memory_path())?;
    if json {
        println!("{}", serde_json::to_string_pretty(&memory.value())?);
    } else {
        if memory.entries.is_empty() {
            println!("(no memory entries)");
        }
        for e in memory.entries {
            let state = e
                .superseded_by
                .as_deref()
                .map(|id| format!("superseded -> {id}"))
                .unwrap_or_else(|| "active".to_string());
            println!(
                "{} [{}; {state}; seen={}] {}",
                e.id,
                e.kind,
                e.seen,
                e.text.replace(['\r', '\n'], " ")
            );
        }
    }
    Ok(())
}

const DISTILL_SESSION_CAP: usize = 64 * 1024 * 1024;
const DISTILL_LINE_LIMIT: usize = 200_000;

#[derive(Debug)]
struct MissingZstd;

impl std::fmt::Display for MissingZstd {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "zstd が無いので圧縮セッションを読めません (zstd not found in PATH)"
        )
    }
}

impl std::error::Error for MissingZstd {}

fn read_session_stream(
    reader: impl Read,
    cap: usize,
    line_limit: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(reader.take(cap as u64));
    let mut bytes = Vec::new();
    let mut lines = 0;
    while bytes.len() < cap && lines < line_limit {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            break;
        }
        let mut end = available.len();
        for (i, byte) in available.iter().enumerate() {
            if *byte == b'\n' {
                lines += 1;
                if lines == line_limit {
                    end = i + 1;
                    break;
                }
            }
        }
        bytes.extend_from_slice(&available[..end]);
        reader.consume(end);
    }
    let limited = bytes.len() == cap || lines == line_limit;
    // A byte limit can split a JSON record or UTF-8 scalar. Keep complete lines.
    if limited && bytes.last() != Some(&b'\n') {
        let end = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        bytes.truncate(end);
    }
    Ok((bytes, limited))
}

fn read_distill_session(source: &Path) -> anyhow::Result<(Vec<u8>, bool)> {
    if !source.extension().is_some_and(|e| e == "zstd") {
        // Same budget as the compressed path: a plain transcript is not a
        // second-class input, and the store cap (4MiB) is far too small for it.
        return read_small_regular(
            source,
            source.parent().unwrap_or(Path::new(".")),
            DISTILL_SESSION_CAP,
        )
        .map(|bytes| (bytes, false))
        .ok_or_else(|| anyhow::anyhow!("session unreadable or over limit: unknown"));
    }
    read_zstd_session(source, DISTILL_SESSION_CAP, DISTILL_LINE_LIMIT, None)
}

fn read_zstd_session(
    source: &Path,
    cap: usize,
    line_limit: usize,
    deadline: Option<Instant>,
) -> anyhow::Result<(Vec<u8>, bool)> {
    let file = std::fs::File::open(source)?;
    read_zstd_session_from_file(source, file, cap, line_limit, deadline)
}

fn read_zstd_session_from_file(
    source: &Path,
    file: std::fs::File,
    cap: usize,
    line_limit: usize,
    deadline: Option<Instant>,
) -> anyhow::Result<(Vec<u8>, bool)> {
    anyhow::ensure!(!expired(deadline), "session deadline exceeded");
    anyhow::ensure!(file.metadata()?.is_file(), "session must be a regular file");
    let mut child = std::process::Command::new("zstd")
        .args(["-dc"])
        .stdin(std::process::Stdio::from(file))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                anyhow::Error::new(MissingZstd)
            } else {
                error.into()
            }
        })?;
    // Drain concurrently so a stalled decompressor cannot block the hook.
    let stdout = child.stdout.take().expect("piped zstd stdout");
    let zstd_stderr = child.stderr.take();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(read_session_stream(stdout, cap, line_limit));
    });
    let result = match deadline {
        Some(limit) => receiver
            .recv_timeout(limit.saturating_duration_since(Instant::now()))
            .map_err(anyhow::Error::from),
        None => receiver.recv().map_err(anyhow::Error::from),
    }
    .and_then(|result| result.map_err(anyhow::Error::from));
    // Stop decompression at either limit or on read failure, then reap the child.
    if result.as_ref().map_or(true, |(_, limited)| *limited) {
        let _ = child.kill();
    }
    let status = if let Some(limit) = deadline {
        loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < limit => {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    anyhow::bail!("session deadline exceeded or zstd wait failed");
                }
            }
        }
    } else {
        child.wait()?
    };
    let (bytes, limited) = result?;
    anyhow::ensure!(!expired(deadline), "session deadline exceeded");
    // zstd writes short diagnostics; keep them for the error instead of
    // discarding the only explanation of a non-zero exit.
    let mut note = Vec::new();
    if let Some(pipe) = zstd_stderr {
        use std::io::Read;
        let _ = pipe.take(4096).read_to_end(&mut note);
    }
    anyhow::ensure!(
        limited || status.success(),
        "zstd session decompression failed (status {status}, source {}): {}",
        source.display(),
        String::from_utf8_lossy(&note).trim()
    );
    Ok((bytes, limited))
}

/// Deterministic user-only extraction, dry-run unless apply is true.
pub fn cmd_distill(source: Option<String>, apply: bool, json: bool) -> anyhow::Result<()> {
    let source = match source {
        Some(s) => PathBuf::from(s),
        None => session_files_sorted(40)
            .into_iter()
            .find(|p| is_jsonl_session(p))
            .ok_or_else(|| anyhow::anyhow!("latest session: unknown (no JSONL transcript)"))?,
    };
    let source = std::fs::canonicalize(source)?;
    let (bytes, limited) = match read_distill_session(&source) {
        Err(error) if error.is::<MissingZstd>() => {
            eprintln!("[rdsh] error: {error}");
            std::process::exit(2);
        }
        result => result?,
    };
    let text = std::str::from_utf8(&bytes)?;
    // Invalid records cannot be interpreted as user speech. Report the gap.
    let invalid = text
        .lines()
        .filter(|line| {
            !line.trim().is_empty() && serde_json::from_str::<serde_json::Value>(line).is_err()
        })
        .count();
    let candidates = distill_candidates(text);
    let path = memory_path();
    let _lock = if apply {
        Some(MemoryLock::acquire(&path)?)
    } else {
        None
    };
    let mut memory = MemoryStore::load(&path)?;
    let session = text
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find_map(|v| v["session_id"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "distill".to_string());
    let mut warnings = Vec::new();
    if limited {
        warnings.push(format!(
            "unknown: session read limit reached ({} bytes / {DISTILL_LINE_LIMIT} lines)",
            DISTILL_SESSION_CAP
        ));
    }
    if invalid > 0 {
        warnings.push(format!("unknown: {invalid} invalid JSONL records omitted"));
    }
    let mut results = Vec::new();
    let now = now_unix();
    for candidate in &candidates {
        let (id, conflicts) =
            memory.remember(&candidate.text, candidate.kind, &session, true, now)?;
        warnings.extend(conflicts);
        results.push(serde_json::json!({"id": id, "kind": candidate.kind, "text": candidate.text}));
    }
    let superseded: Vec<serde_json::Value> = memory
        .entries
        .iter()
        .filter(|e| e.superseded_by.is_some())
        .map(MemoryEntry::value)
        .collect();
    if apply && !candidates.is_empty() {
        memory.save(&path)?;
    }
    warnings.sort();
    warnings.dedup();
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({"apply": apply, "dry_run": !apply,
        "source": source, "candidates": results, "superseded": superseded, "warnings": warnings,
        "rules": "user-only markers; token overlap >=60% of larger set, or strongest lexical retraction target; other conflicts unknown"}))?
        );
    } else {
        println!(
            "[distill: {}] {} candidate(s)",
            if apply { "applied" } else { "dry-run" },
            results.len()
        );
        for candidate in candidates {
            println!("[{}] {}", candidate.kind, candidate.text);
        }
        for warning in warnings {
            println!("{warning}");
        }
    }
    Ok(())
}

pub fn cmd_forget(id_or_prefix: String, json: bool) -> anyhow::Result<()> {
    anyhow::ensure!(!id_or_prefix.is_empty(), "memory id prefix is empty");
    let path = memory_path();
    let _lock = MemoryLock::acquire(&path)?;
    let mut memory = MemoryStore::load(&path)?;
    let matches: Vec<usize> = memory
        .entries
        .iter()
        .enumerate()
        .filter(|(_, e)| e.id.starts_with(&id_or_prefix))
        .map(|(i, _)| i)
        .collect();
    anyhow::ensure!(
        matches.len() == 1,
        "memory prefix must identify exactly one entry (matches={})",
        matches.len()
    );
    let e = &mut memory.entries[matches[0]];
    e.superseded_by = Some("forgotten".to_string());
    let id = e.id.clone();
    memory.revision = memory.revision.saturating_add(1);
    memory.updated_at_unix = now_unix();
    memory.save(&path)?;
    if json {
        println!(
            "{}",
            serde_json::json!({"id": id, "superseded_by": "forgotten", "revision": memory.revision})
        );
    } else {
        println!("{id}: forgotten (history retained)");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_keep_retrieval_bounded_and_git_diff_enabled() {
        let cfg = ContextConfig::default();

        assert_eq!(cfg.token_budget, DEFAULT_BUDGET);
        assert_eq!(cfg.max_code_hits, DEFAULT_CODE_HITS);
        assert_eq!(cfg.max_sessions, DEFAULT_SESSIONS);
        assert!(cfg.enable_retriever);
        assert!(cfg.enable_packer);
        assert!(cfg.enable_verifier);
        assert!(cfg.include_git_diff);
    }

    #[test]
    fn query_terms_split_identifiers_and_recall_cjk_bigrams() {
        assert_eq!(
            query_terms("fooBar2日本語検索 and a"),
            vec![
                "foo".to_string(),
                "bar".to_string(),
                "日本語検索".to_string(),
                "日本".to_string(),
                "本語".to_string(),
                "語検".to_string(),
                "検索".to_string(),
            ]
        );
    }

    // #388: 2文字ASCII語（CI/UI/Go）を検索語として捨てない。
    #[test]
    fn two_char_ascii_terms_are_searchable() {
        assert_eq!(query_terms("CI"), vec!["ci".to_string()]);
        assert_eq!(query_terms("Go"), vec!["go".to_string()]);
        assert!(!is_cjk_bigram("ci"));
        assert!(!is_cjk_bigram("go"));
        assert!(is_cjk_bigram("日本"));
        // ASCIIの2文字語は通常加点される。
        assert!(score_line("ci pipeline", &["ci".to_string()]) > 0);
        // CJK bigramは弱い加点になり、通常語と区別される。
        let weak = score_line("日本語のテスト", &["日本".to_string()]);
        let normal = score_line("pipeline のテスト", &["pipeline".to_string()]);
        assert!(weak > 0);
        assert!(weak < normal);
    }

    #[test]
    fn head_tail_truncates_by_unicode_characters() {
        let (text, truncated) = head_tail("あいうえおABCDE", 2, 3);

        assert!(truncated);
        assert_eq!(text, "あい\n...[rdsh truncated 5 chars]...\nCDE");
        assert_eq!(head_tail("short", 2, 3), ("short".to_string(), false));
    }

    #[test]
    fn truncate_list_obeys_character_and_item_limits() {
        let items = vec![
            "alpha".to_string(),
            "bravo".to_string(),
            "charlie".to_string(),
        ];

        assert_eq!(
            truncate_list(&items, 3, 10),
            ("alpha\n...[rdsh 2 more omitted]...".to_string(), 2)
        );
        assert_eq!(truncate_list(&items, 2, 100).1, 1);
    }

    #[test]
    fn shrinking_a_nonempty_section_keeps_at_least_one_line() {
        assert_eq!(shrink_lines("first\nsecond\nthird", 0.1), "first");
        assert_eq!(shrink_lines("first\nsecond", 1.0), "first\nsecond");
    }

    fn pack_fixture() -> Vec<Section> {
        vec![
            Section {
                name: "goal",
                body: "ship the release".to_string(),
            },
            Section {
                name: "constraints",
                body: "no breaking changes".to_string(),
            },
            Section {
                name: "retrieved",
                body: "hit\n".repeat(400),
            },
            Section {
                name: "open_tasks",
                body: "task\n".repeat(200),
            },
            Section {
                name: "decisions",
                body: "decision\n".repeat(200),
            },
            Section {
                name: "git_diff",
                body: "diff\n".repeat(400),
            },
        ]
    }

    /// goal と constraints は最後まで残し、最終的に予算内へ収める。
    #[test]
    fn pack_by_priority_keeps_goal_and_constraints_within_budget() {
        for budget in [64, 128, 512, 4096] {
            let packed = pack_by_priority(pack_fixture(), budget);
            assert!(estimate(&packed) <= budget, "budget {budget} exceeded");
            assert!(packed.contains("# goal"), "budget {budget} dropped goal");
            assert!(
                packed.contains("# constraints"),
                "budget {budget} dropped constraints"
            );
        }
    }

    #[test]
    fn prune_keep_goal_starts_with_goal_within_budget() {
        let pruned = prune_keep_goal(&pack_fixture(), 200);
        assert!(estimate(&pruned) <= 200, "budget exceeded");
        assert!(pruned.starts_with("# goal"), "goal must come first");
        assert!(pruned.contains("# constraints"), "constraints must be kept");
    }
}

#[cfg(test)]
mod bounded_read_tests {
    use super::truncate_utf8_to_bytes;

    #[test]
    fn lossy_replacements_stay_within_the_byte_cap() {
        let bytes = [0xff; 4];
        let text = String::from_utf8_lossy(&bytes);
        let truncated = truncate_utf8_to_bytes(&text, 4);

        assert_eq!(truncated.len(), 3);
        assert_eq!(truncated.chars().count(), 1);
        assert!(truncated.len() <= 4);
    }

    #[test]
    fn truncation_drops_a_partial_multibyte_scalar() {
        assert_eq!(truncate_utf8_to_bytes("ab🦀z", 4), "ab");
    }

    #[test]
    fn empty_input_and_zero_cap_are_safe() {
        assert_eq!(truncate_utf8_to_bytes("", 0), "");
        assert_eq!(truncate_utf8_to_bytes("abc", 0), "");
    }
}

#[cfg(test)]
mod v3_tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "rdsh-context-test-{}",
                crate::local_http::random_token().unwrap()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tracker() -> SnapshotTracker {
        SnapshotTracker {
            git: GitState::default(),
            files: BTreeMap::new(),
            changed: BTreeSet::new(),
        }
    }

    struct HookFixture {
        _temporary: TempDir,
        root: PathBuf,
        home: PathBuf,
    }

    impl HookFixture {
        fn new() -> Self {
            let temporary = TempDir::new();
            let root = temporary.0.join("work");
            let home = temporary.0.join("dsh");
            std::fs::create_dir_all(root.join("src")).unwrap();
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(
                root.join("src/main.rs"),
                "mod related;\npub fn engine_score(input: &str) -> usize { input.len() }\n",
            )
            .unwrap();
            std::fs::write(root.join("src/related.rs"), "pub fn related() {}\n").unwrap();
            std::fs::write(
                home.join("rdsh.json"),
                serde_json::json!({"beta": {"context_engine": true}, "context": {
                    "goal": "keep the configured goal", "include_git_diff": false,
                    "inject_sessions": false, "inject_deadline_ms": 10000
                }})
                .to_string(),
            )
            .unwrap();
            Self {
                _temporary: temporary,
                root,
                home,
            }
        }

        fn run(&self, action: &str, json: bool, prompt: &str) -> std::process::Output {
            self.run_with_path(action, json, prompt, None)
        }

        fn run_with_path(
            &self,
            action: &str,
            json: bool,
            prompt: &str,
            path: Option<&Path>,
        ) -> std::process::Output {
            // Isolate cwd and DSH_HOME from all concurrently running unit tests.
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--quiet",
                    "--exact",
                    "context::v3_tests::injection_subprocess",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .current_dir(&self.root)
                .env("DSH_HOME", &self.home)
                .env("RDSH_CONTEXT_TEST_ACTION", action)
                .env("RDSH_CONTEXT_TEST_JSON", json.to_string())
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            if let Some(path) = path {
                command.env("PATH", path);
            }
            let mut child = command.spawn().unwrap();
            let payload = serde_json::json!({"cwd": self.root, "prompt": prompt});
            child
                .stdin
                .take()
                .unwrap()
                .write_all(payload.to_string().as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success(), "hook test subprocess failed");
            assert!(output.stderr.is_empty());
            output
        }

        fn inject(&self, json: bool, prompt: &str) -> serde_json::Value {
            let output = self.run("inject", json, prompt);
            let values: Vec<serde_json::Value> = std::str::from_utf8(&output.stdout)
                .unwrap()
                .lines()
                .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                .filter(|v| v.get("hookSpecificOutput").is_some())
                .collect();
            assert_eq!(values.len(), 1, "expected exactly one hook JSON line");
            values.into_iter().next().unwrap()
        }
    }

    #[test]
    fn injection_subprocess() {
        let Ok(action) = std::env::var("RDSH_CONTEXT_TEST_ACTION") else {
            return;
        };
        match action.as_str() {
            "build-index" => crate::deps::cmd_build(None, false, true).unwrap(),
            "status" => {
                cmd_status(std::env::var("RDSH_CONTEXT_TEST_JSON").unwrap() == "true").unwrap()
            }
            "explain" => cmd_explain(None, None).unwrap(),
            "inject" | "inject-sessions" => cmd_inject(
                "user-prompt-submit",
                None,
                Some(if action == "inject-sessions" { 2 } else { 0 }),
                std::env::var("RDSH_CONTEXT_TEST_JSON").unwrap() == "true",
            )
            .unwrap(),
            _ => panic!("unknown hook test action"),
        }
    }

    #[test]
    fn status_and_explain_report_disabled_dependency_graph() {
        let fixture = HookFixture::new();
        std::fs::write(
            fixture.home.join("rdsh.json"),
            serde_json::json!({"features": {"dep_graph": false}, "context": {
                "enable_retriever": false, "include_git_diff": false
            }})
            .to_string(),
        )
        .unwrap();
        let output = fixture.run("status", true, "");
        let text = std::str::from_utf8(&output.stdout).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&text[text.find('{').unwrap()..=text.rfind('}').unwrap()])
                .unwrap();
        assert_eq!(value["dependency_graph"]["enabled"], false);
        assert_eq!(value["deps"]["summary"], "");
        assert_eq!(value["deps"]["index_present"], false);
        assert!(!fixture.home.join("rdsh-index").exists());
        let output = fixture.run("status", false, "");
        assert!(std::str::from_utf8(&output.stdout)
            .unwrap()
            .contains("dependency_graph: disabled via features.dep_graph"));
        let output = fixture.run("explain", false, "");
        assert!(std::str::from_utf8(&output.stdout)
            .unwrap()
            .contains("- dependencies: disabled via features.dep_graph"));
    }

    fn session_hook_context(output: &std::process::Output) -> String {
        let value = std::str::from_utf8(&output.stdout)
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .find(|value| value.get("hookSpecificOutput").is_some())
            .unwrap();
        value["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn injection_inherits_zstd_user_speech_and_skips_failed_sessions() {
        // Requires a working zstd CLI; Windows CI has none, so skip there.
        if !zstd_available() {
            return;
        }
        let fixture = HookFixture::new();
        let sessions = fixture.home.join("sessions/project/valid");
        std::fs::create_dir_all(&sessions).unwrap();
        let compressed = sessions.join("session.jsonl.zstd");
        let transcript = format!(
            "{}\n{}\n",
            serde_json::json!({
                "cwd": fixture.root, "type": "user/message", "data": {"content": [
                    {"type": "text", "text": "engine_score inherited user speech"}
                ]}
            }),
            serde_json::json!({"role": "assistant", "content": "engine_score ignored assistant speech"})
        );
        if !write_zstd_session(&compressed, &transcript) {
            return;
        }
        let broken = fixture.home.join("sessions/project/broken");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("session.jsonl.zstd"), "invalid zstd").unwrap();
        let output = fixture.run("inject-sessions", false, "engine_score");
        let context = session_hook_context(&output);
        assert!(
            context.contains("[session]"),
            "no session line in: {context}"
        );
        assert!(context.contains("engine_score inherited user speech"));
        assert!(!context.contains("ignored assistant speech"));

        let missing = fixture.run_with_path(
            "inject-sessions",
            false,
            "engine_score",
            Some(Path::new("")),
        );
        let context = session_hook_context(&missing);
        assert!(context.contains("keep the configured goal"));
        assert!(!context.contains("[session]"));
    }

    #[cfg(unix)]
    #[test]
    fn inherited_zstd_reader_uses_the_validated_open_handle() {
        if !zstd_available() {
            return;
        }
        let temporary = TempDir::new();
        let source = temporary.0.join("session.jsonl.zstd");
        let replacement = temporary.0.join("replacement.zstd");
        assert!(write_zstd_session(
            &source,
            "{\"role\":\"user\",\"content\":\"original\"}\n"
        ));
        assert!(write_zstd_session(
            &replacement,
            "{\"role\":\"user\",\"content\":\"replacement\"}\n"
        ));
        let root = std::fs::canonicalize(&temporary.0).unwrap();
        let target = std::fs::canonicalize(&source).unwrap();
        let opened = open_beneath(&root, &target).unwrap();
        std::fs::rename(&replacement, &source).unwrap();

        let (bytes, limited) =
            read_zstd_session_from_file(&target, opened, 4096, usize::MAX, None).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(!limited);
        assert!(text.contains("original"));
        assert!(!text.contains("replacement"));
    }

    #[test]
    fn inherited_zstd_output_is_bounded_and_expired_reads_are_skipped() {
        // Requires a working zstd CLI; Windows CI has none, so skip there.
        if !zstd_available() {
            return;
        }
        let temporary = TempDir::new();
        let compressed = temporary.0.join("session.jsonl.zstd");
        if !write_zstd_session(&compressed, &"\n".repeat(256 * 1024 + 1)) {
            return;
        }
        let deadline = Some(Instant::now() + std::time::Duration::from_secs(10));
        assert!(read_inherited_session(&compressed, &temporary.0, deadline).is_none());
        assert!(read_inherited_session(&compressed, &temporary.0, Some(Instant::now())).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn stalled_zstd_does_not_block_injection_past_deadline() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = HookFixture::new();
        let sessions = fixture.home.join("sessions/project/session");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("session.jsonl.zstd"), "placeholder").unwrap();
        let bin = fixture.home.join("bin");
        std::fs::create_dir(&bin).unwrap();
        let zstd = bin.join("zstd");
        std::fs::write(&zstd, "#!/bin/sh\nexec /bin/sleep 5\n").unwrap();
        std::fs::set_permissions(zstd, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(
            fixture.home.join("rdsh.json"),
            serde_json::json!({
                "beta": {"context_engine": true}, "features": {"dep_graph": false},
                "context": {"goal": "keep the configured goal", "enable_retriever": false,
                    "include_git_diff": false, "inject_deadline_ms": 100}
            })
            .to_string(),
        )
        .unwrap();
        let start = Instant::now();
        let output = fixture.run_with_path("inject-sessions", false, "", Some(&bin));
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
        let context = session_hook_context(&output);
        assert!(context.contains("keep the configured goal"));
        assert!(!context.contains("[session]"));
    }

    #[test]
    fn injection_continues_with_missing_or_corrupt_dependency_index() {
        let fixture = HookFixture::new();
        let missing = fixture.inject(false, "engine_score");
        let context = missing["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(context.contains("keep the configured goal"));
        assert!(context.contains("pub fn engine_score"));
        assert!(context.contains("dependencies: unknown"));
        assert!(!context.contains("(dep: related to"));
        assert!(!fixture.home.join("rdsh-index").exists());

        fixture.run("build-index", false, "");
        let indexed = fixture.inject(false, "engine_score");
        assert!(indexed["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap()
            .contains("(dep: related to"));
        let paths: Vec<PathBuf> = std::fs::read_dir(fixture.home.join("rdsh-index"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(paths.len(), 1);
        std::fs::write(&paths[0], "broken").unwrap();
        let corrupt = fixture.inject(false, "engine_score");
        assert_eq!(corrupt, missing);
        assert_eq!(std::fs::read_to_string(&paths[0]).unwrap(), "broken");
    }

    #[test]
    fn hook_prompts_never_create_or_modify_memory() {
        let fixture = HookFixture::new();
        let path = fixture.home.join("rdsh-context-memory.json");
        let prompt = "raw prompt must stay transient";
        fixture.inject(false, prompt);
        assert!(!path.exists());
        assert!(!fixture.home.join(".rdsh-context-memory.lock").exists());

        let mut memory = MemoryStore::default();
        memory
            .remember("curated constraint", "constraint", "manual", false, 1)
            .unwrap();
        memory.save(&path).unwrap();
        let before = std::fs::read(&path).unwrap();
        let metadata = std::fs::metadata(&path).unwrap();
        for json in [false, true] {
            let output = fixture.inject(json, prompt);
            let context = output["hookSpecificOutput"]["additionalContext"]
                .as_str()
                .unwrap();
            assert!(context.contains("[mem] curated constraint"));
            assert!(!context.contains(&format!("[mem] {prompt}")));
            assert_eq!(std::fs::read(&path).unwrap(), before);
            assert_eq!(
                std::fs::metadata(&path).unwrap().modified().unwrap(),
                metadata.modified().unwrap()
            );
            assert!(!fixture.home.join(".rdsh-context-memory.lock").exists());
        }
    }

    #[test]
    fn injection_json_adds_diagnostics_without_changing_context() {
        let fixture = HookFixture::new();
        let plain = fixture.inject(false, "engine_score");
        let diagnostic = fixture.inject(true, "engine_score");
        assert!(plain.get("rdsh").is_none());
        assert_eq!(
            plain["hookSpecificOutput"],
            diagnostic["hookSpecificOutput"]
        );
        assert_eq!(plain["suppressOutput"], diagnostic["suppressOutput"]);
        let context = diagnostic["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert_eq!(
            diagnostic["rdsh"],
            serde_json::json!({
                "sections": packed_breakdown(context), "tokens": estimate(context),
                "budget": 1200, "retrieval_skipped": false,
                "snapshot_stable": false, "sessions": 0
            })
        );
        assert!(context.contains("snapshot: unknown"));
        assert_eq!(fixture.inject(true, "engine_score"), diagnostic);
    }

    #[test]
    fn hook_contract_and_fail_open_are_one_line_or_silence() {
        let line =
            silent_hook_line(Ok(hook_value("user-prompt-submit", "goal\nconstraint"))).unwrap();
        assert!(!line.contains('\n'));
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit");
        assert_eq!(
            v["hookSpecificOutput"]["additionalContext"],
            "goal\nconstraint"
        );
        assert_eq!(v["suppressOutput"], true);
        assert_eq!(
            hook_value("session-start", "context").unwrap()["hookSpecificOutput"]["hookEventName"],
            "SessionStart"
        );
        assert!(silent_hook_line(Ok(hook_value("session-start", " \n"))).is_none());
        assert!(silent_hook_line(Err(anyhow::anyhow!("corrupt index"))).is_none());
        assert!(silent_hook_line(Ok(None)).is_none());
    }

    #[test]
    fn hook_prompt_text_blocks_exclude_tool_content() {
        assert_eq!(
            content_text(&serde_json::json!([{"type":"text","text":"必ず確認"},
            {"type":"tool_result","text":"ignored"},{"type":"text","text":"次は実装"}]))
            .unwrap(),
            "必ず確認\n次は実装"
        );
        assert_eq!(
            content_text(&serde_json::json!("plain")),
            Some("plain".to_string())
        );
    }

    #[test]
    fn memory_roundtrip_duplicate_and_corruption() {
        let temporary = TempDir::new();
        let path = temporary.0.join("memory.json");
        let mut store = MemoryStore::load(&path).unwrap();
        let first = store
            .remember("  Keep   Rust  ", "goal", "manual", false, 1)
            .unwrap()
            .0;
        let second = store
            .remember("keep rust", "note", "manual", false, 2)
            .unwrap()
            .0;
        assert_eq!(first, second);
        assert_eq!(store.entries.len(), 1);
        assert_eq!(store.entries[0].seen, 2);
        store.save(&path).unwrap();
        let loaded = MemoryStore::load(&path).unwrap();
        assert_eq!(loaded.value(), store.value());
        assert_eq!(loaded.revision, 2);
        std::fs::write(&path, "broken").unwrap();
        assert!(MemoryStore::load(&path).is_err());
        assert!(MemoryStore::parse(br#"{"schema":99}"#).is_err());
        // A failed read never silently overwrites corrupt historical evidence.
        assert_eq!(std::fs::read_to_string(path).unwrap(), "broken");
    }

    #[test]
    fn memory_lock_releases_after_abnormal_process_exit() {
        const TARGET: &str = "RDSH_CONTEXT_MEMORY_LOCK_CRASH_TARGET";
        const HELD: &str = "RDSH_CONTEXT_MEMORY_LOCK_CRASH_HELD";

        if let Some(target) = std::env::var_os(TARGET) {
            let _lock = MemoryLock::acquire(&PathBuf::from(target)).unwrap();
            std::fs::write(std::env::var_os(HELD).unwrap(), b"held").unwrap();
            // Simulate a crash path that bypasses the Rust guard's Drop.
            std::process::exit(0);
        }

        let temporary = TempDir::new();
        let target = temporary.0.join("memory.json");
        let held = temporary.0.join("lock-held");
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "context::v3_tests::memory_lock_releases_after_abnormal_process_exit",
            ])
            .env(TARGET, &target)
            .env(HELD, &held)
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(std::fs::read(&held).unwrap(), b"held");
        assert!(MemoryLock::acquire(&target).is_ok());
    }

    #[test]
    fn distill_uses_only_user_markers_and_is_deterministic() {
        let transcript = r#"{"role":"assistant","content":"必ず assistant の案を採用"}
{"role":"tool","content":"TODO tool output"}
{"role":"user","content":"必ず互換性を維持。方針はRust採用。次は検証。普通の雑談"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"do not add dependencies"},{"type":"tool_result","text":"TODO hidden"}]}}
{"role":"user","content":"必ず互換性を維持"}
{"role":"user","content":"use stdlib rather than new crates"}"#;
        let candidates = distill_candidates(transcript);
        assert_eq!(candidates.len(), 5);
        assert_eq!(
            candidates.iter().map(|c| c.kind).collect::<Vec<_>>(),
            vec!["constraint", "decision", "task", "constraint", "decision"]
        );
        assert!(candidates
            .iter()
            .all(|c| !c.text.contains("assistant") && !c.text.contains("hidden")));
        assert_eq!(
            candidates.iter().map(|c| &c.text).collect::<Vec<_>>(),
            distill_candidates(transcript)
                .iter()
                .map(|c| &c.text)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn distill_dsh_user_and_inbox_duplicates_yield_one_candidate() {
        let transcript = r#"{"type":"user/message","seq":10,"data":{"content":[{"type":"text","text":"必ず互換性を維持"},{"type":"file","text":"TODO ignored attachment","attachment":{}}]}}
{"type":"agent/inbox/spliced","data":{"target":"next-turn","inserted":[{"content":[{"type":"text","text":"必ず互換性を維持"}],"source":{}},{"content":[{"type":"text","text":"必ず互換性を維持"}]}]}}
{"role":"user","content":"必ず互換性を維持"}"#;
        let candidates = distill_candidates(transcript);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].kind, "constraint");
        assert_eq!(candidates[0].text, "必ず互換性を維持");
    }

    #[test]
    fn distill_excludes_hook_generated_messages_but_keeps_source_less_users() {
        let transcript = r#"{"type":"user/message","source":{"kind":"hooks-claude-code"},"data":{"content":[{"type":"text","text":"[mem] must not repeat generated context"}]}}
{"type":"agent/inbox/spliced","data":{"inserted":[{"content":[{"type":"text","text":"[mem] never learn injected memory"}],"source":{"kind":"hooks-claude-code"}}]}}
{"type":"user/message","data":{"content":[{"type":"text","text":"必ず旧形式のuser messageを残す"}]}}
{"role":"user","content":"次はsourceなしの従来形式を保つ"}"#;

        let candidates = distill_candidates(transcript);
        assert_eq!(
            candidates
                .iter()
                .map(|candidate| candidate.text.as_str())
                .collect::<Vec<_>>(),
            vec![
                "必ず旧形式のuser messageを残す",
                "次はsourceなしの従来形式を保つ"
            ]
        );
    }

    #[test]
    fn distill_reads_every_inbox_insert_and_only_text_blocks() {
        let event = serde_json::json!({"type": "agent/inbox/spliced", "data": {
        "inserted": [
            {"content": [{"type": "text", "text": "必ず確認"},
                {"type": "file", "text": "TODO ignored"}]},
            {"content": [{"type": "text", "text": "次は検証"}]},
            {"content": [{"type": "file", "text": "TODO ignored"}]}
        ]}});
        assert_eq!(user_texts(&event), vec!["必ず確認", "次は検証"]);
        assert_eq!(distill_candidates(&event.to_string()).len(), 2);
    }

    #[test]
    fn distill_never_uses_assistant_events_as_candidates() {
        let transcript = r#"{"type":"assistant/message","role":"user","content":"必ず無視","data":{"content":[{"type":"text","text":"TODO assistant"}]}}
{"type":"assistant/message/delta","data":{"content":[{"type":"text","text":"必ず無視"}]}}
{"role":"assistant","content":"方針は無視"}
{"type":"user/message","role":"assistant","data":{"content":[{"type":"text","text":"必ず無視"}]}}
{"type":"agent/inbox/spliced","data":{"inserted":[{"role":"assistant","content":[{"type":"text","text":"TODO ignored"}]},{"type":"assistant/message","content":[{"type":"text","text":"TODO ignored"}]}]}}"#;
        assert!(distill_candidates(transcript).is_empty());
    }

    /// True only when the `zstd` CLI is installed and actually runs. Windows
    /// CI installs no zstd, so callers that assert decompressed content skip
    /// instead of failing on the missing tool. Tests that assert *missing*-zstd
    /// behaviour must not call this.
    fn zstd_available() -> bool {
        std::process::Command::new("zstd")
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    fn write_zstd_session(path: &Path, transcript: &str) -> bool {
        let child = std::process::Command::new("zstd")
            .args(["-q", "-c"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::fs::File::create(path).unwrap())
            .stderr(std::process::Stdio::null())
            .spawn();
        let mut child = match child {
            Ok(child) => child,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            Err(error) => panic!("zstd test fixture failed: {error}"),
        };
        child
            .stdin
            .take()
            .unwrap()
            .write_all(transcript.as_bytes())
            .unwrap();
        assert!(child.wait().unwrap().success());
        true
    }

    fn run_distill_subprocess(
        home: &Path,
        source: Option<&Path>,
        empty_path: bool,
    ) -> std::process::Output {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--quiet",
                "--exact",
                "context::v3_tests::distill_subprocess",
                "--nocapture",
                "--test-threads=1",
            ])
            .current_dir(home)
            .env("DSH_HOME", home)
            .env("RDSH_CONTEXT_DISTILL_TEST", "1")
            .env_remove("RDSH_CONTEXT_DISTILL_TEST_SOURCE");
        if let Some(source) = source {
            command.env("RDSH_CONTEXT_DISTILL_TEST_SOURCE", source);
        }
        if empty_path {
            command.env("PATH", "");
        }
        command.output().unwrap()
    }

    #[test]
    fn distill_subprocess() {
        if std::env::var_os("RDSH_CONTEXT_DISTILL_TEST").is_none() {
            return;
        }
        let source = std::env::var("RDSH_CONTEXT_DISTILL_TEST_SOURCE").ok();
        cmd_distill(source, false, false).unwrap();
    }

    #[test]
    fn distill_reads_plain_and_zstd_sessions() {
        let temporary = TempDir::new();
        let plain = temporary.0.join("session.jsonl");
        let compressed = temporary.0.join("session.jsonl.zstd");
        let transcript = "{\"type\":\"user/message\",\"data\":{\"content\":[{\"type\":\"text\",\"text\":\"必ず確認\"}]}}\n";
        std::fs::write(&plain, transcript).unwrap();
        assert_eq!(
            read_distill_session(&plain).unwrap(),
            (transcript.as_bytes().to_vec(), false)
        );
        // Requires a working zstd CLI; Windows CI has none, so skip the
        // compressed half while still checking the plain read above.
        if !zstd_available() {
            return;
        }
        if !write_zstd_session(&compressed, transcript) {
            return;
        }
        let (bytes, limited) = read_distill_session(&compressed).unwrap();
        assert!(!limited);
        assert_eq!(bytes, transcript.as_bytes());
        assert_eq!(
            distill_candidates(std::str::from_utf8(&bytes).unwrap()).len(),
            1
        );
        let output = run_distill_subprocess(&temporary.0, Some(&compressed), false);
        assert!(
            output.status.success(),
            "distill subprocess {} stderr={} stdout={}",
            output.status,
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(String::from_utf8(output.stdout)
            .unwrap()
            .contains("[distill: dry-run] 1 candidate(s)"));
        assert!(!temporary.0.join("rdsh-context-memory.json").exists());
    }

    #[test]
    fn distill_latest_selects_newest_plain_or_zstd_session() {
        // Requires a working zstd CLI; Windows CI has none, so skip there.
        if !zstd_available() {
            return;
        }
        let temporary = TempDir::new();
        let sessions = temporary.0.join("sessions/project/session");
        std::fs::create_dir_all(&sessions).unwrap();
        let plain = sessions.join("session.jsonl");
        let compressed = sessions.join("session.jsonl.zstd");
        std::fs::write(&plain, "{\"role\":\"user\",\"content\":\"次はplain\"}\n").unwrap();
        if !write_zstd_session(
            &compressed,
            "{\"role\":\"user\",\"content\":\"次はzstd\"}\n",
        ) {
            return;
        }
        let modified = UNIX_EPOCH + std::time::Duration::from_secs(1);
        let set_modified = |path: &Path, delta| {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(
                    std::fs::FileTimes::new()
                        .set_modified(modified + std::time::Duration::from_millis(delta)),
                )
                .unwrap();
        };
        set_modified(&plain, 0);
        set_modified(&compressed, 100);
        let output = run_distill_subprocess(&temporary.0, None, false);
        assert!(
            output.status.success(),
            "latest(zstd) subprocess {} stderr={} stdout={}",
            output.status,
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(String::from_utf8(output.stdout)
            .unwrap()
            .contains("[task] 次はzstd"));
        set_modified(&plain, 200);
        let output = run_distill_subprocess(&temporary.0, None, false);
        assert!(
            output.status.success(),
            "latest(plain) subprocess {} stderr={} stdout={}",
            output.status,
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(String::from_utf8(output.stdout)
            .unwrap()
            .contains("[task] 次はplain"));
    }

    #[test]
    fn distill_missing_zstd_exits_two_without_empty_success() {
        let temporary = TempDir::new();
        let sessions = temporary.0.join("sessions/project/session");
        std::fs::create_dir_all(&sessions).unwrap();
        let compressed = sessions.join("session.jsonl.zstd");
        std::fs::write(&compressed, "placeholder").unwrap();
        for source in [Some(compressed.as_path()), None] {
            let output = run_distill_subprocess(&temporary.0, source, true);
            assert_eq!(output.status.code(), Some(2));
            assert!(String::from_utf8(output.stderr)
                .unwrap()
                .contains("zstd が無いので"));
            assert!(!String::from_utf8(output.stdout)
                .unwrap()
                .contains("[distill:"));
        }
    }

    #[test]
    fn distill_invalid_zstd_is_an_error() {
        let temporary = TempDir::new();
        let path = temporary.0.join("session.jsonl.zstd");
        if !write_zstd_session(&path, "") {
            return;
        }
        std::fs::write(&path, "invalid zstd").unwrap();
        assert!(read_distill_session(&path).is_err());
    }

    #[test]
    fn distill_stream_stops_at_line_limit() {
        let prefix = "\n".repeat(DISTILL_LINE_LIMIT);
        let suffix = "{\"role\":\"user\",\"content\":\"TODO outside limit\"}";
        let reader = std::io::Cursor::new(prefix.as_bytes()).chain(suffix.as_bytes());
        let (bytes, limited) =
            read_session_stream(reader, DISTILL_SESSION_CAP, DISTILL_LINE_LIMIT).unwrap();
        assert!(limited);
        assert_eq!(bytes, prefix.as_bytes());
        assert!(distill_candidates(std::str::from_utf8(&bytes).unwrap()).is_empty());
    }

    #[test]
    fn distill_stream_stops_at_byte_limit_and_drops_partial_record() {
        let prefix = b"{\"role\":\"user\",\"content\":\"TODO within limit\"}\n";
        let reader = std::io::Cursor::new(prefix).chain(std::io::repeat(0xff));
        let (bytes, limited) =
            read_session_stream(reader, DISTILL_SESSION_CAP, DISTILL_LINE_LIMIT).unwrap();
        assert!(limited);
        assert_eq!(bytes, prefix);
        assert_eq!(
            distill_candidates(std::str::from_utf8(&bytes).unwrap()).len(),
            1
        );
    }

    #[test]
    fn distill_supersedes_overlap_and_targeted_retraction() {
        let mut store = MemoryStore::default();
        let old = store
            .remember(
                "decided use local Rust parser",
                "decision",
                "manual",
                false,
                1,
            )
            .unwrap()
            .0;
        let unrelated = store
            .remember(
                "never upload private credentials",
                "constraint",
                "manual",
                false,
                1,
            )
            .unwrap()
            .0;
        let newer = store
            .remember(
                "decided use local Rust parser offline",
                "decision",
                "distill",
                true,
                2,
            )
            .unwrap()
            .0;
        assert_eq!(
            store.entries[0].superseded_by.as_deref(),
            Some(newer.as_str())
        );
        let revoked = store
            .remember("revert local Rust parser", "decision", "distill", true, 3)
            .unwrap()
            .0;
        assert_eq!(
            store
                .entries
                .iter()
                .find(|e| e.id == newer)
                .unwrap()
                .superseded_by
                .as_deref(),
            Some(revoked.as_str())
        );
        assert!(store
            .entries
            .iter()
            .find(|e| e.id == unrelated)
            .unwrap()
            .superseded_by
            .is_none());
        assert_eq!(
            store
                .entries
                .iter()
                .find(|e| e.id == old)
                .unwrap()
                .superseded_by
                .as_deref(),
            Some(newer.as_str())
        );
    }

    #[test]
    fn unresolved_conflicts_remain_active_and_warn_unknown() {
        let mut store = MemoryStore::default();
        store
            .remember("decided storage alpha one", "decision", "manual", false, 1)
            .unwrap();
        let (_, warnings) = store
            .remember("decided storage beta two", "decision", "distill", true, 2)
            .unwrap();
        assert!(store.entries.iter().all(|e| e.superseded_by.is_none()));
        assert!(warnings
            .iter()
            .any(|w| w.contains("conflict") && w.contains("unknown")));
        let (_, warnings) = store
            .remember("撤回", "decision", "distill", true, 3)
            .unwrap();
        assert!(warnings.iter().any(|w| w.contains("target unknown")));
    }

    #[test]
    fn assembly_includes_only_active_memory_and_settings_win() {
        let mut memory = MemoryStore::default();
        memory
            .remember("memory goal", "goal", "manual", false, 1)
            .unwrap();
        memory
            .remember("old decision", "decision", "manual", false, 1)
            .unwrap();
        memory.entries[1].superseded_by = Some("forgotten".to_string());
        memory
            .remember("active decision", "decision", "manual", false, 2)
            .unwrap();
        memory
            .remember("active constraint", "constraint", "manual", false, 2)
            .unwrap();
        memory
            .remember("active task", "task", "manual", false, 2)
            .unwrap();
        let mut cfg = ContextConfig {
            enable_retriever: false,
            include_git_diff: false,
            decisions: vec!["configured decision".to_string()],
            ..ContextConfig::default()
        };
        let text = render(&assemble_sections("", &cfg, &memory, &mut tracker(), None));
        assert!(text.contains("[mem] memory goal"));
        assert!(text.contains("configured decision\n[mem] active decision"));
        assert!(text.contains("[mem] active constraint"));
        assert!(text.contains("[mem] active task"));
        assert!(!text.contains("old decision"));
        cfg.goal = "configured goal".to_string();
        let text = render(&assemble_sections("", &cfg, &memory, &mut tracker(), None));
        assert!(text.contains("configured goal"));
        assert!(!text.contains("memory goal"));
    }

    #[test]
    fn deadline_retains_goal_memory_and_skips_retrieval() {
        let mut memory = MemoryStore::default();
        memory
            .remember("active rule", "constraint", "manual", false, 1)
            .unwrap();
        memory
            .remember("active note", "note", "manual", false, 1)
            .unwrap();
        let cfg = ContextConfig {
            goal: "keep this goal".to_string(),
            ..ContextConfig::default()
        };
        let sections = assemble_sections(
            "rust parser",
            &cfg,
            &memory,
            &mut tracker(),
            Some(Instant::now()),
        );
        let text = render(&sections);
        assert!(text.contains("keep this goal"));
        assert!(text.contains("[mem] active rule"));
        assert!(text.contains("[mem] active note"));
        assert!(sections.iter().all(|s| s.name != "retrieved"));
    }

    #[test]
    fn snapshots_record_file_changes_and_required_json_keys() {
        let temporary = TempDir::new();
        let file = temporary.0.join("file.rs");
        std::fs::write(&file, "first").unwrap();
        let mut t = tracker();
        t.record(&file);
        std::fs::write(&file, "changed length").unwrap();
        t.record(&file);
        assert_eq!(t.files.len(), 1);
        assert!(t.changed.iter().any(|p| p.ends_with("file.rs")));
        let snapshot = t.finish(Some(Instant::now()));
        let value = snapshot.value();
        for key in ["head", "branch", "stable", "changed_files", "checked_files"] {
            assert!(value.get(key).is_some());
        }
        assert_eq!(value["stable"], false);
        assert_eq!(value["checked_files"], 1);
        assert!(snapshot
            .line()
            .starts_with("[snapshot: CHANGED during build:"));
    }

    #[test]
    fn git_snapshot_detects_content_changes_with_unchanged_status() {
        use std::process::Command;

        let temporary = TempDir::new();
        let run_git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(&temporary.0)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?}: {output:?}");
            output
        };
        run_git(&["init", "--quiet"]);
        run_git(&["config", "user.name", "rdsh test"]);
        run_git(&["config", "user.email", "rdsh-test@example.invalid"]);
        let file = temporary.0.join("tracked.rs");
        std::fs::write(&file, "base").unwrap();
        run_git(&["add", "tracked.rs"]);
        run_git(&["commit", "--quiet", "-m", "base"]);
        let cwd = std::fs::canonicalize(&temporary.0).unwrap();

        std::fs::write(&file, "one!").unwrap();
        let status_before = git_output_in(Some(&cwd), &["status", "--porcelain=v1"], None).unwrap();
        let dirty_before = git_dirty_paths(&status_before);
        let content_before = git_dirty_content_signature(&cwd, Some(&dirty_before), None).unwrap();
        std::fs::write(&file, "two!").unwrap();
        let status_after = git_output_in(Some(&cwd), &["status", "--porcelain=v1"], None).unwrap();
        let dirty_after = git_dirty_paths(&status_after);
        let content_after = git_dirty_content_signature(&cwd, Some(&dirty_after), None).unwrap();

        assert_eq!(status_before, status_after);
        assert_ne!(content_before, content_after);
    }

    #[test]
    fn git_snapshot_detects_index_changes_with_unchanged_worktree_and_status() {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let temporary = TempDir::new();
        let run_git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(&temporary.0)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?}: {output:?}");
            output
        };
        run_git(&["init", "--quiet"]);
        run_git(&["config", "user.name", "rdsh test"]);
        run_git(&["config", "user.email", "rdsh-test@example.invalid"]);
        let file = temporary.0.join("tracked.rs");
        std::fs::write(&file, "base\n").unwrap();
        run_git(&["add", "tracked.rs"]);
        run_git(&["commit", "--quiet", "-m", "base"]);
        let cwd = std::fs::canonicalize(&temporary.0).unwrap();
        std::fs::write(&file, "working tree\n").unwrap();

        let hash_blob = |text: &str| {
            let mut child = Command::new("git")
                .args(["hash-object", "-w", "--stdin"])
                .current_dir(&cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(text.as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success());
            String::from_utf8(output.stdout).unwrap().trim().to_string()
        };
        let update_index = |blob: &str| {
            let spec = format!("100644,{blob},tracked.rs");
            run_git(&["update-index", "--cacheinfo", &spec]);
        };
        update_index(&hash_blob("index A\n"));
        let status_before = git_output_in(
            Some(&cwd),
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            None,
        )
        .unwrap();
        let dirty_before = git_dirty_paths(&status_before);
        assert_eq!(
            dirty_before.get("tracked.rs").map(String::as_str),
            Some("MM")
        );
        let content_before = git_dirty_content_signature(&cwd, Some(&dirty_before), None).unwrap();

        update_index(&hash_blob("index B with different stats\n"));
        let status_after = git_output_in(
            Some(&cwd),
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            None,
        )
        .unwrap();
        let dirty_after = git_dirty_paths(&status_after);
        let content_after = git_dirty_content_signature(&cwd, Some(&dirty_after), None).unwrap();

        assert_eq!(status_before, status_after);
        assert_eq!(std::fs::read(&file).unwrap(), b"working tree\n");
        assert_ne!(content_before, content_after);
    }

    #[cfg(unix)]
    #[test]
    fn git_snapshot_does_not_wait_when_index_is_replaced_by_fifo() {
        use std::process::Command;
        use std::{ffi::CString, os::unix::ffi::OsStrExt, sync::mpsc, time::Duration};

        let temporary = TempDir::new();
        let output = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&temporary.0)
            .output()
            .unwrap();
        assert!(output.status.success(), "git init failed: {output:?}");
        let cwd = std::fs::canonicalize(&temporary.0).unwrap();
        let git_dir =
            git_output_in(Some(&cwd), &["rev-parse", "--absolute-git-dir"], None).unwrap();
        let index = PathBuf::from(git_dir.trim()).join("index");
        std::fs::write(&index, b"index").unwrap();
        std::fs::rename(&index, index.with_extension("saved")).unwrap();
        let name = CString::new(index.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);

        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let result = git_dirty_content_signature(
                &cwd,
                Some(&BTreeMap::new()),
                Some(Instant::now() + Duration::from_secs(5)),
            );
            let _ = sender.send(result);
        });
        assert!(receiver
            .recv_timeout(Duration::from_secs(6))
            .expect("Git index inspection must not wait on a FIFO")
            .is_none());
    }

    #[test]
    fn git_snapshot_hashes_untracked_file_contents() {
        use std::process::Command;

        let temporary = TempDir::new();
        let init = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&temporary.0)
            .output()
            .unwrap();
        assert!(init.status.success());
        let run_git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(&temporary.0)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?}: {output:?}");
        };
        run_git(&["config", "user.name", "rdsh test"]);
        run_git(&["config", "user.email", "rdsh-test@example.invalid"]);
        std::fs::write(temporary.0.join("tracked.rs"), "base").unwrap();
        run_git(&["add", "tracked.rs"]);
        run_git(&["commit", "--quiet", "-m", "base"]);
        let cwd = std::fs::canonicalize(&temporary.0).unwrap();
        let file = temporary.0.join("new.txt");
        std::fs::write(&file, "one!").unwrap();
        let status_before = git_output_in(
            Some(&cwd),
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            None,
        )
        .unwrap();
        let dirty_before = git_dirty_paths(&status_before);
        let content_before = git_dirty_content_signature(&cwd, Some(&dirty_before), None).unwrap();
        std::fs::write(&file, "two!").unwrap();
        let status_after = git_output_in(
            Some(&cwd),
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            None,
        )
        .unwrap();
        let dirty_after = git_dirty_paths(&status_after);
        let content_after = git_dirty_content_signature(&cwd, Some(&dirty_after), None).unwrap();

        assert_eq!(status_before, status_after);
        assert_ne!(content_before, content_after);
    }

    #[test]
    fn git_snapshot_hashes_root_relative_untracked_paths_from_nested_cwd() {
        use std::process::Command;

        let temporary = TempDir::new();
        let run_git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(&temporary.0)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?}: {output:?}");
            output
        };
        run_git(&["init", "--quiet"]);
        run_git(&["config", "user.name", "rdsh test"]);
        run_git(&["config", "user.email", "rdsh-test@example.invalid"]);
        let repository = std::fs::canonicalize(&temporary.0).unwrap();
        let nested = repository.join("sub");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("note.txt"), "tracked sibling").unwrap();
        run_git(&["add", "sub/note.txt"]);
        run_git(&["commit", "--quiet", "-m", "base"]);

        let untracked = repository.join("note.txt");
        std::fs::write(&untracked, "first untracked value").unwrap();
        let nested = std::fs::canonicalize(nested).unwrap();
        let status_before = git_output_in(
            Some(&nested),
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            None,
        )
        .unwrap();
        let dirty_before = git_dirty_paths(&status_before);
        assert!(dirty_before.contains_key("note.txt"));
        let content_before =
            git_dirty_content_signature(&nested, Some(&dirty_before), None).unwrap();

        std::fs::write(&untracked, "second untracked value").unwrap();
        let status_after = git_output_in(
            Some(&nested),
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            None,
        )
        .unwrap();
        let dirty_after = git_dirty_paths(&status_after);
        let content_after = git_dirty_content_signature(&nested, Some(&dirty_after), None).unwrap();

        assert_eq!(status_before, status_after);
        assert_ne!(content_before, content_after);
    }

    #[test]
    fn memory_lists_have_per_kind_caps_and_ignore_superseded() {
        let mut memory = MemoryStore::default();
        for i in 0..20 {
            memory
                .remember(
                    &format!("{i}: {}", "あ".repeat(250)),
                    "task",
                    "manual",
                    false,
                    i,
                )
                .unwrap();
        }
        let lines = memory_lines(&memory, "task");
        assert_eq!(lines.len(), 12);
        assert!(lines.iter().all(|line| line.chars().count() <= 206));
        assert!(lines[0].starts_with("[mem] 8:"));
    }

    #[test]
    fn dependency_lookup_for_unknown_seeds_is_safe() {
        assert!(
            crate::deps::related_files(&["__rdsh_unknown_seed__.rs".to_string()], 5).is_empty()
        );
    }

    #[test]
    fn injection_config_defaults_and_clamps() {
        let mut c = crate::rdsh_config::ContextSection::default();
        assert_eq!(ContextConfig::from(c.clone()).inject_budget, 1200);
        c.inject_budget = 1;
        c.inject_deadline_ms = 99999;
        c.inject_session_count = 20;
        let c = ContextConfig::from(c);
        assert_eq!(c.inject_budget, 200);
        assert_eq!(c.inject_deadline_ms, 10000);
        assert_eq!(c.inject_session_count, 10);
    }
}
