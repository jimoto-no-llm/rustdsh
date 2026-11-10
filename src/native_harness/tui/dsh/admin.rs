//! Authenticated, catalog-bound management transport for the terminal UI.
//! Executes the same gateway calls as the Web client; never reflects Host services.
mod files;
#[cfg(test)]
mod tests;

use super::{open, redact_value, DshBackend, Remote, MAX_REPLY};
use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use reqwest::{header, Method};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

const MAX_JOBS: usize = 32;
const MAX_EVENTS: usize = 128;
const MAX_EVENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_ARGS: usize = 1024 * 1024;

#[derive(Default)]
pub(super) struct AdminState {
    jobs: BTreeMap<String, Job>,
    sequence: u64,
}
struct Job {
    value: Value,
    cancel: watch::Sender<bool>,
    input: mpsc::Sender<Value>,
    sequence: u64,
    event_sequence: u64,
    event_bytes: usize,
    uplink: bool,
}
impl AdminState {
    fn room(&mut self) -> Result<()> {
        if self.jobs.len() < MAX_JOBS {
            return Ok(());
        }
        let oldest = self
            .jobs
            .iter()
            .filter(|(_, j)| !matches!(j.value["status"].as_str(), Some("running" | "cancelling")))
            .min_by_key(|(_, j)| j.sequence)
            .map(|(id, _)| id.clone());
        if let Some(id) = oldest {
            self.jobs.remove(&id);
            Ok(())
        } else {
            bail!("管理操作が同時実行上限32件に達しました。不要な監視を停止してください")
        }
    }
}

fn validate_action(action: &Value) -> Result<()> {
    let id = action["id"].as_str().context("管理操作IDがありません")?;
    if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
        bail!("管理操作IDが不正です");
    }
    if !matches!(action["mode"].as_str(), Some("unary" | "stream")) {
        bail!("管理操作の通信形式が未対応です");
    }
    match action["transport"].as_str() {
        Some("rpc") => {
            if id.split('/').count() != 2
                || !id.split('/').all(|p| {
                    !p.is_empty()
                        && p.bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"_$-".contains(&c))
                })
            {
                bail!("管理RPC名が不正です");
            }
        }
        Some("http") => {
            let path = action["path"]
                .as_str()
                .context("管理HTTPパスがありません")?;
            if !path.starts_with("/api/rdsh-")
                || path.contains(['?', '#', '\\', '%'])
                || path.split('/').any(|p| matches!(p, "." | ".."))
                || !path
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"/-_".contains(&c))
            {
                bail!("管理HTTPパスが許可対象ではありません");
            }
            if !matches!(
                action["method"].as_str(),
                Some("GET" | "POST" | "PUT" | "PATCH" | "DELETE")
            ) {
                bail!("管理HTTPメソッドが未対応です");
            }
        }
        _ => bail!("管理操作のtransportが未対応です"),
    }
    Ok(())
}
fn catalog_actions(catalog: &Value) -> Result<&Vec<Value>> {
    let actions = catalog["actions"]
        .as_array()
        .context("管理catalogの形式が不正です")?;
    if actions.len() > 4096 {
        bail!("管理catalogが4096件を超えています")
    }
    let mut ids = std::collections::HashSet::new();
    for action in actions {
        validate_action(action)?;
        if !ids.insert(action["id"].as_str().unwrap()) {
            bail!("管理catalogに重複IDがあります")
        }
    }
    Ok(actions)
}
fn sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase().replace(['_', '-'], "");
    lower.contains("password")
        || lower.contains("apikey")
        || lower.contains("secret")
        || matches!(
            lower.as_str(),
            "token"
                | "accesstoken"
                | "refreshtoken"
                | "idtoken"
                | "authtoken"
                | "authorization"
                | "cookie"
        )
}
fn collect_secrets(value: &Value, all: bool, secrets: &mut Vec<String>) {
    match value {
        Value::String(s) if all && !s.is_empty() => secrets.push(s.clone()),
        Value::Object(o) => {
            for (k, v) in o {
                collect_secrets(v, all || sensitive_key(k), secrets)
            }
        }
        Value::Array(a) => {
            for v in a {
                collect_secrets(v, all, secrets)
            }
        }
        _ => {}
    }
}
fn redact_admin(value: &mut Value, secrets: &[String]) {
    redact_value(value, secrets);
    match value {
        Value::String(text) => {
            // Explicitly supplied short secrets need masking too. The shared chat
            // redactor's six-byte threshold is inappropriate for credential forms.
            for secret in secrets.iter().filter(|s| !s.is_empty() && s.len() < 6) {
                *text = text.replace(secret, "[REDACTED]");
            }
        }
        Value::Object(o) => {
            for (k, v) in o {
                if sensitive_key(k) {
                    *v = json!("[REDACTED]")
                } else {
                    redact_admin(v, secrets)
                }
            }
        }
        Value::Array(a) => {
            for v in a {
                redact_admin(v, secrets)
            }
        }
        _ => {}
    }
}

