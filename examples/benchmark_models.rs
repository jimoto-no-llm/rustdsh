//! Opt-in real-provider benchmark. No model or network calls during cargo test.
use anyhow::{bail, Context, Result};
use clap::Parser;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Parser)]
struct Args {
    #[arg(long)]
    bin: PathBuf,
    #[arg(long)]
    original: PathBuf,
    /// Path only; the official DSH provider reads and refreshes existing auth.
    #[arg(long)]
    credentials: PathBuf,
    /// Non-secret DSH providers catalog, containing model/compat metadata.
    #[arg(long)]
    catalog: PathBuf,
    /// Optional installed runtime bundle (e.g. app.asar), fingerprinted only.
    #[arg(long)]
    runtime_artifact: Option<PathBuf>,
    /// New output directory; existing runs are never overwritten.
    #[arg(long)]
    out: PathBuf,
    #[arg(long, default_value_t = 3)]
    samples: usize,
    #[arg(long, default_value_t = 120)]
    timeout_seconds: u64,
    #[arg(long, value_parser = ["response", "read", "rust_fix"])]
    only_case: Option<String>,
    #[arg(long, value_parser = ["openai-codex", "anthropic"])]
    only_provider: Option<String>,
    /// Use SSE without a WebSocket session cache in the isolated Codex profile.
    #[arg(long)]
    codex_sse: bool,
    /// Exact model ID from the supplied openai-codex catalog (no fallback).
    #[arg(long, default_value = "gpt-6.1-sol", value_parser = parse_model_id)]
    codex_model: String,
    /// Exact model ID from the supplied anthropic catalog (no fallback).
    #[arg(long, default_value = "claude-sonnet-5-5", value_parser = parse_model_id)]
    anthropic_model: String,
}

fn parse_model_id(value: &str) -> std::result::Result<String, String> {
    if value.len() > 128
        || !value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err("model ID must start with an ASCII letter or digit and contain only letters, digits, dots, hyphens or underscores (128 bytes maximum)".into());
    }
    Ok(value.to_owned())
}

fn provider_configs(
    catalog: &Value,
    selections: &[(&str, &str)],
    only: Option<&str>,
) -> Result<Vec<Option<Value>>> {
    selections
        .iter()
        .map(|&(provider, model)| {
            if only.is_some_and(|selected| selected != provider) {
                return Ok(None);
            }
            let provider_catalog = catalog.get(provider).with_context(|| {
                format!("catalog provider {provider} missing for model {model}")
            })?;
            provider_catalog["models"]
                .as_array()
                .with_context(|| {
                    format!("catalog models missing for provider {provider} and model {model}")
                })?
                .iter()
                .find(|v| v["id"] == model)
                .with_context(|| {
                    format!("requested model {model} missing from catalog provider {provider}")
                })?;
            Ok(Some(
                json!({"models":[{"id":model}],"retryPolicy":{"mode":"normal","maxRetries":0}}),
            ))
        })
        .collect()
}

fn summarize_runs(runs: &[Value], selections: &[(&str, &str)], only: Option<&str>) -> Vec<Value> {
    let mut summaries = Vec::new();
    for (provider, model) in selections.iter().copied() {
        if only.is_some_and(|selected| selected != provider) {
            continue;
        }
        for (case, launcher) in [
            ("response", "original"),
            ("response", "rdsh"),
            ("read", "rdsh"),
            ("rust_fix", "rdsh"),
        ] {
            let group: Vec<&Value> = runs
                .iter()
                .filter(|v| {
                    v["provider"] == provider
                        && v["model"] == model
                        && v["case"] == case
                        && v["launcher"] == launcher
                })
                .collect();
            let times: Vec<f64> = group
                .iter()
                .filter(|v| v["model_passed"] == true)
                .filter_map(|v| v["response_elapsed_seconds"].as_f64())
                .collect();
            summaries.push(json!({"provider":provider,"model":model,"case":case,"launcher":launcher,"attempts":group.len(),"passed":times.len(),
                "runtime_passed":group.iter().filter(|v|v["passed"]==true).count(),
                "median_success_seconds":percentile(&times,0.5),"p95_success_seconds":percentile(&times,0.95),
                "max_success_seconds":percentile(&times,1.0)}));
        }
    }
    summaries
}

fn accepted(events: &[Value], expected: &str, needs_tool: bool, exit_ok: bool) -> bool {
    exit_ok
        && events.iter().any(|e| e["type"] == "final")
        && response_accepted(events, expected, needs_tool)
}

