//! Inference-only official SDK transport. Rust owns history, validation and tools.
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::{
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};

const LIMIT: usize = 8 * 1024 * 1024;

pub struct SdkConfig {
    pub bridge_dir: PathBuf,
    /// Resolved once by the harness from its authorized credential store.
    pub agy_key: Option<String>,
}

/// Receives a model JSON envelope as plain text. No SDK tool is exposed.
/// Credentials come exclusively from inherited allowlisted environment variables
/// or Cursor's official store under HOME. No credential file is parsed here.
pub async fn generate(
    config: &SdkConfig,
    provider: &str,
    model: &str,
    prompt: &str,
) -> Result<String> {
    if model.is_empty()
        || prompt.is_empty()
        || prompt.len() > LIMIT
        || !config.bridge_dir.is_absolute()
    {
        bail!("SDK_INVALID_REQUEST");
    }
    let (mut command, payload) = match provider {
        "cursor-sdk" => {
            let mut command = Command::new("node");
            command.arg(config.bridge_dir.join("cursor-sdk-runner.mjs"));
            (
                command,
                serde_json::json!({"action":"generate","model":model,"prompt":prompt}),
            )
        }
        "agy-sdk" => {
            let mut command = Command::new(config.bridge_dir.join(".venv/bin/python"));
            command.arg(config.bridge_dir.join("agy-sdk.py"));
            (
                command,
                serde_json::json!({"operation":"generate","model":model,"prompt":prompt}),
            )
        }
        _ => bail!("SDK_UNKNOWN_PROVIDER"),
    };
    let input = serde_json::to_vec(&payload).map_err(|_| anyhow::anyhow!("SDK_INVALID_REQUEST"))?;
    if input.len() > LIMIT {
        bail!("SDK_INPUT_LIMIT");
    }
    command.env_clear();
    for key in [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "TMPDIR",
        "TEMP",
        "TMP",
        "SystemRoot",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let keys: &[&str] = if provider == "cursor-sdk" {
        &["CURSOR_API_KEY"]
    } else {
        &["GEMINI_API_KEY", "GOOGLE_API_KEY"]
    };
    for key in keys {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    if provider == "agy-sdk" {
        if let Some(key) = &config.agy_key {
            command
                .env("GEMINI_API_KEY", key)
                .env("GOOGLE_API_KEY", key);
        }
    }
    let workspace = TemporaryRoot::create()?;
    command.env("RDSH_SDK_TMPDIR", &workspace.0);
    command.current_dir(&config.bridge_dir);
    let (status, stdout, _stderr) = run_process(command, &input, 120, LIMIT).await?;
    decode_sdk_response(status, &stdout)
}

fn decode_sdk_response(status: i32, bytes: &[u8]) -> Result<String> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("SDK_INVALID_RESPONSE"))?;
    if let Some(error) = value.get("error") {
        let safe = match error.as_str() {
            Some("SDK_AUTH_REQUIRED") => "SDK_AUTH_REQUIRED",
            Some("SDK_NOT_INSTALLED") => "SDK_NOT_INSTALLED",
            Some("SDK_TOOL_DETECTED") => "SDK_TOOL_DETECTED",
            Some("INPUT_LIMIT") => "SDK_INPUT_LIMIT",
            Some("OUTPUT_LIMIT") => "SDK_OUTPUT_LIMIT",
            Some("INVALID_REQUEST") => "SDK_INVALID_REQUEST",
            Some("INVALID_RESPONSE") => "SDK_INVALID_RESPONSE",
            _ => "SDK_REQUEST_FAILED",
        };
        if value.get("httpStatus").and_then(Value::as_u64) == Some(429) {
            if value.get("quotaScope").and_then(Value::as_str) == Some("daily") {
                bail!("SDK_RATE_LIMITED_HTTP_429_DAILY");
            }
            bail!("SDK_RATE_LIMITED_HTTP_429");
        }
        bail!("{safe}");
    }
    if status != 0 {
        bail!("SDK_REQUEST_FAILED");
    }
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .context("SDK_INVALID_RESPONSE")?;
    if text.len() > LIMIT || text.is_empty() {
        bail!("SDK_INVALID_RESPONSE");
    }
    Ok(text.to_owned())
}

