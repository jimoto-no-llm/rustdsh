//! ACP delegation: preserve Devin's permission requests instead of rejecting them in print mode.
use super::engine::{Call, Engine};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};

const FRAME_LIMIT: usize = 1024 * 1024;
const WIRE_LIMIT: usize = 8 * 1024 * 1024;
const TEXT_LIMIT: usize = 64 * 1024;

pub(super) async fn execute(
    engine: &Engine,
    run_id: u64,
    prompt: &str,
    timeout: u64,
) -> Result<Value> {
    let mut command = Command::new(&engine.devin);
    command
        .args(["--permission-mode", "auto", "acp"])
        .current_dir(&engine.workspace)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for name in [
        "HOME",
        "PATH",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "TMP",
        "TEMP",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "SystemRoot",
        "APPDATA",
        "LOCALAPPDATA",
        "USERPROFILE",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    #[cfg(unix)]
    command.process_group(0);
    let mut child = engine.with_current_run(run_id, || {
        command
            .spawn()
            .map_err(|_| anyhow::anyhow!("DEVIN_ACP_SPAWN_FAILED"))
    })?;
    let _group = super::sdk::ProcessGroupGuard(child.id());
    let mut bridge = Bridge {
        input: child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("DEVIN_ACP_PIPE_FAILED"))?,
        output: BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| anyhow::anyhow!("DEVIN_ACP_PIPE_FAILED"))?,
        ),
        engine,
        run_id,
        session: None,
        text: String::new(),
        denied: false,
        failed: false,
        remaining: WIRE_LIMIT,
        calls: std::collections::HashMap::new(),
        pending_permission: None,
    };
    let operation = async {
        let init=bridge.rpc(1,"initialize",json!({"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"rustdsh","version":env!("CARGO_PKG_VERSION")}})).await?;
        if init["protocolVersion"] != 1 {
            bail!("DEVIN_ACP_VERSION_UNSUPPORTED");
        }
        let session = bridge
            .rpc(
                2,
                "session/new",
                json!({"cwd":engine.workspace,"mcpServers":[]}),
            )
            .await?;
        let id = session["sessionId"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() < 1024)
            .ok_or_else(|| anyhow::anyhow!("DEVIN_ACP_SESSION_INVALID"))?;
        bridge.session = Some(id.into());
        let result = bridge
            .rpc(
                3,
                "session/prompt",
                json!({"sessionId":id,"prompt":[{"type":"text","text":prompt}]}),
            )
            .await?;
        let completed = result["stopReason"] == "end_turn"
            && !bridge.denied
            && !bridge.failed
            && !bridge.text.trim().is_empty();
        Ok::<_, anyhow::Error>(
            json!({"exitCode":null,"transport":"acp","stdout":engine.redact(&bridge.text),"stderr":"","processStarted":true,"executed":completed,"completed":completed,"permissionDenied":bridge.denied,"failedToolCalls":bridge.failed,"stopReason":result["stopReason"],"error":if completed {Value::Null} else if bridge.denied {json!("DEVIN_PERMISSION_DENIED")} else {json!("DEVIN_INCOMPLETE")}}),
        )
    };
    let result = match tokio::time::timeout(std::time::Duration::from_secs(timeout), operation)
        .await
    {
        Ok(Ok(value)) => value,
        outcome => {
            let error = match outcome {
                Ok(Err(error)) => engine.redact(&error.to_string()),
                _ => "DEVIN_ACP_TIMEOUT".into(),
            };
            if let Some(id) = bridge.pending_permission.take() {
                let _ = tokio::time::timeout(std::time::Duration::from_millis(100), bridge.write(json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"cancelled"}}}))).await;
            }
            json!({"exitCode":null,"transport":"acp","stdout":engine.redact(&bridge.text),"stderr":"","processStarted":true,"executed":false,"completed":false,"completionUnknown":true,"error":error})
        }
    };
    engine.clear_devin_permission(run_id);
    let _ = child.kill().await;
    let _ = child.wait().await;
    Ok(result)
}

