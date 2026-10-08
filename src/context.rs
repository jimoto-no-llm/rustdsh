//! Context engine (v2): rebuild per-turn context from local files.
//!
//! Single source of truth is `$DSH_HOME/rdsh.json` (`context` section).
//! The old `rdsh-context.json` is read-only fallback and only applies when
//! `rdsh.json` has no `context` key (handled inside `rdsh_config::load`).
//!
//! Improvements over the prototype:
//! - multi-term scored retrieval (filename bonus, dedup, ranked)
//! - priority packing (goal first, retrieved first to drop)
//! - richer git snapshot (branch + status + diff stat)
//! - verifier warnings (missing files surface explicitly)

use std::io::Write;

const SCHEMA: u32 = 2;
const DEFAULT_BUDGET: usize = 4000;
const DEFAULT_CODE_HITS: usize = 20;
const DEFAULT_SESSIONS: usize = 10;

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

fn query_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = vec![];
    for raw in query
        .to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-' || c == '/'))
    {
        let t = raw
            .trim()
            .trim_matches(|c| c == '_' || c == '-' || c == '/');
        if t.len() < 2 && t.chars().count() < 1 {
            continue;
        }
        if t.is_empty() {
            continue;
        }
        // よくある英単語のノイズだけ落とす（日本語1文字は残す）
        if matches!(t, "the" | "and" | "for" | "with" | "this" | "that") {
            continue;
        }
        if !terms.iter().any(|x| x.as_str() == t) {
            terms.push(t.to_string());
        }
        if terms.len() >= 8 {
            break;
        }
    }
    terms
}

fn score_line(line_lower: &str, terms: &[String]) -> usize {
    let mut score = 0usize;
    for t in terms {
        if line_lower.contains(t) {
            // 長い語ほど確度が高い
            score += 2 + t.len().min(12);
        }
    }
    score
}

// ---- file helpers ----

fn read_bounded(path: &str, cap: usize) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
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

fn git_snapshot() -> String {
    let branch = git_branch().unwrap_or_else(|| "(no branch)".to_string());
    let status = git_status_short();
    let diff = git_diff_stat();
    format!("branch: {branch}\n--- status ---\n{status}\n--- diff --stat ---\n{diff}")
}

// ---- sessions ----

