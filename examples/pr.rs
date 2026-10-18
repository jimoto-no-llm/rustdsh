//! Repository maintenance CLI; GitHub operations here are read-only.
use anyhow::{ensure, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const REPO: &str = "jimoto-no-llm/rustdsh";
const FIELDS: &str = "number,title,body,url,state,isDraft,author,baseRefName,baseRefOid,headRefOid,mergeable,mergeStateStatus,reviewDecision,files,changedFiles,statusCheckRollup";
const SETTINGS: &str = include_str!("../.github/project-settings.json");

#[derive(Parser)]
#[command(
    about = "rustdsh PR queue, review evidence, preparation and merge checks (read-only GitHub)"
)]
struct Cli {
    #[command(subcommand)]
    action: Action,
}
#[derive(Subcommand)]
enum Action {
    /// List up to 100 open PRs, ordered by priority and number.
    Queue,
    /// Save the current snapshot and diff under .local/pr/<number>/.
    Inspect { number: u64 },
    /// Record your completed review of the current head and base.
    Review {
        number: u64,
        #[arg(long, value_enum)]
        verdict: Verdict,
        #[arg(long)]
        notes: PathBuf,
    },
    /// Run verification in a clean checkout of the reviewed head.
    Prepare { number: u64 },
    /// Compare saved evidence with fresh GitHub state; print a pinned merge command.
    Gate { number: u64 },
    /// CI body check, with path-specific verification advice.
    Policy {
        #[arg(long)]
        event: PathBuf,
        #[arg(long)]
        base: Option<String>,
    },
}
#[derive(Clone, Copy, ValueEnum)]
enum Verdict {
    Ready,
    NeedsWork,
}

