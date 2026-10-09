//! Context engine (v2): rebuild per-turn context from local files.
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

use std::io::Write;
use std::path::Path;

use crate::file_security::open_beneath;

const SCHEMA: u32 = 2;
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
        }
    }
}

impl From<crate::rdsh_config::ContextSection> for ContextConfig {
    fn from(c: crate::rdsh_config::ContextSection) -> Self {
        Self {
            token_budget: c.token_budget.clamp(500, 200000),
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
    ContextConfig::from(crate::rdsh_config::load().context)
}

fn estimate(s: &str) -> usize {
    crate::tokens::estimate_tokens(s)
}

// ---- query terms ----

fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}'
        | '\u{f900}'..='\u{faff}' | '\u{ff00}'..='\u{ffef}' | '\u{20000}'..='\u{2ebef}')
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
    let mut terms: Vec<String> = vec![];
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
        if nchars < 1 {
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
        if t.len() == 2 && t.chars().count() == 2 && t.chars().all(is_cjk) {
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
    if text.len() > cap {
        let end = text
            .char_indices()
            .take(cap)
            .last()
            .map(|(i, _)| i)
            .unwrap_or(0);
        Some(text[..end].to_string())
    } else {
        Some(text)
    }
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
    let mut kept: Vec<&str> = vec![];
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

fn git_branch() -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s.chars().take(120).collect())
    }
}

fn git_status_short() -> String {
    let out = std::process::Command::new("git")
        .args(["status", "--short", "--", "."])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).into_owned();
            let lines: Vec<&str> = s.lines().take(15).collect();
            if lines.is_empty() {
                "(clean)".to_string()
            } else {
                lines.join("\n").chars().take(1200).collect()
            }
        }
        _ => "(git unavailable)".to_string(),
    }
}

fn git_diff_stat() -> String {
    let out = std::process::Command::new("git")
        .args(["diff", "--stat", "--", "."])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).into_owned();
            let t = s.trim().to_string();
            if t.is_empty() {
                "(no unstaged diff)".to_string()
            } else {
                t.chars().take(1500).collect()
            }
        }
        _ => "(git unavailable)".to_string(),
    }
}

fn git_staged_stat() -> String {
    let out = std::process::Command::new("git")
        .args(["diff", "--cached", "--stat", "--", "."])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).into_owned();
            let t = s.trim().to_string();
            if t.is_empty() {
                "(no staged diff)".to_string()
            } else {
                t.chars().take(1500).collect()
            }
        }
        _ => "(git unavailable)".to_string(),
    }
}

fn git_snapshot() -> String {
    let branch = git_branch().unwrap_or_else(|| "(no branch)".to_string());
    let status = git_status_short();
    let untracked = status.lines().filter(|l| l.starts_with("??")).count();
    let diff = git_diff_stat();
    let staged = git_staged_stat();
    format!(
        "branch: {branch} (untracked: {untracked})\n--- status ---\n{status}\n--- diff --stat (unstaged) ---\n{diff}\n--- diff --cached --stat (staged) ---\n{staged}"
    )
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

fn session_files_sorted(limit_dirs: usize) -> Vec<std::path::PathBuf> {
    let root = format!("{}/sessions", crate::inspect::dsh_home());
    let projs: Vec<std::path::PathBuf> = match std::fs::read_dir(&root) {
        Ok(e) => {
            let mut v: Vec<(u64, std::path::PathBuf)> = e
                .filter_map(|e| e.ok())
                .filter(|e| e.metadata().is_ok_and(|m| m.is_dir()))
                .map(|e| {
                    let p = e.path();
                    (mtime_secs(&p), p)
                })
                .collect();
            // プロジェクト名順ではなく更新が新しい順に辿る
            v.sort_by_key(|(m, _)| std::cmp::Reverse(*m));
            v.into_iter().take(40).map(|(_, p)| p).collect()
        }
        Err(_) => return vec![],
    };
    let mut files: Vec<(u64, std::path::PathBuf)> = vec![];
    for proj in projs {
        let mut sessions = std::fs::read_dir(&proj)
            .map(|e| e.filter_map(|e| e.ok()).collect::<Vec<_>>())
            .unwrap_or_default();
        // セッションも新しい順に上限まで
        sessions.sort_by_key(|e| std::cmp::Reverse(mtime_secs(&e.path())));
        for s in sessions.into_iter().take(limit_dirs.max(1)) {
            let sdir = s.path();
            let mut inner = std::fs::read_dir(&sdir)
                .map(|e| e.filter_map(|e| e.ok()).collect::<Vec<_>>())
                .unwrap_or_default();
            inner.sort_by_key(|e| std::cmp::Reverse(mtime_secs(&e.path())));
            for f in inner.into_iter().take(6) {
                let p = f.path();
                if !p.is_file() {
                    continue;
                }
                // JSONL等の履歴本体を優先し、巨大バイナリは後段で除外する
                if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                    let el = ext.to_lowercase();
                    if matches!(el.as_str(), "lock" | "tmp" | "bin" | "dat") {
                        continue;
                    }
                }
                files.push((mtime_secs(&p), p));
                if files.len() >= 400 {
                    break;
                }
            }
            if files.len() >= 400 {
                break;
            }
        }
        if files.len() >= 400 {
            break;
        }
    }
    // 新しい順
    files.sort_by_key(|(m, _)| std::cmp::Reverse(*m));
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
    let mut scored: Vec<(usize, u64, String)> = vec![];
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
            if t.len() == 2 && t.chars().count() == 2 {
                continue;
            }
            if lower.contains(t) {
                score += 3 + t.chars().count().min(12);
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
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
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
    let mut pats: Vec<String> = vec![];
    for cand in [root.join(".gitignore"), root.join(".git/info/exclude")] {
        let Ok(text) = std::fs::read_to_string(&cand) else {
            continue;
        };
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
    if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
        let lower = name.to_lowercase();
        if CODE_FILENAMES.contains(&lower.as_str()) {
            return true;
        }
    }
    p.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|x| CODE_EXTS.contains(&x.to_lowercase().as_str()))
}

