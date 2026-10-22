//! Rust-owned tools: bounded workspace reads and an explicitly approved Devin CLI.
use super::engine::{Call, Engine};
use anyhow::{bail, Result};
use serde::Deserialize;
use std::future::Future;

use serde_json::{json, Value};
use std::io::Read;
use std::path::{Component, Path};

const FILE_LIMIT: u64 = 64 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadArgs {
    path: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DevinArgs {
    prompt: String,
    #[serde(default = "default_timeout")]
    timeout: u64,
}
fn default_timeout() -> u64 {
    60
}

fn safe_path(path: &str) -> Result<()> {
    if path.is_empty() || path.len() > 4096 {
        bail!("ファイルパスが不正です");
    }
    for part in Path::new(path).components() {
        let Component::Normal(name) = part else {
            bail!("ワークスペース内の相対パスのみ利用できます");
        };
        let name = name
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("パスがUTF-8ではありません"))?;
        if name.starts_with('.')
            || matches!(
                name.to_ascii_lowercase().as_str(),
                "id_rsa" | "id_ed25519" | "credentials.json" | "auth.json"
            )
        {
            bail!("認証情報・隠しファイルはread対象外です");
        }
    }
    Ok(())
}
pub fn validate(call: &Call) -> Result<()> {
    match call.name.as_str() {
        "read" => {
            let args: ReadArgs = serde_json::from_value(call.arguments.clone())
                .map_err(|_| anyhow::anyhow!("readの引数が不正です"))?;
            safe_path(&args.path)
        }
        "devin_cli" => {
            let args: DevinArgs = serde_json::from_value(call.arguments.clone())
                .map_err(|_| anyhow::anyhow!("Devinの引数が不正です"))?;
            if args.prompt.trim().is_empty()
                || args.prompt.len() > 16 * 1024
                || !(1..=300).contains(&args.timeout)
            {
                bail!("Devinのprompt/timeoutが範囲外です");
            }
            Ok(())
        }
        _ => bail!("宣言されていないツールです"),
    }
}

#[cfg(unix)]
fn open_file(workspace: &Path, path: &str) -> Result<std::fs::File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    let root = CString::new(workspace.as_os_str().as_bytes())?;
    // Every component is opened relative to an already opened directory. No
    // symlink (including one swapped while approval is pending) is followed.
    let fd = unsafe {
        libc::open(
            root.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        bail!("ワークスペースを開けません");
    }
    let mut parent = unsafe { OwnedFd::from_raw_fd(fd) };
    let parts: Vec<_> = Path::new(path).components().collect();
    for (i, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else {
            bail!("不正なパスです");
        };
        let name = CString::new(name.as_bytes())?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if i + 1 < parts.len() {
                libc::O_DIRECTORY
            } else {
                0
            };
        let next = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if next < 0 {
            bail!("ファイルを開けません（symlinkは許可されません）");
        }
        parent = unsafe { OwnedFd::from_raw_fd(next) };
    }
    Ok(std::fs::File::from(parent))
}
#[cfg(not(unix))]
fn open_file(_workspace: &Path, _path: &str) -> Result<std::fs::File> {
    bail!("このプラットフォームでは安全なnative readは未対応です")
}
fn read_file(workspace: &Path, path: &str) -> Result<Value> {
    safe_path(path)?;
    let file = open_file(workspace, path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > FILE_LIMIT {
        bail!("UTF-8の通常ファイル（64KiB以下）のみ読み取れます");
    }
    let mut bytes = vec![];
    file.take(FILE_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > FILE_LIMIT {
        bail!("ファイルが64KiBを超えています");
    }
    let content = String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("UTF-8ではありません"))?;
    Ok(json!({"path":path,"content":content,"executed":true}))
}
pub async fn execute(engine: &Engine, run_id: u64, call: &Call) -> Result<Value> {
    validate(call)?;
    match call.name.as_str() {
        "read" => {
            let args: ReadArgs = serde_json::from_value(call.arguments.clone())?;
            engine.with_current_run(run_id, || read_file(&engine.workspace, &args.path))
        }
        "devin_cli" => {
            let args: DevinArgs = serde_json::from_value(call.arguments.clone())?;
            let mut command = tokio::process::Command::new(&engine.devin);
            command
                .env_clear()
                .current_dir(&engine.workspace)
                .arg("-p")
                .arg(&args.prompt);
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
            ] {
                if let Some(value) = std::env::var_os(name) {
                    command.env(name, value);
                }
            }
            let mut operation = Box::pin(super::sdk::run_process(
                command,
                b"",
                args.timeout,
                64 * 1024,
            ));
            // Spawn and cancellation share the run gate, so a cancelled run
            // cannot begin a new side effect after its approval completes.
            let first = std::future::poll_fn(|cx| {
                std::task::Poll::Ready(
                    engine.with_current_run(run_id, || Ok(operation.as_mut().poll(cx))),
                )
            })
            .await?;
            let result = match first {
                std::task::Poll::Ready(result) => result,
                std::task::Poll::Pending => operation.await,
            };
            let (code, out, err) =
                result.map_err(|_| anyhow::anyhow!("Devinの起動・時間・出力制限で停止しました"))?;
            Ok(
                json!({"exitCode":code,"stdout":engine.redact(&String::from_utf8_lossy(&out)),"stderr":engine.redact(&String::from_utf8_lossy(&err)),"executed":true}),
            )
        }
        _ => bail!("未対応ツール"),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    fn fixture() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "rdsh-native-tool-{}",
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn traversal_and_secret_paths_rejected() {
        for path in [
            "../secret",
            "/etc/passwd",
            ".env",
            "sub/.credentials.yaml",
            "auth.json",
            "",
        ] {
            assert!(safe_path(path).is_err(), "{path}");
        }
        assert!(safe_path("src/example.txt").is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn bounded_reads_reject_fifo_and_large_files() {
        let root = fixture();
        std::fs::write(root.join("file.txt"), "nonce").unwrap();
        assert_eq!(read_file(&root, "file.txt").unwrap()["content"], "nonce");
        std::fs::write(root.join("large"), vec![b'x'; 65537]).unwrap();
        assert!(read_file(&root, "large").is_err());
        assert!(read_file(&root, "missing").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(not(unix))]
    #[test]
    fn unsupported_platform_read_fails_closed() {
        let error = read_file(&std::env::temp_dir(), "unused.txt").unwrap_err();
        assert!(error.to_string().contains("未対応"));
    }
    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_rejected_for_file_and_ancestor() {
        use std::os::unix::fs::symlink;
        let root = fixture();
        symlink("/etc/passwd", root.join("file")).unwrap();
        symlink("/etc", root.join("folder")).unwrap();
        assert!(read_file(&root, "file").is_err());
        assert!(read_file(&root, "folder/passwd").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
