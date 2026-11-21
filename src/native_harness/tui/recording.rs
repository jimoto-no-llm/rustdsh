//! Explicit local microphone capture and Host speech transcription; never auto-send.
use super::{backend::HarnessBackend, editor};
use anyhow::{bail, Context, Result};
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::{
    layout::Rect,
    style::{Color, Style},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
    Frame,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const MAX_SECONDS: u64 = 120;
const MAX_BYTES: u64 = 4 * 1024 * 1024;
enum Phase {
    Confirm(bool),
    Recording,
    Stopping,
    Ready,
    Send(bool),
    Transcribing(String),
    Done,
    Failed,
}
pub(super) struct Pane {
    phase: Phase,
    child: Option<Child>,
    path: Option<PathBuf>,
    started: Instant,
    stopped: Option<Instant>,
    catalog_job: Option<String>,
    catalog: Value,
    provider: Option<usize>,
    transcript: Option<String>,
    notice: String,
    next_poll: Instant,
}
fn start_job(backend: &dyn HarnessBackend, id: &str, args: Value) -> Result<String> {
    let result = backend.request(
        "/api/admin/start",
        json!({"id":id,"args":args,"confirmed":true}),
    )?;
    result["jobId"]
        .as_str()
        .map(str::to_owned)
        .context("音声操作のjob IDがありません")
}
fn job(backend: &dyn HarnessBackend, id: &str) -> Result<Value> {
    backend.request("/api/admin/job", json!({"jobId":id}))
}
fn active(value: &Value) -> bool {
    matches!(value["status"].as_str(), Some("running" | "cancelling"))
}
fn capture_input() -> Result<Vec<String>> {
    let device = std::env::var("RDSH_AUDIO_DEVICE").unwrap_or_else(|_| "default".into());
    if device.len() > 512 || device.chars().any(char::is_control) {
        bail!("録音デバイス名が不正です")
    }
    #[cfg(target_os = "macos")]
    {
        Ok(vec![
            "-f".into(),
            "avfoundation".into(),
            "-i".into(),
            format!("none:{device}"),
        ])
    }
    #[cfg(target_os = "linux")]
    {
        Ok(vec!["-f".into(), "pulse".into(), "-i".into(), device])
    }
    #[cfg(target_os = "windows")]
    {
        if device == "default" {
            bail!("RDSH_AUDIO_DEVICEにWindows録音デバイス名を指定してください")
        }
        Ok(vec![
            "-f".into(),
            "dshow".into(),
            "-i".into(),
            format!("audio={device}"),
        ])
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = device;
        bail!("このOSの録音入力は未対応です")
    }
}
fn ffmpeg() -> PathBuf {
    std::env::var_os("RDSH_FFMPEG_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            [
                "/opt/homebrew/bin/ffmpeg",
                "/usr/local/bin/ffmpeg",
                "/usr/bin/ffmpeg",
            ]
            .iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())
            .unwrap_or_else(|| "ffmpeg".into())
        })
}
fn recording_path() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!(
        "rdsh-recording-{}",
        crate::local_http::random_token()?
    ));
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&dir)?;
    let path = dir.join("recording.wav");
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(&path)?;
    Ok(path)
}
fn validate_wav(path: &std::path::Path) -> Result<()> {
    let mut file = fs::File::open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() < 44 || meta.len() > MAX_BYTES {
        bail!("録音が空または上限を超えています")
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.read_to_end(&mut bytes)?;
    validate_wav_bytes(&bytes)?;
    Ok(())
}
fn validate_wav_bytes(bytes: &[u8]) -> Result<()> {
    if bytes.len() < 44 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        bail!("録音のWAV形式が不正です")
    }
    let word =
        |offset: usize| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
    if word(4).checked_add(8) != Some(bytes.len()) {
        bail!("録音のWAV長が不正です")
    }
    let mut offset = 12;
    let mut format = false;
    let mut data = false;
    while offset + 8 <= bytes.len() {
        let size = word(offset + 4);
        let start = offset + 8;
        let end = start
            .checked_add(size)
            .filter(|n| *n <= bytes.len())
            .context("録音のWAVチャンクが不正です")?;
        match &bytes[offset..offset + 4] {
            b"fmt " => {
                format = size >= 16
                    && bytes[start..start + 4] == [1, 0, 1, 0]
                    && word(start + 4) == 16000
                    && word(start + 8) == 32000
                    && bytes[start + 12..start + 16] == [2, 0, 16, 0];
            }
            b"data" => {
                data = size > 0 && size % 2 == 0 && size <= MAX_SECONDS as usize * 32000;
            }
            _ => {}
        }
        offset = end + (size % 2);
    }
    if !format || !data || offset != bytes.len() {
        bail!("録音は16kHz mono PCM16 WAVである必要があります")
    }
    Ok(())
}
fn spawn_capture(args: &[String], path: &std::path::Path) -> std::io::Result<Child> {
    Command::new(ffmpeg())
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(args)
        .args(["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t"])
        .arg(MAX_SECONDS.to_string())
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}
impl Pane {
    pub(super) fn report_error(&mut self, value: String) {
        self.notice = value;
        if matches!(self.phase, Phase::Confirm(_)) {
            self.phase = Phase::Failed;
        } else if matches!(self.phase, Phase::Send(_)) {
            self.phase = Phase::Ready;
        }
    }
    pub(super) fn new(backend: &dyn HarnessBackend) -> Self {
        let catalog_job = start_job(backend, "speech/catalog", json!({})).ok();
        Self {
            phase: Phase::Confirm(false),
            child: None,
            path: None,
            started: Instant::now(),
            stopped: None,
            catalog_job,
            catalog: Value::Null,
            provider: None,
            transcript: None,
            notice: String::new(),
            next_poll: Instant::now(),
        }
    }
    pub(super) fn clear_confirmation(&mut self) {
        if let Phase::Confirm(v) | Phase::Send(v) = &mut self.phase {
            *v = false;
        }
    }
    pub(super) fn is_recording(&self) -> bool {
        matches!(self.phase, Phase::Recording | Phase::Stopping)
    }
    fn start_capture(&mut self) -> Result<()> {
        let args = capture_input()?;
        let path = recording_path()?;
        let result = spawn_capture(&args, &path);
        let child = match result {
            Ok(child) => child,
            Err(_) => {
                let _ = fs::remove_file(&path);
                let _ = fs::remove_dir(path.parent().unwrap());
                bail!("ffmpegを起動できません。インストールとRDSH_FFMPEG_BINを確認してください")
            }
        };
        self.child = Some(child);
        self.path = Some(path);
        self.phase = Phase::Recording;
        self.started = Instant::now();
        self.stopped = None;
        self.notice = "マイクを録音中。Spaceで停止します（最長120秒）".into();
        Ok(())
    }
    fn stop_capture(&mut self) {
        if let Some(child) = &mut self.child {
            if let Some(mut input) = child.stdin.take() {
                let _ = input.write_all(b"q\n");
            }
        }
        self.phase = Phase::Stopping;
        self.stopped = Some(Instant::now());
        self.notice = "録音を保存中".into();
    }
    fn selected(&self) -> Option<&Value> {
        self.provider
            .and_then(|i| self.catalog["providers"].as_array()?.get(i))
    }
    fn transcribe(&mut self, backend: &dyn HarnessBackend) -> Result<()> {
        let path = self.path.as_ref().context("録音ファイルがありません")?;
        validate_wav(path)?;
        let provider = self.selected().context(
            "音声プロバイダがありません。/manage speech/catalog で設定を確認してください",
        )?;
        let mut request = json!({"audioBase64":{"$file":path},"providerId":provider["id"]});
        if let Some(language) = self.catalog["selection"]["language"].as_str() {
            request["language"] = json!(language);
        }
        self.phase = Phase::Transcribing(start_job(
            backend,
            "speech/transcribe",
            json!({"request":request}),
        )?);
        self.notice = "音声を転写中。結果は下書きに入れ、送信しません".into();
        Ok(())
    }
    pub(super) fn key(&mut self, key: KeyEvent, backend: &dyn HarnessBackend) -> Result<bool> {
        if key.kind == KeyEventKind::Release {
            return Ok(false);
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && matches!(key.code, KeyCode::Char(']' | '5')) {
            self.cancel(backend);
            return Ok(true);
        }
        if ctrl && key.code == KeyCode::Char('c') {
            self.cancel(backend);
            return Ok(true);
        }
        if key.code == KeyCode::Esc {
            self.cancel(backend);
            return Ok(true);
        }
        match &mut self.phase {
            Phase::Confirm(selected) | Phase::Send(selected) => match key.code {
                KeyCode::Tab | KeyCode::BackTab | KeyCode::Left | KeyCode::Right => {
                    *selected = !*selected
                }
                KeyCode::Enter if key.kind == KeyEventKind::Press => {
                    let accepted = *selected;
                    *selected = false;
                    if !accepted {
                        if matches!(self.phase, Phase::Send(_)) {
                            self.phase = Phase::Ready;
                        } else {
                            return Ok(true);
                        }
                    } else if matches!(self.phase, Phase::Confirm(_)) {
                        self.start_capture()?;
                    } else {
                        self.transcribe(backend)?;
                    }
                }
                _ => {}
            },
            Phase::Recording if key.code == KeyCode::Char(' ') || key.code == KeyCode::Enter => {
                self.stop_capture()
            }
            Phase::Ready => match key.code {
                KeyCode::Char('t') => self.phase = Phase::Send(false),
                KeyCode::Char('p') => {
                    let n = self.catalog["providers"].as_array().map_or(0, Vec::len);
                    if n > 0 {
                        self.provider = Some((self.provider.unwrap_or(0) + 1) % n);
                    }
                }
                KeyCode::Char('r') => self.phase = Phase::Confirm(false),
                _ => {}
            },
            Phase::Failed if key.code == KeyCode::Char('r') => self.phase = Phase::Confirm(false),
            _ => {}
        }
        Ok(false)
    }
    pub(super) fn poll(&mut self, backend: &dyn HarnessBackend) {
        if Instant::now() < self.next_poll {
            return;
        }
        self.next_poll = Instant::now() + Duration::from_millis(100);
        if let Some(id) = self.catalog_job.clone() {
            match job(backend, &id) {
                Ok(value) if active(&value) => {}
                Ok(value) => {
                    self.catalog_job = None;
                    if value["status"] == "complete" {
                        self.catalog = value["result"].clone();
                        let selected = self.catalog["selection"]["providerId"].clone();
                        self.provider = self.catalog["providers"].as_array().and_then(|rows| {
                            rows.iter()
                                .position(|p| p["id"] == selected)
                                .or_else(|| (!rows.is_empty()).then_some(0))
                        });
                    }
                }
                Err(_) => self.catalog_job = None,
            }
        }
        if self.child.is_some() {
            if matches!(self.phase, Phase::Recording)
                && self.started.elapsed() > Duration::from_secs(MAX_SECONDS + 2)
            {
                self.stop_capture();
            }
            let timed_out = self
                .stopped
                .is_some_and(|t| t.elapsed() > Duration::from_secs(5));
            let result = self.child.as_mut().unwrap().try_wait();
            if timed_out {
                self.kill_capture();
                self.phase = Phase::Failed;
                self.notice =
                    "録音の停止がタイムアウトしました。マイク権限を確認してください".into();
            } else if let Ok(Some(status)) = result {
                self.child.take();
                if status.success()
                    && self
                        .path
                        .as_deref()
                        .is_some_and(|p| validate_wav(p).is_ok())
                {
                    self.phase = Phase::Ready;
                    self.notice =
                        "録音を保存しました。Tで転写、Pでプロバイダ選択、Rで再録音".into();
                } else {
                    self.phase = Phase::Failed;
                    self.notice =
                        "録音できませんでした。OSのマイク権限・入力デバイスを確認してください"
                            .into();
                }
            } else if result.is_err() {
                self.kill_capture();
                self.phase = Phase::Failed;
                self.notice = "録音プロセスの状態を取得できません".into();
            }
        }
        if let Phase::Transcribing(id) = &self.phase {
            match job(backend, id) {
                Ok(value) if active(&value) => {}
                Ok(value) => {
                    if value["status"] == "complete" {
                        if let Some(text) = value["result"]["text"]
                            .as_str()
                            .filter(|s| s.len() <= editor::INPUT_LIMIT)
                        {
                            self.transcript = Some(editor::clean(text));
                            self.phase = Phase::Done;
                            return;
                        }
                    }
                    self.phase = Phase::Ready;
                    self.notice =
                        "音声を転写できませんでした。プロバイダの準備・設定を確認してください"
                            .into();
                }
                Err(error) => {
                    self.notice = backend.redact(&error.to_string());
                    self.phase = Phase::Ready;
                }
            }
        }
    }
    fn kill_capture(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    pub(super) fn cancel(&mut self, backend: &dyn HarnessBackend) {
        self.kill_capture();
        if let Phase::Transcribing(id) = &self.phase {
            let _ = backend.request("/api/admin/cancel", json!({"jobId":id}));
        }
        if let Some(id) = self.catalog_job.take() {
            let _ = backend.request("/api/admin/cancel", json!({"jobId":id}));
        }
        self.phase = Phase::Done;
    }
    pub(super) fn take_transcript(&mut self) -> Option<String> {
        self.transcript.take()
    }
    pub(super) fn draw(&mut self, frame: &mut Frame, area: Rect) {
        frame.render_widget(Clear, area);
        let block = Block::default()
            .borders(Borders::ALL)
            .title(" 音声入力 ")
            .border_style(Style::default().fg(Color::Cyan));
        let inner = block.inner(area);
        frame.render_widget(block, area);
        let provider = self
            .selected()
            .map(|p| {
                format!(
                    "{} ({})",
                    p["name"].as_str().unwrap_or("音声プロバイダ"),
                    p["location"].as_str().unwrap_or("場所未取得")
                )
            })
            .unwrap_or_else(|| "未設定（/manage speech/catalog）".into());
        let content=match self.phase {
            Phase::Confirm(selected)=>format!("システムのマイクから録音します。OSのマイク許可が必要です。\n最長120秒。音声はローカルWAVへ保存し、転写前に送信先を確認します。\n\n{}\n\nTab 選択 / Enter 決定 / Esc 閉じる",if selected{"戻る    [録音開始]"}else{"[戻る]    録音開始"}),
            Phase::Send(selected)=>format!("録音を次のプロバイダへ転写のため送信します。\n{provider}\n結果は会話の下書きへ入り、自動送信しません。\n\n{}\nTab 選択 / Enter 決定",if selected{"戻る    [転写する]"}else{"[戻る]    転写する"}),
            _=>format!("{}\n\n経過: {}秒\n送信先: {}\n録音: {}\n\nSpace 停止 / T 転写 / P プロバイダ / R 再録音\nEsc / Ctrl+] 閉じる",self.notice,self.started.elapsed().as_secs().min(MAX_SECONDS),provider,self.path.as_ref().map(|p|p.display().to_string()).unwrap_or_default()),
        };
        frame.render_widget(
            Paragraph::new(editor::clean(&content)).wrap(Wrap { trim: false }),
            inner,
        );
    }
}
impl Drop for Pane {
    fn drop(&mut self) {
        self.kill_capture();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<(String, Value)>>,
    }
    impl HarnessBackend for Fake {
        fn snapshot(&self) -> Value {
            json!({})
        }
        fn request(&self, path: &str, body: Value) -> Result<Value> {
            self.calls.lock().unwrap().push((path.into(), body));
            Ok(json!({"jobId":"fixture","status":"complete","result":{"text":"転写結果"}}))
        }
        fn cancel(&self) {}
        fn reset(&self) -> Result<()> {
            Ok(())
        }
        fn redact(&self, s: &str) -> String {
            s.into()
        }
    }
    #[test]
    fn capture_requires_confirmation_and_shrink_clears_selection() {
        let backend = Fake::default();
        let mut pane = Pane::new(&backend);
        pane.key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE), &backend)
            .unwrap();
        pane.clear_confirmation();
        assert!(pane
            .key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE), &backend)
            .unwrap());
        assert!(pane.child.is_none());
        assert!(pane.path.is_none());
    }
    #[test]
    fn transcript_is_draft_only_and_cancel_propagates() {
        let backend = Fake::default();
        let mut pane = Pane::new(&backend);
        pane.catalog_job = None;
        pane.phase = Phase::Transcribing("audio".into());
        pane.poll(&backend);
        assert_eq!(pane.take_transcript().as_deref(), Some("転写結果"));
        assert!(backend
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|(p, _)| p != "/api/message"));
        pane.phase = Phase::Transcribing("second".into());
        pane.cancel(&backend);
        assert!(backend
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(p, v)| p == "/api/admin/cancel" && v["jobId"] == "second"));
    }
    #[test]
    fn wav_format_and_private_file_are_checked() {
        let path = recording_path().unwrap();
        assert!(validate_wav(&path).is_err());
        let mut bytes = vec![0; 46];
        bytes[..4].copy_from_slice(b"RIFF");
        bytes[4..8].copy_from_slice(&38u32.to_le_bytes());
        bytes[8..16].copy_from_slice(b"WAVEfmt ");
        bytes[16..20].copy_from_slice(&16u32.to_le_bytes());
        bytes[20..24].copy_from_slice(&[1, 0, 1, 0]);
        bytes[24..28].copy_from_slice(&16000u32.to_le_bytes());
        bytes[28..32].copy_from_slice(&32000u32.to_le_bytes());
        bytes[32..36].copy_from_slice(&[2, 0, 16, 0]);
        bytes[36..40].copy_from_slice(b"data");
        bytes[40..44].copy_from_slice(&2u32.to_le_bytes());
        fs::write(&path, &bytes).unwrap();
        assert!(validate_wav(&path).is_ok());
        bytes[20] = 3;
        assert!(validate_wav_bytes(&bytes).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_file(&path).unwrap();
        fs::remove_dir(path.parent().unwrap()).unwrap();
    }
    #[test]
    #[ignore = "requires local ffmpeg; synthetic audio only, never opens a microphone"]
    fn synthetic_capture_stops_and_reaches_ready() {
        let backend = Fake::default();
        let mut pane = Pane::new(&backend);
        pane.catalog_job = None;
        let path = recording_path().unwrap();
        pane.child = Some(
            spawn_capture(
                &[
                    "-f".into(),
                    "lavfi".into(),
                    "-i".into(),
                    "sine=frequency=440:duration=0.2".into(),
                ],
                &path,
            )
            .unwrap(),
        );
        pane.path = Some(path.clone());
        pane.phase = Phase::Recording;
        let deadline = Instant::now() + Duration::from_secs(10);
        while pane.child.is_some() && Instant::now() < deadline {
            pane.next_poll = Instant::now();
            pane.poll(&backend);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(matches!(pane.phase, Phase::Ready), "{}", pane.notice);
        validate_wav(&path).unwrap();
        pane.cancel(&backend);
        fs::remove_file(&path).unwrap();
        fs::remove_dir(path.parent().unwrap()).unwrap();
    }
}