/// Bounded child transport shared by inference and the explicitly approved Devin
/// tool. Caller must construct fixed arguments, clear/allowlist env and sanitize
/// returned bytes before displaying them. All error messages here are fixed.
pub async fn run_process(
    mut command: Command,
    input: &[u8],
    timeout_secs: u64,
    limit: usize,
) -> Result<(i32, Vec<u8>, Vec<u8>)> {
    if timeout_secs == 0 || limit == 0 || input.len() > limit {
        bail!("PROCESS_INVALID_LIMIT");
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| anyhow::anyhow!("PROCESS_SPAWN_FAILED"))?;
    let _group = ProcessGroupGuard(child.id());
    let mut stdin = child.stdin.take().context("PROCESS_PIPE_FAILED")?;
    let stdout = child.stdout.take().context("PROCESS_PIPE_FAILED")?;
    let stderr = child.stderr.take().context("PROCESS_PIPE_FAILED")?;
    let budget = Arc::new(AtomicUsize::new(0));
    let transaction = async {
        let writer = async {
            stdin
                .write_all(input)
                .await
                .map_err(|_| anyhow::anyhow!("PROCESS_INPUT_FAILED"))?;
            stdin
                .shutdown()
                .await
                .map_err(|_| anyhow::anyhow!("PROCESS_INPUT_FAILED"))?;
            // Close the descriptor before waiting; SDKs read JSON until EOF.
            drop(stdin);
            Ok::<_, anyhow::Error>(())
        };
        let waiter = async {
            child
                .wait()
                .await
                .map_err(|_| anyhow::anyhow!("PROCESS_WAIT_FAILED"))
        };
        let (_, output, errors, status) = tokio::try_join!(
            writer,
            read_bounded(stdout, budget.clone(), limit),
            read_bounded(stderr, budget, limit),
            waiter
        )?;
        Ok((status.code().unwrap_or(-1), output, errors))
    };
    tokio::time::timeout(Duration::from_secs(timeout_secs), transaction)
        .await
        .map_err(|_| anyhow::anyhow!("PROCESS_TIMEOUT"))?
}

async fn read_bounded(
    mut reader: impl AsyncRead + Unpin,
    budget: Arc<AtomicUsize>,
    limit: usize,
) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let count = reader
            .read(&mut chunk)
            .await
            .map_err(|_| anyhow::anyhow!("PROCESS_OUTPUT_FAILED"))?;
        if count == 0 {
            return Ok(output);
        }
        if budget
            .fetch_add(count, Ordering::Relaxed)
            .saturating_add(count)
            > limit
        {
            bail!("PROCESS_OUTPUT_LIMIT");
        }
        output.extend_from_slice(&chunk[..count]);
    }
}

struct ProcessGroupGuard(Option<u32>);
impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(id) = self.0 {
            if let Ok(id) = i32::try_from(id) {
                // Dedicated group excludes the harness. Also kills descendants
                // after the leader exits, on timeout, or future cancellation.
                unsafe {
                    libc::kill(-id, libc::SIGKILL);
                }
            }
        }
    }
}

