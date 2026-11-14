//! First-run provisioning. HTTP clients select fixed actions, never commands,
//! paths, download URLs or arbitrary model names.
mod cloud;
mod local;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

pub const MODELS: &[(&str, u64)] = &[
    ("qwen3:1.7b", 1_400_000_000),
    ("qwen3:4b", 2_500_000_000),
    ("qwen3:8b", 5_200_000_000),
];
pub fn model_allowed(model: &str) -> bool {
    MODELS.iter().any(|(id, _)| *id == model)
}
pub fn root() -> Result<PathBuf> {
    Ok(
        PathBuf::from(crate::auth::home().context("HOME_UNAVAILABLE")?)
            .join(".local/share/rdsh/runtime"),
    )
}
#[derive(Default, Clone, Serialize)]
pub struct State {
    pub running: bool,
    pub action: String,
    pub phase: String,
    pub completed: u64,
    pub total: Option<u64>,
    pub model: Option<String>,
    pub error: Option<String>,
    pub ready: bool,
}
#[derive(Default)]
pub struct Manager {
    state: Mutex<State>,
    cancelled: AtomicBool,
    closed: AtomicBool,
    choices: Mutex<Vec<cloud::Choice>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    action: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    provider: Option<String>,
}
impl Manager {
    pub fn close_if_idle(&self) -> bool {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.running {
            return false;
        }
        self.closed.store(true, Ordering::Relaxed);
        true
    }
    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.cancelled.store(true, Ordering::Relaxed);
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.state.lock().unwrap_or_else(|p| p.into_inner()).running
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    pub fn status(&self) -> serde_json::Value {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner()).clone();
        // Progress polling must not rescan credentials, profiles or local ports.
        // Retain the last catalog while a job is active; refresh after it ends.
        let choices = if state.running {
            self.choices
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone()
        } else {
            let choices = cloud::choices();
            *self.choices.lock().unwrap_or_else(|p| p.into_inner()) = choices.clone();
            choices
        };
        serde_json::json!({"job":state, "models":MODELS.iter().map(|(id,bytes)|serde_json::json!({"id":id,"bytes":bytes})).collect::<Vec<_>>(), "selected":selection(), "choices":choices, "local_available":local::installed()})
    }
    pub fn start(self: &Arc<Self>, body: &[u8]) -> Result<()> {
        let request: Request = serde_json::from_slice(body).context("INVALID_REQUEST")?;
        if request.action == "cancel" {
            self.cancelled.store(true, Ordering::Relaxed);
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.running {
                state.phase = "cancelling".into();
            }
            return Ok(());
        }
        if !matches!(
            request.action.as_str(),
            "runtime" | "codex" | "local-model" | "select"
        ) {
            bail!("INVALID_ACTION");
        }
        if request.action == "local-model" && !request.model.as_deref().is_some_and(model_allowed) {
            bail!("INVALID_MODEL");
        }
        if matches!(request.action.as_str(), "runtime" | "codex") && request.model.is_some() {
            bail!("INVALID_MODEL");
        }
        let selected_cloud = if request.action == "select" {
            let provider = request.provider.as_deref().context("INVALID_PROVIDER")?;
            let model = request.model.as_deref().context("INVALID_MODEL")?;
            Some(
                cloud::choices()
                    .into_iter()
                    .find(|c| c.provider == provider && c.model == model)
                    .context("INVALID_MODEL")?,
            )
        } else {
            if request.provider.is_some() {
                bail!("INVALID_PROVIDER");
            }
            None
        };
        {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.running || self.closed.load(Ordering::Relaxed) {
                bail!("ALREADY_RUNNING");
            }
            self.cancelled.store(false, Ordering::Relaxed);
            *state = State {
                running: true,
                action: request.action.clone(),
                phase: "preparing".into(),
                model: request.model.clone(),
                ..State::default()
            };
        }
        let manager = self.clone();
        std::thread::spawn(move || {
            let result = (|| {
                if matches!(request.action.as_str(), "runtime" | "codex") {
                    install_runtime_for(&manager, request.action == "codex")?;
                } else if let Some(choice) = selected_cloud {
                    save_cloud_selection(&choice)?;
                } else {
                    let model = request.model.as_deref().context("INVALID_MODEL")?;
                    local::prepare(&manager, model)?;
                    manager.check_cancelled()?;
                    save_selection(model)?;
                }
                Ok::<_, anyhow::Error>(())
            })();
            let mut state = manager.state.lock().unwrap_or_else(|p| p.into_inner());
            state.running = false;
            match result {
                Ok(()) => {
                    state.ready = true;
                    state.phase = "complete".into();
                }
                Err(error) => {
                    // Never return raw child output, URLs with secrets, or file contents.
                    let code = error.to_string();
                    state.error = Some(
                        if [
                            "CANCELLED",
                            "CHECKSUM_MISMATCH",
                            "UNSUPPORTED_HOST",
                            "MODEL_PULL_FAILED",
                            "LOCAL_SERVER_FAILED",
                            "DOWNLOAD_FAILED",
                            "RUNTIME_INSTALL_FAILED",
                            "EXTRACTION_FAILED",
                            "INSUFFICIENT_SPACE",
                        ]
                        .contains(&code.as_str())
                        {
                            code
                        } else {
                            "PROVISION_FAILED".into()
                        },
                    );
                    state.phase = "failed".into();
                }
            }
        });
        Ok(())
    }
    pub(super) fn progress(&self, phase: &str, completed: u64, total: Option<u64>) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.phase = phase.into();
        state.completed = completed;
        state.total = total;
    }
    pub(super) fn check_cancelled(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            bail!("CANCELLED");
        }
        Ok(())
    }
}