impl DshBackend {
    pub(super) fn admin_request(&self, path: &str, body: Value) -> Result<Value> {
        match path.split('?').next().unwrap_or(path) {
            "/api/admin/catalog" => {
                let mut catalog = self.rpc("rdshTuiAdmin/catalog",json!({}))
                    .map_err(|error| anyhow::anyhow!("DSH管理catalogを取得できません。rdsh-tui-admin pluginの有効化を確認してください: {error}"))?;
                catalog_actions(&catalog)?;
                catalog["sessionId"] = json!(self.session());
                catalog["workspace"] = json!(self.workspace);
                // Schema is metadata: don't redact property names or token-related schema fields.
                Ok(catalog)
            }
            "/api/admin/start" => self.start_admin(body),
            "/api/admin/job" => {
                let id = body["jobId"]
                    .as_str()
                    .or_else(|| body["id"].as_str())
                    .map(str::to_owned)
                    .or_else(|| {
                        path.split_once('?').and_then(|(_, q)| {
                            q.split('&')
                                .find_map(|p| p.strip_prefix("id=").map(str::to_owned))
                        })
                    })
                    .context("管理jobIdがありません")?;
                let state = self.admin.lock().unwrap();
                Ok(state
                    .jobs
                    .get(&id)
                    .context("管理jobが存在しません")?
                    .value
                    .clone())
            }
            "/api/admin/cancel" => {
                let id = body["jobId"].as_str().context("管理jobIdがありません")?;
                let mut state = self.admin.lock().unwrap();
                let job = state.jobs.get_mut(id).context("管理jobが存在しません")?;
                if job.value["status"] == "running" {
                    let _ = job.cancel.send(true);
                    job.value["status"] = json!("cancelling");
                }
                Ok(json!({"ok":true}))
            }
            "/api/admin/input" => {
                let id = body["jobId"].as_str().context("管理jobIdがありません")?;
                let value = body.get("value").context("stream入力がありません")?;
                if serde_json::to_vec(value)?.len() > MAX_ARGS {
                    bail!("stream入力は1MiB以内にしてください")
                }
                let state = self.admin.lock().unwrap();
                let job = state.jobs.get(id).context("管理jobが存在しません")?;
                if job.value["status"] != "running" || !job.uplink {
                    bail!("この管理jobは入力を受け付けません")
                }
                job.input
                    .try_send(value.clone())
                    .map_err(|_| anyhow::anyhow!("stream入力が満杯または終了しています"))?;
                Ok(json!({"ok":true}))
            }
            _ => bail!("未対応の管理要求です"),
        }
    }
    fn start_admin(&self, body: Value) -> Result<Value> {
        if body["confirmed"] != true {
            bail!("管理操作の実行には内容の確認が必要です")
        }
        let id = body["id"].as_str().context("管理操作IDがありません")?;
        let args = body
            .get("args")
            .filter(|a| a.is_object())
            .context("管理引数はJSON objectで指定してください")?
            .clone();
        if serde_json::to_vec(&args)?.len() > MAX_ARGS {
            bail!("管理引数は1MiB以内にしてください")
        }
        // Re-fetch on each start. Removed plugins and withdrawn actions cannot be invoked
        // through an old picker. The gateway still applies its own validation/peer policy.
        let catalog = self.rpc("rdshTuiAdmin/catalog", json!({}))?;
        let action = catalog_actions(&catalog)?
            .iter()
            .find(|a| a["id"] == id)
            .context("この操作は現在のDSH catalogに登録されていません")?
            .clone();
        if action["transport"] == "rpc" && matches!(id, "$events/result" | "commands/execute") {
            // Commands require the same explicit confirmation, but permission selection
            // retains the purpose-built policy dialog rather than a hidden generic bypass.
            if id == "$events/result" {
                bail!("承認と質問には専用のTUIダイアログを使ってください")
            }
            let line = args["line"].as_str().unwrap_or("");
            let name = line
                .trim_start_matches('/')
                .split_whitespace()
                .next()
                .unwrap_or("");
            if matches!(name, "permission" | "mode" | "plan") {
                bail!("/permission または /mode を使ってください")
            }
        }
        let job_id = crate::local_http::random_token()?;
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (input_tx, input_rx) = mpsc::channel(16);
        let sensitive = action["sensitive"] == true || id.starts_with("credentials/");
        let hide_result = matches!(id, "credentials/set" | "credentials/unset");
        let uplink = action["mode"] == "stream"
            && action["transport"] == "rpc"
            && (action["uplink"] == true
                || action["uplink"].is_object()
                || action["descriptor"]["uplink"].is_object());
        {
            let mut state = self.admin.lock().unwrap();
            state.room()?;
            state.sequence += 1;
            let sequence = state.sequence;
            state.jobs.insert(job_id.clone(),Job {
                value:json!({"id":job_id,"action":id,"status":"running","events":[],"droppedEvents":0,"uplink":uplink}),
                cancel:cancel_tx,input:input_tx,sequence,event_sequence:0,event_bytes:0,uplink,
            });
        }
        let mut secrets = self.secrets.clone();
        collect_secrets(&args, sensitive, &mut secrets);
        let remote = self.remote.clone();
        let state = self.admin.clone();
        let workspace = self.workspace.clone();
        let task_id = job_id.clone();
        self.runtime.spawn(async move {
            let result=run_job(&remote,&action,args,&workspace,&state,&task_id,cancel_rx,input_rx,&secrets).await;
            let mut state=state.lock().unwrap();
            if let Some(job)=state.jobs.get_mut(&task_id) {
                match result {
                    Ok(JobResult::Cancelled)=>{job.value["status"]=json!("cancelled");job.value["message"]=json!("クライアント側の要求を停止しました。既に完了した変更は取り消されません");},
                    Ok(JobResult::Complete(mut value))=>{
                        let failed = matches!(value["application"].as_str(), Some("failed" | "cancelled")) || value["ok"] == false;
                        job.value["status"] = json!(if failed {"failed"} else {"complete"});
                        if failed {job.value["error"] = json!(format!("DSH管理操作は適用されませんでした: {}", safe_code(&value["error"])));}
                        if value.get("error").is_some() {value["error"]=json!({"code":safe_code(&value["error"])});}
                        if hide_result {value=json!({"ok":!failed,"message":"機密操作の値は表示しません"})}
                        redact_admin(&mut value,&secrets);job.value["result"]=value;
                    },
                    Err(error)=>{job.value["status"]=json!("failed");job.value["error"]=json!(error.to_string());redact_admin(&mut job.value,&secrets);},
                }
            }
        });
        Ok(json!({"jobId":job_id}))
    }
    pub(super) fn cancel_admin_jobs(&self) {
        for job in self.admin.lock().unwrap().jobs.values() {
            let _ = job.cancel.send(true);
        }
    }
}

