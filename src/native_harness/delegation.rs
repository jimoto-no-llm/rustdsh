//! Bounded child reasoning loop sharing the parent's workspace and execution gates.
use super::{
    engine::{build_prompt, parse_turn, Engine, Message, MAX_HISTORY},
    tools,
};
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
    match tokio::time::timeout(timeout, child_loop(engine, run_id, provider, model, prompt)).await {
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
    let mut history = vec![Message {
        role: "user".into(),
        content: engine.redact(prompt),
    }];
    let mut results = Vec::new();
    let mut failed = false;
    for step in 0..CHILD_STEPS {
        engine.with_current_run(run_id, || Ok(()))?;
        let encoded = serde_json::to_string(&history)?;
        if encoded.len() > MAX_HISTORY {
            bail!("MODEL_CALL_HISTORY_LIMIT");
        }
        let mut request = build_prompt(&encoded);
        let controls = engine.state.lock().unwrap().controls.prompt();
        request.insert_str(0, controls);
        request.insert_str(0, &engine.redact(&format!(
            "You are a delegated child model. Current workspace (JSON): {}. You may propose read, write and devin_cli only. Nested model_call is unavailable. Execute the delegated task using these tools when needed, then return the final answer in text with toolCalls:[]. You only see your delegated request and your own tool results; parent conversation is not available. ", json!(engine.workspace))));
        engine.event(
            run_id,
            "delegate",
            provider,
            &format!("Child step {} → {model}", step + 1),
        )?;
        let mut turn = None;
        for attempt in 0..2 {
            let generation = engine
                .generate_turn(run_id, provider, model, &request)
                .await?;
            let parsed = parse_turn(&generation.text).and_then(|value| {
                for call in &value.tool_calls {
                    if !matches!(call.name.as_str(), "read" | "write" | "devin_cli") {
                        bail!("MODEL_CALL_RECURSION_DISABLED");
                    }
                    tools::validate_target(engine, call)?;
                }
                Ok(value)
            });
            match parsed {
                Ok(value) => { turn = Some(value); break; }
                Err(error) if attempt == 0 => request.push_str(&format!(
                    "\nPrevious output failed validation: {}. Return the declared JSON object with only read, write or devin_cli. No tool from the rejected batch ran.", engine.redact(&error.to_string()))),
                Err(_) => bail!("MODEL_CALL_INVALID_TURN"),
            }
        }
        let turn = turn.ok_or_else(|| anyhow::anyhow!("MODEL_CALL_INVALID_TURN"))?;
        if !turn.text.is_empty() {
            history.push(Message {
                role: "assistant".into(),
                content: engine.redact(&turn.text),
            });
        }
        if turn.tool_calls.is_empty() {
            return Ok(
                json!({"provider":provider,"model":model,"text":engine.redact(&turn.text),
                "executed":true,"completed":!failed,"failedToolCalls":failed,
                "steps":step+1,"toolCalls":results}),
            );
        }
        history.push(Message {
            role: "assistant_tool_proposals".into(),
            content: engine.redact(&serde_json::to_string(&turn.tool_calls)?),
        });
        for call in turn.tool_calls {
            engine.event(
                run_id,
                "delegate_tool",
                &call.name,
                &format!(
                    "{provider} / {model}: {}",
                    serde_json::to_string(&call.arguments)?
                ),
            )?;
            let allowed = engine.permission(run_id, &call).await?;
            let result = if allowed {
                // Boxing breaks the compile-time cycle; validation above forbids recursive delegation.
                Box::pin(tools::execute(engine, run_id, &call)).await
            } else {
                let policy_denied = !engine.state.lock().unwrap().controls.allows(&call.name);
                Ok(
                    json!({"error":if policy_denied {"POLICY_DENIED"}else{"USER_DENIED"},"executed":false}),
                )
            };
            engine.with_current_run(run_id, || Ok(()))?;
            let mut result = match result {
                Ok(value) => value,
                Err(error) => json!({"error":engine.redact(&error.to_string()),"executed":false}),
            };
            engine.redact_value(&mut result);
            let succeeded = result["executed"] == true
                && result["completed"] != false
                && result.get("error").is_none_or(Value::is_null);
            failed |= !succeeded;
            results.push(json!({"id":call.id,"name":call.name,"executed":result["executed"],"completed":succeeded}));
            let content = engine.redact(&serde_json::to_string(
                &json!({"toolCallId":call.id,"name":call.name,"result":result}),
            )?);
            engine.event(run_id, "delegate_result", &call.name, &content)?;
            history.push(Message {
                role: "tool".into(),
                content,
            });
        }
    }
    bail!("MODEL_CALL_STEP_LIMIT")
}
