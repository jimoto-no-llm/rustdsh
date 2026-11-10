//! Rust terminal surface for the installed DSH Web Remote protocol.
//! The host owns tools, persistence, credentials and its existing approval policy.
mod admin;
mod controls;
mod models;
mod state;
#[cfg(test)]
mod tests;

use super::backend::HarnessBackend;
use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use reqwest::{header, redirect::Policy, Client, Url};
use serde_json::{json, Value};
use state::View;
use std::{
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::Child,
    runtime::Runtime,
    sync::{mpsc, watch},
};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

const MAX_REPLY: usize = 16 * 1024 * 1024;
#[derive(Clone)]
struct Remote {
    client: Client,
    base: Url,
    cookie: String,
}
impl Remote {
    async fn authenticate(launch: Url) -> Result<Self> {
        validate_launch(&launch)?;
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .timeout(Duration::from_secs(30))
            .build()?;
        let response = client
            .get(launch.clone())
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("DSH 認証接続に失敗しました"))?;
        if response.status() != reqwest::StatusCode::SEE_OTHER {
            bail!("DSH 起動認証が拒否されました");
        }
        let cookie = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .filter_map(|v| v.split(';').next())
            .collect::<Vec<_>>()
            .join("; ");
        if cookie.is_empty() {
            bail!("DSH 認証Cookieがありません");
        }
        let mut base = launch;
        base.set_query(None);
        Ok(Self {
            client,
            base,
            cookie,
        })
    }
    async fn rpc(&self, method: &str, args: Value) -> Result<Value> {
        let rpc_id = crate::local_http::random_token()?;
        let envelope =
            json!({"type":"client-request","rpcId":rpc_id,"method":method,"payload":{"args":args}});
        let response = self
            .client
            .post(self.base.join(&format!("api/{method}"))?)
            .header(header::COOKIE, &self.cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(envelope.to_string())
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("DSH remote 要求に失敗しました: {method}"))?;
        if !response.status().is_success() {
            bail!("DSH remote HTTP {}: {method}", response.status().as_u16());
        }
        let mut bytes = Vec::new();
        let mut chunks = response.bytes_stream();
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk.map_err(|_| anyhow::anyhow!("DSH 応答を読み取れません"))?;
            if bytes.len() + chunk.len() > MAX_REPLY {
                bail!("DSH 応答が上限16MiBを超えました");
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).context("DSH 応答形式が不正です")?;
        if value["rpcId"] != rpc_id || value["type"] != "server-response" {
            bail!("DSH RPC応答が一致しません");
        }
        if value["result"]["ok"] != true {
            let code = value["result"]["error"]["code"]
                .as_str()
                .unwrap_or("unknown");
            // Codes are sufficient for diagnostics; never echo arbitrary host messages.
            let code: String = code
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || "/-_".contains(*c))
                .take(100)
                .collect();
            bail!("DSH {method}: {code}");
        }
        Ok(value["result"]["value"].clone())
    }
    async fn outcome(&self, client_id: &str, event_id: &str, outcome: Value) -> Result<Value> {
        self.rpc(
            "$events/result",
            json!({"clientId":client_id,"eventId":event_id,"outcome":outcome}),
        )
        .await
    }
}

