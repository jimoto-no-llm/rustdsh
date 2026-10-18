//! Thin, opt-in Gas City CLI boundary. Gas City owns scheduling and recovery.

use anyhow::{bail, Context, Result};
use clap::{Args, Subcommand};
use sha2::{Digest, Sha256};
use std::fs::File;
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

fn verified_binary(path: &Path, expected: &str) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("Gas City 実行ファイルには絶対パスを指定してください");
    }
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("Gas City の SHA-256 は64桁の16進数で指定してください");
    }
    let canonical = path
        .canonicalize()
        .context("Gas City 実行ファイルを開けません")?;
    let mut file = File::open(&canonical).context("Gas City 実行ファイルを読めません")?;
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
    Ok(canonical)
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
    let mut command = Command::new(binary);
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
        let digest: String = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(
            verified_binary(&path, &digest).unwrap(),
            path.canonicalize().unwrap()
        );
        assert!(verified_binary(&path, &"0".repeat(64)).is_err());
    }
}