fn response_accepted(events: &[Value], expected: &str, needs_tool: bool) -> bool {
    events
        .iter()
        .rev()
        .find(|e| e["type"] == "final" || e["type"] == "text")
        .and_then(|e| e["text"].as_str())
        .is_some_and(|s| s.trim() == expected)
        && events.iter().any(|e| {
            e["type"] == "status" && e["phase"] == "turn_end" && e["reason"]["kind"] == "completed"
        })
        && !events.iter().any(|e| {
            e["type"] == "error" || (e["type"] == "tool_result" && e["status"] != "completed")
        })
        && (!needs_tool
            || events.iter().any(|call| {
                call["type"] == "tool_call"
                    && events.iter().any(|e| {
                        e["type"] == "tool_result"
                            && e["status"] == "completed"
                            && e["callId"] == call["callId"]
                    })
            }))
}

fn terminate(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{}", child.id())])
            .status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &child.id().to_string()])
            .output();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn percentile(values: &[f64], p: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut v = values.to_vec();
    v.sort_by(f64::total_cmp);
    Some(
        v[((p * v.len() as f64).ceil() as usize)
            .saturating_sub(1)
            .min(v.len() - 1)],
    )
}

fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

struct RunCleanup(PathBuf);
impl RunCleanup {
    fn clean(&self) -> Result<()> {
        for name in [
            "workspace",
            "home",
            "dsh-home",
            "sessions",
            "cargo-target",
            "tmp",
            "node-cache",
        ] {
            let path = self.0.join(name);
            if path.exists() {
                fs::remove_dir_all(path)?;
            }
        }
        let patch = self.0.join("patch.json");
        if patch.exists() {
            fs::remove_file(patch)?;
        }
        Ok(())
    }
}
impl Drop for RunCleanup {
    fn drop(&mut self) {
        let _ = self.clean();
    }
}

fn patch(args: &Args, run: &Path, selection: (&str, &str), config: &Value, case: &str) -> Value {
    let (provider, model) = selection;
    let cwd = run.join("workspace");
    let readable = if case == "read" {
        vec![cwd.join("fixture.json")]
    } else if case == "rust_fix" {
        vec![cwd.join("src/lib.rs")]
    } else {
        vec![]
    };
    let writable = if case == "rust_fix" {
        vec![cwd.join("src/lib.rs")]
    } else {
        vec![]
    };
    let mut providers = json!({});
    providers[provider] = config.clone();
    if args.codex_sse && provider == "openai-codex" {
        providers[provider]["transport"] = json!("sse");
        providers[provider]["cacheRetention"] = json!("none");
    }
    let mut entries = vec![
        json!({"id":"credentials", "config":{"path":args.credentials,"watch":false}}),
        json!({"id":"agent-default-model", "config":{"provider":provider,"model":model,"reasoningEffort":"high"}}),
        json!({"id":"llm-pi-ai", "config":{"providers":providers}}),
        json!({"id":"session-persistence-jsonl", "config":{"root":run.join("sessions")}}),
        json!({"id":"sandbox-policy", "config":{"mode":if case == "rust_fix" {"workspace-write"} else {"read-only"},"workspaceRoot":cwd}}),
        json!({"id":"tools", "config":{"mode":"native"}}),
        json!({"id":"benchmark-fence", "name":Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/model_benchmark/fence.mjs"),
          "config":{"cwd":cwd,"readable":readable,"writable":writable,"maxRequests":if case == "response" {1} else if case == "read" {2} else {4}}}),
    ];
    // Keep core Agent/Session/fs code official; remove unrelated capabilities.
    for id in [
        "session-title-llm",
        "session-telemetry-otel",
        "deepseek-account",
        "tool-plugin-manager",
        "plugin-manager",
        "tool-bash",
        "tool-pwsh",
        "tool-jobs",
        "tool-fs-search",
        "tool-skill",
        "skill-filesystem",
        "agent-instructions",
        "tool-subagent",
        "tool-subagent-fork",
        "tool-subagent-control",
        "tool-subagent-list-agents",
        "tool-workflow",
        "tool-todo",
        "tool-goal",
        "tool-ralph",
        "tool-web",
        "ptc-runtime",
        "workflow-ptc",
        "plan-mode",
        "user-questions",
        "attachment-local",
        "image-offload",
    ] {
        entries.push(json!({"id":id,"disabled":true}));
    }
    if case == "response" {
        entries.push(json!({"id":"tool-fs","disabled":true}));
    }
    Value::Array(entries)
}

