//! Mandatory tool boundary for delegated agent execution. Unknown runtimes
//! and unsupported hosts are refused rather than delegated unprotected.
use std::path::{Path, PathBuf};

const PRELOAD: &str = include_str!("../security/preload.mjs");
const ISOLATION: &str = include_str!("../security/tool-isolation.mjs");

fn private_directory() -> anyhow::Result<PathBuf> {
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).map_err(|e| anyhow::anyhow!("security runtime randomness: {e}"))?;
    let name: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let directory = std::env::temp_dir().join(format!("rdsh-tool-security-{name}"));
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700);
        builder
    };
    #[cfg(not(unix))]
    let builder = std::fs::DirBuilder::new();
    builder.create(&directory)?;
    Ok(directory)
}

pub fn command(orig: &str, node: &str) -> anyhow::Result<std::process::Command> {
    anyhow::ensure!(cfg!(all(target_os = "linux", target_arch = "x86_64")),
        "RDSH_SECURITY: protected agent tools currently require Linux x86_64; refusing unprotected delegation");
    let executable = std::fs::canonicalize(orig)?;
    anyhow::ensure!(
        executable.file_name().is_some_and(|n| n == "bin.js"),
        "RDSH_SECURITY: unsupported DSH executable; expected the audited DSH lib/bin.js"
    );
    let package = executable
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| anyhow::anyhow!("RDSH_SECURITY: invalid DSH package path"))?;
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(package.join("package.json"))?)?;
    anyhow::ensure!(
        manifest["name"] == "@deepseek-ai/dsh" && manifest["version"] == "0.2.0-rc.2",
        "RDSH_SECURITY: unsupported DSH version; an audited execution adapter is required"
    );
    let runtime = package.join("node_modules/@deepseek-ai/dsh-tools/lib/index.js");
    anyhow::ensure!(
        runtime.is_file(),
        "RDSH_SECURITY: audited tool runtime is missing"
    );
    anyhow::ensure!(
        Path::new("/usr/bin/bwrap").is_file() && Path::new("/usr/bin/prlimit").is_file(),
        "RDSH_SECURITY: bubblewrap and prlimit are required; refusing unprotected delegation"
    );
    let directory = private_directory()?;
    // Files are embedded in rdsh: no working-tree plugin can replace the gate.
    crate::auth::write_creds(&directory.join("preload.mjs").to_string_lossy(), PRELOAD)?;
    crate::auth::write_creds(
        &directory.join("tool-isolation.mjs").to_string_lossy(),
        ISOLATION,
    )?;
    let mut command = std::process::Command::new(node);
    command
        .arg("--import")
        .arg(directory.join("preload.mjs"))
        .arg(executable);
    command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    command.env("RDSH_TOOL_RUNTIME", runtime);
    command.env(
        "RDSH_SHARED_FILES",
        std::env::var("RDSH_SHARED_FILES").unwrap_or_else(|_| "[]".into()),
    );
    command.env("RDSH_SECURE_WORKSPACE", std::fs::canonicalize(".")?);
    eprintln!("[rdsh security] tools: explicitly shared files only; network and writes denied");
    Ok(command)
}
