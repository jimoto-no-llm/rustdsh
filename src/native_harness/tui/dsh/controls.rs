//! Public DSH slash-command bridge. No command is submitted as a model prompt.
use super::DshBackend;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

fn safe_preset(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-.:".contains(&c))
}
fn supports(roster: &Value, name: &str) -> Result<bool> {
    let rows = roster.as_array().context("DSHコマンド一覧が不正です")?;
    if rows.len() > 512 || rows.iter().any(|r| !r["name"].is_string()) {
        bail!("DSHコマンド一覧が不正です");
    }
    Ok(rows.iter().any(|r| r["name"] == name))
}
fn permissions(catalog: &Value) -> Result<Vec<Value>> {
    let rows = catalog["options"]
        .as_array()
        .context("DSH権限候補が不正です")?;
    if rows.len() > 128 {
        bail!("DSH権限候補が多すぎます");
    }
    rows.iter()
        .map(|r| {
            let id = r["value"]
                .as_str()
                .filter(|id| safe_preset(id))
                .context("DSH権限候補のIDが不正です")?;
            let description = r["description"]
                .as_str()
                .unwrap_or("DSHの権限プリセットを適用します");
            if description.len() > 4096 || r["name"].as_str().is_some_and(|name| name.len() > 256) {
                bail!("DSH権限候補の説明が長すぎます");
            }
            let description = if id == "auto" {
                format!("全ツールを自動承認する設定です。{description}")
            } else {
                description.to_owned()
            };
            Ok(json!({"id":id,"name":r["name"].as_str().unwrap_or(id),
            "description":description,"selectable":id!="custom"}))
        })
        .collect()
}
fn result(value: Value) -> Result<Value> {
    match value["result"]["kind"].as_str() {
        Some("success") => Ok(json!({"ok":true,"message":value["result"]["text"].as_str()
            .unwrap_or("DSHへ設定を送信しました。状態はホストの確定情報で更新します")})),
        Some("error") => bail!(
            "{}",
            value["result"]["text"]
                .as_str()
                .unwrap_or("DSHがコマンドを拒否しました")
        ),
        _ => bail!("DSHがコマンドを受理しませんでした。モデルへは送信していません"),
    }
}
impl DshBackend {
    pub(super) fn host_commands(&self, line: Option<&str>) -> Result<Value> {
        let roster = self.rpc("commands/list", json!({"agentId":self.session()}))?;
        supports(&roster, "")?;
        if let Some(line) = line {
            self.require_idle()?;
            if !line.starts_with('/') || line.len() > 16384 || line.chars().any(char::is_control) {
                bail!("DSHコマンドが不正です");
            }
            let name = line[1..]
                .split_whitespace()
                .next()
                .context("コマンド名がありません")?;
            if matches!(name, "permission" | "mode" | "plan") {
                bail!("/permission または /mode を使って設定してください");
            }
            if !supports(&roster, name)? {
                bail!("このDSHホストに未登録のコマンドです。モデルへは送信していません");
            }
            let value = result(self.rpc(
                "commands/execute",
                json!({"agentId":self.session(),"line":line,"submittedAttachments":[]}),
            )?)?;
            return Ok(json!({"text":value["message"]}));
        }
        let mut text = String::from(
            "/dsh COMMAND ARGS で実行。権限設定は /permission。管理操作は /manage。\n\n",
        );
        for row in roster.as_array().unwrap() {
            let name = row["name"].as_str().unwrap();
            let description = row["description"].as_str().unwrap_or("");
            if name.len() > 128 || description.len() > 4096 {
                bail!("DSHコマンド説明が上限を超えています");
            }
            text.push_str(&format!("/{name} — {description}\n"));
        }
        Ok(json!({"text":text}))
    }
    fn control_catalog(&self) -> Result<Value> {
        let roster = self.rpc("commands/list", json!({"agentId":self.session()}))?;
        let plan = supports(&roster, "plan")?;
        let permission = supports(&roster, "permission")?;
        let choices = if permission {
            permissions(&self.rpc("permissionPresets/catalog", json!({}))?)?
        } else {
            vec![]
        };
        let mut value = self.view.lock().unwrap().value["controls"].clone();
        if !value.is_object() {
            value = json!({});
        }
        value["modes"] = if plan {
            json!([
            {"id":"normal","name":"通常","description":"DSHの計画モードを解除します"},
            {"id":"plan","name":"計画","description":"DSHの計画モードを選択します"}])
        } else {
            json!([])
        };
        value["permissions"] = json!(choices);
        Ok(value)
    }
    pub(super) fn control_request(&self, path: &str, body: Value) -> Result<Value> {
        if path == "/api/controls" {
            return self.control_catalog();
        }
        self.require_idle()?;
        let catalog = self.control_catalog()?;
        let line = match path {
            "/api/mode" => {
                if body.as_object().is_none_or(|o| o.len() != 1) {
                    bail!("モード指定が不正です");
                }
                let mode = body["mode"].as_str().context("モードがありません")?;
                if !catalog["modes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|r| r["id"] == mode)
                {
                    bail!("このDSH構成では指定した計画モードを利用できません");
                }
                if catalog["mode"] == mode && catalog["planPending"] != true {
                    return Ok(json!({"ok":true,"message":"既に選択中のモードです"}));
                }
                if mode == "plan" {
                    "/plan".to_owned()
                } else {
                    "/plan off".to_owned()
                }
            }
            "/api/permission" => {
                if body.as_object().is_none_or(|o| o.len() != 2) || body["confirmed"] != true {
                    bail!("パーミッション変更には確認が必要です");
                }
                let preset = body["preset"]
                    .as_str()
                    .filter(|id| safe_preset(id))
                    .context("権限IDが不正です")?;
                if !catalog["permissions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|r| r["id"] == preset && r["selectable"] != false)
                {
                    bail!("このDSH構成で選択可能な権限プリセットを指定してください");
                }
                format!("/permission {preset}")
            }
            _ => bail!("未対応の制御です"),
        };
        let value = self.rpc(
            "commands/execute",
            json!({"agentId":self.session(),"line":line,"submittedAttachments":[]}),
        )?;
        result(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_roster_and_permission_ids_are_validated_before_submission() {
        assert!(supports(&json!([{"name":"plan"}]), "plan").unwrap());
        assert!(!supports(&json!([{"name":"other"}]), "plan").unwrap());
        assert!(supports(&json!({"name":"plan"}), "plan").is_err());
        assert!(permissions(&json!({"options":[{"value":"auto\n/plan","name":"bad"}]})).is_err());
        let rows = permissions(
            &json!({"options":[{"value":"custom","name":"Custom"},{"value":"safe","name":"Safe"}]}),
        )
        .unwrap();
        assert_eq!(rows[0]["selectable"], false);
        assert_eq!(rows[1]["id"], "safe");
    }
    #[test]
    fn unhandled_and_failed_host_commands_are_errors_never_prompt_fallbacks() {
        assert!(result(Value::Null).is_err());
        assert!(result(json!({"result":{"kind":"error","text":"blocked"}}))
            .unwrap_err()
            .to_string()
            .contains("blocked"));
        assert_eq!(
            result(json!({"result":{"kind":"success","text":"done"}})).unwrap()["message"],
            "done"
        );
    }
}