#[derive(Default)]
struct SessionFacts {
    routes: Vec<(String, String)>,
    headers: usize,
    effort_ok: bool,
    catalog_ok: bool,
    retry_attempts: usize,
    provider_attempts: usize,
}
fn valid_tool_catalog(header: &Value, needs_tool: bool) -> bool {
    match header.get("tools") {
        None => !needs_tool,
        Some(Value::Array(tools)) => {
            if needs_tool {
                !tools.is_empty()
                    && tools.iter().all(|tool| {
                        matches!(tool["name"].as_str(), Some("read" | "edit" | "write"))
                    })
            } else {
                tools.is_empty()
            }
        }
        _ => false,
    }
}
fn session_facts(root: &Path, needs_tool: bool) -> Result<SessionFacts> {
    let mut facts = SessionFacts {
        effort_ok: true,
        catalog_ok: true,
        ..Default::default()
    };
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        if path.is_dir() {
            let sub = session_facts(&path, needs_tool)?;
            facts.routes.extend(sub.routes);
            facts.headers += sub.headers;
            facts.effort_ok &= sub.effort_ok;
            facts.catalog_ok &= sub.catalog_ok;
            facts.retry_attempts += sub.retry_attempts;
            facts.provider_attempts += sub.provider_attempts;
        } else if path
            .file_name()
            .is_some_and(|n| n == "session.v4.jsonl.zstd")
        {
            let output = Command::new("zstd").args(["-dc"]).arg(&path).output()?;
            if !output.status.success() {
                bail!("session decompression failed");
            }
            for line in output.stdout.split(|b| *b == b'\n') {
                if let Ok(v) = serde_json::from_slice::<Value>(line) {
                    if v["type"] == "request/context" {
                        if let (Some(p), Some(m)) =
                            (v["data"]["provider"].as_str(), v["data"]["model"].as_str())
                        {
                            facts.routes.push((p.to_owned(), m.to_owned()));
                        }
                    }
                    if v["type"] == "request/header" {
                        facts.headers += 1;
                        facts.effort_ok &=
                            v["data"]["header"]["config"]["reasoningEffort"] == "high";
                        facts.catalog_ok &= valid_tool_catalog(&v["data"]["header"], needs_tool);
                    }
                    if v["type"] == "assistant/attempt" {
                        facts.retry_attempts += 1;
                    }
                    if v["type"] == "assistant/message" || v["type"] == "assistant/attempt" {
                        facts.provider_attempts += 1;
                    }
                }
            }
        }
    }
    Ok(facts)
}

fn classify(events: &[Value], timed_out: bool) -> &'static str {
    if timed_out {
        return "timeout";
    }
    let errors = events
        .iter()
        .filter(|e| e["type"] == "error" || (e["type"] == "status" && e["phase"] == "turn_end"))
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if errors.contains("401") || errors.contains("unauthorized") || errors.contains("credential") {
        "authentication"
    } else if errors.contains("429") || errors.contains("rate_limit") {
        "rate_limit"
    } else if errors.contains("model")
        && (errors.contains("not found") || errors.contains("not supported"))
    {
        "model_unavailable"
    } else {
        "runtime_or_oracle_failure"
    }
}

const BUG: &str = "pub fn sum_inclusive(n: u64) -> u64 { (0..n).sum() }\n";
const ORACLE: &str = "#[test] fn inclusive_boundaries() { for n in 0..=1000 { assert_eq!(fixture::sum_inclusive(n), n * (n + 1) / 2, \"n={n}\"); } }\n";

fn safe_arithmetic(source: &str) -> bool {
    let normalized: String = source.chars().filter(|c| !c.is_whitespace()).collect();
    [
        "pubfnsum_inclusive(n:u64)->u64{(1..=n).sum()}",
        "pubfnsum_inclusive(n:u64)->u64{(1..=n).sum::<u64>()}",
        "pubfnsum_inclusive(n:u64)->u64{n*(n+1)/2}",
        "pubfnsum_inclusive(n:u64)->u64{(n*(n+1))/2}",
    ]
    .contains(&normalized.as_str())
}

