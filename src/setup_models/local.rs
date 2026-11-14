//! Managed Ollama and a bounded, fixed-model first-run download.
use super::{command, root, Manager, Scratch};
use anyhow::{bail, Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};
const HOST: &str = "http://127.0.0.1:11534";
const VERSION: &str = "v0.40.14";
fn artifact() -> Result<(&'static str, &'static str)> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok((
            "ollama-linux-amd64.tar.zst",
            "993e83d08c3d13d17c55009a3e2664c8a25445e644aec3a68bef5abb6abce67d",
        )),
        ("linux", "aarch64") => Ok((
            "ollama-linux-arm64.tar.zst",
            "39bb333b7b4c0bafcdd7fad35eab1ae9aaf4518ea0f2c731de4376e3a29c94d0",
        )),
        ("macos", "x86_64" | "aarch64") => Ok((
            "ollama-darwin.tgz",
            "f3bf9a528e908da0da5a2b3a4ad3252a369d62186501dc4880261e8d9023bff5",
        )),
        ("windows", "x86_64") => Ok((
            "ollama-windows-amd64.zip",
            "65d68cade6cf6375f398b518224f8c8a15e062387f38cf477abfc848de7e7e29",
        )),
        ("windows", "aarch64") => Ok((
            "ollama-windows-arm64.zip",
            "df8a4e954587ac65ba52ec26b453490a21cd58f80b55f75cf0d706f1506764a8",
        )),
        _ => bail!("UNSUPPORTED_HOST"),
    }
}
fn directory() -> Result<PathBuf> {
    Ok(root()?.join(format!("ollama-{VERSION}")))
}
fn binary() -> Result<PathBuf> {
    let directory = directory()?;
    let candidates = if cfg!(windows) {
        vec![directory.join("ollama.exe")]
    } else {
        vec![directory.join("bin/ollama"), directory.join("ollama")]
    };
    Ok(candidates
        .iter()
        .find(|p| p.is_file())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone()))
}
pub(super) fn installed() -> bool {
    binary().is_ok_and(|p| p.is_file())
}
fn runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("PROVISION_FAILED")
}
fn client(timeout: u64) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(timeout))
        .build()
        .context("PROVISION_FAILED")
}
async fn bounded_json(mut response: reqwest::Response) -> Result<Value> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.context("MODEL_PULL_FAILED")? {
        if bytes.len().saturating_add(chunk.len()) > 65536 {
            bail!("MODEL_PULL_FAILED");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).context("MODEL_PULL_FAILED")
}
fn running() -> bool {
    runtime().is_ok_and(|rt| {
        rt.block_on(async {
            let Ok(client) = client(2) else {
                return false;
            };
            let Ok(response) = client.get(format!("{HOST}/api/version")).send().await else {
                return false;
            };
            if !response.status().is_success() {
                return false;
            }
            bounded_json(response)
                .await
                .is_ok_and(|v| v.get("version").and_then(Value::as_str).is_some())
        })
    })
}
pub(super) fn ensure_service() -> Result<()> {
    ensure_service_for(None)
}
fn ensure_service_for(manager: Option<&Manager>) -> Result<()> {
    if running() {
        return Ok(());
    }
    let executable = binary()?;
    if !executable.is_file() {
        bail!("LOCAL_SERVER_FAILED");
    }
    let root = root()?;
    std::fs::create_dir_all(root.join("models"))?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("ollama.log"))?;
    let mut command = std::process::Command::new(executable);
    command
        .arg("serve")
        .current_dir(&root)
        .env_clear()
        .env("HOME", crate::auth::home().context("HOME_UNAVAILABLE")?)
        .env("OLLAMA_HOST", "127.0.0.1:11534")
        .env("OLLAMA_MODELS", root.join("models"))
        .env("OLLAMA_CONTEXT_LENGTH", "4096")
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    for name in [
        "PATH",
        "SystemRoot",
        "USERPROFILE",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
        "SSL_CERT_FILE",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let mut child = command.spawn().context("LOCAL_SERVER_FAILED")?;
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        if manager.is_some_and(|m| m.check_cancelled().is_err()) {
            let _ = child.kill();
            let _ = child.wait();
            bail!("CANCELLED");
        }
        if running() {
            // A background waiter reaps this owned daemon when it eventually exits.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(());
        }
        if child.try_wait()?.is_some() {
            bail!("LOCAL_SERVER_FAILED");
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = child.kill();
    let _ = child.wait();
    bail!("LOCAL_SERVER_FAILED")
}
pub(super) fn node() -> Result<PathBuf> {
    let root = root()?;
    let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("macos", "aarch64") => "darwin-arm64",
        ("windows", "x86_64") => "win-x64",
        ("windows", "aarch64") => "win-arm64",
        _ => bail!("UNSUPPORTED_HOST"),
    };
    let managed = root
        .join(format!("node-v24.22.1-{platform}"))
        .join(if cfg!(windows) {
            "node.exe"
        } else {
            "bin/node"
        });
    if managed.is_file() {
        return Ok(managed);
    }
    crate::passthrough::find_node_bin()
        .map(PathBuf::from)
        .context("RUNTIME_INSTALL_FAILED")
}
async fn send(
    manager: &Manager,
    request: reqwest::RequestBuilder,
    code: &str,
) -> Result<reqwest::Response> {
    let request = request.send();
    tokio::pin!(request);
    loop {
        manager.check_cancelled()?;
        tokio::select! {
            response = &mut request => return response.and_then(reqwest::Response::error_for_status).map_err(|_| anyhow::anyhow!("{code}")),
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
    }
}
async fn download(
    manager: &Manager,
    url: &str,
    path: &std::path::Path,
    expected: &str,
) -> Result<()> {
    let mut response = send(manager, client(1800)?.get(url), "DOWNLOAD_FAILED").await?;
    let total = response.content_length();
    let mut file = std::fs::File::create(path)?;
    let mut hash = Sha256::new();
    let mut completed = 0u64;
    loop {
        manager.check_cancelled()?;
        let chunk = tokio::select! {
            result=response.chunk()=>result.context("DOWNLOAD_FAILED")?,
            _=tokio::time::sleep(Duration::from_millis(300))=>continue,
        };
        let Some(chunk) = chunk else {
            break;
        };
        completed = completed.saturating_add(chunk.len() as u64);
        if completed > 4 * 1024 * 1024 * 1024u64 {
            bail!("DOWNLOAD_FAILED");
        }
        file.write_all(&chunk)?;
        hash.update(&chunk);
        manager.progress("ollama-download", completed, total);
    }
    file.sync_all()?;
    let digest: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if digest != expected {
        bail!("CHECKSUM_MISMATCH");
    }
    Ok(())
}
fn install(manager: &Manager) -> Result<()> {
    if installed() {
        return Ok(());
    }
    let (asset, digest) = artifact()?;
    let root = root()?;
    std::fs::create_dir_all(&root)?;
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(root.as_os_str().as_bytes())?;
        let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } == 0 {
            let stat = unsafe { stat.assume_init() };
            if (stat.f_bavail as u128) * (stat.f_frsize as u128) < 12 * 1024 * 1024 * 1024u128 {
                bail!("INSUFFICIENT_SPACE");
            }
        }
    }
    let scratch = Scratch::in_dir(&root)?;
    let archive = scratch.0.join(asset);
    manager.progress("ollama-download", 0, None);
    runtime()?.block_on(download(
        manager,
        &format!("https://github.com/ollama/ollama/releases/download/{VERSION}/{asset}"),
        &archive,
        digest,
    ))?;
    manager.check_cancelled()?;
    manager.progress("ollama-extract", 0, None);
    let dest = scratch.0.join("expanded");
    std::fs::create_dir(&dest)?;
    if asset.ends_with(".tar.zst") {
        // Node's bundled streaming Zstd support avoids another system dependency.
        let uncompressed = scratch.0.join("ollama.tar");
        let mut cmd = std::process::Command::new(node()?);
        cmd.args(["--input-type=module","-e", "import{createReadStream,createWriteStream}from'node:fs';import{createZstdDecompress}from'node:zlib';import{pipeline}from'node:stream/promises';await pipeline(createReadStream(process.argv[1]),createZstdDecompress(),createWriteStream(process.argv[2]));"]).arg(&archive).arg(&uncompressed);
        command(manager, cmd, Duration::from_secs(900))
            .map_err(|error| super::operation_error(error, "EXTRACTION_FAILED"))?;
        let mut tar = std::process::Command::new("tar");
        tar.arg("-xf").arg(uncompressed).arg("-C").arg(&dest);
        command(manager, tar, Duration::from_secs(900))
            .map_err(|error| super::operation_error(error, "EXTRACTION_FAILED"))?;
    } else if asset.ends_with(".tgz") {
        let mut tar = std::process::Command::new("tar");
        tar.arg("-xzf").arg(&archive).arg("-C").arg(&dest);
        command(manager, tar, Duration::from_secs(900))
            .map_err(|error| super::operation_error(error, "EXTRACTION_FAILED"))?;
    } else {
        #[cfg(windows)]
        {
            let script = scratch.0.join("extract.ps1");
            std::fs::write(&script,"param([string]$Archive,[string]$Destination)\n$ErrorActionPreference='Stop'\nExpand-Archive -LiteralPath $Archive -DestinationPath $Destination\n")?;
            let powershell =
                PathBuf::from(std::env::var_os("SystemRoot").context("UNSUPPORTED_HOST")?)
                    .join("System32/WindowsPowerShell/v1.0/powershell.exe");
            let mut cmd = std::process::Command::new(powershell);
            cmd.args(["-NoProfile", "-NonInteractive", "-File"])
                .arg(script)
                .arg("-Archive")
                .arg(&archive)
                .arg("-Destination")
                .arg(&dest);
            command(manager, cmd, Duration::from_secs(900))
                .map_err(|error| super::operation_error(error, "EXTRACTION_FAILED"))?;
        }
        #[cfg(not(windows))]
        bail!("UNSUPPORTED_HOST");
    }
    manager.check_cancelled()?;
    // Nothing is installed until verification and extraction both succeeded.
    let executable = if cfg!(windows) {
        dest.join("ollama.exe")
    } else if dest.join("bin/ollama").is_file() {
        dest.join("bin/ollama")
    } else {
        dest.join("ollama")
    };
    if !executable.is_file() {
        bail!("EXTRACTION_FAILED");
    }
    std::fs::rename(&dest, directory()?).context("EXTRACTION_FAILED")?;
    if !installed() {
        bail!("EXTRACTION_FAILED");
    }
    Ok(())
}
fn consume_line(manager: &Manager, line: &[u8], success: &mut bool) -> Result<()> {
    if line.is_empty() {
        return Ok(());
    }
    let value: Value = serde_json::from_slice(line).context("MODEL_PULL_FAILED")?;
    if value.get("error").is_some() {
        bail!("MODEL_PULL_FAILED");
    }
    if value["status"] == "success" {
        *success = true;
    }
    let total = value
        .get("total")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0);
    let completed = value.get("completed").and_then(Value::as_u64).unwrap_or(0);
    manager.progress(
        "model-download",
        completed.min(total.unwrap_or(completed)),
        total,
    );
    Ok(())
}
async fn pull(manager: &Manager, model: &str, host: &str) -> Result<()> {
    anyhow::ensure!(super::model_allowed(model), "INVALID_MODEL");
    let client = client(7200)?;
    let mut response = send(
        manager,
        client
            .post(format!("{host}/api/pull"))
            .json(&serde_json::json!({"model":model,"stream":true})),
        "MODEL_PULL_FAILED",
    )
    .await?;
    let mut pending = Vec::new();
    let mut success = false;
    loop {
        manager.check_cancelled()?;
        let chunk = tokio::select! {
            result=response.chunk()=>result.context("MODEL_PULL_FAILED")?,
            _=tokio::time::sleep(Duration::from_millis(300))=>continue,
        };
        let Some(chunk) = chunk else {
            break;
        };
        pending.extend_from_slice(&chunk);
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line = pending.drain(..=end).collect::<Vec<_>>();
            if line.len() > 65536 {
                bail!("MODEL_PULL_FAILED");
            }
            consume_line(manager, &line[..line.len() - 1], &mut success)?;
        }
        if pending.len() > 65536 {
            bail!("MODEL_PULL_FAILED");
        }
    }
    if !pending.is_empty() {
        consume_line(manager, &pending, &mut success)?;
    }
    if !success {
        bail!("MODEL_PULL_FAILED");
    }
    // Do not mark a pull response alone as a usable model.
    let show = send(
        manager,
        client
            .post(format!("{host}/api/show"))
            .timeout(Duration::from_secs(10))
            .json(&serde_json::json!({"model":model})),
        "MODEL_PULL_FAILED",
    )
    .await?;
    let show = bounded_json(show).await?;
    let capabilities = show
        .get("capabilities")
        .and_then(Value::as_array)
        .context("MODEL_PULL_FAILED")?;
    if !capabilities.iter().any(|c| c == "completion") || !capabilities.iter().any(|c| c == "tools")
    {
        bail!("MODEL_PULL_FAILED");
    }
    Ok(())
}
pub(super) fn prepare(manager: &Manager, model: &str) -> Result<()> {
    manager.check_cancelled()?;
    super::install_runtime(manager)?;
    if !running() {
        install(manager)?;
        manager.progress("local-server", 0, None);
        ensure_service_for(Some(manager))?;
    }
    manager.progress("model-download", 0, None);
    runtime()?.block_on(pull(manager, model, HOST))?;
    manager.progress("configure", 0, None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn mock(responses: Vec<String>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for body in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = [0u8; 8192];
                let _ = stream.read(&mut request).unwrap();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        host
    }
    #[test]
    fn streamed_pull_requires_success_and_tools_capability() {
        let manager = Manager::default();
        for (stream, show, expected) in [
            (
                "{\"completed\":3,\"total\":10}\n{\"status\":\"success\"}\n",
                Some("{\"capabilities\":[\"completion\",\"tools\"]}"),
                true,
            ),
            (
                "{\"status\":\"success\"}",
                Some("{\"capabilities\":[\"completion\"]}"),
                false,
            ),
            ("{\"completed\":3,\"total\":10}\n", None, false),
            ("{\"error\":\"upstream private detail\"}\n", None, false),
            ("malformed\n", None, false),
        ] {
            let mut responses = vec![stream.to_owned()];
            if let Some(show) = show {
                responses.push(show.to_owned());
            }
            let host = mock(responses);
            assert_eq!(
                runtime()
                    .unwrap()
                    .block_on(pull(&manager, "qwen3:4b", &host))
                    .is_ok(),
                expected
            );
        }
    }
    #[test]
    fn cancellation_interrupts_waiting_for_response_headers() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        let manager = std::sync::Arc::new(Manager::default());
        let cancelling = manager.clone();
        let server = std::thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            cancelling
                .cancelled
                .store(true, std::sync::atomic::Ordering::Relaxed);
            std::thread::sleep(Duration::from_millis(300));
        });
        let start = Instant::now();
        assert_eq!(
            runtime()
                .unwrap()
                .block_on(pull(&manager, "qwen3:4b", &host))
                .unwrap_err()
                .to_string(),
            "CANCELLED"
        );
        assert!(start.elapsed() < Duration::from_secs(2));
        server.join().unwrap();
    }
    #[test]
    fn pull_errors_and_malformed_lines_never_become_success() {
        let manager = Manager::default();
        let mut success = false;
        for line in [
            b"{\"error\":\"private upstream error\"}".as_slice(),
            b"not json".as_slice(),
        ] {
            assert!(consume_line(&manager, line, &mut success).is_err());
            assert!(!success);
        }
        consume_line(&manager, b"{\"status\":\"success\"}", &mut success).unwrap();
        assert!(success);
    }
    #[test]
    fn progress_does_not_overflow_total() {
        let manager = Manager::default();
        let mut success = false;
        consume_line(&manager, b"{\"completed\":99,\"total\":10}", &mut success).unwrap();
        assert_eq!(manager.status()["job"]["completed"], 10);
    }
}
