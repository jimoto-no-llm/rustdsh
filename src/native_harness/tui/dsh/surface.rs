//! Private headless browser transport. No debugging port or user's browser profile.
use super::{stop_child, DshBackend};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Child,
    sync::mpsc,
};

const HELPER: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/tui-web-surface.mjs"
));
const MAX_FRAME: usize = 16 * 1024 * 1024;
const MAX_INPUT: usize = 2 * 1024 * 1024;

pub(super) struct Surface {
    child: Child,
    input: mpsc::Sender<Value>,
    value: Arc<Mutex<Value>>,
    temporary: PathBuf,
}

fn storage_path(profile: &str) -> Result<PathBuf> {
    let home = std::env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|home| PathBuf::from(home).join(".dsh"))
        })
        .context("TUIブラウザの保存先を決定できません")?;
    let key: String = Sha256::digest(profile.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(home.join("tui-web").join(key).join("storage.json"))
}

fn dimensions(body: &Value) -> Result<(u64, u64)> {
    let width = body
        .get("width")
        .map_or(Some(1000), Value::as_u64)
        .context("画面幅が不正です")?;
    let height = body
        .get("height")
        .map_or(Some(700), Value::as_u64)
        .context("画面高さが不正です")?;
    if !(240..=1920).contains(&width) || !(240..=1920).contains(&height) {
        bail!("ブラウザ画面は240〜1920pxで指定してください");
    }
    Ok((width, height))
}

fn validate_input(value: &Value) -> Result<()> {
    if !value.is_object() || serde_json::to_vec(value)?.len() > MAX_INPUT {
        bail!("Web画面の入力が大きすぎるか不正です");
    }
    if !matches!(
        value["kind"].as_str(),
        Some(
            "activate"
                | "fill"
                | "text"
                | "key"
                | "click"
                | "move"
                | "scroll"
                | "resize"
                | "dialog"
                | "files"
                | "directory"
                | "document"
                | "back"
                | "forward"
                | "reload"
                | "tab"
                | "close_tab"
        )
    ) {
        bail!("未対応のWeb画面操作です");
    }
    if value["kind"] == "resize" {
        dimensions(value)?;
    }
    Ok(())
}

