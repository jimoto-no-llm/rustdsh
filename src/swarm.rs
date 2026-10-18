//! Thin, opt-in Gas City CLI boundary. Gas City owns scheduling and recovery.

use anyhow::{bail, Context, Result};
use clap::{Args, Subcommand};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Args, Debug)]
pub struct SwarmOptions {
    /// Absolute path to a fixed Gas City `gc` executable.
    #[arg(long, env = "RDSH_GASCITY_BIN")]
    gc_binary: Option<PathBuf>,
    /// SHA-256 of the exact executable artifact.
    #[arg(long, env = "RDSH_GASCITY_SHA256")]
    gc_sha256: Option<String>,
    /// Gas City directory (required except for help).
    #[arg(long, env = "RDSH_GASCITY_CITY")]
    city: Option<PathBuf>,
}

#[derive(Subcommand, Debug, Clone, Copy)]
pub enum SwarmAction {
    Doctor,
    Init,
    Start,
    Status,
    Stop,
}

fn command_args(action: SwarmAction, city: &Path) -> Vec<std::ffi::OsString> {
    let name = match action {
        SwarmAction::Doctor => "doctor",
        SwarmAction::Init => "init",
        SwarmAction::Start => "start",
        SwarmAction::Status => "status",
        SwarmAction::Stop => "stop",
    };
    if matches!(action, SwarmAction::Doctor) {
        vec![name.into()]
    } else {
        vec![name.into(), city.as_os_str().to_owned()]
    }
}

struct VerifiedBinary {
    // Keep the exact checked file open until the launched process exits.
    _file: File,
    #[cfg(not(unix))]
    path: PathBuf,
}

impl VerifiedBinary {
    fn command(&self) -> Command {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            #[cfg(target_os = "linux")]
            let directory = "/proc/self/fd";
            #[cfg(not(target_os = "linux"))]
            let directory = "/dev/fd";
            Command::new(format!("{directory}/{}", self._file.as_raw_fd()))
        }
        #[cfg(not(unix))]
        {
            Command::new(&self.path)
        }
    }
}

fn verified_binary(path: &Path, expected: &str) -> Result<VerifiedBinary> {
    if !path.is_absolute() {
        bail!("Gas City 実行ファイルには絶対パスを指定してください");
    }
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("Gas City の SHA-256 は64桁の16進数で指定してください");
    }
    let canonical = path
        .canonicalize()
        .context("Gas City 実行ファイルを開けません")?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ: prevent replacement and writes while validating/running.
        options.share_mode(1);
    }
    let mut file = options
        .open(&canonical)
        .context("Gas City 実行ファイルを読めません")?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let actual: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if !actual.eq_ignore_ascii_case(expected) {
        bail!("Gas City 実行ファイルの SHA-256 が固定値と一致しません");
    }
    Ok(VerifiedBinary {
        _file: file,
        #[cfg(not(unix))]
        path: canonical,
    })
}

pub fn run(options: SwarmOptions, action: SwarmAction) -> Result<i32> {
    let binary = options
        .gc_binary
        .context("--gc-binary または RDSH_GASCITY_BIN が必要です")?;
    let digest = options
        .gc_sha256
        .context("--gc-sha256 または RDSH_GASCITY_SHA256 が必要です")?;
    let city = options
        .city
        .context("--city または RDSH_GASCITY_CITY が必要です")?;
    if !city.is_absolute() {
        bail!("Gas City ディレクトリには絶対パスを指定してください");
    }
    let binary = verified_binary(&binary, &digest)?;
    if !matches!(action, SwarmAction::Init) && !city.is_dir() {
        bail!("Gas City ディレクトリがありません: {}", city.display());
    }
    let mut command = binary.command();
    command.args(command_args(action, &city));
    if city.is_dir() {
        command.current_dir(&city);
    }
    let status = command.status().context("Gas City の起動に失敗しました")?;
    Ok(status.code().unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delegates_only_one_gas_city_action() {
        let city = Path::new("/tmp/city");
        assert_eq!(
            command_args(SwarmAction::Start, city),
            ["start", "/tmp/city"]
        );
        assert_eq!(command_args(SwarmAction::Doctor, city), ["doctor"]);
    }

    #[test]
    fn rejects_unpinned_binary() {
        let result = verified_binary(Path::new("gc"), &"0".repeat(64));
        assert!(result.is_err());
    }

    #[test]
    fn executable_digest_must_match_exact_bytes() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let bytes = std::fs::read(&path).unwrap();
        let digest: String = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(
            verified_binary(&path, &digest)
                .unwrap()
                ._file
                .metadata()
                .unwrap()
                .len(),
            bytes.len() as u64
        );
        assert!(verified_binary(&path, &"0".repeat(64)).is_err());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn launching_keeps_the_verified_executable_when_its_path_is_replaced() {
        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let fixture = Fixture(
            std::env::temp_dir().join(format!("rdsh-pinned-gc-{}-{nonce}", std::process::id())),
        );
        std::fs::create_dir(&fixture.0).unwrap();
        let path = fixture.0.join("gc.exe");
        #[cfg(unix)]
        let source = PathBuf::from("/bin/sh");
        #[cfg(windows)]
        let source = PathBuf::from(
            std::env::var_os("COMSPEC").unwrap_or_else(|| "C:\\Windows\\System32\\cmd.exe".into()),
        );
        std::fs::copy(source, &path).unwrap();
        let digest: String = Sha256::digest(std::fs::read(&path).unwrap())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let verified = verified_binary(&path, &digest).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::rename(&path, fixture.0.join("checked-binary")).unwrap();
            std::fs::write(&path, b"#!/bin/sh\nexit 1\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(
                verified
                    .command()
                    .args(["-c", "exit 73"])
                    .status()
                    .unwrap()
                    .code(),
                Some(73)
            );
        }
        #[cfg(windows)]
        {
            assert!(std::fs::rename(&path, fixture.0.join("checked-binary")).is_err());
            assert!(OpenOptions::new().write(true).open(&path).is_err());
            assert_eq!(
                verified
                    .command()
                    .args(["/C", "exit 73"])
                    .status()
                    .unwrap()
                    .code(),
                Some(73)
            );
        }
    }
}