enum JobResult {
    Complete(Value),
    Cancelled,
}
fn event(
    state: &Arc<Mutex<AdminState>>,
    id: &str,
    mut value: Value,
    secrets: &[String],
) -> Result<()> {
    redact_admin(&mut value, secrets);
    let bytes = serde_json::to_vec(&value)?.len();
    if bytes > MAX_EVENT_BYTES {
        bail!("管理streamの1イベントが2MiBを超えました")
    }
    let mut state = state.lock().unwrap();
    let Some(job) = state.jobs.get_mut(id) else {
        return Ok(());
    };
    job.event_sequence += 1;
    job.event_bytes += bytes;
    let events = job.value["events"].as_array_mut().unwrap();
    events.push(json!({"sequence":job.event_sequence,"value":value}));
    let mut dropped = 0;
    while events.len() > MAX_EVENTS || job.event_bytes > MAX_EVENT_BYTES {
        let old = events.remove(0);
        job.event_bytes = job
            .event_bytes
            .saturating_sub(serde_json::to_vec(&old["value"])?.len());
        dropped += 1;
    }
    job.value["droppedEvents"] = json!(job.value["droppedEvents"].as_u64().unwrap_or(0) + dropped);
    Ok(())
}
#[allow(clippy::too_many_arguments)]
async fn run_job(
    remote: &Remote,
    action: &Value,
    args: Value,
    workspace: &Path,
    state: &Arc<Mutex<AdminState>>,
    id: &str,
    mut cancel: watch::Receiver<bool>,
    input: mpsc::Receiver<Value>,
    secrets: &[String],
) -> Result<JobResult> {
    let args = files::expand_files(args, workspace)?;
    if *cancel.borrow() {
        return Ok(JobResult::Cancelled);
    }
    if action["mode"] == "stream" && action["transport"] == "rpc" {
        return run_stream(remote, action, args, state, id, cancel, input, secrets).await;
    }
    let operation = async {
        if action["mode"] == "stream" {
            run_sse(remote, action, args, state, id, secrets)
                .await
                .map(JobResult::Complete)
        } else {
            run_unary(remote, action, args)
                .await
                .map(JobResult::Complete)
        }
    };
    tokio::select! {
        biased;
        _=cancel.changed()=>Ok(JobResult::Cancelled),
        result=operation=>result,
    }
}
async fn bounded_bytes(response: reqwest::Response) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|_| anyhow::anyhow!("管理応答を読み取れません"))?;
        if bytes.len() + chunk.len() > MAX_REPLY {
            bail!("管理応答が16MiBを超えました")
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn safe_code(value: &Value) -> String {
    value["code"]
        .as_str()
        .unwrap_or("unknown")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || "/-_".contains(*c))
        .take(100)
        .collect()
}
fn rpc_response(mut value: Value, id: &str) -> Result<Value> {
    if value["type"] != "server-response" || value["rpcId"] != id {
        bail!("管理RPC応答が一致しません")
    }
    if value["result"]["ok"] != true {
        bail!(
            "DSH管理操作が失敗しました: {}",
            safe_code(&value["result"]["error"])
        )
    }
    Ok(value["result"]["value"].take())
}
fn http_request(remote: &Remote, action: &Value, args: &Value) -> Result<reqwest::RequestBuilder> {
    let mut url = remote
        .base
        .join(action["path"].as_str().context("HTTP pathがありません")?)?;
    let method = Method::from_bytes(action["method"].as_str().unwrap_or("").as_bytes())?;
    let mut request = remote
        .client
        .request(method.clone(), url.clone())
        .header(header::COOKIE, &remote.cookie)
        .timeout(Duration::from_secs(600));
    if method == Method::GET {
        if let Some(query) = args.as_object() {
            for (key, value) in query {
                let allowed = action["query"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|v| v.as_str() == Some(key));
                if !allowed {
                    bail!("このHTTP操作では指定したquery引数が許可されていません")
                }
                let value = match value {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    Value::Bool(b) => b.to_string(),
                    Value::Null => continue,
                    _ => bail!("GET引数は文字列・数値・真偽値で指定してください"),
                };
                url.query_pairs_mut().append_pair(key, &value);
            }
        }
        request = remote
            .client
            .get(url)
            .header(header::COOKIE, &remote.cookie)
            .timeout(Duration::from_secs(600));
    } else {
        request = request
            .header(header::CONTENT_TYPE, "application/json")
            .body(args.to_string());
    }
    Ok(request)
}
async fn run_unary(remote: &Remote, action: &Value, args: Value) -> Result<Value> {
    let rpc_id = crate::local_http::random_token()?;
    let is_rpc = action["transport"] == "rpc";
    let request = if is_rpc {
        remote.client.post(remote.base.join(&format!("api/{}",action["id"].as_str().unwrap()))?)
            .header(header::COOKIE,&remote.cookie).header(header::CONTENT_TYPE,"application/json")
            .timeout(Duration::from_secs(600))
            .body(json!({"type":"client-request","rpcId":rpc_id,"method":action["id"],"payload":{"args":args}}).to_string())
    } else {
        http_request(remote, action, &args)?
    };
    let response = request
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("管理HTTP要求に失敗しました"))?;
    let status = response.status();
    if !status.is_success() {
        bail!("DSH管理HTTP {}", status.as_u16())
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let bytes = bounded_bytes(response).await?;
    let value = if content_type
        .to_ascii_lowercase()
        .starts_with("multipart/form-data")
    {
        files::decode_multipart(&content_type, &bytes)?
    } else if content_type.contains("json") || is_rpc {
        serde_json::from_slice(&bytes).context("管理JSON応答の形式が不正です")?
    } else if content_type.starts_with("text/") {
        json!({"text":String::from_utf8(bytes).context("管理テキストはUTF-8ではありません")?})
    } else {
        files::artifact(&bytes, &content_type)?
    };
    let value = if is_rpc {
        rpc_response(value, &rpc_id)?
    } else {
        value
    };
    Ok(value)
}
#[allow(clippy::too_many_arguments)]
async fn run_stream(
    remote: &Remote,
    action: &Value,
    args: Value,
    state: &Arc<Mutex<AdminState>>,
    id: &str,
    mut cancel: watch::Receiver<bool>,
    mut input: mpsc::Receiver<Value>,
    secrets: &[String],
) -> Result<JobResult> {
    let mut url = remote.base.join("api/remote.mux")?;
    url.set_scheme("ws")
        .map_err(|_| anyhow::anyhow!("管理stream URLが不正です"))?;
    let mut request = url.as_str().into_client_request()?;
    request
        .headers_mut()
        .insert("Cookie", remote.cookie.parse()?);
    let connection = tokio_tungstenite::connect_async(request);
    let socket = tokio::select! {_=cancel.changed()=>return Ok(JobResult::Cancelled),result=tokio::time::timeout(Duration::from_secs(30),connection)=>result.map_err(|_|anyhow::anyhow!("管理stream接続がタイムアウトしました"))?};
    let (mut ws, _) = socket.map_err(|_| anyhow::anyhow!("管理streamに接続できません"))?;
    ws.send(open(id, action["id"].as_str().unwrap(), args))
        .await
        .map_err(|_| anyhow::anyhow!("管理streamを開始できません"))?;
    loop {
        tokio::select! {
            biased;
            _=cancel.changed()=>{
                let _=tokio::time::timeout(Duration::from_secs(2),ws.send(Message::text(json!({"type":"cancel","streamId":id}).to_string()))).await;
                let _=tokio::time::timeout(Duration::from_secs(2),ws.close(None)).await;
                return Ok(JobResult::Cancelled);
            },
            value=input.recv()=>{
                if let Some(value)=value {ws.send(Message::text(json!({"type":"item","streamId":id,"value":value}).to_string())).await.map_err(|_|anyhow::anyhow!("管理streamへ入力できません"))?;}
            },
            frame=ws.next()=>{
                let text=match frame {Some(Ok(Message::Text(t)))=>t,Some(Ok(Message::Ping(p)))=>{ws.send(Message::Pong(p)).await.map_err(|_|anyhow::anyhow!("管理streamの接続が切れました"))?;continue},Some(Ok(Message::Close(_)))|None|Some(Err(_))=>bail!("管理streamの接続が切れました。変更の重複を避けるため自動再実行していません"),_=>continue};
                if text.len()>MAX_REPLY {bail!("管理stream frameが16MiBを超えました")}
                let frame:Value=serde_json::from_str(&text).context("管理streamのJSONが不正です")?;
                if frame["streamId"]!=id {continue}
                match frame["type"].as_str() {
                    Some("item")=>event(state,id,frame["value"].clone(),secrets)?,
                    Some("end")=>return Ok(JobResult::Complete(json!({"ended":true}))),
                    Some("error")=>bail!("DSH管理streamが失敗しました: {}",safe_code(&frame["error"])),
                    _=>bail!("管理streamのframe形式が未対応です"),
                }
            }
        }
    }
}
async fn run_sse(
    remote: &Remote,
    action: &Value,
    args: Value,
    state: &Arc<Mutex<AdminState>>,
    id: &str,
    secrets: &[String],
) -> Result<Value> {
    let response = http_request(remote, action, &args)?
        .timeout(Duration::from_secs(365 * 24 * 60 * 60))
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("管理SSEに接続できません"))?;
    if !response.status().is_success() {
        bail!("管理SSE HTTP {}", response.status().as_u16())
    }
    if !response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"))
    {
        bail!("管理SSEのContent-Typeが不正です")
    }
    let mut chunks = response.bytes_stream();
    let mut pending = Vec::new();
    let mut data = String::new();
    let mut name = String::new();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|_| anyhow::anyhow!("管理SSEの接続が切れました"))?;
        if pending.len() + chunk.len() > MAX_EVENT_BYTES {
            bail!("管理SSEが上限を超えました")
        }
        pending.extend_from_slice(&chunk);
        while let Some(pos) = pending.iter().position(|b| *b == b'\n') {
            let line = pending.drain(..=pos).collect::<Vec<_>>();
            let line = std::str::from_utf8(&line)
                .context("管理SSEはUTF-8ではありません")?
                .trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if !data.is_empty() {
                    let text = data.trim_end_matches('\n');
                    let value = serde_json::from_str::<Value>(text).unwrap_or_else(|_| json!(text));
                    event(state, id, json!({"event":name,"data":value}), secrets)?;
                    data.clear();
                    name.clear();
                }
            } else if let Some(value) = line.strip_prefix("data:") {
                data.push_str(value.strip_prefix(' ').unwrap_or(value));
                data.push('\n');
            } else if let Some(value) = line.strip_prefix("event:") {
                name = value.trim_start().to_owned();
            }
            if data.len() + name.len() > MAX_EVENT_BYTES {
                bail!("管理SSEイベントが上限を超えました")
            }
        }
    }
    Ok(json!({"ended":true}))
}
