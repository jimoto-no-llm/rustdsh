//! Process-local controls. Full access is explicitly selected, never the default.
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
    FullAccess,
}
#[derive(Default)]
pub struct Settings {
    pub mode: Mode,
    pub permission: Permission,
}
impl Settings {
    pub fn snapshot(&self) -> Value {
        json!({"mode":self.mode,"planPending":false,"permission":self.permission,
            "modes":[{"id":"normal","name":"通常","description":"選択したパーミッションでツールを実行します"},
                {"id":"plan","name":"計画","description":"調査と計画のみ。Devinの実行を禁止します"}],
            "permissions":[{"id":"ask","name":"毎回確認","description":"すべてのツールを一回ずつ承認します"},
                {"id":"read-only","name":"読み取り専用","description":"Devinを禁止し、readとmodel_callは毎回確認します"},
                {"id":"full-access","name":"フルアクセス","description":"通常モードでは全ツールとDevin内部の操作を自動承認します。ファイル内容のモデル送信、別モデルへの依頼、Devinによるコマンド実行・ファイル変更・ネットワークアクセスが個別確認なしで行われます。Plan中はDevin禁止・readとmodel_callの毎回確認を維持します。readの対象制限とOSの権限は変わりません。現在のプロセス終了まで有効です"}]})
    }
    pub fn allows(&self, tool: &str) -> bool {
        !matches!(tool, "devin_cli" | "devin_permission")
            || (self.mode == Mode::Normal && self.permission != Permission::ReadOnly)
    }
    pub fn auto_approves(&self, tool: &str) -> bool {
        self.mode == Mode::Normal
            && self.permission == Permission::FullAccess
            && matches!(
                tool,
                "read" | "model_call" | "devin_cli" | "devin_permission"
            )
    }
    pub fn prompt(&self) -> &'static str {
        if self.mode == Mode::Plan {
            "Plan mode is active. Investigate and explain a plan only. Never propose devin_cli or an action that changes the workspace. read and model_call still require approval. "
        } else if self.permission == Permission::ReadOnly {
            "Read-only permission is active. Never propose devin_cli or an action that changes the workspace. read and model_call still require approval. "
        } else if self.permission == Permission::FullAccess {
            "Normal mode with full-access permission is active. Rust automatically approves read, model_call, devin_cli and Devin's internal permission requests. Propose the tools needed to fulfill the user's request without asking for per-tool approval. Rust still validates all calls and enforces read boundaries, cancellation and limits. Never claim execution without a Rust tool result. "
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
                "full-access" => Permission::FullAccess,
                _ => bail!("パーミッションはask、read-only、full-accessを指定してください"),
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
    fn full_access_is_explicit_and_cannot_change_during_a_run() {
        let e = engine();
        assert_eq!(e.snapshot()["controls"]["permission"], "ask");
        assert!(
            request(&e, "/api/controls", json!({})).unwrap()["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["id"] == "full-access")
        );
        for body in [
            json!({"preset":"full-access"}),
            json!({"preset":"full-access","confirmed":false}),
        ] {
            assert!(request(&e, "/api/permission", body).is_err());
            assert_eq!(e.snapshot()["controls"]["permission"], "ask");
        }
        for status in ["running", "approval"] {
            e.state.lock().unwrap().status = status.into();
            assert!(request(
                &e,
                "/api/permission",
                json!({"preset":"full-access","confirmed":true})
            )
            .is_err());
        }
        e.state.lock().unwrap().status = "idle".into();
        request(
            &e,
            "/api/permission",
            json!({"preset":"full-access","confirmed":true}),
        )
        .unwrap();
        assert_eq!(e.snapshot()["controls"]["permission"], "full-access");
        request(
            &e,
            "/api/permission",
            json!({"preset":"ask","confirmed":true}),
        )
        .unwrap();
        assert_eq!(e.snapshot()["controls"]["permission"], "ask");
    }
    #[tokio::test]
    async fn full_access_auto_approves_known_tools_and_records_redacted_events() {
        let mut e = engine();
        Arc::get_mut(&mut e)
            .unwrap()
            .secrets
            .push("fixture-secret".into());
        {
            let mut s = e.state.lock().unwrap();
            s.run_id = 1;
            s.status = "running".into();
            s.controls.permission = Permission::FullAccess;
            assert!(!s.controls.auto_approves("unknown_tool"));
        }
        for name in ["read", "model_call", "devin_cli", "devin_permission"] {
            for _ in 0..2 {
                assert!(tokio::time::timeout(
                    std::time::Duration::from_secs(1),
                    e.permission(
                        1,
                        &Call {
                            id: "auto".into(),
                            name: name.into(),
                            arguments: json!({"value":"fixture-secret"}),
                        }
                    )
                )
                .await
                .unwrap()
                .unwrap());
            }
        }
        let snapshot = e.snapshot();
        assert_eq!(snapshot["status"], "running");
        assert_eq!(snapshot["pending"], Value::Null);
        assert!(e.state.lock().unwrap().decision.is_none());
        let events = snapshot["events"].as_array().unwrap();
        assert_eq!(events.len(), 8);
        assert!(events.iter().all(|v| v["name"] == "auto_allow"));
        assert!(snapshot.to_string().contains("[REDACTED]"));
        assert!(!snapshot.to_string().contains("fixture-secret"));
        e.cancel();
        assert!(e
            .permission(
                1,
                &Call {
                    id: "stale".into(),
                    name: "read".into(),
                    arguments: json!({"path":"file.txt"})
                }
            )
            .await
            .is_err());
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
        for (mode, permission) in [
            (Mode::Plan, Permission::Ask),
            (Mode::Plan, Permission::FullAccess),
            (Mode::Normal, Permission::ReadOnly),
        ] {
            let e = engine();
            {
                let mut s = e.state.lock().unwrap();
                s.run_id = 1;
                s.status = "running".into();
                s.controls.mode = mode;
                s.controls.permission = permission;
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
            s.controls.permission = Permission::FullAccess;
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