fn session_files_sorted(limit_dirs: usize) -> Vec<std::path::PathBuf> {
    let root = format!("{}/sessions", crate::inspect::dsh_home());
    let projs: Vec<std::path::PathBuf> = match std::fs::read_dir(&root) {
        Ok(e) => {
            let mut v: Vec<_> = e
                .filter_map(|e| e.ok())
                .filter(|e| e.metadata().is_ok_and(|m| m.is_dir()))
                .map(|e| e.path())
                .collect();
            v.sort();
            v.into_iter().take(20).collect()
        }
        Err(_) => return vec![],
    };
    let mut files: Vec<(u64, std::path::PathBuf)> = vec![];
    for proj in projs {
        let sessions = std::fs::read_dir(&proj)
            .map(|e| e.filter_map(|e| e.ok()).collect::<Vec<_>>())
            .unwrap_or_default();
        for s in sessions.into_iter().take(limit_dirs) {
            let sdir = s.path();
            let inner = std::fs::read_dir(&sdir)
                .map(|e| e.filter_map(|e| e.ok()).collect::<Vec<_>>())
                .unwrap_or_default();
            for f in inner.into_iter().take(6) {
                let p = f.path();
                if !p.is_file() {
                    continue;
                }
                let mtime = f
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                files.push((mtime, p));
            }
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
        let bytes = std::fs::read(&p).unwrap_or_default();
        if bytes.is_empty() || bytes.len() > 256 * 1024 || bytes.contains(&0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let lower = text.to_lowercase();
        let mut score = 0usize;
        let mut snippet = String::new();
        for t in &terms {
            if lower.contains(t) {
                score += 3 + t.len().min(12);
                if snippet.is_empty() {
                    for line in text.lines().take(400) {
                        if line.to_lowercase().contains(t) {
                            snippet = line.chars().take(140).collect();
                            break;
                        }
                    }
                }
            }
        }
        if score == 0 {
            continue;
        }
        // 新しさボーナス（最大+5）
        let mtime = p
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
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
    "rs", "js", "mjs", "cjs", "ts", "mts", "cts", "py", "go", "java", "rb", "md", "yml", "yaml",
    "toml", "json", "sh", "ps1", "html", "css",
];

fn code_hits(query: &str, max: usize) -> Vec<String> {
    let terms = query_terms(query);
    if terms.is_empty() {
        return vec![];
    }
    let mut scored: Vec<(usize, String)> = vec![];
    let mut stack = vec![std::path::PathBuf::from(".")];
    let mut files_seen = 0usize;
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .map(|e| e.filter_map(|e| e.ok()).collect::<Vec<_>>())
            .unwrap_or_default();
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with(".") || name == "target" || name == "node_modules" {
                continue;
            }
            let p = e.path();
            let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
            if is_dir {
                if files_seen < 4000 {
                    stack.push(p);
                }
                continue;
            }
            let keep = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|x| CODE_EXTS.contains(&x.to_lowercase().as_str()))
                .unwrap_or(false);
            if !keep {
                continue;
            }
            files_seen += 1;
            if files_seen > 4000 {
                break;
            }
            let bytes = match std::fs::read(&p) {
                Ok(b) => b,
                Err(_) => continue,
            };
            if bytes.is_empty() || bytes.len() > 256 * 1024 || bytes.contains(&0) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            let path_lower = p.display().to_string().to_lowercase();
            let mut file_bonus = 0usize;
            for t in &terms {
                if path_lower.contains(t) {
                    file_bonus += 6;
                }
            }
            let mut best: Vec<(usize, usize, String)> = vec![];
            for (i, line) in text.lines().enumerate().take(2000) {
                let ll = line.to_lowercase();
                let s = score_line(&ll, &terms);
                if s > 0 {
                    best.push((s, i, line.chars().take(160).collect()));
                }
                if best.len() >= 8 {
                    // 1ファイルの深掘りを抑える
                    break;
                }
            }
            for (s, i, snippet) in best {
                scored.push((
                    s + file_bonus,
                    format!("{}:{}:{}", p.display(), i + 1, snippet),
                ));
            }
            if scored.len() >= max * 6 {
                break;
            }
        }
        if scored.len() >= max * 6 {
            break;
        }
    }
    // 重複除去して点数順
    scored.sort_by_key(|a| std::cmp::Reverse(a.0));
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
        secs.push(Section {
            name: "constraints",
            body: cfg.constraints.join("\n"),
        });
    }
    if !cfg.working_files.is_empty() {
        let mut parts: Vec<String> = vec![];
        for f in cfg.working_files.iter().take(12) {
            match read_bounded(f, 8000) {
                Some(t) => {
                    let lines = t.lines().count();
                    let tok = estimate(&t);
                    parts.push(format!(
                        "## {f} ({lines} lines, ~{tok}tok)\n{}",
                        t.chars().take(3000).collect::<String>()
                    ));
                }
                None => parts.push(format!(
                    "## {f}\n(missing or binary — verify before trusting)"
                )),
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
        secs.push(Section {
            name: "decisions",
            body: cfg.decisions.join("\n"),
        });
    }
    if !cfg.open_tasks.is_empty() {
        secs.push(Section {
            name: "open_tasks",
            body: cfg.open_tasks.join("\n"),
        });
    }
    if cfg.enable_retriever {
        let q = query.trim();
        let mut parts: Vec<String> = vec![];
        for h in code_hits(q, cfg.max_code_hits) {
            parts.push(h);
        }
        for s in recent_sessions(q, cfg.max_sessions) {
            parts.push(s);
        }
        if !parts.is_empty() {
            secs.push(Section {
                name: "retrieved",
                body: parts.join("\n"),
            });
        }
    }
    // 優先度順に並べ替え（安定）
    let order = priority_order();
    secs.sort_by_key(|s| order.iter().position(|n| *n == s.name).unwrap_or(99));
    secs
}

fn pack_by_priority(sections: Vec<Section>, budget: usize) -> String {
    let full = render(&sections);
    if estimate(&full) <= budget {
        return full;
    }
    // 低優先度から削る：retrieved -> open_tasks -> decisions -> git_diff -> related_files
    // goal と constraints は最後まで残す
    let mut kept: Vec<Section> = sections;
    // 1) retrieved を半分→1/4→0と段階的に削る
    for frac in [0.5, 0.25, 0.0] {
        let mut trial = vec![];
        for s in &kept {
            if s.name == "retrieved" && frac == 0.0 {
                continue;
            }
            if s.name == "retrieved" {
                let lines: Vec<&str> = s.body.lines().collect();
                let keep = ((lines.len() as f64) * frac) as usize;
                trial.push(Section {
                    name: s.name,
                    body: lines
                        .into_iter()
                        .take(keep.max(1))
                        .collect::<Vec<_>>()
                        .join("\n"),
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
        if kept.iter().all(|s| s.name != "retrieved") {
            break;
        }
    }
    // retrieved を落としても超過なら、低優先度節から順に落とす
    for drop in ["open_tasks", "decisions", "git_diff", "related_files"] {
        if estimate(&render(&kept)) <= budget {
            break;
        }
        kept.retain(|s| s.name != drop);
    }
    if estimate(&render(&kept)) <= budget {
        return render(&kept);
    }
    // それでも超過なら残りを素朴に刈る（goal は必ず残す）
    crate::tokens::prune_to_budget(&render(&kept), budget)
}

fn render(sections: &[Section]) -> String {
    let mut s = String::new();
    for sec in sections {
        s.push_str(&format!("# {}\n{}\n\n", sec.name, sec.body));
    }
    s
}

fn missing_files(cfg: &ContextConfig) -> Vec<String> {
    cfg.working_files
        .iter()
        .filter(|f| std::fs::metadata(f).is_err())
        .cloned()
        .collect()
}

pub fn cmd_status(json: bool) -> anyhow::Result<()> {
    let cfg = load_config();
    let wm = format!(
        "goal={} decisions={} files={} tasks={}",
        cfg.goal.chars().count(),
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
    writeln!(out, "working memory: {} (~{} tokens)", wm, wm_tokens)?;
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
        // 節ごとの内訳は packed 後の概算（pack前後差の目安）
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
    writeln!(out, "# code")?;
    for h in code_hits(&query, max) {
        writeln!(out, "{h}")?;
    }
    writeln!(out, "# sessions")?;
    for s in recent_sessions(&query, max.min(20)) {
        writeln!(out, "{s}")?;
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
    for s in &sections {
        let t = estimate(&s.body);
        let why = match s.name {
            "goal" => "always first: keeps long sessions on track (never dropped)",
            "constraints" => "must-not-break rules (kept until the end)",
            "related_files" => "working set from settings (missing files warn)",
            "git_diff" => "branch + status + diff stat (fresh, not from memory)",
            "decisions" => "reused past decisions (structured, not full history)",
            "open_tasks" => "unresolved work only",
            "retrieved" => "scored hits: multi-term + filename bonus, ranked (first to trim)",
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