fn code_hits(query: &str, max: usize) -> Vec<String> {
    let terms = query_terms(query);
    if terms.is_empty() {
        return vec![];
    }
    let root = std::fs::canonicalize(".").ok();
    let Some(root) = root else {
        return vec![];
    };
    let ignore_pats = load_gitignore_patterns(&root);
    let mut scored: Vec<(usize, String)> = vec![];
    let mut stack = vec![root.clone()];
    let mut files_seen = 0usize;
    // 決定的な走査順にするためディレクトリ・ファイルとも名前順に処理する。
    while let Some(dir) = stack.pop() {
        let mut entries = std::fs::read_dir(&dir)
            .map(|e| e.filter_map(|e| e.ok()).collect::<Vec<_>>())
            .unwrap_or_default();
        entries.sort_by_key(|e| e.file_name());
        let mut subdirs: Vec<std::path::PathBuf> = vec![];
        for e in entries {
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
                if t.len() == 2 && t.chars().count() == 2 {
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
                Some(ref e) if e == "md" => 0usize,
                Some(_) => 1usize,
                None => 1usize,
            };
            // 全行を採点し、行番号が若い順のバイアスを排して上位だけ残す。
            let mut best: Vec<(usize, usize, String)> = vec![];
            for (i, line) in text.lines().enumerate().take(2000) {
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
        "related_files",
        "git_diff",
        "decisions",
        "open_tasks",
        "retrieved",
    ]
}

fn assemble(query: &str, cfg: &ContextConfig) -> Vec<Section> {
    let mut secs: Vec<Section> = vec![];
    let goal = if cfg.goal.trim().is_empty() {
        "(unset — set with: rdsh settings set context.goal \"...\")".to_string()
    } else {
        cfg.goal.clone()
    };
    secs.push(Section {
        name: "goal",
        body: goal,
    });
    if !cfg.constraints.is_empty() {
        let (body, _) = truncate_list(&cfg.constraints, 20, 2000);
        secs.push(Section {
            name: "constraints",
            body,
        });
    }
    if !cfg.working_files.is_empty() {
        let mut parts: Vec<String> = vec![];
        for f in cfg.working_files.iter().take(12) {
            match read_working_file(f, 8000) {
                Ok(t) => {
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
    if cfg.include_git_diff {
        secs.push(Section {
            name: "git_diff",
            body: git_snapshot(),
        });
    }
    if !cfg.decisions.is_empty() {
        let (body, _) = truncate_list(&cfg.decisions, 20, 2000);
        secs.push(Section {
            name: "decisions",
            body,
        });
    }
    if !cfg.open_tasks.is_empty() {
        let (body, _) = truncate_list(&cfg.open_tasks, 20, 2000);
        secs.push(Section {
            name: "open_tasks",
            body,
        });
    }
    if cfg.enable_retriever {
        let q = query.trim();
        let mut parts: Vec<String> = vec![];
        for h in code_hits(q, cfg.max_code_hits) {
            parts.push(h);
        }
        // Cross-project session history is available only through an explicit
        // native context search, never automatically sent to a model.
        if !parts.is_empty() {
            secs.push(Section {
                name: "retrieved",
                body: parts.join("\n"),
            });
        } else if !q.is_empty() {
            // 空の沈黙より明示（pack対象外の小節なので予算への影響は微小）。
            secs.push(Section {
                name: "retrieved",
                body: format!("(no hits for query {q:?})"),
            });
        }
    }
    // 優先度順に並べ替え（安定）
    let order = priority_order();
    secs.sort_by_key(|s| order.iter().position(|n| *n == s.name).unwrap_or(99));
    secs
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
            if matches!(s.name, "retrieved" | "open_tasks" | "decisions") {
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
    let mut rest: Vec<&Section> = vec![];
    for s in sections {
        if s.name == "goal" || s.name == "constraints" {
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
    let mut out: Vec<serde_json::Value> = vec![];
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
    let mut out: Vec<String> = vec![];
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

pub fn cmd_build(
    query: Option<String>,
    budget: Option<usize>,
    as_json: bool,
) -> anyhow::Result<()> {
    let cfg = load_config();
    let q = query.unwrap_or_default();
    let budget = budget.unwrap_or(cfg.token_budget).clamp(500, 200000);
    let sections = assemble(&q, &cfg);
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
        });
        println!("{}", serde_json::to_string_pretty(&v)?);
        return Ok(());
    }
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    out.write_all(packed.as_bytes())?;
    if !packed.ends_with('\n') {
        out.write_all(b"\n")?;
    }
    out.flush()?;
    eprintln!("[rdsh context build] {before}->{after} tokens (budget {budget})");
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
    let budget = budget.unwrap_or(cfg.token_budget).clamp(500, 200000);
    let sections = assemble(&q, &cfg);
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
            "goal" => "always first: keeps long sessions on track (never dropped)",
            "constraints" => "must-not-break rules (kept until the end)",
            "related_files" => "working set from settings (missing files warn)",
            "git_diff" => "branch + status + diff stat (fresh, not from memory)",
            "decisions" => "reused past decisions (structured, not full history)",
            "open_tasks" => "unresolved work only",
            "retrieved" => "scored hits: coverage + boundary + filename bonus, CJK bigram recall, per-file top3, ranked (first to trim)",
            _ => "",
        };
        writeln!(out, "- {}: ~{} tokens - {}", s.name, t, why)?;
    }
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
