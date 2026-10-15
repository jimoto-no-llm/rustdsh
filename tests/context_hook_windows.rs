#![cfg(windows)]

use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "rdsh hook path with spaces {} {nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run_hook_admin(args: &[&str]) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_rdsh"))
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "rdsh {args:?}: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn installed_hook_launches_an_absolute_binary_path_with_spaces_in_powershell() {
    let temporary = TempDir::new();
    let bin_dir = temporary.0.join("binary path with spaces");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let rdsh = bin_dir.join("rdsh.exe");
    std::fs::copy(env!("CARGO_BIN_EXE_rdsh"), &rdsh).unwrap();
    let hooks = temporary.0.join("hooks config.json");
    let rdsh_arg = rdsh.to_str().unwrap();
    let hooks_arg = hooks.to_str().unwrap();

    let installed = run_hook_admin(&[
        "context", "hook", "install", "--path", hooks_arg, "--rdsh", rdsh_arg, "--json",
    ]);
    let command = installed["command"].as_str().unwrap();
    assert!(
        command.starts_with("& '"),
        "unexpected PowerShell command: {command}"
    );
    assert!(
        run_hook_admin(&["context", "hook", "status", "--path", hooks_arg, "--json"])["installed"]
            .as_bool()
            .unwrap()
    );

    let mut powershell = Command::new("pwsh.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command,
        ])
        .current_dir(&temporary.0)
        .env("DSH_HOME", &temporary.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let cwd = temporary.0.to_str().unwrap();
    powershell
        .stdin
        .take()
        .unwrap()
        .write_all(
            format!(
                "{{\"cwd\":{},\"prompt\":\"test\"}}",
                serde_json::to_string(cwd).unwrap()
            )
            .as_bytes(),
        )
        .unwrap();
    let launched = powershell.wait_with_output().unwrap();
    assert!(
        launched.status.success(),
        "PowerShell launch failed: stdout={} stderr={}",
        String::from_utf8_lossy(&launched.stdout),
        String::from_utf8_lossy(&launched.stderr)
    );

    let removed = run_hook_admin(&["context", "hook", "remove", "--path", hooks_arg, "--json"]);
    assert_eq!(removed["changed"], true);
    assert_eq!(
        run_hook_admin(&["context", "hook", "status", "--path", hooks_arg, "--json"])["installed"],
        false
    );
}
