//! Backend contract shared by the full-screen UI and harness implementations.
use super::super::{dispatch, engine::Engine, usage::UsageStats};
use anyhow::{bail, Result};
use serde_json::Value;
use std::sync::Arc;
use tokio::runtime::Runtime;

pub(crate) trait HarnessBackend {
    fn snapshot(&self) -> Value;
    fn request(&self, path: &str, body: Value) -> Result<Value>;
    fn cancel(&self);
    fn reset(&self) -> Result<()>;
    fn redact(&self, value: &str) -> String;
}

pub(super) struct NativeBackend {
    engine: Arc<Engine>,
    runtime: Arc<Runtime>,
}

impl NativeBackend {
    pub(super) fn new(engine: Arc<Engine>, runtime: Arc<Runtime>) -> Self {
        Self { engine, runtime }
    }
}

impl HarnessBackend for NativeBackend {
    fn snapshot(&self) -> Value {
        self.engine.snapshot()
    }

    fn request(&self, path: &str, body: Value) -> Result<Value> {
        dispatch(
            "POST",
            path,
            &body.to_string(),
            self.engine.clone(),
            self.runtime.clone(),
        )
    }

    fn cancel(&self) {
        self.engine.cancel();
    }

    fn reset(&self) -> Result<()> {
        let mut state = self.engine.state.lock().unwrap();
        if matches!(state.status.as_str(), "running" | "approval") {
            bail!("実行中は新しい会話を開始できません");
        }
        state.run_id += 1;
        state.usage = UsageStats::default();
        state.messages.clear();
        state.events.clear();
        state.error = None;
        state.status = "idle".into();
        Ok(())
    }

    fn redact(&self, value: &str) -> String {
        self.engine.redact(value)
    }
}
