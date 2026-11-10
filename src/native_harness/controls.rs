//! Conversation-scoped controls. Native read permissions remain one-shot.
use super::engine::{Engine, Event};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    #[default]
    Normal,
    Plan,
}
#[derive(Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Permission {
    #[default]
    Ask,
    ReadOnly,
}
#[derive(Default)]
pub struct Settings {
    pub mode: Mode,
    pub permission: Permission,
}
impl Settings {
    pub fn snapshot(&self) -> Value {
        json!({"mode":self.mode,"planPending":false,"permission":self.permission,
            "modes":[{"id":"normal","name":"通常","description":"ツールは一回ずつ承認します"},
                {"id":"plan","name":"計画","description":"調査と計画のみ。Devinの実行を禁止します"}],
            "permissions":[{"id":"ask","name":"毎回確認","description":"すべてのツールを一回ずつ承認します"},
                {"id":"read-only","name":"読み取り専用","description":"Devinを禁止し、readとmodel_callは毎回確認します"}]})
    }
    pub fn allows(&self, tool: &str) -> bool {
        !matches!(tool, "devin_cli" | "devin_permission")
            || (self.mode == Mode::Normal && self.permission == Permission::Ask)
    }
    pub fn prompt(&self) -> &'static str {
        if self.mode == Mode::Plan {
            "Plan mode is active. Investigate and explain a plan only. Never propose devin_cli or an action that changes the workspace. read and model_call still require approval. "
        } else if self.permission == Permission::ReadOnly {
            "Read-only permission is active. Never propose devin_cli or an action that changes the workspace. read and model_call still require approval. "
        } else {
            "Normal mode with ask permission is active. Every tool still requires one-shot user approval. "
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModeRequest {
    mode: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PermissionRequest {
    preset: String,
    confirmed: bool,
}

pub(super) fn request(engine: &Engine, path: &str, body: Value) -> Result<Value> {
    let mut state = engine.state.lock().unwrap();
    if path == "/api/controls" {
        return Ok(state.controls.snapshot());
    }
    if matches!(state.status.as_str(), "running" | "approval") {
        bail!("実行中はモード・パーミッションを変更できません");
    }
    match path {
        "/api/mode" => {
            let req: ModeRequest = serde_json::from_value(body)
                .map_err(|_| anyhow::anyhow!("モード指定が不正です"))?;
            state.controls.mode = match req.mode.as_str() {
                "normal" | "act" => Mode::Normal,
                "plan" => Mode::Plan,
                _ => bail!("モードはnormalまたはplanを指定してください"),
            };
        }
        "/api/permission" => {
            let req: PermissionRequest = serde_json::from_value(body)
                .map_err(|_| anyhow::anyhow!("パーミッション指定が不正です"))?;
            if !req.confirmed {
                bail!("パーミッション変更には確認が必要です");
            }
            state.controls.permission = match req.preset.as_str() {
                "ask" => Permission::Ask,
                "read-only" => Permission::ReadOnly,
                _ => bail!("パーミッションはaskまたはread-onlyを指定してください"),
            };
        }
        _ => bail!("未対応の制御です"),
    }
    let value = state.controls.snapshot();
    state.events.push(Event {
        kind: "controls".into(),
        name: "select".into(),
        content: format!(
            "モード: {} / パーミッション: {}",
            value["mode"], value["permission"]
        ),
    });
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_harness::{
        engine::{Call, State},
        profiles, sdk,
    };
    use std::sync::{Arc, Mutex};
    fn engine() -> Arc<Engine> {
        Arc::new(Engine {
            state: Mutex::new(State::default()),
            workspace: std::env::temp_dir(),
            sdk: sdk::SdkConfig {
                bridge_dir: std::env::temp_dir(),
                agy_key: None,
            },
            devin: "/no-devin".into(),
            secrets: vec![],
            registry: profiles::Registry::default(),
        })
    }
    #[test]
    fn settings_validate_confirmation_and_refuse_changes_during_work() {
        let e = engine();
        assert_eq!(
            request(&e, "/api/mode", json!({"mode":"plan"})).unwrap()["mode"],
            "plan"
        );
        assert!(request(
            &e,
            "/api/permission",
            json!({"preset":"read-only","confirmed":false})
        )
        .is_err());
        assert_eq!(e.snapshot()["controls"]["permission"], "ask");
        assert!(request(
            &e,
            "/api/permission",
            json!({"preset":"auto","confirmed":true})
        )
        .is_err());
        request(
            &e,
            "/api/permission",
            json!({"preset":"read-only","confirmed":true}),
        )
        .unwrap();
        for status in ["running", "approval"] {
            e.state.lock().unwrap().status = status.into();
            assert!(request(&e, "/api/mode", json!({"mode":"normal"})).is_err());
            assert!(request(
                &e,
                "/api/permission",
                json!({"preset":"ask","confirmed":true})
            )
            .is_err());
        }
        assert_eq!(e.snapshot()["controls"]["mode"], "plan");
        assert_eq!(e.snapshot()["controls"]["permission"], "read-only");
    }
    #[tokio::test]
    async fn plan_and_readonly_deny_devin_before_approval_or_process_start() {
        for plan in [true, false] {
            let e = engine();
            {
                let mut s = e.state.lock().unwrap();
                s.run_id = 1;
                s.status = "running".into();
                if plan {
                    s.controls.mode = Mode::Plan;
                } else {
                    s.controls.permission = Permission::ReadOnly;
                }
            }
            let call = Call {
                id: "blocked".into(),
                name: "devin_cli".into(),
                arguments: json!({"prompt":"must not run"}),
            };
            assert!(!e.permission(1, &call).await.unwrap());
            let s = e.state.lock().unwrap();
            assert!(s.pending.is_none());
            assert!(s.decision.is_none());
            assert_eq!(s.status, "running");
            assert_eq!(s.events.last().unwrap().kind, "policy");
        }
    }
    #[tokio::test]
    async fn plan_reads_still_wait_for_explicit_one_shot_approval() {
        let e = engine();
        {
            let mut s = e.state.lock().unwrap();
            s.run_id = 1;
            s.status = "running".into();
            s.controls.mode = Mode::Plan;
        }
        let next = e.clone();
        let task = tokio::spawn(async move {
            next.permission(
                1,
                &Call {
                    id: "read".into(),
                    name: "read".into(),
                    arguments: json!({"path":"file.txt"}),
                },
            )
            .await
        });
        let id = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if let Some(id) = e
                    .state
                    .lock()
                    .unwrap()
                    .pending
                    .as_ref()
                    .map(|p| p.id.clone())
                {
                    break id;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!task.is_finished());
        e.approve(&id, false).unwrap();
        assert!(!task.await.unwrap().unwrap());
    }
}