pub(super) struct Scratch(pub PathBuf);
impl Scratch {
    pub(super) fn new() -> Result<Self> {
        Self::in_dir(&std::env::temp_dir())
    }
    pub(super) fn in_dir(parent: &Path) -> Result<Self> {
        let path = parent.join(format!(
            "rdsh-provision-{}",
            crate::local_http::random_token()?
        ));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path)?;
        Ok(Self(path))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn command(
    manager: &Manager,
    mut command: std::process::Command,
    timeout: Duration,
) -> Result<()> {
    use std::process::Stdio;
    manager.check_cancelled()?;
    // Output goes to private scratch storage, never a pipe that could block.
    let scratch = Scratch::new()?;
    let log = std::fs::File::create(scratch.0.join("command.log"))?;
    command
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    crate::worker_git::configure_process_tree(&mut command);
    #[allow(unused_mut)]
    let mut spawned = command.spawn().context("PROVISION_FAILED")?;
    #[cfg(windows)]
    let job = match crate::worker_git::ProcessTreeGuard::attach(&mut spawned) {
        Ok(job) => job,
        Err(error) => {
            let _ = spawned.kill();
            let _ = spawned.wait();
            return Err(error.into());
        }
    };
    struct OwnedChild {
        child: std::process::Child,
        #[cfg(windows)]
        _job: crate::worker_git::ProcessTreeGuard,
    }
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(self.child.id() as i32), libc::SIGKILL);
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
    let mut child = OwnedChild {
        child: spawned,
        #[cfg(windows)]
        _job: job,
    };
    let deadline = Instant::now() + timeout;
    loop {
        manager.check_cancelled()?;
        if let Some(status) = child.child.try_wait()? {
            if status.success() {
                return Ok(());
            }
            bail!("PROVISION_FAILED");
        }
        if Instant::now() >= deadline {
            bail!("PROVISION_FAILED");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn install_runtime(manager: &Manager) -> Result<()> {
    install_runtime_for(manager, false)
}
fn install_runtime_for(manager: &Manager, codex: bool) -> Result<()> {
    manager.progress("runtime", 0, None);
    let scratch = Scratch::new()?;
    #[cfg(unix)]
    let mut process = {
        let script = scratch.0.join("install.sh");
        std::fs::write(&script, include_str!("../install.sh"))?;
        let mut cmd = std::process::Command::new("bash");
        cmd.arg(script).arg("--runtime-only");
        if codex {
            cmd.arg("--with-codex");
        }
        cmd
    };
    #[cfg(windows)]
    let mut process = {
        let script = scratch.0.join("install.ps1");
        std::fs::write(&script, include_str!("../install.ps1"))?;
        let system = PathBuf::from(std::env::var_os("SystemRoot").context("UNSUPPORTED_HOST")?);
        let mut cmd = std::process::Command::new(
            system.join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .arg("-RuntimeOnly");
        if codex {
            cmd.arg("-WithCodex");
        }
        cmd
    };
    #[cfg(not(any(unix, windows)))]
    {
        bail!("UNSUPPORTED_HOST");
    }
    #[cfg(any(unix, windows))]
    {
        process.env("RDSH_SKIP_RUNTIME", "0");
        command(manager, process, Duration::from_secs(900))
            .map_err(|error| operation_error(error, "RUNTIME_INSTALL_FAILED"))
    }
}
pub(super) fn operation_error(error: anyhow::Error, code: &str) -> anyhow::Error {
    if error.to_string() == "CANCELLED" {
        error
    } else {
        anyhow::anyhow!("{code}")
    }
}
fn selection_path() -> Result<PathBuf> {
    Ok(root()?.join("first-model.json"))
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub provider: String,
    pub model: String,
    pub profiles: Vec<String>,
}
pub fn selection() -> Option<Selection> {
    let path = selection_path().ok()?;
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > 4096 {
        return None;
    }
    let value: Selection = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if value.provider.is_empty()
        || value.provider.len() > 200
        || value.provider.chars().any(char::is_control)
        || value.model.is_empty()
        || value.model.len() > 200
        || value.model.chars().any(char::is_control)
        || value.profiles.is_empty()
        || value.profiles.len() > 2
        || value
            .profiles
            .iter()
            .any(|p| !matches!(p.as_str(), "web" | "tui"))
    {
        return None;
    }
    if value.provider == "rdsh-local" && !model_allowed(&value.model) {
        return None;
    }
    Some(value)
}
fn save_cloud_selection(choice: &cloud::Choice) -> Result<()> {
    let text = format!(
        "- id: agent-default-model\n  config:\n    provider: {}\n    model: {}\n",
        serde_json::to_string(&choice.provider)?,
        serde_json::to_string(&choice.model)?
    );
    persist_selection(
        &Selection {
            provider: choice.provider.clone(),
            model: choice.model.clone(),
            profiles: choice.profiles.clone(),
        },
        &text,
    )
}
fn save_selection(model: &str) -> Result<()> {
    anyhow::ensure!(model_allowed(model), "INVALID_MODEL");
    let text = crate::providers::setup_local_overlay(model)?;
    persist_selection(
        &Selection {
            provider: "rdsh-local".into(),
            model: model.into(),
            profiles: vec!["web".into(), "tui".into()],
        },
        &text,
    )
}
fn persist_selection(selection: &Selection, text: &str) -> Result<()> {
    let root = root()?;
    std::fs::create_dir_all(&root)?;
    let overlay = root.join("first-model.yml");
    atomic_write(&overlay, text.as_bytes())?;
    atomic_write(&selection_path()?, &serde_json::to_vec(selection)?)
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension(format!("tmp-{}", crate::local_http::random_token()?));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        replace_file(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
#[cfg(not(windows))]
fn replace_file(source: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::rename(source, dest)
}
#[cfg(windows)]
fn replace_file(source: &Path, dest: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let dest: Vec<u16> = dest.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(source.as_ptr(), dest.as_ptr(), 1 | 8) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub fn selected_for(profile: &str) -> bool {
    selection().is_some_and(|s| s.profiles.iter().any(|p| p == profile))
}
pub fn apply_launch(command: &mut std::process::Command, dry: bool, profile: &str) -> Result<bool> {
    let Some(selected) = selection() else {
        return Ok(false);
    };
    if !selected.profiles.iter().any(|p| p == profile) {
        return Ok(false);
    }
    let overlay = root()?.join("first-model.yml");
    let text = if selected.provider == "rdsh-local" {
        crate::providers::setup_local_overlay(&selected.model)?
    } else {
        format!(
            "- id: agent-default-model\n  config:\n    provider: {}\n    model: {}\n",
            serde_json::to_string(&selected.provider)?,
            serde_json::to_string(&selected.model)?
        )
    };
    if !dry {
        atomic_write(&overlay, text.as_bytes())?;
    }
    if !dry && selected.provider == "rdsh-local" {
        local::ensure_service()?;
    }
    command.arg("--patch").arg(overlay);
    if selected.provider == "rdsh-local" {
        command.env("RDSH_LOCAL_API_KEY", "no-key");
    }
    Ok(true)
}

pub fn managed_login() -> Option<PathBuf> {
    let path = root()
        .ok()?
        .join("bin")
        .join(if cfg!(windows) { "codex.cmd" } else { "codex" });
    crate::executable::is_executable(&path).then_some(path)
}

/// Make privately installed runtime tools available to every delegated command.
pub fn managed_node() -> Option<PathBuf> {
    let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("macos", "aarch64") => "darwin-arm64",
        ("windows", "x86_64") => "win-x64",
        ("windows", "aarch64") => "win-arm64",
        _ => return None,
    };
    let file = root()
        .ok()?
        .join(format!("node-v24.22.1-{platform}"))
        .join(if cfg!(windows) {
            "node.exe"
        } else {
            "bin/node"
        });
    crate::executable::is_executable(&file).then_some(file)
}
pub fn runtime_environment(command: &mut std::process::Command) -> Result<()> {
    let Ok(root) = root() else {
        return Ok(());
    };
    let mut paths = Vec::new();
    if let Some(node) = managed_node() {
        if let Some(parent) = node.parent() {
            paths.push(parent.to_path_buf());
        }
    }
    if root.join("bin").is_dir() {
        paths.push(root.join("bin"));
    }
    if paths.is_empty() {
        return Ok(());
    }
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    command.env("PATH", std::env::join_paths(paths)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_cannot_supply_commands_paths_or_unlisted_models() {
        for body in [
            r#"{"action":"shell"}"#,
            r#"{"action":"local-model","model":"../../bin/sh"}"#,
            r#"{"action":"local-model","model":"qwen3:4b","url":"http://evil"}"#,
            r#"{"action":"runtime","model":"qwen3:4b"}"#,
        ] {
            assert!(Arc::new(Manager::default()).start(body.as_bytes()).is_err());
        }
    }
    #[cfg(unix)]
    #[test]
    fn cancellation_kills_install_descendants() {
        let scratch = Scratch::new().unwrap();
        let marker = scratch.0.join("child-marker");
        let manager = Arc::new(Manager::default());
        let cancelling = manager.clone();
        let cancel = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancelling.cancelled.store(true, Ordering::Relaxed);
        });
        let mut process = std::process::Command::new("sh");
        process
            .args(["-c", "(sleep 0.5; printf survived > \"$1\") & wait", "sh"])
            .arg(&marker);
        assert_eq!(
            command(&manager, process, Duration::from_secs(3))
                .unwrap_err()
                .to_string(),
            "CANCELLED"
        );
        cancel.join().unwrap();
        std::thread::sleep(Duration::from_millis(600));
        assert!(!marker.exists(), "a descendant survived cancellation");
    }
    #[test]
    fn closed_setup_cannot_start_installation() {
        let manager = Arc::new(Manager::default());
        assert!(manager.close_if_idle());
        assert!(manager.start(br#"{"action":"runtime"}"#).is_err());
    }
    #[test]
    fn atomic_selection_write_can_replace_previous_file() {
        let scratch = Scratch::new().unwrap();
        let path = scratch.0.join("selection.json");
        atomic_write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert_eq!(std::fs::read_dir(&scratch.0).unwrap().count(), 1);
    }
    #[test]
    fn cancellation_does_not_start_a_process() {
        let manager = Arc::new(Manager::default());
        manager.start(br#"{"action":"cancel"}"#).unwrap();
        assert!(manager.check_cancelled().is_err());
        assert!(!manager.status()["job"]["running"].as_bool().unwrap());
    }
}