struct TemporaryRoot(PathBuf);
impl TemporaryRoot {
    fn create() -> Result<Self> {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| anyhow::anyhow!("SDK_TEMP_FAILED"))?;
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = std::env::temp_dir().join(format!("rdsh-native-sdk-{suffix}"));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&path)
            .map_err(|_| anyhow::anyhow!("SDK_TEMP_FAILED"))?;
        Ok(Self(path))
    }
}
impl Drop for TemporaryRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_envelope_returned_without_execution() {
        let text = r#"{"tool_calls":[{"name":"read","arguments":{"path":"nonce.txt"}}]}"#;
        let stdout = serde_json::to_vec(&serde_json::json!({"text":text})).unwrap();
        assert_eq!(decode_sdk_response(0, &stdout).unwrap(), text);
    }
    #[test]
    fn errors_never_echo_untrusted_sdk_messages() {
        let error = decode_sdk_response(
            1,
            br#"{"error":"SECRET_ACCESS_TOKEN","exceptionClass":"SECRET"}"#,
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "SDK_REQUEST_FAILED");
        assert_eq!(
            decode_sdk_response(0, b"secret invalid json")
                .unwrap_err()
                .to_string(),
            "SDK_INVALID_RESPONSE"
        );
        assert_eq!(
            decode_sdk_response(1, br#"{"error":"SDK_REQUEST_FAILED","httpStatus":429}"#)
                .unwrap_err()
                .to_string(),
            "SDK_RATE_LIMITED_HTTP_429"
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stdin_eof_and_both_output_streams() {
        let mut command = Command::new("/bin/sh");
        command
            .env_clear()
            .arg("-c")
            .arg("/bin/cat; printf stderr >&2");
        let (code, out, err) = run_process(command, b"payload", 2, 128).await.unwrap();
        assert_eq!(
            (code, out, err),
            (0, b"payload".to_vec(), b"stderr".to_vec())
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn combined_output_is_bounded() {
        let mut command = Command::new("/bin/sh");
        command
            .env_clear()
            .arg("-c")
            .arg("printf 12345; printf 67890 >&2");
        assert_eq!(
            run_process(command, b"", 2, 8)
                .await
                .unwrap_err()
                .to_string(),
            "PROCESS_OUTPUT_LIMIT"
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_covers_descendants_holding_output_pipes() {
        let mut command = Command::new("/bin/sh");
        command.env_clear().arg("-c").arg("/bin/sleep 30 & exit 0");
        assert_eq!(
            run_process(command, b"", 1, 128)
                .await
                .unwrap_err()
                .to_string(),
            "PROCESS_TIMEOUT"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn abort_kills_descendants_before_they_can_write() {
        let root = TemporaryRoot::create().unwrap();
        let started = root.0.join("started");
        let leader = root.0.join("leader");
        let release = root.0.join("release");
        let survivor = root.0.join("survivor");
        let mut command = Command::new("/bin/sh");
        command
            .env_clear()
            .arg("-c")
            .arg(r#"/bin/sh -c 'printf "%s\n" "$$" > "$1"; while [ ! -e "$2" ]; do /bin/sleep 0.01; done; printf survivor > "$3"' fixture-child "$1" "$2" "$3" & printf "%s\n" "$$" > "$4"; wait"#)
            .arg("test-child")
            .arg(&started)
            .arg(&release)
            .arg(&survivor)
            .arg(&leader);
        let task = tokio::spawn(async move { run_process(command, b"", 30, 128).await });
        // Readiness must come from the actual descendant after fork/exec,
        // not the leader before it has even created a background process.
        let (parent_pid, child_pid) = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let read_pid = |path: &std::path::Path| {
                    std::fs::read_to_string(path)
                        .ok()?
                        .trim()
                        .parse::<u32>()
                        .ok()
                };
                if let (Some(parent), Some(child)) = (read_pid(&leader), read_pid(&started)) {
                    break (parent, child);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let _cleanup = ProcessGroupGuard(Some(parent_pid));
        assert_ne!(parent_pid, child_pid);
        assert_eq!(
            unsafe { libc::getpgid(child_pid as i32) },
            parent_pid as i32
        );
        assert!(!survivor.exists());
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        // If cancellation leaves the child alive, releasing it now makes the
        // failure observable without racing a pre-cancellation sleep timer.
        std::fs::write(&release, b"release").unwrap();
        tokio::time::sleep(Duration::from_millis(1300)).await;
        assert!(
            !survivor.exists(),
            "descendant survived harness cancellation"
        );
    }
}
