//! Context engine prototype (test implementation).
//!
//! Goal: rebuild the context needed for this turn instead of
//! passing the whole history. Backed by existing rdsh pieces:
//! search / sessions for retrieval, tokens / prune /
//! compact for packing. Local files only, no vector DB.
//!
//! Config lives at DSH_HOME/rdsh-context.json (prototype schema v1).
//! Missing/empty file -> DSH_HOME/rdsh.json $.context, else defaults; never an error.

use std::io::Write;

const SCHEMA: u32 = 1;
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

pub fn config_path() -> String {
    format!("{}/rdsh-context.json", crate::inspect::dsh_home())
}

pub fn load_config() -> ContextConfig {
    let path = config_path();
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    // Existing rdsh-context.json always wins; fall back to rdsh.json $.context
    // only when the file is missing or empty.
    if raw.trim().is_empty() {
        if let Some(cfg) = load_fallback() {
            return cfg;
        }
        return ContextConfig::default();
    }
    parse_config(&raw)
}

fn load_fallback() -> Option<ContextConfig> {
    let path = format!("{}/rdsh.json", crate::inspect::dsh_home());
    let raw = std::fs::read_to_string(&path).ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let ctx = v.get("context")?;
    if !ctx.is_object() {
        return None;
    }
    Some(parse_value(ctx))
}

fn parse_config(raw: &str) -> ContextConfig {
    let v: serde_json::Value = serde_json::from_str(raw).unwrap_or(serde_json::Value::Null);
    parse_value(&v)
}

fn parse_value(v: &serde_json::Value) -> ContextConfig {
    let mut cfg = ContextConfig::default();
    if let Some(n) = v.get("token_budget").and_then(|x| x.as_u64()) {
        cfg.token_budget = (n as usize).clamp(500, 200000);
    }
    if let Some(b) = v.get("enable_retriever").and_then(|x| x.as_bool()) {
        cfg.enable_retriever = b;
    }
    if let Some(b) = v.get("enable_packer").and_then(|x| x.as_bool()) {
        cfg.enable_packer = b;
    }
    if let Some(b) = v.get("enable_verifier").and_then(|x| x.as_bool()) {
        cfg.enable_verifier = b;
    }
    if let Some(s) = v.get("goal").and_then(|x| x.as_str()) {
        cfg.goal = s.chars().take(2000).collect();
    }
    cfg.decisions = str_list(v, "decisions", 50, 500);
    cfg.constraints = str_list(v, "constraints", 50, 500);
    cfg.working_files = str_list(v, "working_files", 50, 300);
    cfg.open_tasks = str_list(v, "open_tasks", 50, 500);
    if cfg.working_files.is_empty() {
        cfg.working_files = str_list(v, "files", 50, 300);
    }
    if let Some(n) = v.get("max_code_hits").and_then(|x| x.as_u64()) {
        cfg.max_code_hits = (n as usize).clamp(1, 100);
    }
    if let Some(n) = v.get("max_sessions").and_then(|x| x.as_u64()) {
        cfg.max_sessions = (n as usize).clamp(0, 20);
    }
    if let Some(b) = v.get("include_git_diff").and_then(|x| x.as_bool()) {
        cfg.include_git_diff = b;
    }
    cfg
}

fn str_list(v: &serde_json::Value, key: &str, max_items: usize, max_chars: usize) -> Vec<String> {
    match v.get(key).and_then(|x| x.as_array()) {
        Some(arr) => arr
            .iter()
            .filter_map(|x| x.as_str())
            .take(max_items)
            .map(|s| s.chars().take(max_chars).collect())
            .filter(|s: &String| !s.trim().is_empty())
            .collect(),
        None => vec![],
    }
}

fn estimate(s: &str) -> usize {
    crate::tokens::estimate_tokens(s)
}

fn read_bounded(path: &str, cap: usize) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
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

fn git_diff_stat() -> String {
    let out = std::process::Command::new("git")
        .args(["diff", "--stat", "--", "."])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).into_owned();
            let t = s.trim().to_string();
            if t.is_empty() {
                "(clean)".to_string()
            } else {
                t.chars().take(2000).collect()
            }
        }
        _ => "(git unavailable)".to_string(),
    }
}

