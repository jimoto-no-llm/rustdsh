//! Optional tool boundary for delegated agent execution.
//!
//! Default: delegated runs keep the normal DSH tools and normal file access.
//! The strict boundary (only `--share-file` files, no network, no host writes)
//! is opt-in through `features.agent_tool_sandbox`, an explicit
//! `--share-file`, or `RDSH_SECURITY=1`. Unknown runtimes and unsupported
//! hosts are still refused when the boundary is active.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};

const PRELOAD: &str = include_str!("../security/preload.mjs");
const ISOLATION: &str = include_str!("../security/tool-isolation.mjs");

/// 0 = follow settings, 1 = boundary on, 2 = boundary off.
static SANDBOX: AtomicU8 = AtomicU8::new(0);

/// Record the settings-derived boundary decision for this process.
pub fn configure(sandbox: bool) {
    SANDBOX.store(if sandbox { 1 } else { 2 }, Ordering::Relaxed);
}

/// `RDSH_SECURITY=1` forces the boundary on, `RDSH_SECURITY=0` forces it off.
pub fn env_override() -> Option<bool> {
    match std::env::var("RDSH_SECURITY").ok().as_deref() {
        Some("1") => Some(true),
        Some("0") => Some(false),
        _ => None,
    }
}

/// True when delegated agent tools must stay inside the strict boundary.
pub fn sandbox_enabled() -> bool {
    if let Some(forced) = env_override() {
        return forced;
    }
    matches!(SANDBOX.load(Ordering::Relaxed), 1)
}

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

pub fn command(
    orig: &str,
    node: &str,
    locale: crate::locale::Locale,
) -> anyhow::Result<std::process::Command> {
    anyhow::ensure!(cfg!(all(target_os = "linux", target_arch = "x86_64")),
        "{}",
        match locale {
            crate::locale::Locale::English => "RDSH_SECURITY: protected agent tools currently require Linux x86_64; refusing unprotected delegation",
            crate::locale::Locale::Chinese => "RDSH_SECURITY：受保护的代理工具目前需要 Linux x86_64；拒绝未受保护的委派",
            crate::locale::Locale::Japanese => "RDSH_SECURITY: 保護されたエージェントツールには現在 Linux x86_64 が必要です。保護されない委譲を拒否します",
        });
    let executable = std::fs::canonicalize(orig)?;
    anyhow::ensure!(
        executable.file_name().is_some_and(|n| n == "bin.js"),
        "{}",
        match locale {
            crate::locale::Locale::English => "RDSH_SECURITY: unsupported DSH executable; expected the audited DSH lib/bin.js",
            crate::locale::Locale::Chinese => "RDSH_SECURITY：不支持的 DSH 可执行文件；需要经过审计的 DSH lib/bin.js",
            crate::locale::Locale::Japanese => "RDSH_SECURITY: 対応していない DSH 実行ファイルです。監査済みの DSH lib/bin.js が必要です",
        }
    );
    let package = executable.parent().and_then(Path::parent).ok_or_else(|| {
        anyhow::anyhow!(match locale {
            crate::locale::Locale::English => "RDSH_SECURITY: invalid DSH package path",
            crate::locale::Locale::Chinese => "RDSH_SECURITY：DSH 包路径无效",
            crate::locale::Locale::Japanese => "RDSH_SECURITY: DSH パッケージのパスが無効です",
        })
    })?;
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(package.join("package.json"))?)?;
    // Audited DSH releases: latest rc (0.2.0-rc.2) and 0.2.1-alpha.1 share the
    // same lib/bin.js surface; both carry the audited dsh-tools runtime path.
    // Keep the list explicit: any other version needs a new audit.
    const AUDITED_DSH_VERSIONS: [&str; 2] = ["0.2.0-rc.2", "0.2.1-alpha.1"];
    anyhow::ensure!(
        manifest["name"] == "@deepseek-ai/dsh"
            && manifest["version"]
                .as_str()
                .is_some_and(|v| AUDITED_DSH_VERSIONS.contains(&v)),
        "{}",
        match locale {
            crate::locale::Locale::English => "RDSH_SECURITY: unsupported DSH version; an audited execution adapter is required",
            crate::locale::Locale::Chinese => "RDSH_SECURITY：不支持的 DSH 版本；需要经过审计的执行适配器",
            crate::locale::Locale::Japanese => "RDSH_SECURITY: 対応していない DSH バージョンです。監査済みの実行アダプターが必要です",
        }
    );
    let runtime = package.join("node_modules/@deepseek-ai/dsh-tools/lib/index.js");
    anyhow::ensure!(
        runtime.is_file(),
        "{}",
        match locale {
            crate::locale::Locale::English => "RDSH_SECURITY: audited tool runtime is missing",
            crate::locale::Locale::Chinese => "RDSH_SECURITY：缺少经过审计的工具运行时",
            crate::locale::Locale::Japanese =>
                "RDSH_SECURITY: 監査済みツールランタイムがありません",
        }
    );
    anyhow::ensure!(
        Path::new("/usr/bin/bwrap").is_file() && Path::new("/usr/bin/prlimit").is_file(),
        "{}",
        match locale {
            crate::locale::Locale::English => "RDSH_SECURITY: bubblewrap and prlimit are required; refusing unprotected delegation",
            crate::locale::Locale::Chinese => "RDSH_SECURITY：需要 bubblewrap 和 prlimit；拒绝未受保护的委派",
            crate::locale::Locale::Japanese => "RDSH_SECURITY: bubblewrap と prlimit が必要です。保護されない委譲を拒否します",
        }
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
    eprintln!(
        "[rdsh security] {}",
        match locale {
            crate::locale::Locale::English =>
                "tools: explicitly shared files only; network and writes denied",
            crate::locale::Locale::Chinese => "工具：仅允许显式共享的文件；网络和写入已拒绝",
            crate::locale::Locale::Japanese =>
                "ツール: 明示的に共有したファイルのみ使用可。ネットワークと書き込みは拒否されます",
        }
    );
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundary_is_opt_in() {
        configure(false);
        assert!(!sandbox_enabled());
        configure(true);
        assert!(sandbox_enabled());
        configure(false);
        assert!(!sandbox_enabled());
    }
}
