//! Bounded child reasoning loop sharing the parent's workspace and execution
//! gates. The loop itself is `engine::run_loop`; this module only supplies the
//! child's parameters and shapes its single `model_call` result.
use super::engine::{Engine, LoopSpec};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::time::Duration;

const CHILD_STEPS: usize = 8;
const CHILD_TIMEOUT: Duration = Duration::from_secs(600);

pub(super) async fn execute(
    engine: &Engine,
    run_id: u64,
    provider: &str,
    model: &str,
    prompt: &str,
) -> Result<Value> {
    execute_with_timeout(engine, run_id, provider, model, prompt, CHILD_TIMEOUT).await
}

pub(super) async fn execute_with_timeout(
    engine: &Engine,
    run_id: u64,
    provider: &str,
    model: &str,
    prompt: &str,
    timeout: Duration,
) -> Result<Value> {
    engine.with_current_run(run_id, || Ok(()))?;
    if !engine.model_allowed(provider, model) {
        bail!("NATIVE_MODEL_UNAVAILABLE");
    }
    let child = child_loop(engine, run_id, provider, model, prompt);
    match tokio::time::timeout(timeout, child).await {
        Ok(Ok(value)) => Ok(value),
        outcome => {
            // Any dropped approval future cleans only its own request via PendingGuard.
            engine.with_current_run(run_id, || Ok(()))?;
            let error = match outcome {
                Ok(Err(error)) => engine.redact(&error.to_string()),
                _ => "MODEL_CALL_TIMEOUT".into(),
            };
            Ok(json!({"provider":provider,"model":model,"error":error,
                "executed":true,"completed":false}))
        }
    }
}

async fn child_loop(
    engine: &Engine,
    run_id: u64,
    provider: &str,
    model: &str,
    prompt: &str,
) -> Result<Value> {
    let spec = LoopSpec::child(engine, run_id, provider, model, prompt, CHILD_STEPS);
    // Boxed: the parent conversation reaches this loop back through
    // `model_call`, so the child loop must not grow the recursive future type.
    let outcome = Box::pin(engine.run_loop(spec)).await?;
    Ok(
        json!({"provider":provider,"model":model,"text":outcome.text,
        "executed":true,"completed":!outcome.failed,
        "failedToolCalls":outcome.failed,"steps":outcome.steps,
        "toolCalls":outcome.calls}),
    )
}