struct Bridge<'a> {
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    engine: &'a Engine,
    run_id: u64,
    session: Option<String>,
    text: String,
    denied: bool,
    failed: bool,
    remaining: usize,
    calls: std::collections::HashMap<String, Value>,
    pending_permission: Option<Value>,
}
impl Bridge<'_> {
    async fn write(&mut self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value)?;
        if bytes.len() > FRAME_LIMIT {
            bail!("DEVIN_ACP_INPUT_LIMIT");
        }
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|_| anyhow::anyhow!("DEVIN_ACP_WRITE_FAILED"))?;
        self.input
            .flush()
            .await
            .map_err(|_| anyhow::anyhow!("DEVIN_ACP_WRITE_FAILED"))
    }
    async fn read(&mut self) -> Result<Value> {
        let mut frame = Vec::new();
        loop {
            let available = self
                .output
                .fill_buf()
                .await
                .map_err(|_| anyhow::anyhow!("DEVIN_ACP_READ_FAILED"))?;
            if available.is_empty() {
                bail!("DEVIN_ACP_EOF");
            }
            let end = available.iter().position(|b| *b == b'\n');
            let count = end.map_or(available.len(), |p| p + 1);
            if count > self.remaining || frame.len().saturating_add(count) > FRAME_LIMIT {
                bail!("DEVIN_ACP_OUTPUT_LIMIT");
            }
            frame.extend_from_slice(&available[..count]);
            self.output.consume(count);
            self.remaining -= count;
            if end.is_some() {
                if frame.iter().all(u8::is_ascii_whitespace) {
                    frame.clear();
                    continue;
                }
                return serde_json::from_slice(&frame)
                    .map_err(|_| anyhow::anyhow!("DEVIN_ACP_INVALID_JSON"));
            }
        }
    }
    async fn rpc(&mut self, id: u64, method: &str, params: Value) -> Result<Value> {
        self.write(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        loop {
            let message = self.read().await?;
            if message["jsonrpc"] != "2.0" {
                bail!("DEVIN_ACP_INVALID_MESSAGE");
            }
            if let Some(method) = message["method"].as_str() {
                if method == "session/request_permission" {
                    self.permission(&message).await?;
                } else if method == "session/update" {
                    if self.session.as_deref() != message["params"]["sessionId"].as_str() {
                        continue;
                    }
                    let update = &message["params"]["update"];
                    if update["sessionUpdate"] == "agent_message_chunk"
                        && update["content"]["type"] == "text"
                    {
                        let text = update["content"]["text"]
                            .as_str()
                            .ok_or_else(|| anyhow::anyhow!("DEVIN_ACP_INVALID_TEXT"))?;
                        if self.text.len().saturating_add(text.len()) > TEXT_LIMIT {
                            bail!("DEVIN_ACP_TEXT_LIMIT");
                        }
                        self.text.push_str(text);
                    }
                    if matches!(
                        update["sessionUpdate"].as_str(),
                        Some("tool_call" | "tool_call_update")
                    ) {
                        if update["status"] == "failed" {
                            self.failed = true;
                        }
                        if let Some(id) = update["toolCallId"]
                            .as_str()
                            .filter(|s| !s.is_empty() && s.len() <= 1024)
                        {
                            if self.calls.len() >= 128 && !self.calls.contains_key(id) {
                                bail!("DEVIN_ACP_TOOL_LIMIT");
                            }
                            let entry = self.calls.entry(id.into()).or_insert_with(|| json!({}));
                            if let (Some(target), Some(source)) =
                                (entry.as_object_mut(), update.as_object())
                            {
                                target.extend(source.clone());
                            }
                        }
                    }
                } else if message.get("id").is_some() {
                    self.write(json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32601,"message":"Unsupported client capability"}})).await?;
                }
                continue;
            }
            if message["id"] != id {
                bail!("DEVIN_ACP_UNEXPECTED_RESPONSE");
            }
            if message.get("error").is_some() {
                bail!("DEVIN_ACP_RPC_FAILED");
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("DEVIN_ACP_INVALID_RESPONSE"));
        }
    }
    async fn permission(&mut self, message: &Value) -> Result<()> {
        let params = &message["params"];
        let mut outcome = json!({"outcome":"cancelled"});
        if message.get("id").is_none() {
            bail!("DEVIN_ACP_PERMISSION_ID_REQUIRED");
        }
        let valid_call = params["toolCall"].is_object()
            && params["toolCall"]["toolCallId"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 1024);
        let option = valid_call.then(|| once_option(params)).flatten();
        if self.session.is_some() && self.session.as_deref() == params["sessionId"].as_str() {
            if let Some(option) = option {
                let mut details = self
                    .calls
                    .get(params["toolCall"]["toolCallId"].as_str().unwrap())
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                details
                    .as_object_mut()
                    .unwrap()
                    .extend(params["toolCall"].as_object().unwrap().clone());
                let call = Call {
                    id: crate::local_http::random_token()?,
                    name: "devin_permission".into(),
                    arguments: json!({"workspace":self.engine.workspace,"toolCall":details}),
                };
                self.pending_permission = Some(message["id"].clone());
                let allow = self.engine.permission(self.run_id, &call).await?;
                self.engine.with_current_run(self.run_id, || Ok(()))?;
                if allow {
                    outcome = json!({"outcome":"selected","optionId":option});
                } else {
                    self.denied = true;
                }
            } else {
                self.denied = true;
            }
        } else {
            self.denied = true;
        }
        self.write(json!({"jsonrpc":"2.0","id":message["id"],"result":{"outcome":outcome}}))
            .await?;
        self.pending_permission = None;
        Ok(())
    }
}
fn once_option(params: &Value) -> Option<&str> {
    params["options"]
        .as_array()?
        .iter()
        .find(|v| v["kind"] == "allow_once")?["optionId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 200)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn never_promotes_an_always_permission_to_once() {
        assert_eq!(
            once_option(&json!({"options":[{"kind":"allow_always","optionId":"all"}]})),
            None
        );
        assert_eq!(
            once_option(
                &json!({"options":[{"kind":"allow_always","optionId":"all"},{"kind":"allow_once","optionId":"once"}]})
            ),
            Some("once")
        );
        assert_eq!(
            once_option(&json!({"options":[{"kind":"allow_once","optionId":""}]})),
            None
        );
    }
    #[tokio::test]
    #[cfg(unix)]
    async fn nested_permission_waits_for_rust_ui_and_denial_is_not_success() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::{Arc, Mutex};
        for allow in [Some(true), Some(false), None] {
            let root = super::super::sdk::TemporaryRoot::create().unwrap();
            let binary = root.0.join("devin-fixture");
            std::fs::write(&binary,r#"#!/usr/bin/env python3
import sys,json,os
assert sys.argv[1:]==['--permission-mode','auto','acp']
def send(m):print(json.dumps(m),flush=True)
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='initialize':
  assert m['params']['clientCapabilities']=={}
  send({'jsonrpc':'2.0','id':m['id'],'result':{'protocolVersion':1}})
 elif m.get('method')=='session/new':
  assert m['params']['cwd']==os.getcwd() and m['params']['mcpServers']==[]
  send({'jsonrpc':'2.0','id':m['id'],'result':{'sessionId':'fixture'}})
 elif m.get('method')=='session/prompt':
  send({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'fixture','update':{'sessionUpdate':'tool_call','toolCallId':'call-1','title':'git status','rawInput':{'command':'git status'}}}})
  send({'jsonrpc':'2.0','id':900,'method':'session/request_permission','params':{'sessionId':'fixture','toolCall':{'toolCallId':'call-1'},'options':[{'optionId':'all','kind':'allow_always'},{'optionId':'once','kind':'allow_once'}]}})
 elif m.get('id')==900:
  chosen=m['result']['outcome'];approved=chosen.get('optionId')=='once'
  assert approved or chosen['outcome']=='cancelled'
  open('decision.json','w').write(json.dumps(chosen))
  send({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'fixture','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'ACP_OK' if approved else 'Denied'}}}})
  send({'jsonrpc':'2.0','id':3,'result':{'stopReason':'end_turn'}})
"#).unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
            let engine = Arc::new(Engine {
                state: Mutex::new(super::super::engine::State {
                    run_id: 1,
                    status: "running".into(),
                    ..Default::default()
                }),
                workspace: root.0.canonicalize().unwrap(),
                sdk: super::super::sdk::SdkConfig {
                    bridge_dir: root.0.clone(),
                    agy_key: None,
                },
                devin: binary,
                secrets: vec![],
                registry: super::super::profiles::Registry::default(),
            });
            let next = engine.clone();
            let task = tokio::spawn(async move {
                execute(&next, 1, "survey", if allow.is_none() { 1 } else { 10 }).await
            });
            let pending = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    let snapshot = engine.snapshot();
                    if snapshot["status"] == "approval" {
                        break snapshot["pending"].clone();
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(pending["tool"], "devin_permission");
            assert_eq!(
                pending["arguments"]["toolCall"]["rawInput"]["command"],
                "git status"
            );
            assert!(!root.0.join("decision.json").exists());
            assert!(!task.is_finished());
            if let Some(allow) = allow {
                engine
                    .approve(pending["id"].as_str().unwrap(), allow)
                    .unwrap();
            }
            let result = task.await.unwrap().unwrap();
            let Some(allow) = allow else {
                assert_eq!(result["error"], "DEVIN_ACP_TIMEOUT");
                assert_eq!(result["completed"], false);
                assert_eq!(result["completionUnknown"], true);
                assert_eq!(engine.snapshot()["pending"], Value::Null);
                assert_eq!(engine.snapshot()["status"], "running");
                continue;
            };
            assert_eq!(result["completed"], allow);
            assert_eq!(result["executed"], allow);
            assert_eq!(result["permissionDenied"], !allow);
            assert_eq!(result["processStarted"], true);
            let decision: Value =
                serde_json::from_slice(&std::fs::read(root.0.join("decision.json")).unwrap())
                    .unwrap();
            assert_ne!(decision["optionId"], "all");
        }
    }
}