impl DshBackend {
    pub(super) fn surface_request(&self, path: &str, body: Value) -> Result<Value> {
        match path {
            "/api/surface/start" => {
                let (width, height) = dimensions(&body)?;
                let mut state = self.surface.lock().unwrap();
                if let Some(surface) = state.as_ref() {
                    if surface.value.lock().unwrap()["status"] != "failed" {
                        return Ok(json!({"ok":true}));
                    }
                }
                if let Some(mut previous) = state.take() {
                    self.runtime.block_on(previous.close());
                }
                let init = json!({"type":"init", "url":self.remote.base.as_str(), "cookie":self.remote.cookie,
                    "width":width,"height":height,"workspace":self.workspace,"storagePath":storage_path(&self.profile)?,"sessionId":self.session()});
                let surface = self.runtime.block_on(Surface::start(init))?;
                *state = Some(surface);
                Ok(json!({"ok":true}))
            }
            "/api/surface/state" => {
                let state = self.surface.lock().unwrap();
                let Some(surface) = state.as_ref() else {
                    return Ok(json!({"status":"closed","controls":[],"tabs":[]}));
                };
                let value = surface.value.lock().unwrap().clone();
                Ok(value)
            }
            "/api/surface/session" => {
                let state = self.surface.lock().unwrap();
                let surface = state.as_ref().context("Web画面が起動していません")?;
                let id = crate::local_http::random_token()?;
                surface
                    .input
                    .try_send(json!({"type":"input","value":{"kind":"session_snapshot","id":id}}))
                    .map_err(|_| anyhow::anyhow!("Web画面の選択状態を確認できません"))?;
                self.runtime.block_on(async {
                    tokio::time::timeout(Duration::from_secs(5), async {
                        loop {
                            {
                                let value = surface.value.lock().unwrap();
                                if value["sessionBarrier"].as_str() == Some(id.as_str()) {
                                    return Ok(json!({"sessionId":value["sessionId"]}));
                                }
                                if value["status"] == "failed" {
                                    bail!("Web画面が終了しています");
                                }
                            }
                            tokio::time::sleep(Duration::from_millis(15)).await;
                        }
                    })
                    .await
                    .context("Web画面のセッション確認が時間切れになりました")?
                })
            }
            "/api/surface/input" => {
                validate_input(&body)?;
                let state = self.surface.lock().unwrap();
                let surface = state.as_ref().context("Web画面が起動していません")?;
                surface
                    .input
                    .try_send(json!({"type":"input","value":body}))
                    .map_err(|_| anyhow::anyhow!("Web画面の入力待ちが満杯または終了しています"))?;
                Ok(json!({"ok":true}))
            }
            "/api/surface/close" => {
                self.close_surface();
                Ok(json!({"ok":true}))
            }
            _ => bail!("未対応のWeb画面要求です"),
        }
    }
    pub(super) fn sync_surface_session(&self) {
        if let Some(surface) = self.surface.lock().unwrap().as_ref() {
            let _ = surface.input.try_send(
                json!({"type":"input","value":{"kind":"session","sessionId":self.session()}}),
            );
        }
    }
    pub(super) fn close_surface(&self) {
        if let Some(mut surface) = self.surface.lock().unwrap().take() {
            self.runtime.block_on(surface.close());
        }
    }
}
impl Surface {
    async fn start(init: Value) -> Result<Self> {
        let node = crate::passthrough::find_node_bin().context("Web画面にはNode.jsが必要です")?;
        let temporary = std::env::temp_dir().join(format!(
            "rdsh-web-surface-{}",
            crate::local_http::random_token()?
        ));
        let mut directory = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        directory
            .create(&temporary)
            .context("Web画面の作業フォルダを作成できません")?;
        let helper = temporary.join("surface.mjs");
        fs::write(&helper, HELPER)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&helper, fs::Permissions::from_mode(0o600))?;
        }
        let mut command = tokio::process::Command::new(node);
        command
            .arg(&helper)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        {
            command.process_group(0);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                let _ = fs::remove_dir_all(&temporary);
                bail!("Web画面プロセスを起動できません");
            }
        };
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let value = Arc::new(Mutex::new(
            json!({"status":"starting","controls":[],"tabs":[]}),
        ));
        let read_value = value.clone();
        let (input, mut inputs) = mpsc::channel::<Value>(128);
        input
            .send(init)
            .await
            .context("Web画面の初期化に失敗しました")?;
        tokio::spawn(async move {
            while let Some(value) = inputs.recv().await {
                let Ok(mut data) = serde_json::to_vec(&value) else {
                    break;
                };
                data.push(b'\n');
                if stdin.write_all(&data).await.is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            let mut discard = [0; 4096];
            while matches!(stderr.read(&mut discard).await, Ok(n) if n > 0) {}
        });
        tokio::spawn(async move {
            let mut buffer = Vec::new();
            let mut chunk = [0; 65536];
            loop {
                match stdout.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(length) => buffer.extend_from_slice(&chunk[..length]),
                }
                if buffer.len() > MAX_FRAME {
                    break;
                }
                while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                    let line = buffer.drain(..=end).collect::<Vec<_>>();
                    let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                        continue;
                    };
                    if message["type"] == "state" && message["value"].is_object() {
                        *read_value.lock().unwrap() = message["value"].clone();
                    }
                }
            }
            let mut state = read_value.lock().unwrap();
            if state["status"] != "failed" {
                *state = json!({"status":"failed","error":"Web画面プロセスが終了しました","controls":[],"tabs":[]});
            }
        });
        Ok(Self {
            child,
            input,
            value,
            temporary,
        })
    }
    async fn close(&mut self) {
        let _ = self.input.try_send(json!({"type":"close"}));
        if tokio::time::timeout(Duration::from_secs(2), self.child.wait())
            .await
            .is_err()
        {
            stop_child(&mut self.child).await;
        }
        let _ = fs::remove_dir_all(&self.temporary);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn surface_inputs_are_bounded_and_do_not_expose_an_arbitrary_cdp_evaluator() {
        assert!(validate_input(&json!({"kind":"text","text":"日本語"})).is_ok());
        assert!(
            validate_input(&json!({"kind":"Runtime.evaluate","expression":"anything"})).is_err()
        );
        assert!(dimensions(&json!({"width":0,"height":700})).is_err());
        assert!(dimensions(&json!({"width":true,"height":700})).is_err());
        assert!(validate_input(&json!({"kind":"resize","width":1000,"height":700})).is_ok());
    }
    #[test]
    fn private_browser_uses_pipes_and_keeps_the_sandbox() {
        assert!(HELPER.contains("--remote-debugging-pipe"));
        assert!(!HELPER.contains("--no-sandbox"));
        assert!(!HELPER.contains("--remote-debugging-port"));
    }
}