fn validate_launch(url: &Url) -> Result<()> {
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none_or(|p| p == 0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.fragment().is_some()
        || url.query_pairs().count() != 1
        || !url
            .query_pairs()
            .any(|(k, v)| k == "token" && !v.is_empty())
    {
        bail!("DSH 起動URLが期待するloopback形式ではありません");
    }
    Ok(())
}
fn startup_url(line: &str) -> Option<Url> {
    let text = line.trim().strip_prefix("dsh web: ")?;
    let url = Url::parse(text).ok()?;
    validate_launch(&url).ok()?;
    Some(url)
}

enum Command {
    Follow(String),
    CloseWait(String),
    Stop,
}
pub(super) struct DshBackend {
    runtime: Runtime,
    remote: Remote,
    view: Arc<Mutex<View>>,
    commands: mpsc::UnboundedSender<Command>,
    child: Mutex<Child>,
    workspace: PathBuf,
    secrets: Vec<String>,
    admin: Arc<Mutex<admin::AdminState>>,
}
impl DshBackend {
    pub(super) fn start(
        workspace: PathBuf,
        profile: &str,
        locale: crate::locale::Locale,
    ) -> Result<Self> {
        let workspace = workspace.canonicalize()?;
        if !workspace.is_dir() {
            bail!("--workspace はディレクトリを指定してください");
        }
        if profile.is_empty() || profile.starts_with('-') || profile.contains(['/', '\\']) {
            bail!("DSH profile名が不正です");
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        let (remote, child, launch_secret) = runtime.block_on(async {
            let mut command = crate::passthrough::tui_host_command(profile, locale)?;
            command
                .current_dir(&workspace)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                command.process_group(0);
            }
            let mut command = tokio::process::Command::from(command);
            command.kill_on_drop(true);
            let mut child = command.spawn().context("DSH host を起動できません")?;
            // Drain logs privately. Startup can contain auth URLs: do not print them.
            let mut stderr = child.stderr.take().unwrap();
            tokio::spawn(async move {
                let mut b = [0; 4096];
                while matches!(stderr.read(&mut b).await,Ok(n) if n>0) {}
            });
            let mut stdout = child.stdout.take().unwrap();
            let start = tokio::time::timeout(Duration::from_secs(40), async {
                let mut buffer = Vec::new();
                let mut chunk = [0; 4096];
                let mut discarded = 0usize;
                loop {
                    let n = stdout.read(&mut chunk).await?;
                    if n == 0 {
                        bail!("DSH host が準備前に終了しました");
                    }
                    buffer.extend_from_slice(&chunk[..n]);
                    while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
                        let line = buffer.drain(..=pos).collect::<Vec<_>>();
                        if let Some(url) = startup_url(&String::from_utf8_lossy(&line)) {
                            return Ok(url);
                        }
                        discarded += line.len();
                    }
                    if buffer.len() > 65536 || discarded > 8 * 1024 * 1024 {
                        bail!("DSH startup出力が上限を超えました");
                    }
                }
            })
            .await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("DSH host 起動が40秒でタイムアウトしました")));
            let url = match start {
                Ok(url) => url,
                Err(e) => {
                    stop_child(&mut child).await;
                    return Err(e);
                }
            };
            tokio::spawn(async move {
                let mut b = [0; 4096];
                while matches!(stdout.read(&mut b).await,Ok(n) if n>0) {}
            });
            let secret = url
                .query_pairs()
                .find(|(k, _)| k == "token")
                .unwrap()
                .1
                .into_owned();
            let remote = match Remote::authenticate(url.clone()).await {
                Ok(r) => r,
                Err(e) => {
                    stop_child(&mut child).await;
                    return Err(e);
                }
            };
            Ok::<_, anyhow::Error>((remote, child, secret))
        })?;
        let catalog = match runtime.block_on(remote.rpc("session/modelCatalog", json!({}))) {
            Ok(v) => v,
            Err(e) => {
                let mut child = child;
                runtime.block_on(stop_child(&mut child));
                return Err(e);
            }
        };
        let view = Arc::new(Mutex::new(View::new(
            &workspace,
            profile,
            models::catalog(catalog),
        )));
        let (commands, rx) = mpsc::unbounded_channel();
        let (ready_tx, mut ready_rx) = watch::channel(false);
        runtime.spawn(pump(remote.clone(), view.clone(), rx, ready_tx));
        let mut secrets = vec![launch_secret, remote.cookie.clone()];
        secrets.extend(
            std::env::vars()
                .filter(|(k, _)| {
                    k.contains("API_KEY") || k.contains("TOKEN") || k.contains("SECRET")
                })
                .map(|(_, v)| v),
        );
        let backend = Self {
            runtime,
            remote,
            view,
            commands,
            child: Mutex::new(child),
            workspace,
            secrets,
            admin: Arc::new(Mutex::new(admin::AdminState::default())),
        };
        backend.runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(15), async {
                while !*ready_rx.borrow_and_update() {
                    ready_rx
                        .changed()
                        .await
                        .context("DSH events接続が閉じました")?;
                }
                Ok::<_, anyhow::Error>(())
            })
            .await
            .context("DSH events接続がタイムアウトしました")?
        })?;
        backend.create(None)?;
        Ok(backend)
    }
    fn rpc(&self, method: &str, args: Value) -> Result<Value> {
        self.runtime.block_on(self.remote.rpc(method, args))
    }
    fn session(&self) -> String {
        self.view.lock().unwrap().session_id.clone()
    }
    fn require_idle(&self) -> Result<()> {
        let view = self.view.lock().unwrap();
        if matches!(view.value["status"].as_str(), Some("running" | "approval")) {
            bail!("実行中は変更できません");
        }
        if view.client_id.is_empty() || view.value["connected"] != true {
            bail!("DSH 接続がありません");
        }
        if !view.session_id.is_empty() && view.value["loaded"] != true {
            bail!("DSH 会話を読込み中です");
        }
        Ok(())
    }
    fn create(&self, id: Option<&str>) -> Result<()> {
        self.require_idle()?;
        let request = if let Some(id) = id {
            json!({"sessionId":id})
        } else {
            json!({"cwd":self.workspace})
        };
        let value = self.rpc("session/create", json!({"request":request}))?;
        let id = value["sessionId"]
            .as_str()
            .context("DSH sessionIdがありません")?;
        self.view.lock().unwrap().set_session(id);
        self.commands
            .send(Command::Follow(id.into()))
            .context("DSH 接続が閉じました")?;
        // Wait for baseline; do not let input race the initial model/state restore.
        self.runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(15), async {
                loop {
                    if self.view.lock().unwrap().value["loaded"] == true {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .context("DSH 会話の読込みがタイムアウトしました")
        })?;
        let busy = matches!(
            self.view.lock().unwrap().value["status"].as_str(),
            Some("running" | "approval")
        );
        if !busy {
            self.upgrade_anthropic()?;
        }
        Ok(())
    }

    fn upgrade_anthropic(&self) -> Result<()> {
        let model = {
            let view = self.view.lock().unwrap();
            (view.value["provider"] == "anthropic")
                .then(|| view.value["model"].as_str().unwrap_or("").to_owned())
        };
        if let Some(model) = model {
            self.request("/api/model", json!({"provider":"claude-cli","model":model}))?;
        }
        Ok(())
    }
}
impl HarnessBackend for DshBackend {
    fn snapshot(&self) -> Value {
        let mut value = self.view.lock().unwrap().snapshot();
        redact_value(&mut value, &self.secrets);
        value
    }
    fn request(&self, path: &str, body: Value) -> Result<Value> {
        if path.starts_with("/api/admin/") {
            return self.admin_request(path, body);
        }
        match path {
            "/api/message"=>{
                self.require_idle()?;
                self.upgrade_anthropic()?;
                let text=body["text"].as_str().filter(|t|!t.trim().is_empty()&&t.len()<=16384).context("入力は1〜16KiBにしてください")?;
                let session=self.session();
                self.view.lock().unwrap().value["status"]=json!("running");
                let result=self.rpc("session/prompt",json!({"request":{"requestId":crate::local_http::random_token()?,"sessionId":session,"mode":"queue","content":[{"type":"text","text":text}]}}));
                if let Err(ref e)=result {self.view.lock().unwrap().fail(&e.to_string());}result
            },
            "/api/model"=>{
                self.require_idle()?;
                let p=models::provider(body["provider"].as_str().context("providerがありません")?);
                let m=body["model"].as_str().context("modelがありません")?;
                let valid=self.view.lock().unwrap().value["providers"].as_array().into_iter().flatten().any(|v|v["id"]==p&&v["models"].as_array().into_iter().flatten().any(|v|v["id"]==m));
                if !valid {bail!("DSH catalogにないモデルです");}
                self.rpc("session/selectModel",json!({"request":{"sessionId":self.session(),"provider":p,"model":m}}))?;
                let mut view=self.view.lock().unwrap();view.value["provider"]=json!(p);view.value["model"]=json!(m);Ok(json!({"ok":true}))
            },
            "/api/approval"|"/api/question"=>{
                let id=body["id"].as_str().context("要求IDがありません")?;
                let (client,event)={let view=self.view.lock().unwrap();(view.client_id.clone(),view.pending_event(id).context("要求が失効しています")?)};
                let is_question=event["event"]=="user-questions/request"||event["continued"]==true;
                if is_question && path=="/api/approval" && body["allow"]==false {
                    self.rpc("session/cancel",json!({"request":{"sessionId":self.session()}}))?;
                    self.view.lock().unwrap().cancel_event(id);
                    let _=self.commands.send(Command::CloseWait(id.into()));
                    return Ok(json!({"ok":true}));
                }
                if (path=="/api/question")!=is_question {bail!("要求の種類が一致しません");}
                if !is_question && body["allow"]==true && event["detailsUnavailable"]==true {bail!("ツール引数が未取得のため許可できません");}
                let answer=if is_question {validate_answers(&event,&body["answers"])?} else {json!(if body["allow"]==true {"allowed-once"}else{"rejected"})};
                let result=if event["continued"]==true {
                    self.rpc("userQuestions/answer",json!({"agentId":event["agentId"],"callId":event["callId"],"answer":answer}))
                }else{self.runtime.block_on(self.remote.outcome(&client,id,json!({"kind":"result","value":answer})))}?;
                self.view.lock().unwrap().cancel_event(id);
                let _=self.commands.send(Command::CloseWait(id.into()));
                Ok(result)
            },
            "/api/controls"|"/api/mode"|"/api/permission"=>self.control_request(path,body),
            "/api/sessions"=>{
                let result=self.rpc("session/list",json!({"_request":{}}))?;
                session_list(&result,&self.workspace)
            },
            "/api/resume"=>{self.create(Some(body["sessionId"].as_str().context("sessionIdがありません")?))?;Ok(json!({"ok":true}))},
            "/api/host-commands"=>self.host_commands(None),
            "/api/host-command"=>self.host_commands(Some(body["line"].as_str().context("コマンドがありません")?)),
            "/api/plugins"=>self.rpc("pluginInventory/list",json!({})),
            "/api/settings"=>self.rpc("settings/describe",json!({})),
            _=>bail!("DSH backendで未対応の要求です"),
        }.map(|mut value|{redact_value(&mut value,&self.secrets);value})
    }
    fn cancel(&self) {
        if let Err(e) = self.rpc(
            "session/cancel",
            json!({"request":{"sessionId":self.session()}}),
        ) {
            self.view.lock().unwrap().fail(&e.to_string());
        }
    }
    fn reset(&self) -> Result<()> {
        self.create(None)
    }
    fn redact(&self, value: &str) -> String {
        let mut value = json!(value);
        redact_value(&mut value, &self.secrets);
        value.as_str().unwrap().into()
    }
}
impl Drop for DshBackend {
    fn drop(&mut self) {
        self.cancel_admin_jobs();
        let _ = self.runtime.block_on(self.remote.rpc(
            "session/cancel",
            json!({"request":{"sessionId":self.session()}}),
        ));
        let _ = self.commands.send(Command::Stop);
        self.runtime
            .block_on(stop_child(self.child.get_mut().unwrap()));
    }
}
async fn stop_child(child: &mut Child) {
    #[cfg(unix)]
    if let Some(id) = child.id() {
        unsafe {
            libc::kill(-(id as i32), libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    let _ = child.start_kill();
    if tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .is_err()
    {
        #[cfg(unix)]
        if let Some(id) = child.id() {
            unsafe {
                libc::kill(-(id as i32), libc::SIGKILL);
            }
        }
        let _ = child.kill().await;
    }
}
fn redact_value(value: &mut Value, secrets: &[String]) {
    match value {
        Value::String(s) => {
            for secret in secrets.iter().filter(|s| s.len() >= 6) {
                *s = s.replace(secret, "[REDACTED]");
            }
        }
        Value::Array(a) => {
            for v in a {
                redact_value(v, secrets)
            }
        }
        Value::Object(o) => {
            for (k, v) in o {
                if matches!(
                    k.to_ascii_lowercase().as_str(),
                    "apikey"
                        | "api_key"
                        | "token"
                        | "accesstoken"
                        | "refreshtoken"
                        | "password"
                        | "authorization"
                        | "cookie"
                ) {
                    *v = json!("[REDACTED]");
                } else {
                    redact_value(v, secrets)
                }
            }
        }
        _ => {}
    }
}

fn session_list(result: &Value, workspace: &std::path::Path) -> Result<Value> {
    let items = result["items"]
        .as_array()
        .context("DSH session一覧形式が不正です")?;
    let items=items.iter().filter(|s| {
        s["blank"]!=true && s["origin"]!="subagent" && s["parentSessionId"].is_null()
            && s["cwd"].as_str().is_some_and(|cwd|std::path::Path::new(cwd)==workspace)
    }).map(|s|json!({"id":s["sessionId"],"title":s["projections"]["values"]["title"],"cwd":s["cwd"],"running":s["running"]})).collect::<Vec<_>>();
    Ok(json!({"items":items}))
}

/// Validate against the current host request at submission, not a stale UI form.
fn validate_answers(event: &Value, answers: &Value) -> Result<Value> {
    let questions = event
        .get("questions")
        .or_else(|| event["request"].get("questions"))
        .and_then(Value::as_array)
        .context("質問の形式が不正です")?;
    let answers = answers.as_array().context("回答の形式が不正です")?;
    if questions.is_empty()
        || questions.len() > 32
        || answers.len() != questions.len()
        || serde_json::to_vec(event)?.len() > 256 * 1024
    {
        bail!("質問・回答の件数またはサイズが上限を超えています");
    }
    let mut seen = std::collections::HashSet::new();
    for question in questions {
        let id = question["id"].as_str().context("質問IDがありません")?;
        if !seen.insert(id) {
            bail!("質問IDが重複しています");
        }
        let matches = answers.iter().filter(|a| a["id"] == id).collect::<Vec<_>>();
        if matches.len() != 1 {
            bail!("回答IDが一致しません");
        }
        let answer = matches[0];
        if answer.as_object().is_none_or(|o| {
            o.keys()
                .any(|k| !matches!(k.as_str(), "id" | "selected" | "custom"))
        }) {
            bail!("未対応の回答項目です");
        }
        let selected = answer["selected"]
            .as_array()
            .context("選択回答の形式が不正です")?;
        if selected.len() > 64 || (question["multiSelect"] != true && selected.len() > 1) {
            bail!("選択回答の件数が不正です");
        }
        let mut unique = std::collections::HashSet::new();
        for selected in selected {
            let label = selected.as_str().context("選択肢が文字列ではありません")?;
            if !unique.insert(label)
                || !question["options"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|o| o["label"] == label)
            {
                bail!("未定義または重複した選択肢です");
            }
        }
        let custom = match answer.get("custom") {
            None => "",
            Some(v) => v.as_str().context("自由回答が文字列ではありません")?,
        };
        if custom.len() > 16384 || (selected.is_empty() && custom.trim().is_empty()) {
            bail!("回答を入力してください（自由回答は16KiB以内）");
        }
    }
    Ok(json!({"answers":answers}))
}

fn open(id: &str, endpoint: &str, args: Value) -> Message {
    Message::text(
        json!({"type":"open","streamId":id,"endpoint":endpoint,"payload":{"args":args}})
            .to_string(),
    )
}
fn follow(id: &str, session: &str) -> Message {
    open(
        id,
        "session/follow",
        json!({"request":{"address":{"kind":"session","sessionId":session},"assistantStream":true,"maxMessages":500}}),
    )
}
async fn pump(
    remote: Remote,
    view: Arc<Mutex<View>>,
    mut rx: mpsc::UnboundedReceiver<Command>,
    ready: watch::Sender<bool>,
) {
    let mut session = String::new();
    let mut generation = 0u64;
    loop {
        generation += 1;
        let mut url = remote.base.join("api/remote.mux").unwrap();
        url.set_scheme("ws").unwrap();
        let mut request = url.as_str().into_client_request().unwrap();
        request
            .headers_mut()
            .insert("Cookie", remote.cookie.parse().unwrap());
        let socket = tokio_tungstenite::connect_async(request).await;
        let Ok((mut ws, _)) = socket else {
            view.lock().unwrap().disconnected();
            let _ = ready.send(false);
            tokio::select! {
                _=tokio::time::sleep(Duration::from_secs(1))=>continue,
                command=rx.recv()=>{
                    match command {
                        None|Some(Command::Stop)=>return,
                        Some(Command::Follow(next))=>session=next,
                        _=>{},
                    }
                    continue;
                }
            }
        };
        if ws.send(open("events", "$events", json!({}))).await.is_err() {
            continue;
        }
        let mut follow_id = format!("session-{generation}");
        let mut waits = std::collections::HashMap::<String, String>::new();
        let mut children = std::collections::HashSet::<String>::new();
        loop {
            tokio::select! {
                command=rx.recv()=>match command {
                    None|Some(Command::Stop)=>{let _=ws.close(None).await;return;},
                    Some(Command::Follow(s))=>{
                        let _=ws.send(Message::text(json!({"type":"cancel","streamId":follow_id}).to_string())).await;
                        for child in children.drain(){let _=ws.send(Message::text(json!({"type":"cancel","streamId":format!("child:{child}")}).to_string())).await;}
                        for (_,stream) in waits.drain(){let _=ws.send(Message::text(json!({"type":"cancel","streamId":stream}).to_string())).await;}
                        session=s;generation+=1;follow_id=format!("session-{generation}");
                        if ws.send(follow(&follow_id,&session)).await.is_err(){break;}
                    },
                    Some(Command::CloseWait(event))=>{if let Some(id)=waits.remove(&event){let _=ws.send(Message::text(json!({"type":"cancel","streamId":id}).to_string())).await;}},
                },
                frame=ws.next()=>{
                    let text=match frame {Some(Ok(Message::Text(t)))=>t,Some(Ok(Message::Ping(p)))=>{if ws.send(Message::Pong(p)).await.is_err(){break;}continue;},Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,_=>continue};
                    if text.len()>MAX_REPLY {view.lock().unwrap().fail("DSH frameが上限を超えました");break;}
                    let Ok(frame)=serde_json::from_str::<Value>(&text)else{view.lock().unwrap().fail("DSH frame形式が不正です");break;};
                    let value=&frame["value"];
                    if frame["type"]=="error" {view.lock().unwrap().fail("DSH streamがエラーを返しました");continue;}
                    if frame["type"]!="item" {continue;}
                    if frame["streamId"]=="events" {
                        match value["type"].as_str() {
                            Some("ready")=>{
                                let Some(client)=value["clientId"].as_str()else{break;};{let mut v=view.lock().unwrap();v.client_id=client.into();v.connected();}let _=ready.send(true);
                                if ws.send(open("control","session/control",json!({}))).await.is_err(){break;}
                                if !session.is_empty()&&ws.send(follow(&follow_id,&session)).await.is_err(){break;}
                            },
                            Some("waterfall")=>{
                                let (handled,client)={let mut v=view.lock().unwrap();(v.waterfall(value),v.client_id.clone())};
                                let event=value["eventId"].as_str().unwrap_or("");
                                if !handled {let r=remote.clone();let event=event.to_owned();tokio::spawn(async move {let _=r.outcome(&client,&event,json!({"kind":"next"})).await;});}
                                else if value["request"]["wait"]["timed"]==true {
                                    if let (Some(agent),Some(call))=(value["agentId"].as_str(),value["request"]["wait"]["callId"].as_str()) {
                                        let id=format!("question-{event}");
                                        let _=ws.send(open(&id,"userQuestions/attachWait",json!({"agentId":agent,"callId":call}))).await;waits.insert(event.into(),id);
                                    }
                                }
                            },
                            Some("cancel")=>{if let Some(id)=value["eventId"].as_str(){view.lock().unwrap().cancel_event(id);if let Some(stream)=waits.remove(id){let _=ws.send(Message::text(json!({"type":"cancel","streamId":stream}).to_string())).await;}}},
                            _=>{},
                        }
                    }else if frame["streamId"]==follow_id {
                        view.lock().unwrap().apply_follow(value);
                        if value["type"]=="snapshot" && value["hasMore"]==true {
                            let mut records=value["records"].clone();
                            let mut complete=false;
                            for _ in 0..10 {
                                let before=records.as_array().into_iter().flatten().filter_map(|r|r["event"]["seq"].as_u64()).min();
                                let Some(before)=before else{break;};
                                let page=remote.rpc("session/page",json!({"request":{"address":{"kind":"session","sessionId":session},"throughSeq":value["cursor"],"beforeSeq":before,"maxMessages":500}})).await;
                                match page {
                                    Ok(page)=>{view.lock().unwrap().prepend_records(&page["records"]);records=page["records"].clone();if page["hasMore"]!=true{complete=true;break;}},
                                    Err(_)=>{view.lock().unwrap().fail("DSH 過去履歴を取得できませんでした。再開をやり直してください");break;},
                                }
                            }
                            if complete {view.lock().unwrap().history_complete();}
                        }
                    }
                    else if frame["streamId"]=="control" {view.lock().unwrap().apply_control(value);}
                    else if let Some(agent)=frame["streamId"].as_str().and_then(|s|s.strip_prefix("child:")) {view.lock().unwrap().apply_child_follow(agent,value);}
                    // Observe only descendants proven by DSH's direct-child catalogs.
                    // Their permission arguments must never be borrowed from another agent.
                    let owned=view.lock().unwrap().owned_sessions().into_iter().collect::<std::collections::HashSet<_>>();
                    for child in children.difference(&owned){let _=ws.send(Message::text(json!({"type":"cancel","streamId":format!("child:{child}")}).to_string())).await;}
                    for child in owned.difference(&children){let _=ws.send(follow(&format!("child:{child}"),child)).await;}
                    children=owned;
                }
            }
        }
        view.lock().unwrap().disconnected();
        let _ = ready.send(false);
        tokio::select! {_=tokio::time::sleep(Duration::from_millis(500))=>{},command=rx.recv()=>match command {None|Some(Command::Stop)=>return,Some(Command::Follow(s))=>session=s,_=>{}}}
    }
}