fn output(program: &str, args: &[&str]) -> Result<String> {
    let out = Command::new(program)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .with_context(|| format!("{program} is unavailable"))?;
    // Never echo arbitrary command stderr, diffs or credentials into logs.
    ensure!(
        out.status.success(),
        "{program} failed; run the command directly to inspect its diagnostic"
    );
    String::from_utf8(out.stdout).context("command returned non-UTF-8 output")
}
fn gh(args: &[&str]) -> Result<String> {
    let mut args = args.to_vec();
    args.extend(["--repo", REPO]);
    output("gh", &args)
}
fn oid(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .with_context(|| format!("missing {key}"))
}
fn snapshot(number: u64) -> Result<Value> {
    ensure!(number > 0, "PR number must be positive");
    let value: Value =
        serde_json::from_str(&gh(&["pr", "view", &number.to_string(), "--json", FIELDS])?)?;
    ensure!(
        value["number"].as_u64() == Some(number),
        "PR identity mismatch"
    );
    ensure!(
        oid(field(&value, "headRefOid")?) && oid(field(&value, "baseRefOid")?),
        "PR commit IDs unavailable"
    );
    Ok(value)
}
fn folder(number: u64) -> PathBuf {
    PathBuf::from(format!(".local/pr/{number}"))
}
fn save(path: &Path, value: &Value) -> Result<()> {
    fs::create_dir_all(path.parent().context("missing parent")?)?;
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}
fn load(path: &Path) -> Result<Value> {
    serde_json::from_slice(&fs::read(path).with_context(|| format!("missing {}", path.display()))?)
        .context("invalid evidence JSON")
}
fn evidence_path(number: u64, pr: &Value, stage: &str) -> Result<PathBuf> {
    Ok(folder(number).join(format!(
        "{stage}-{}-{}.json",
        field(pr, "headRefOid")?,
        field(pr, "baseRefOid")?
    )))
}
fn identity(number: u64, pr: &Value) -> Result<Value> {
    Ok(json!({"schema": 1, "repository": REPO, "number": number,
        "head": field(pr, "headRefOid")?, "base": field(pr, "baseRefOid")?}))
}
fn same_evidence(number: u64, pr: &Value, receipt: &Value) -> Result<()> {
    let expected = identity(number, pr)?;
    for key in ["schema", "repository", "number", "head", "base"] {
        ensure!(
            receipt[key] == expected[key],
            "stale or mismatched {key}; review the current PR"
        );
    }
    Ok(())
}
fn paths(pr: &Value) -> Result<Vec<&str>> {
    let files = pr["files"]
        .as_array()
        .context("changed files unavailable")?;
    ensure!(
        pr["changedFiles"].as_u64() == Some(files.len() as u64),
        "file list is incomplete; split or inspect the PR manually"
    );
    files.iter().map(|item| field(item, "path")).collect()
}
fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect()
}
fn inspect(number: u64) -> Result<Value> {
    let pr = snapshot(number)?;
    let diff = gh(&["pr", "diff", &number.to_string(), "--patch"])?;
    let after = snapshot(number)?;
    ensure!(
        pr["headRefOid"] == after["headRefOid"] && pr["baseRefOid"] == after["baseRefOid"],
        "PR changed during capture; retry inspect"
    );
    save(&folder(number).join("snapshot.json"), &pr)?;
    fs::write(folder(number).join("diff.patch"), diff)?;
    println!(
        "#{} {} [{}] head={} base={}",
        number,
        clean(field(&pr, "title")?),
        field(&pr, "mergeStateStatus")?,
        field(&pr, "headRefOid")?,
        field(&pr, "baseRefOid")?
    );
    println!("Evidence: {}", folder(number).display());
    for hint in advice(&paths(&pr)?) {
        println!("Verification: {hint}");
    }
    Ok(pr)
}
fn queue() -> Result<()> {
    let prs: Value = serde_json::from_str(&gh(&[
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,title,isDraft,labels,reviewDecision,mergeStateStatus",
    ])?)?;
    let mut rows = prs.as_array().context("invalid PR list")?.clone();
    let priority = |pr: &Value| {
        pr["labels"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|l| l["name"].as_str())
            .filter(|s| ["P0", "P1", "P2", "P3"].contains(s))
            .min()
            .unwrap_or("P2")
            .to_owned()
    };
    rows.sort_by_key(|pr| (priority(pr), pr["number"].as_u64().unwrap_or(0)));
    for pr in &rows {
        println!(
            "{}\t#{}\t{}\t{}\t{}\t{}",
            priority(pr),
            pr["number"],
            if pr["isDraft"] == true {
                "draft"
            } else {
                "open"
            },
            pr["reviewDecision"].as_str().unwrap_or("UNKNOWN"),
            pr["mergeStateStatus"].as_str().unwrap_or("UNKNOWN"),
            clean(field(pr, "title")?)
        );
    }
    println!(
        "{} PRs (maximum 100; inspect refreshes each PR)",
        rows.len()
    );
    Ok(())
}
fn strip_comments(body: &str) -> String {
    let mut result = String::new();
    let mut rest = body;
    while let Some(at) = rest.find("<!--") {
        result.push_str(&rest[..at]);
        match rest[at + 4..].find("-->") {
            Some(end) => rest = &rest[at + 4 + end + 3..],
            None => return result,
        }
    }
    result.push_str(rest);
    result
}
fn body_errors(body: &str) -> Vec<String> {
    let body = strip_comments(body);
    let mut sections = BTreeMap::<&str, String>::new();
    let mut active = None;
    let mut fenced = false;
    let fence = char::from(96).to_string().repeat(3);
    for line in body.lines() {
        if line.trim_start().starts_with(&fence) || line.trim_start().starts_with("~~~") {
            fenced = !fenced;
        }
        if !fenced && line.starts_with("## ") {
            active = [
                ("Overview", "概要"),
                ("Changes", "変更"),
                ("Verification", "検証"),
                ("Caveats", "注意点"),
            ]
            .into_iter()
            .find(|(en, ja)| line.contains(en) || line.contains(ja))
            .map(|(en, _)| en);
        } else if let Some(name) = active {
            sections.entry(name).or_default().push_str(line);
        }
    }
    ["Overview", "Changes", "Verification", "Caveats"]
        .into_iter()
        .filter(|name| sections.get(name).is_none_or(|s| s.trim().is_empty()))
        .map(|name| format!("Fill the {name} section; template comments do not count"))
        .collect()
}
fn advice(paths: &[&str]) -> Vec<&'static str> {
    let mut result = vec!["cargo fmt --check; cargo clippy --all-targets -- -D warnings; cargo test --release; sh tests/regress.sh"];
    if paths.iter().any(|p| p.starts_with("dashboard/")) {
        result.push("npm ci --prefix dashboard; npm test --prefix dashboard");
    }
    if paths.iter().any(|p| p.starts_with("plugins/")) {
        result.push("Run changed plugin tests against the newly built rdsh binary");
    }
    if paths.iter().any(|p| {
        p.contains("install") || p.contains("release") || p.starts_with(".github/workflows/cd")
    }) {
        result.push("python3 -m unittest discover -s tests -p 'test_release_*.py'; tests/install-isolated.sh --source local");
    }
    if paths.iter().any(|p| {
        p.ends_with(".html")
            || p.ends_with(".css")
            || p.ends_with(".tsx")
            || p.ends_with("client.js")
    }) {
        result.push(
            "Attach real before/after PNGs and GIF for motion; run tests/e2e/README.md gates",
        );
    }
    result
}
fn policy(event: &Path, base: Option<String>) -> Result<()> {
    let event = load(event)?;
    let pr = &event["pull_request"];
    let errors = body_errors(pr["body"].as_str().unwrap_or(""));
    let owned = if let Some(base) = base {
        ensure!(oid(&base), "invalid base SHA");
        let head = field(&pr["head"], "sha")?;
        ensure!(oid(head), "invalid head SHA");
        output(
            "git",
            &[
                "diff",
                "--name-only",
                "-z",
                &format!("{base}...{head}"),
                "--",
            ],
        )?
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let paths: Vec<&str> = owned.iter().map(String::as_str).collect();
    for hint in advice(&paths) {
        println!("- {hint}");
    }
    for error in &errors {
        eprintln!("{error}");
    }
    ensure!(
        errors.is_empty(),
        "PR body needs the four completed template sections"
    );
    println!("PR body policy passed");
    Ok(())
}
fn commands(paths: &[&str]) -> Vec<Vec<&'static str>> {
    let ui = paths.iter().any(|p| {
        p.ends_with(".html")
            || p.ends_with(".css")
            || p.ends_with(".tsx")
            || p.ends_with("client.js")
    });
    let mut commands = vec![
        vec!["cargo", "fmt", "--check"],
        vec![
            "cargo",
            "clippy",
            "--locked",
            "--all-targets",
            "--",
            "-D",
            "warnings",
        ],
        vec!["cargo", "test", "--locked", "--release"],
        vec![
            "cargo",
            "test",
            "--locked",
            "--release",
            "--example",
            "benchmark_extended",
        ],
        vec![
            "cargo",
            "test",
            "--locked",
            "--release",
            "--example",
            "benchmark_models",
        ],
        vec!["cargo", "test", "--locked", "--release", "--example", "pr"],
        vec!["cargo", "build", "--locked", "--release"],
        vec!["node", "--test", "tests/model_benchmark/fence.test.mjs"],
        vec!["sh", "tests/regress.sh"],
    ];
    if paths
        .iter()
        .any(|p| p.starts_with("plugins/workflow-board/") || *p == "src/workflow_patch.rs")
    {
        commands.push(vec![
            "node",
            "--test",
            "plugins/workflow-board/tests/source-patch.test.mjs",
        ]);
    }
    if ui || paths.iter().any(|p| p.starts_with("dashboard/")) {
        commands.push(vec!["npm", "ci", "--prefix", "dashboard"]);
    }
    if paths.iter().any(|p| p.starts_with("dashboard/")) {
        commands.push(vec!["npm", "test", "--prefix", "dashboard"]);
    }
    if ui {
        commands.push(vec!["npm", "ci", "--prefix", "tests/e2e"]);
        commands.push(vec!["npm", "test", "--prefix", "tests/e2e"]);
    }
    if paths.iter().any(|p| {
        p.contains("install") || p.contains("release") || p.starts_with(".github/workflows/cd")
    }) {
        commands.push(vec![
            "python3",
            "-m",
            "unittest",
            "discover",
            "-s",
            "tests",
            "-p",
            "test_release_*.py",
        ]);
        commands.push(vec!["sh", "tests/install-isolated.sh", "--source", "local"]);
    }
    commands
}
fn checkout_matches(pr: &Value) -> Result<()> {
    ensure!(
        output("git", &["rev-parse", "HEAD"])?.trim() == field(pr, "headRefOid")?,
        "checkout must be the reviewed PR head"
    );
    ensure!(
        output(
            "git",
            &[
                "-c",
                "core.fsmonitor=false",
                "status",
                "--porcelain=v1",
                "--untracked-files=all"
            ]
        )?
        .trim()
        .is_empty(),
        "checkout has local changes; use a clean isolated checkout"
    );
    Ok(())
}
fn prepare(number: u64) -> Result<()> {
    let pr = snapshot(number)?;
    ensure!(
        pr["state"] == "OPEN" && pr["isDraft"] == false && pr["baseRefName"] == "main",
        "prepare requires an open, non-draft PR to main"
    );
    let review = load(&evidence_path(number, &pr, "review")?)?;
    same_evidence(number, &pr, &review)?;
    ensure!(
        review["verdict"] == "ready",
        "address review findings first"
    );
    checkout_matches(&pr)?;
    // A failed rerun must not leave an older success receipt usable.
    let receipt_path = evidence_path(number, &pr, "prepared")?;
    match fs::remove_file(&receipt_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let selected = commands(&paths(&pr)?);
    let binary = std::env::current_dir()?
        .join("target/release")
        .join(if cfg!(windows) { "rdsh.exe" } else { "rdsh" });
    for args in &selected {
        println!("Running: {}", args.join(" "));
        let status = Command::new(args[0])
            .args(&args[1..])
            .env("RDSH_BIN", &binary)
            .env("RDSH_E2E_BIN", &binary)
            .status()?;
        ensure!(
            status.success(),
            "verification failed; no preparation receipt saved"
        );
    }
    checkout_matches(&pr)?;
    let fresh = snapshot(number)?;
    ensure!(
        fresh["headRefOid"] == pr["headRefOid"] && fresh["baseRefOid"] == pr["baseRefOid"],
        "PR changed during verification"
    );
    let mut receipt = identity(number, &pr)?;
    receipt["checks"] = json!(selected.iter().map(|c| c.join(" ")).collect::<Vec<_>>());
    receipt["passed"] = json!(true);
    save(&receipt_path, &receipt)?;
    println!("Prepared #{} at {}", number, field(&pr, "headRefOid")?);
    Ok(())
}
fn gate_errors(number: u64, pr: &Value, review: &Value, prepared: &Value) -> Result<Vec<String>> {
    same_evidence(number, pr, review)?;
    same_evidence(number, pr, prepared)?;
    let mut errors = Vec::new();
    for (key, expected) in [
        ("state", json!("OPEN")),
        ("isDraft", json!(false)),
        ("baseRefName", json!("main")),
        ("mergeable", json!("MERGEABLE")),
        ("mergeStateStatus", json!("CLEAN")),
        ("reviewDecision", json!("APPROVED")),
    ] {
        if pr[key] != expected {
            errors.push(format!("{key} is not {expected}"));
        }
    }
    if review["verdict"] != "ready" || review["notes"].as_str().is_none_or(|s| s.trim().is_empty())
    {
        errors.push("completed review with nonempty notes required".into());
    }
    let expected: Vec<String> = commands(&paths(pr)?).iter().map(|c| c.join(" ")).collect();
    if prepared["passed"] != true || prepared["checks"] != json!(expected) {
        errors.push("complete local verification receipt required".into());
    }
    let settings: Value = serde_json::from_str(SETTINGS)?;
    let required = settings["required_checks"]
        .as_array()
        .context("required checks configuration missing")?;
    let checks = pr["statusCheckRollup"]
        .as_array()
        .context("remote checks unavailable")?;
    let mut states = BTreeMap::<&str, Vec<&str>>::new();
    for check in checks {
        let name = check["name"]
            .as_str()
            .or_else(|| check["context"].as_str())
            .context("check name missing")?;
        let state = if check["status"] == "COMPLETED" {
            check["conclusion"].as_str()
        } else if check.get("state").is_some() {
            check["state"].as_str()
        } else {
            Some("PENDING")
        }
        .context("check state missing")?;
        states.entry(name).or_default().push(state);
        if !["SUCCESS", "NEUTRAL", "SKIPPED"].contains(&state) {
            errors.push(format!("{name}: {state}"));
        }
    }
    for name in required.iter().filter_map(Value::as_str) {
        if states
            .get(name)
            .is_none_or(|items| items.is_empty() || items.iter().any(|s| *s != "SUCCESS"))
        {
            errors.push(format!("required check not successful: {name}"));
        }
    }
    errors.extend(body_errors(pr["body"].as_str().unwrap_or("")));
    Ok(errors)
}
fn gate(number: u64) -> Result<()> {
    let pr = snapshot(number)?;
    let review = load(&evidence_path(number, &pr, "review")?)?;
    let prepared = load(&evidence_path(number, &pr, "prepared")?)?;
    let errors = gate_errors(number, &pr, &review, &prepared)?;
    for error in &errors {
        eprintln!("- {error}");
    }
    ensure!(
        errors.is_empty(),
        "merge blocked; refresh evidence after fixes or new commits"
    );
    println!("All gates passed for #{}; explicit merge command:", number);
    println!(
        "gh pr merge {number} --repo {REPO} --squash --match-head-commit {}",
        field(&pr, "headRefOid")?
    );
    Ok(())
}
fn run() -> Result<()> {
    match Cli::parse().action {
        Action::Queue => queue(),
        Action::Inspect { number } => inspect(number).map(|_| ()),
        Action::Review {
            number,
            verdict,
            notes,
        } => {
            let notes = fs::read_to_string(notes)?;
            ensure!(!notes.trim().is_empty(), "review notes cannot be empty");
            let pr = inspect(number)?;
            let mut receipt = identity(number, &pr)?;
            receipt["verdict"] = json!(match verdict {
                Verdict::Ready => "ready",
                Verdict::NeedsWork => "needs-work",
            });
            receipt["notes"] = json!(notes);
            save(&evidence_path(number, &pr, "review")?, &receipt)?;
            println!("Review recorded locally; no GitHub review submitted");
            Ok(())
        }
        Action::Prepare { number } => prepare(number),
        Action::Gate { number } => gate(number),
        Action::Policy { event, base } => policy(&event, base),
    }
}
fn main() {
    if let Err(error) = run() {
        eprintln!("PR workflow: {error:#}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Value, Value, Value) {
        let settings: Value = serde_json::from_str(SETTINGS).unwrap();
        let names: Vec<Value> = settings["required_checks"].as_array().unwrap().clone();
        let pr = json!({"number": 1, "headRefOid": "a".repeat(40), "baseRefOid": "b".repeat(40),
            "state": "OPEN", "isDraft": false, "baseRefName": "main", "mergeable": "MERGEABLE",
            "mergeStateStatus": "CLEAN", "reviewDecision": "APPROVED", "files": [], "changedFiles": 0,
            "body": "## Overview\nsummary\n## Changes\nchange\n## Verification\ntests pass\n## Caveats\nnone\n",
            "statusCheckRollup": names.iter().map(|name| json!({"name": name, "status": "COMPLETED", "conclusion": "SUCCESS"})).collect::<Vec<_>>()});
        let mut review = identity(1, &pr).unwrap();
        review["verdict"] = json!("ready");
        review["notes"] = json!("Reviewed diff and failure paths.");
        let mut prepared = identity(1, &pr).unwrap();
        prepared["passed"] = json!(true);
        prepared["checks"] = json!(commands(&[])
            .iter()
            .map(|c| c.join(" "))
            .collect::<Vec<_>>());
        (pr, review, prepared)
    }
    #[test]
    fn complete_same_commit_evidence_passes() {
        let (pr, review, prepared) = fixture();
        assert!(gate_errors(1, &pr, &review, &prepared).unwrap().is_empty());
    }
    #[test]
    fn changed_head_base_or_repository_invalidates_evidence() {
        let (pr, review, prepared) = fixture();
        for key in ["head", "base", "repository", "number", "schema"] {
            let mut bad = review.clone();
            bad[key] = json!("different");
            assert!(gate_errors(1, &pr, &bad, &prepared).is_err(), "{key}");
        }
    }
    #[test]
    fn missing_failed_pending_skipped_and_duplicate_required_checks_block() {
        let (pr, review, prepared) = fixture();
        for state in [
            "FAILURE",
            "CANCELLED",
            "TIMED_OUT",
            "ACTION_REQUIRED",
            "SKIPPED",
            "NEUTRAL",
            "",
        ] {
            let mut bad = pr.clone();
            bad["statusCheckRollup"][0]["conclusion"] = json!(state);
            assert!(
                !gate_errors(1, &bad, &review, &prepared).unwrap().is_empty(),
                "{state}"
            );
        }
        let mut bad = pr.clone();
        bad["statusCheckRollup"][0]["status"] = json!("IN_PROGRESS");
        assert!(!gate_errors(1, &bad, &review, &prepared).unwrap().is_empty());
        let mut bad = pr.clone();
        bad["statusCheckRollup"].as_array_mut().unwrap().clear();
        assert!(!gate_errors(1, &bad, &review, &prepared).unwrap().is_empty());
        let mut bad = pr.clone();
        let mut duplicate = bad["statusCheckRollup"][0].clone();
        duplicate["conclusion"] = json!("FAILURE");
        bad["statusCheckRollup"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert!(!gate_errors(1, &bad, &review, &prepared).unwrap().is_empty());
    }
    #[test]
    fn draft_conflicts_unknown_reviews_incomplete_files_or_tests_block() {
        let (pr, review, prepared) = fixture();
        for (key, value) in [
            ("isDraft", json!(true)),
            ("mergeable", json!("UNKNOWN")),
            ("mergeStateStatus", json!("BLOCKED")),
            ("reviewDecision", json!("REVIEW_REQUIRED")),
            ("state", json!("CLOSED")),
            ("baseRefName", json!("other")),
        ] {
            let mut bad = pr.clone();
            bad[key] = value;
            assert!(!gate_errors(1, &bad, &review, &prepared).unwrap().is_empty());
        }
        let mut bad = pr.clone();
        bad["changedFiles"] = json!(301);
        assert!(gate_errors(1, &bad, &review, &prepared).is_err());
        let mut bad = prepared.clone();
        bad["checks"] = json!(["cargo test"]);
        assert!(!gate_errors(1, &pr, &review, &bad).unwrap().is_empty());
    }
    #[test]
    fn empty_template_and_headings_inside_fences_do_not_count() {
        assert_eq!(
            body_errors(include_str!("../.github/pull_request_template.md")).len(),
            4
        );
        let fence = char::from(96).to_string().repeat(3);
        assert_eq!(
            body_errors(&format!("{fence}\n## Overview\nfake\n{fence}\n")).len(),
            4
        );
        assert!(
            body_errors("## 概要\n修正\n## 変更\n説明\n## 検証\n成功\n## 注意点\nなし\n")
                .is_empty()
        );
    }
}