fn cargo_oracle(cwd: &Path, home: &Path, run: &Path) -> Result<bool> {
    Ok(Command::new("cargo")
        .args(["test", "--offline", "--quiet"])
        .current_dir(cwd)
        .env("HOME", home)
        .env(
            "RUSTUP_HOME",
            std::env::var_os("RUSTUP_HOME").unwrap_or_else(|| {
                Path::new(&std::env::var("HOME").unwrap_or_default())
                    .join(".rustup")
                    .into_os_string()
            }),
        )
        .env(
            "CARGO_HOME",
            std::env::var_os("CARGO_HOME").unwrap_or_else(|| {
                Path::new(&std::env::var("HOME").unwrap_or_default())
                    .join(".cargo")
                    .into_os_string()
            }),
        )
        .env("CARGO_TARGET_DIR", run.join("cargo-target"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?
        .success())
}

fn run_one(
    args: &Args,
    index: usize,
    sample: usize,
    selection: (&str, &str),
    provider_config: &Value,
    case: &str,
    launcher: &str,
) -> Result<Value> {
    let (provider, model) = selection;
    let run = args
        .out
        .join(format!("{index:03}-{model}-{case}-{launcher}"));
    private_dir(&run)?;
    let cleanup = RunCleanup(run.clone());
    let cwd = run.join("workspace");
    private_dir(&cwd)?;
    let home = run.join("home");
    private_dir(&home)?;
    private_dir(&run.join("tmp"))?;
    let mut nonce_bytes = [0_u8; 16];
    getrandom::fill(&mut nonce_bytes)
        .map_err(|e| anyhow::anyhow!("nonce generation failed: {e}"))?;
    let nonce: String = nonce_bytes.iter().map(|b| format!("{b:02x}")).collect();
    let expected = format!("{nonce}:49");
    fs::write(
        cwd.join("fixture.json"),
        serde_json::to_vec(&json!({"nonce":nonce,"numbers":[3,7,11,28]}))?,
    )?;
    if case == "rust_fix" {
        private_dir(&cwd.join("src"))?;
        private_dir(&cwd.join("tests"))?;
        fs::write(
            cwd.join("Cargo.toml"),
            "[package]\nname=\"fixture\"\nversion=\"0.1.0\"\nedition=\"2021\"\n",
        )?;
        fs::write(cwd.join("src/lib.rs"), BUG)?;
        fs::write(cwd.join("tests/oracle.rs"), ORACLE)?;
        if cargo_oracle(&cwd, &home, &run)? {
            bail!("bug fixture must fail before model execution");
        }
    }
    let prompt = match case {
        "response" => format!("Reply exactly in the form NONCE:TOTAL, with no spaces, code fences or other text. NONCE is {nonce}. TOTAL is the sum of 3, 7, 11, 28. No tools."),
        "read" => "Use the read tool to read only fixture.json. Reply exactly in the form NONCE:TOTAL, with no spaces, code fences or other text. NONCE is the file's nonce and TOTAL is the sum of its numbers. Do not write, delegate, or read any other file.".to_string(),
        _ => "Read src/lib.rs and fix sum_inclusive so it returns the sum of integers 1 through n, inclusive, also correct for n=0. Keep the same function signature and use the inclusive range sum or the arithmetic formula; no other items or comments. Edit only src/lib.rs using file tools. No other files, shell, delegation or network. Return only FIXED when finished.".to_string(),
    };
    let patch_path = run.join("patch.json");
    fs::write(
        &patch_path,
        serde_json::to_vec_pretty(&patch(args, &run, selection, provider_config, case))?,
    )?;
    let mut command = Command::new(if launcher == "rdsh" {
        &args.bin
    } else {
        &args.original
    });
    command
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("LANG", "C.UTF-8")
        .env("TERM", "dumb")
        .env("TMPDIR", run.join("tmp"));
    command
        .args(["headless", "--patch"])
        .arg(&patch_path)
        .args(["--json", &prompt])
        .current_dir(&cwd)
        .env("HOME", &home)
        .env("DSH_HOME", run.join("dsh-home"))
        .env("RDSH_ORIG_BIN", &args.original)
        .env(
            "DSH_PERMISSION_MODE",
            if case == "rust_fix" {
                "workspace-write"
            } else {
                "read-only"
            },
        )
        .env("NODE_COMPILE_CACHE", args.out.join("node-cache"))
        .env_remove("RDSH_DRY_RUN")
        .env_remove("RDSH_PASSTHROUGH")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let start = Instant::now();
    let mut child = command.spawn().context("model launcher failed to start")?;
    let stdout = child.stdout.take().context("missing output pipe")?;
    let (tx, rx) = mpsc::channel();
    let reader = thread::spawn(move || {
        // Output stays in memory. Do not persist raw errors, reasoning or tool payloads.
        for line in BufReader::new(stdout.take(16 * 1024 * 1024)).lines() {
            let Ok(line) = line else {
                break;
            };
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let _ = tx.send((start.elapsed().as_secs_f64(), v));
            }
        }
    });
    let mut events = Vec::new();
    let mut first_committed_text = None;
    let mut response_elapsed = None;
    let (exit, timed_out, shutdown_timeout) = loop {
        for (t, event) in rx.try_iter() {
            if event["type"] == "text" && first_committed_text.is_none() {
                first_committed_text = Some(t);
            }
            if event["type"] == "status" && event["phase"] == "turn_end" {
                response_elapsed = Some(t);
            }
            events.push(event);
        }
        if let Some(status) = child.try_wait()? {
            break (status, false, false);
        }
        if response_elapsed.is_some_and(|t| start.elapsed().as_secs_f64() >= t + 2.0) {
            terminate(&mut child);
            break (child.wait()?, false, true);
        }
        if start.elapsed() >= Duration::from_secs(args.timeout_seconds) {
            terminate(&mut child);
            break (child.wait()?, true, false);
        }
        thread::sleep(Duration::from_millis(20));
    };
    let elapsed = start.elapsed().as_secs_f64();
    let _ = reader.join();
    for (t, event) in rx.try_iter() {
        if event["type"] == "text" && first_committed_text.is_none() {
            first_committed_text = Some(t);
        }
        if event["type"] == "status" && event["phase"] == "turn_end" {
            response_elapsed = Some(t);
        }
        events.push(event);
    }
    let facts = session_facts(&run.join("sessions"), case != "response").unwrap_or_default();
    let route_ok = !facts.routes.is_empty()
        && facts
            .routes
            .iter()
            .all(|(p, m)| p == provider && m == model);
    let effort_ok = facts.headers > 0 && facts.effort_ok;
    let expected_answer = if case == "rust_fix" {
        "FIXED"
    } else {
        &expected
    };
    let answer_ok = accepted(
        &events,
        expected_answer,
        case != "response",
        exit.success() && !timed_out,
    );
    let generated_source_allowed = if case == "rust_fix" {
        Some(safe_arithmetic(&fs::read_to_string(
            cwd.join("src/lib.rs"),
        )?))
    } else {
        None
    };
    let cargo_oracle_passed = if generated_source_allowed == Some(true) {
        Some(cargo_oracle(&cwd, &home, &run)?)
    } else {
        None
    };
    let oracle_ok = if case == "rust_fix" {
        fs::read_to_string(cwd.join("tests/oracle.rs"))? == ORACLE
            && cargo_oracle_passed == Some(true)
    } else {
        fs::read(cwd.join("fixture.json"))?
            == serde_json::to_vec(&json!({"nonce":nonce,"numbers":[3,7,11,28]}))?
    };
    let max_requests = if case == "response" {
        1
    } else if case == "read" {
        2
    } else {
        4
    };
    let model_passed = response_accepted(&events, expected_answer, case != "response")
        && route_ok
        && oracle_ok
        && effort_ok
        && facts.catalog_ok
        && facts.retry_attempts == 0
        && facts.provider_attempts <= max_requests;
    let passed = model_passed && answer_ok && !shutdown_timeout;
    let usage: Vec<Value> = events
        .iter()
        .filter(|v| v["type"] == "status" && v["phase"] == "step_end")
        .filter_map(|v| v.get("usage").cloned())
        .collect();
    let tool_call_count = events.iter().filter(|v| v["type"] == "tool_call").count();
    let step_count = events
        .iter()
        .filter(|v| v["type"] == "status" && v["phase"] == "step_start")
        .count();
    let result = json!({"index":index,"sample":sample,"provider":provider,"model":model,"case":case,"launcher":launcher,
        "configured_reasoning_effort":"high","effort_verified":effort_ok,"elapsed_seconds":elapsed,"first_committed_text_seconds":first_committed_text,
        "passed":passed,"answer_ok":answer_ok,"session_request_routes":facts.routes,"route_ok":route_ok,"oracle_ok":oracle_ok,
        "model_passed":model_passed,"response_elapsed_seconds":response_elapsed,"shutdown_timeout":shutdown_timeout,
        "final_event_count":events.iter().filter(|e|e["type"]=="final").count(),
        "generated_source_allowed":generated_source_allowed,"cargo_oracle_passed":cargo_oracle_passed,
        "exit_code":exit.code(),"timed_out":timed_out,"tool_call_count":tool_call_count,"step_usage":usage,
        "step_count":step_count,"recorded_provider_attempts":facts.provider_attempts,"retry_attempt_events":facts.retry_attempts,
        "tool_catalog_ok":facts.catalog_ok,"configured_retry_limit":0,"max_model_requests":if case == "response" {1} else if case == "read" {2} else {4},
        "failure_class":if generated_source_allowed == Some(false) {Some("unreviewed_generated_source")}
        else if cargo_oracle_passed == Some(false) {Some("cargo_oracle_failed")}
        else if passed {None} else if shutdown_timeout {Some("shutdown_timeout")} else {Some(classify(&events,timed_out))}});
    fs::write(run.join("result.json"), serde_json::to_vec_pretty(&result)?)?;
    cleanup.clean().context("raw model run cleanup failed")?;
    println!(
        "{} {} {} sample={} model_passed={} runtime_passed={} response={:?}s",
        model, case, launcher, sample, model_passed, passed, response_elapsed
    );
    Ok(result)
}

fn fingerprint(path: &Path) -> Result<String> {
    let output = Command::new("shasum")
        .args(["-a", "256"])
        .arg(path)
        .output()?;
    if !output.status.success() {
        bail!("SHA-256 fingerprint failed");
    }
    let text = String::from_utf8(output.stdout)?;
    let hash = text
        .split_whitespace()
        .next()
        .context("missing fingerprint")?;
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("invalid SHA-256 fingerprint");
    }
    Ok(hash.to_owned())
}

