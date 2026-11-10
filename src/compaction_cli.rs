//! Read-only metadata reporting and the JSON cost bridge used by the DSH plugin.
use anyhow::{bail, Result};
use clap::Subcommand;
use native_compaction::{break_even, CostInput, Prices};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;

#[derive(Debug, Subcommand)]
pub enum Action {
    /// Read a DSH JSONL log; emit hashes/counts only, never transcript bodies.
    Report { file: String },
    /// Evaluate early compaction economics. A dash reads JSON from stdin.
    Decide {
        #[arg(long)]
        input_file: String,
    },
    /// Describe the implemented DSH capabilities without contacting providers.
    Capabilities,
}

fn read(path: &str, limit: u64) -> Result<String> {
    let reader: Box<dyn Read> = if path == "-" {
        Box::new(std::io::stdin())
    } else {
        Box::new(
            std::fs::File::open(path)
                .map_err(|_| anyhow::anyhow!("cannot read compaction input"))?,
        )
    };
    let mut text = String::new();
    reader
        .take(limit + 1)
        .read_to_string(&mut text)
        .map_err(|_| anyhow::anyhow!("invalid compaction input"))?;
    if text.len() as u64 > limit {
        bail!("compaction input exceeds size limit");
    }
    Ok(text)
}

pub fn decide(value: &Value) -> Result<Value> {
    let count = |key: &str| {
        value[key]
            .as_u64()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or_else(|| anyhow::anyhow!("invalid compaction token count"))
    };
    let price = |key: &str| {
        value["prices"][key]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
            .ok_or_else(|| anyhow::anyhow!("invalid compaction price"))
    };
    let expected = value["expected_turns"]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .ok_or_else(|| anyhow::anyhow!("invalid expected_turns"))?;
    let economics = break_even(
        CostInput {
            prefix: count("prefix")?,
            replaced: count("replaced")?,
            summary: count("summary")?,
            tail: count("tail")?,
            instruction: count("instruction")?,
            summarizer_reuses_prefix: value["summarizer_reuses_prefix"]
                .as_bool()
                .ok_or_else(|| anyhow::anyhow!("invalid cache reuse flag"))?,
        },
        Prices {
            input: price("input")?,
            output: price("output")?,
            cache_read: price("cache_read")?,
            cache_write: price("cache_write")?,
        },
    );
    if !economics.one_time_cost.is_finite() || !economics.saving_per_turn.is_finite() {
        bail!("compaction cost overflow");
    }
    let should_compact = count("current")? >= count("trigger")?
        || economics
            .turns
            .is_some_and(|n| n.is_finite() && n <= expected && economics.saving_per_turn > 0.0);
    Ok(
        json!({"compact":should_compact,"one_time_cost":economics.one_time_cost,
        "saving_per_turn":economics.saving_per_turn,"break_even_turns":economics.turns}),
    )
}

pub fn report(text: &str) -> Result<Value> {
    let mut records: BTreeMap<String, Value> = BTreeMap::new();
    let mut prunes = 0u64;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        if line.len() > 8 * 1024 * 1024 {
            bail!("compaction log event exceeds size limit");
        }
        let event: Value =
            serde_json::from_str(line).map_err(|_| anyhow::anyhow!("invalid session JSONL"))?;
        let kind = event["type"].as_str().unwrap_or_default();
        if kind == "compaction/prune" {
            prunes += 1;
        }
        if !["compaction/start", "compaction/summary", "compaction/end"].contains(&kind) {
            continue;
        }
        let data = &event["data"];
        let id = data["compactionId"]
            .as_str()
            .filter(|s| s.len() <= 200)
            .ok_or_else(|| anyhow::anyhow!("invalid compaction event ID"))?;
        let record = records.entry(id.to_owned()).or_insert_with(
            || json!({"id":id,"started":false,"summarized":false,"ended":false,"failed":false}),
        );
        match kind {
            "compaction/start" => record["started"] = json!(true),
            "compaction/end" => {
                record["ended"] = json!(true);
                record["failed"] = json!(data.get("error").is_some_and(|e| !e.is_null()));
            }
            "compaction/summary" => {
                record["summarized"] = json!(true);
                let summary = serde_json::to_vec(&data["summary"])?;
                record["summary_sha256"] = json!(Sha256::digest(&summary)
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>());
                record["summary_bytes"] = json!(summary.len());
                record["replaced_messages"] = json!(data["shadowedSeqs"].as_array().map(Vec::len));
                record["replaced_tokens"] = json!(data["shadowedTokenCount"].as_u64());
                let mut usage = serde_json::Map::new();
                for key in [
                    "inputTokens",
                    "outputTokens",
                    "cacheReadTokens",
                    "cacheWriteTokens",
                ] {
                    if let Some(n) = data["usage"][key].as_u64() {
                        usage.insert(key.into(), json!(n));
                    }
                }
                record["usage"] = Value::Object(usage);
            }
            _ => unreachable!(),
        }
    }
    let mut rows: Vec<_> = records.into_values().collect();
    for row in &mut rows {
        row["completed"] = json!(
            row["started"] == true
                && row["summarized"] == true
                && row["ended"] == true
                && row["failed"] == false
        );
    }
    Ok(json!({"schema":1,"count":rows.len(),"prune_events":prunes,"compactions":rows}))
}

pub fn capabilities() -> Value {
    json!({"default_method":"dsh_summary","methods":["dsh_summary","off"],
        "triggers":["threshold","manual","after_overflow","explicit_range"],
        "unsupported":["provider_native","background","pause_after","model_tool"],
        "retention":"not_guaranteed","source_url":"https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/compaction.md",
        "checked_at":"2026-11-10","backend":"@deepseek-ai/dsh-compaction-basic@0.2.1-rc.2"})
}

pub fn run(action: Action) -> Result<()> {
    let result = match action {
        Action::Report { file } => report(&read(&file, 64 * 1024 * 1024)?)?,
        Action::Decide { input_file } => decide(
            &serde_json::from_str(&read(&input_file, 64 * 1024)?)
                .map_err(|_| anyhow::anyhow!("invalid compaction input JSON"))?,
        )?,
        Action::Capabilities => capabilities(),
    };
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