fn recent_sessions(query: &str, limit: usize) -> Vec<String> {
    if limit == 0 {
        return vec![];
    }
    let root = format!("{}/sessions", crate::inspect::dsh_home());
    let projs: Vec<String> = match std::fs::read_dir(&root) {
        Ok(e) => e
            .filter_map(|e| e.ok())
            .filter(|e| e.metadata().map(|m| m.is_dir()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .take(20)
            .collect(),
        Err(_) => return vec![],
    };
    let q = query.to_lowercase();
    let mut hits: Vec<String> = vec![];
    for proj in projs {
        let pdir = std::path::Path::new(&root).join(&proj);
        let mut files: Vec<_> = std::fs::read_dir(&pdir)
            .map(|e| {
                e.filter_map(|e| e.ok())
                    .filter(|e| e.metadata().map(|m| m.is_file()).unwrap_or(false))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        files.sort_by_key(|e| std::cmp::Reverse(e.metadata().and_then(|m| m.modified()).ok()));
        for f in files.into_iter().take(5) {
            if hits.len() >= limit {
                break;
            }
            let p = f.path();
            let bytes = std::fs::read(&p).unwrap_or_default();
            if bytes.len() > 128 * 1024 {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes).into_owned();
            if q.is_empty() || text.to_lowercase().contains(&q) {
                hits.push(format!(
                    "{}:{}",
                    proj,
                    p.file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default()
                ));
            }
        }
    }
    hits
}

fn code_hits(query: &str, max: usize) -> Vec<String> {
    if query.trim().is_empty() {
        return vec![];
    }
    let mut out: Vec<String> = vec![];
    let mut stack = vec![std::path::PathBuf::from(".")];
    let q = query.to_lowercase();
    while let Some(dir) = stack.pop() {
        if out.len() >= max {
            break;
        }
        let entries = std::fs::read_dir(&dir)
            .map(|e| e.filter_map(|e| e.ok()).collect::<Vec<_>>())
            .unwrap_or_default();
        for e in entries {
            if out.len() >= max {
                break;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with(".") || name == "target" || name == "node_modules" || name == ".git"
            {
                continue;
            }
            let p = e.path();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                stack.push(p);
                continue;
            }
            let keep = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|x| matches!(x, "rs" | "mjs" | "js" | "md" | "yml" | "toml"))
                .unwrap_or(false);
            if !keep {
                continue;
            }
            if let Ok(bytes) = std::fs::read(&p) {
                if bytes.len() > 128 * 1024 {
                    continue;
                }
                let text = String::from_utf8_lossy(&bytes);
                for (i, line) in text.lines().enumerate().take(2000) {
                    if out.len() >= max {
                        break;
                    }
                    if line.to_lowercase().contains(&q) {
                        out.push(format!(
                            "{}:{}:{}",
                            p.display(),
                            i + 1,
                            line.chars().take(160).collect::<String>()
                        ));
                    }
                }
            }
        }
    }
    out
}

struct Section {
    name: &'static str,
    body: String,
}

fn assemble(query: &str, cfg: &ContextConfig) -> Vec<Section> {
    let mut secs: Vec<Section> = vec![];
    let goal = if cfg.goal.trim().is_empty() {
        "(unset - set goal in rdsh settings or rdsh-context.json)".to_string()
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
                Some(t) => parts.push(format!(
                    "## {}\n{}",
                    f,
                    t.chars().take(2000).collect::<String>()
                )),
                None => parts.push(format!("## {}\n(missing - verify before trusting)", f)),
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
            body: git_diff_stat(),
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
            parts.push(format!("[session] {}", s));
        }
        if !parts.is_empty() {
            secs.push(Section {
                name: "retrieved",
                body: parts.join("\n"),
            });
        }
    }
    secs
}

fn render(sections: &[Section]) -> String {
    let mut s = String::new();
    for sec in sections {
        s.push_str(&format!("# {}\n{}\n\n", sec.name, sec.body));
    }
    s
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
    if json {
        let v = serde_json::json!({
            "schema": SCHEMA,
            "prototype": true,
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
            "config_path": config_path(),
        });
        println!("{}", serde_json::to_string_pretty(&v)?);
        return Ok(());
    }
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    writeln!(out, "[rdsh context: prototype v1]")?;
    writeln!(out, "config: {}", config_path())?;
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
        writeln!(out, "goal: (unset)")?;
    } else {
        writeln!(out, "goal: {}", cfg.goal)?;
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
    let packed = if cfg.enable_packer {
        crate::tokens::prune_to_budget(&full, budget)
    } else {
        full
    };
    let after = estimate(&packed);
    if as_json {
        let v = serde_json::json!({
            "prototype": true,
            "query": q,
            "budget": budget,
            "max_code_hits": cfg.max_code_hits,
            "max_sessions": cfg.max_sessions,
            "include_git_diff": cfg.include_git_diff,
            "tokens_before": before,
            "tokens_after": after,
            "sections": sections.iter().map(|s| serde_json::json!({"name": s.name, "tokens": estimate(&s.body)})).collect::<Vec<_>>(),
            "context": packed,
        });
        println!("{}", serde_json::to_string_pretty(&v)?);
        return Ok(());
    }
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    out.write_all(packed.as_bytes())?;
    if !packed.ends_with("\n") {
        out.write_all(b"\n")?;
    }
    out.flush()?;
    eprintln!(
        "[rdsh context build] {}->{} tokens (budget {})",
        before, after, budget
    );
    Ok(())
}

pub fn cmd_search(query: String, max: usize) -> anyhow::Result<()> {
    let max = max.clamp(1, 100);
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    writeln!(out, "# code")?;
    for h in code_hits(&query, max) {
        writeln!(out, "{}", h)?;
    }
    writeln!(out, "# sessions")?;
    for s in recent_sessions(&query, max.min(20)) {
        writeln!(out, "{}", s)?;
    }
    out.flush()?;
    eprintln!("[rdsh context search] query={:?}", query);
    Ok(())
}

pub fn cmd_explain(query: Option<String>, budget: Option<usize>) -> anyhow::Result<()> {
    let cfg = load_config();
    let q = query.unwrap_or_default();
    let budget = budget.unwrap_or(cfg.token_budget).clamp(500, 200000);
    let sections = assemble(&q, &cfg);
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    writeln!(out, "[rdsh context explain: prototype v1]")?;
    if cfg.include_git_diff {
        writeln!(out, "priority: goal > constraints > related_files > git_diff > decisions > open_tasks > retrieved")?;
    } else {
        writeln!(out, "priority: goal > constraints > related_files > decisions > open_tasks > retrieved (git_diff OFF)")?;
    }
    writeln!(out, "budget: {} tokens", budget)?;
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
            "goal" => "always first: keeps long sessions on track",
            "constraints" => "must-not-break rules",
            "related_files" => "working set from settings (verify if missing)",
            "git_diff" => "current uncommitted change (fresh, not from memory)",
            "decisions" => "reused past decisions (structured, not full history)",
            "open_tasks" => "unresolved work only",
            "retrieved" => "query-related hits from search/sessions (retriever)",
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
    out.flush()?;
    Ok(())
}