fn fingerprint_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn load_catalog(path: &Path) -> Result<(Value, String)> {
    let bytes = fs::read(path).context("catalog read failed")?;
    let catalog = serde_json::from_slice(&bytes).context("catalog JSON parse failed")?;
    Ok((catalog, fingerprint_bytes(&bytes)))
}

fn version(path: &Path) -> Result<String> {
    let output = Command::new(path).arg("--version").output()?;
    if !output.status.success() {
        bail!("version check failed");
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

fn main() -> Result<()> {
    let mut args = Args::parse();
    if !(1..=10).contains(&args.samples) || !(1..=300).contains(&args.timeout_seconds) {
        bail!("samples must be 1..10, timeout 1..300 seconds");
    }
    args.bin = fs::canonicalize(&args.bin)?;
    args.original = fs::canonicalize(&args.original)?;
    args.credentials = fs::canonicalize(&args.credentials)?;
    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()?;
    if !status.status.success() || !status.stdout.is_empty() {
        bail!("commit the benchmark harness and start from a clean checkout");
    }
    if args.out.exists() {
        bail!("output directory already exists; use a new directory");
    }
    let (catalog, catalog_sha256) = load_catalog(&args.catalog)?;
    let selections = [
        ("openai-codex", args.codex_model.as_str()),
        ("anthropic", args.anthropic_model.as_str()),
    ];
    let configs = provider_configs(&catalog, &selections, args.only_provider.as_deref())?;
    private_dir(&args.out)?;
    args.out = fs::canonicalize(&args.out)?;
    let cleanup = RunCleanup(args.out.clone());
    let source = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()?;
    let mut report = json!({"schema":1,"source_commit":String::from_utf8_lossy(&source.stdout).trim(),"samples_per_condition":args.samples,
        "platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,
        "started_unix_seconds":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs(),
        "rdsh_sha256":fingerprint(&args.bin)?,"original_launcher_sha256":fingerprint(&args.original)?,
        "rdsh_version":version(&args.bin)?,"dsh_version":version(&args.original)?,
        "runtime_artifact_sha256":args.runtime_artifact.as_deref().map(fingerprint).transpose()?,
        "measurement":"response from spawn to committed turn_end; process lifetime and normal exit tracked separately; first text is not first token",
        "ordering":"sequential; alternate provider and launcher order every sample; no automatic retries",
        "catalog_sha256":catalog_sha256,
        "catalog_resolution":"exact ID selected from supplied catalog; official installed catalog supplies model metadata without raw SDK compat overrides",
        "codex_sse_enabled":args.codex_sse,
        "authentication":"existing official credential provider; normal OAuth refresh permitted; no credential export",
        "only_case":args.only_case,"only_provider":args.only_provider,
        "runs":[]});
    for sample in 1..=args.samples {
        let order = if sample % 2 == 1 { [0, 1] } else { [1, 0] };
        for p in order {
            let (provider, model) = selections[p];
            if args
                .only_provider
                .as_deref()
                .is_some_and(|filter| filter != provider)
            {
                continue;
            }
            let launchers = if sample % 2 == 1 {
                ["original", "rdsh"]
            } else {
                ["rdsh", "original"]
            };
            for launcher in launchers {
                if args
                    .only_case
                    .as_deref()
                    .is_some_and(|filter| filter != "response")
                {
                    continue;
                }
                let index = report["runs"].as_array().unwrap().len() + 1;
                let result = run_one(
                    &args,
                    index,
                    sample,
                    (provider, model),
                    configs[p]
                        .as_ref()
                        .context("selected provider configuration missing")?,
                    "response",
                    launcher,
                )?;
                report["runs"].as_array_mut().unwrap().push(result);
                fs::write(
                    args.out.join("report.json"),
                    serde_json::to_vec_pretty(&report)?,
                )?;
            }
            for case in ["read", "rust_fix"] {
                if args
                    .only_case
                    .as_deref()
                    .is_some_and(|filter| filter != case)
                {
                    continue;
                }
                let index = report["runs"].as_array().unwrap().len() + 1;
                let result = run_one(
                    &args,
                    index,
                    sample,
                    (provider, model),
                    configs[p]
                        .as_ref()
                        .context("selected provider configuration missing")?,
                    case,
                    "rdsh",
                )?;
                report["runs"].as_array_mut().unwrap().push(result);
                fs::write(
                    args.out.join("report.json"),
                    serde_json::to_vec_pretty(&report)?,
                )?;
            }
        }
    }
    let runs = report["runs"].as_array().unwrap();
    let summaries = summarize_runs(runs, &selections, args.only_provider.as_deref());
    let all_ok = runs.iter().all(|v| v["passed"] == true);
    let all_model_ok = runs.iter().all(|v| v["model_passed"] == true);
    report["summaries"] = json!(summaries);
    report["all_passed"] = json!(all_ok);
    report["all_model_passed"] = json!(all_model_ok);
    fs::write(
        args.out.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    cleanup
        .clean()
        .context("shared compile cache cleanup failed")?;
    if !all_ok {
        bail!("some real-provider tests failed; inspect sanitized report.json");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn summaries_separate_providers_with_the_same_model_id_and_respect_selection() {
        let runs = vec![
            json!({"provider":"openai-codex","model":"shared","case":"response","launcher":"rdsh","model_passed":true,"passed":true,"response_elapsed_seconds":2.0}),
            json!({"provider":"anthropic","model":"shared","case":"response","launcher":"rdsh","model_passed":true,"passed":false,"response_elapsed_seconds":8.0}),
        ];
        let selections = [("openai-codex", "shared"), ("anthropic", "shared")];
        let summaries = summarize_runs(&runs, &selections, None);
        let codex = summaries
            .iter()
            .find(|v| {
                v["provider"] == "openai-codex"
                    && v["case"] == "response"
                    && v["launcher"] == "rdsh"
            })
            .unwrap();
        assert_eq!(codex["attempts"], 1);
        assert_eq!(codex["median_success_seconds"], 2.0);
        assert_eq!(codex["runtime_passed"], 1);
        let only = summarize_runs(&runs, &selections, Some("anthropic"));
        assert_eq!(only.len(), 4);
        assert!(only.iter().all(|v| v["provider"] == "anthropic"));
        assert_eq!(only[1]["median_success_seconds"], 8.0);
        assert_eq!(only[1]["runtime_passed"], 0);
    }

    #[test]
    fn codex_sse_is_opt_in_and_preserves_other_provider_options() {
        let base = [
            "benchmark_models",
            "--bin",
            "rdsh",
            "--original",
            "dsh",
            "--credentials",
            "credentials.yaml",
            "--catalog",
            "catalog.json",
            "--out",
            "run",
        ];
        let default = Args::try_parse_from(base).unwrap();
        assert!(!default.codex_sse);
        let selected = Args::try_parse_from(base.into_iter().chain(["--codex-sse"])).unwrap();
        let supplied =
            json!({"models":[{"id":"gpt-6-sol"}],"retryPolicy":{"mode":"normal","maxRetries":0}});
        let profile = |args: &Args, provider| {
            patch(
                args,
                Path::new("run"),
                (provider, "gpt-6-sol"),
                &supplied,
                "response",
            )
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "llm-pi-ai")
            .unwrap()["config"]["providers"][provider]
                .clone()
        };
        assert_eq!(profile(&default, "openai-codex"), supplied);
        let mut expected = supplied.clone();
        expected["transport"] = json!("sse");
        expected["cacheRetention"] = json!("none");
        assert_eq!(profile(&selected, "openai-codex"), expected);
        assert_eq!(profile(&selected, "anthropic"), supplied);
    }

    #[test]
    fn model_selection_is_explicit_and_preserves_defaults() {
        let base = [
            "benchmark_models",
            "--bin",
            "rdsh",
            "--original",
            "dsh",
            "--credentials",
            "credentials.yaml",
            "--catalog",
            "catalog.json",
            "--out",
            "run",
        ];
        let custom = Args::try_parse_from(base.into_iter().chain([
            "--codex-model",
            "gpt-6-astra",
            "--anthropic-model",
            "claude-opus-5-5",
            "--only-provider",
            "openai-codex",
        ]));
        let custom = custom.unwrap();
        assert_eq!(custom.codex_model, "gpt-6-astra");
        assert_eq!(custom.anthropic_model, "claude-opus-5-5");
        let defaults = Args::try_parse_from(base).unwrap();
        assert_eq!(defaults.codex_model, "gpt-6.1-sol");
        assert_eq!(defaults.anthropic_model, "claude-sonnet-5-5");
    }

    #[test]
    fn model_ids_cannot_escape_the_run_directory() {
        for model in [
            "../../outside",
            "",
            "../outside",
            "model/name",
            "model\\name",
            "a\nsecret",
            ".",
            "..",
        ] {
            let parsed = Args::try_parse_from([
                "benchmark_models",
                "--bin",
                "rdsh",
                "--original",
                "dsh",
                "--credentials",
                "credentials.yaml",
                "--catalog",
                "catalog.json",
                "--out",
                "run",
                "--codex-model",
                model,
            ]);
            assert!(parsed.is_err(), "unsafe model ID accepted");
        }
    }
    #[test]
    fn only_selected_provider_is_required_and_unknown_models_never_fallback() {
        let catalog =
            json!({"openai-codex":{"models":[{"id":"gpt-6-astra","compat":{"test":true}}]}});
        let selections = [("openai-codex", "gpt-6-astra"), ("anthropic", "missing")];
        let result = provider_configs(&catalog, &selections, Some("openai-codex")).unwrap();
        assert!(result[1].is_none());
        assert_eq!(
            result[0].as_ref().unwrap()["models"][0],
            json!({"id":"gpt-6-astra"})
        );
        assert_eq!(result[0].as_ref().unwrap()["retryPolicy"]["maxRetries"], 0);
        let missing_provider = provider_configs(&catalog, &selections, None).unwrap_err();
        assert!(missing_provider
            .to_string()
            .contains("catalog provider anthropic missing for model missing"));
        let missing_model = provider_configs(
            &catalog,
            &[("openai-codex", "absent")],
            Some("openai-codex"),
        )
        .unwrap_err();
        assert!(missing_model
            .to_string()
            .contains("requested model absent missing from catalog provider openai-codex"));
        let missing_models = provider_configs(
            &json!({"openai-codex": {}}),
            &[("openai-codex", "absent")],
            Some("openai-codex"),
        )
        .unwrap_err();
        assert!(missing_models
            .to_string()
            .contains("catalog models missing for provider openai-codex and model absent"));
    }

    #[test]
    fn catalog_fingerprint_is_bound_to_the_same_bytes_that_were_parsed() {
        let path = std::env::temp_dir().join(format!(
            "rdsh-benchmark-catalog-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let first = br#"{"openai-codex":{"models":[{"id":"gpt-6-astra"}]}}"#;
        let replacement = br#"{"openai-codex":{"models":[{"id":"changed"}]}}"#;
        fs::write(&path, first).unwrap();
        let (_, digest) = load_catalog(&path).unwrap();
        fs::write(&path, replacement).unwrap();
        assert_eq!(
            digest,
            "fc078d53d4da3d94215b1f6b4d1c4e82783adb305fc02c53611d3281b1b36a0b"
        );
        assert_ne!(digest, fingerprint_bytes(&fs::read(&path).unwrap()));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn tool_runs_require_a_nonempty_valid_catalog() {
        assert!(valid_tool_catalog(
            &json!({"tools":[{"name":"read"},{"name":"edit"},{"name":"write"}]}),
            true
        ));
        assert!(!valid_tool_catalog(&json!({}), true));
        assert!(valid_tool_catalog(&json!({}), false));
        assert!(!valid_tool_catalog(&json!({"tools":[]}), true));
        assert!(!valid_tool_catalog(&json!({"tools":null}), false));
        assert!(!valid_tool_catalog(
            &json!({"tools":[{"name":"read_image"}]}),
            true
        ));
        assert!(!valid_tool_catalog(&json!({"tools":[{}]}), true));
    }

    #[test]
    fn completed_model_answer_does_not_hide_a_missing_final_or_failed_exit() {
        let mut events = good();
        events.pop();
        events.push(json!({"type":"text","text":"nonce:49"}));
        assert!(response_accepted(&events, "nonce:49", true));
        assert!(!accepted(&events, "nonce:49", true, true));
        assert!(!accepted(&good(), "nonce:49", true, false));
        events.push(json!({"type":"text","text":"wrong"}));
        assert!(!response_accepted(&events, "nonce:49", true));
    }

    #[test]
    fn never_executes_arbitrary_generated_rust() {
        assert!(safe_arithmetic(
            "pub fn sum_inclusive(n: u64) -> u64 { (1..=n).sum() }"
        ));
        assert!(!safe_arithmetic(BUG));
        assert!(!safe_arithmetic(
            "pub fn sum_inclusive(n:u64)->u64{std::process::exit(0)}"
        ));
        assert!(!safe_arithmetic("include!(\"/tmp/other.rs\");"));
    }

    #[test]
    fn quantiles_use_nearest_rank_and_empty_results_stay_missing() {
        assert_eq!(percentile(&[], 0.95), None);
        assert_eq!(percentile(&[3., 1., 2.], 0.5), Some(2.));
        let v: Vec<f64> = (1..=20).map(f64::from).collect();
        assert_eq!(percentile(&v, 0.95), Some(19.));
    }

    fn good() -> Vec<Value> {
        vec![
            json!({"type":"tool_call","tool":"read","callId":"1"}),
            json!({"type":"tool_result","callId":"1","status":"completed"}),
            json!({"type":"status","phase":"turn_end","reason":{"kind":"completed"}}),
            json!({"type":"final","text":"nonce:49"}),
        ]
    }

    #[test]
    fn requires_completed_turn_exact_answer_and_successful_tool() {
        assert!(accepted(&good(), "nonce:49", true, true));
        assert!(!accepted(&good(), "nonce:48", true, true));
        assert!(!accepted(&good(), "nonce:49", true, false));
        let mut v = good();
        v[2]["reason"]["kind"] = json!("error");
        assert!(!accepted(&v, "nonce:49", true, true));
        v = good();
        v[1]["status"] = json!("error");
        assert!(!accepted(&v, "nonce:49", true, true));
        v = good();
        v[1]["callId"] = json!("unrelated");
        assert!(!accepted(&v, "nonce:49", true, true));
        assert!(!accepted(
            &[json!({"type":"final","text":"nonce:49"})],
            "nonce:49",
            false,
            true
        ));
    }
}
