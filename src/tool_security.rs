//! Optional tool boundary for delegated agent execution.
//!
//! Default: delegated runs keep the normal DSH tools and normal file access.
//! The strict boundary (only `--share-file` files, no network, no host writes)
//! is opt-in through `features.agent_tool_sandbox`, an explicit
//! `--share-file`, or `RDSH_SECURITY=1`. Unknown runtimes and unsupported
//! hosts are still refused when the boundary is active.
use anyhow::Context;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};

const PRELOAD: &str = include_str!("../security/preload.mjs");
const ISOLATION: &str = include_str!("../security/tool-isolation.mjs");
const SECCOMP: &str = include_str!("../security/seccomp.mjs");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AuditedAdapter {
    id: &'static str,
    dsh_version: &'static str,
    tools_version: &'static str,
    /// SHA256 of the release tarball's lib/bin.js. A tree whose entry file
    /// was swapped keeps a valid manifest here, so the entry content is
    /// verified before any boundary work happens.
    bin_sha256: &'static str,
}

const AUDITED_ADAPTERS: [AuditedAdapter; 4] = [
    AuditedAdapter {
        id: "dsh-tools-0.2.0-rc.2",
        dsh_version: "0.2.0-rc.2",
        tools_version: "0.2.0-rc.2",
        bin_sha256: "1a03dee18683483ff6a1b27b2a1e650230da6bcca9a0f55f7d81b3308c3f307f",
    },
    AuditedAdapter {
        id: "dsh-tools-0.2.1-alpha.1",
        dsh_version: "0.2.1-alpha.1",
        tools_version: "0.2.1-alpha.1",
        bin_sha256: "1a03dee18683483ff6a1b27b2a1e650230da6bcca9a0f55f7d81b3308c3f307f",
    },
    AuditedAdapter {
        id: "dsh-tools-0.2.1-alpha.3",
        dsh_version: "0.2.1-alpha.3",
        tools_version: "0.2.1-alpha.3",
        bin_sha256: "80112efe368efb1a39720c7ada0af00442e5131fb2744edaaff8a3e8bb499e6f",
    },
    AuditedAdapter {
        id: "dsh-tools-0.2.1-rc.3",
        dsh_version: "0.2.1-rc.3",
        tools_version: "0.2.1-rc.3",
        // bin.js is byte-identical to 0.2.1-alpha.3; dsh-tools moved on.
        bin_sha256: "80112efe368efb1a39720c7ada0af00442e5131fb2744edaaff8a3e8bb499e6f",
    },
];

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

fn audited_adapter(
    dsh_manifest: &serde_json::Value,
    tools_manifest: &serde_json::Value,
) -> Option<AuditedAdapter> {
    if dsh_manifest["name"] != "@deepseek-ai/dsh"
        || tools_manifest["name"] != "@deepseek-ai/dsh-tools"
    {
        return None;
    }
    AUDITED_ADAPTERS.iter().copied().find(|adapter| {
        dsh_manifest["version"] == adapter.dsh_version
            && dsh_manifest["devDependencies"]["@deepseek-ai/dsh-tools"] == adapter.tools_version
            && dsh_manifest["dependencies"]["@deepseek-ai/dsh-agent-instructions"]
                == adapter.dsh_version
            && tools_manifest["version"] == adapter.tools_version
            && tools_manifest["main"] == "lib/index.js"
            && tools_manifest["exports"]["."]
                == serde_json::json!({
                    "types": "./lib/types/index.d.ts",
                    "default": "./lib/index.js"
                })
    })
}

/// Follow Node's upward `node_modules` search from the real entry point.
///
/// The first package directory wins even when it is malformed. Falling back to
/// an outer audited copy would patch a different runtime than Node resolves.
fn first_tools_package(executable: &Path) -> std::io::Result<Option<PathBuf>> {
    let Some(parent) = executable.parent() else {
        return Ok(None);
    };
    for ancestor in parent.ancestors() {
        if ancestor
            .file_name()
            .is_some_and(|name| name == "node_modules")
        {
            continue;
        }
        let candidate = ancestor.join("node_modules/@deepseek-ai/dsh-tools");
        match std::fs::symlink_metadata(&candidate) {
            Ok(_) => return std::fs::canonicalize(candidate).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

fn canonical_package_file(package: &Path, relative: &Path) -> std::io::Result<Option<PathBuf>> {
    let file = match std::fs::canonicalize(package.join(relative)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(file.starts_with(package).then_some(file))
}

fn language_code(locale: crate::locale::Locale) -> &'static str {
    match locale {
        crate::locale::Locale::English => "en",
        crate::locale::Locale::Chinese => "zh",
        crate::locale::Locale::Japanese => "ja",
    }
}

fn read_dsh_manifest(
    path: &Path,
    locale: crate::locale::Locale,
) -> anyhow::Result<serde_json::Value> {
    let message = match locale {
        crate::locale::Locale::English => "RDSH_SECURITY[INVALID_DSH_MANIFEST]: cannot read the audited DSH package manifest",
        crate::locale::Locale::Chinese => "RDSH_SECURITY[INVALID_DSH_MANIFEST]：无法读取经过审计的 DSH 包清单",
        crate::locale::Locale::Japanese => "RDSH_SECURITY[INVALID_DSH_MANIFEST]: 監査対象のDSHパッケージマニフェストを読み込めません",
    };
    let bytes = std::fs::read(path).with_context(|| message)?;
    serde_json::from_slice(&bytes).with_context(|| message)
}

fn read_tools_manifest(
    path: &Path,
    locale: crate::locale::Locale,
) -> anyhow::Result<serde_json::Value> {
    let message = match locale {
        crate::locale::Locale::English => "RDSH_SECURITY[INVALID_TOOL_MANIFEST]: cannot read the audited tool runtime manifest",
        crate::locale::Locale::Chinese => "RDSH_SECURITY[INVALID_TOOL_MANIFEST]：无法读取经过审计的工具运行时清单",
        crate::locale::Locale::Japanese => "RDSH_SECURITY[INVALID_TOOL_MANIFEST]: 監査対象のツールランタイムマニフェストを読み込めません",
    };
    let bytes = std::fs::read(path).with_context(|| message)?;
    serde_json::from_slice(&bytes).with_context(|| message)
}

/// Lowercase hex SHA256 of a byte slice.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The audited pair is matched by manifest alone unless the entry file that
/// Node actually runs is pinned too. A swapped lib/bin.js inside a copied
/// tree keeps every manifest field, so the digest is checked before the
/// boundary files are staged.
fn verify_entry_digest(
    executable: &Path,
    expected_sha256: &str,
    locale: crate::locale::Locale,
) -> anyhow::Result<()> {
    let bytes = std::fs::read(executable).map_err(|error| {
        anyhow::anyhow!(match locale {
            crate::locale::Locale::English =>
                format!("RDSH_SECURITY[AUDIT_DIGEST]: cannot read the DSH entry file: {error}"),
            crate::locale::Locale::Chinese =>
                format!("RDSH_SECURITY[AUDIT_DIGEST]：无法读取 DSH 入口文件：{error}"),
            crate::locale::Locale::Japanese => format!(
                "RDSH_SECURITY[AUDIT_DIGEST]: DSHのエントリファイルを読み込めません: {error}"
            ),
        })
    })?;
    let actual = sha256_hex(&bytes);
    anyhow::ensure!(
        actual == expected_sha256,
        "{}",
        match locale {
            crate::locale::Locale::English =>
                "RDSH_SECURITY[AUDIT_DIGEST]: the DSH entry file does not match the audited digest; refusing to delegate",
            crate::locale::Locale::Chinese =>
                "RDSH_SECURITY[AUDIT_DIGEST]：DSH 入口文件与审计摘要不符；拒绝委派",
            crate::locale::Locale::Japanese =>
                "RDSH_SECURITY[AUDIT_DIGEST]: DSHのエントリファイルが監査済みダイジェストと一致しません。委譲を拒否します",
        }
    );
    Ok(())
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
        executable.file_name().is_some_and(|n| n == "bin.js")
            && executable
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|n| n == "lib"),
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
    let dsh_manifest_path = canonical_package_file(package, Path::new("package.json"))?
        .ok_or_else(|| {
            anyhow::anyhow!(match locale {
                crate::locale::Locale::English => "RDSH_SECURITY[INVALID_DSH_MANIFEST]: DSH package manifest escapes its package",
                crate::locale::Locale::Chinese => "RDSH_SECURITY[INVALID_DSH_MANIFEST]：DSH 包清单超出其包目录",
                crate::locale::Locale::Japanese => "RDSH_SECURITY[INVALID_DSH_MANIFEST]: DSHパッケージマニフェストがパッケージ外を参照しています",
            })
        })?;
    let dsh_manifest = read_dsh_manifest(&dsh_manifest_path, locale)?;
    let tools_package = first_tools_package(&executable)
        .with_context(|| match locale {
            crate::locale::Locale::English => "RDSH_SECURITY[INVALID_TOOL_PATH]: cannot resolve the audited tool runtime package",
            crate::locale::Locale::Chinese => "RDSH_SECURITY[INVALID_TOOL_PATH]：无法解析经过审计的工具运行时包",
            crate::locale::Locale::Japanese => "RDSH_SECURITY[INVALID_TOOL_PATH]: 監査対象のツールランタイムパッケージを解決できません",
        })?
        .ok_or_else(|| {
        anyhow::anyhow!(match locale {
            crate::locale::Locale::English => "RDSH_SECURITY: audited tool runtime is missing",
            crate::locale::Locale::Chinese => "RDSH_SECURITY：缺少经过审计的工具运行时",
            crate::locale::Locale::Japanese =>
                "RDSH_SECURITY: 監査済みツールランタイムがありません",
        })
    })?;
    let tools_manifest_path = canonical_package_file(&tools_package, Path::new("package.json"))?
        .ok_or_else(|| {
            anyhow::anyhow!(match locale {
                crate::locale::Locale::English => "RDSH_SECURITY[INVALID_TOOL_MANIFEST]: tool runtime manifest escapes its package",
                crate::locale::Locale::Chinese => "RDSH_SECURITY[INVALID_TOOL_MANIFEST]：工具运行时清单超出其包目录",
                crate::locale::Locale::Japanese => "RDSH_SECURITY[INVALID_TOOL_MANIFEST]: ツールランタイムマニフェストがパッケージ外を参照しています",
            })
        })?;
    let tools_manifest = read_tools_manifest(&tools_manifest_path, locale)?;
    let adapter = audited_adapter(&dsh_manifest, &tools_manifest).ok_or_else(|| {
        anyhow::anyhow!(match locale {
            crate::locale::Locale::English => "RDSH_SECURITY: unsupported DSH and tool runtime version pair; an audited execution adapter is required",
            crate::locale::Locale::Chinese => "RDSH_SECURITY：不支持的 DSH 与工具运行时版本组合；需要经过审计的执行适配器",
            crate::locale::Locale::Japanese => "RDSH_SECURITY: DSHとツールランタイムのバージョン組み合わせに対応していません。監査済みの実行アダプターが必要です",
        })
    })?;
    verify_entry_digest(&executable, adapter.bin_sha256, locale)?;
    let runtime = canonical_package_file(&tools_package, Path::new("lib/index.js"))?
        .filter(|path| path.is_file())
        .ok_or_else(|| {
            anyhow::anyhow!(match locale {
                crate::locale::Locale::English =>
                    "RDSH_SECURITY: audited tool runtime is missing or escapes its package",
                crate::locale::Locale::Chinese =>
                    "RDSH_SECURITY：经过审计的工具运行时缺失或超出其包目录",
                crate::locale::Locale::Japanese =>
                    "RDSH_SECURITY: 監査済みツールランタイムがないか、パッケージ外を参照しています",
            })
        })?;
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
    crate::auth::write_creds(&directory.join("seccomp.mjs").to_string_lossy(), SECCOMP)?;
    let mut command = std::process::Command::new(node);
    command
        .arg("--import")
        .arg(directory.join("preload.mjs"))
        .arg(executable);
    command
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        // A writable compile cache could substitute the machine code that
        // runs even when the load-hook source digest still matches.
        .env_remove("NODE_COMPILE_CACHE");
    command.env("RDSH_TOOL_RUNTIME", runtime);
    command.env("RDSH_TOOL_ADAPTER", adapter.id);
    command.env("RDSH_SECURITY_LANG", language_code(locale));
    command.env(
        "RDSH_SHARED_FILES",
        std::env::var("RDSH_SHARED_FILES").unwrap_or_else(|_| "[]".into()),
    );
    command.env("RDSH_SECURE_WORKSPACE", std::fs::canonicalize(".")?);
    eprintln!(
        "[rdsh security] {}",
        match locale {
            crate::locale::Locale::English =>
                "rdsh_inspect is isolated; other DSH tools use upstream permissions",
            crate::locale::Locale::Chinese => "rdsh_inspect 已隔离；其他 DSH 工具使用上游权限",
            crate::locale::Locale::Japanese =>
                "rdsh_inspect は分離されています。その他の DSH ツールは上流の権限を使用します",
        }
    );
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dsh_manifest(name: &str, version: &str) -> serde_json::Value {
        serde_json::json!({
            "name": name,
            "version": version,
            "dependencies": { "@deepseek-ai/dsh-agent-instructions": version },
            "devDependencies": { "@deepseek-ai/dsh-tools": version },
        })
    }

    fn tools_manifest(name: &str, version: &str) -> serde_json::Value {
        serde_json::json!({
            "name": name,
            "version": version,
            "main": "lib/index.js",
            "exports": { ".": {
                "types": "./lib/types/index.d.ts",
                "default": "./lib/index.js"
            } },
        })
    }

    fn temporary_directory(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "rdsh-tool-security-test-{label}-{}-{}",
            std::process::id(),
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        root
    }

    #[test]
    fn sha256_hex_matches_the_known_vectors() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn entry_digest_check_accepts_the_pinned_content_only() {
        let root = temporary_directory("digest");
        let entry = root.join("bin.js");
        std::fs::write(&entry, b"// audited\n").unwrap();
        let good = sha256_hex(b"// audited\n");
        verify_entry_digest(&entry, &good, crate::locale::Locale::English).unwrap();
        let error = verify_entry_digest(
            &entry,
            "0".repeat(64).as_str(),
            crate::locale::Locale::English,
        )
        .expect_err("swapped entry must fail");
        assert!(error.to_string().contains("AUDIT_DIGEST"), "{error}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn every_audited_adapter_pins_a_full_digest() {
        for adapter in AUDITED_ADAPTERS {
            assert_eq!(adapter.bin_sha256.len(), 64, "{}", adapter.id);
            assert!(
                adapter
                    .bin_sha256
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
                "{}",
                adapter.id
            );
        }
    }
    #[test]
    fn boundary_is_opt_in() {
        configure(false);
        assert!(!sandbox_enabled());
        configure(true);
        assert!(sandbox_enabled());
        configure(false);
        assert!(!sandbox_enabled());
    }

    #[test]
    fn audited_adapter_requires_exact_release_pairs() {
        for adapter in AUDITED_ADAPTERS {
            let dsh = dsh_manifest("@deepseek-ai/dsh", adapter.dsh_version);
            let tools = tools_manifest("@deepseek-ai/dsh-tools", adapter.tools_version);
            assert_eq!(audited_adapter(&dsh, &tools), Some(adapter));
        }
        for dsh in AUDITED_ADAPTERS {
            for tools in AUDITED_ADAPTERS {
                if dsh.dsh_version == tools.tools_version {
                    continue;
                }
                assert_eq!(
                    audited_adapter(
                        &dsh_manifest("@deepseek-ai/dsh", dsh.dsh_version),
                        &tools_manifest("@deepseek-ai/dsh-tools", tools.tools_version),
                    ),
                    None
                );
            }
        }
        assert_eq!(
            audited_adapter(
                &dsh_manifest("@deepseek-ai/dsh", "0.2.1-alpha.4"),
                &tools_manifest("@deepseek-ai/dsh-tools", "0.2.1-alpha.4"),
            ),
            None
        );
        assert_eq!(
            audited_adapter(
                &dsh_manifest("not-dsh", "0.2.1-alpha.3"),
                &tools_manifest("@deepseek-ai/dsh-tools", "0.2.1-alpha.3"),
            ),
            None
        );
        let dsh = dsh_manifest("@deepseek-ai/dsh", "0.2.1-alpha.3");
        let mut forged_exports = tools_manifest("@deepseek-ai/dsh-tools", "0.2.1-alpha.3");
        forged_exports["exports"]["."]["default"] = "./lib/other.js".into();
        assert_eq!(audited_adapter(&dsh, &forged_exports), None);
    }

    #[test]
    fn conditional_exports_cannot_select_an_unpatched_runtime() {
        let dsh = dsh_manifest("@deepseek-ai/dsh", "0.2.1-alpha.3");
        for condition in ["node", "import", "require"] {
            let mut tools = tools_manifest("@deepseek-ai/dsh-tools", "0.2.1-alpha.3");
            tools["exports"]["."][condition] = "./lib/other.js".into();
            assert_eq!(audited_adapter(&dsh, &tools), None, "{condition}");
        }
    }

    #[test]
    fn node_resolution_uses_first_package_and_supports_hoisting() {
        let root = temporary_directory("resolution");
        let dsh = root.join("node_modules/@deepseek-ai/dsh");
        let entry = dsh.join("lib/bin.js");
        let outer = root.join("node_modules/@deepseek-ai/dsh-tools");
        let skipped = root.join("node_modules/node_modules/@deepseek-ai/dsh-tools");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&outer).unwrap();
        std::fs::create_dir_all(&skipped).unwrap();
        std::fs::write(&entry, "// fixture\n").unwrap();
        assert_eq!(
            first_tools_package(&entry).unwrap(),
            Some(std::fs::canonicalize(&outer).unwrap())
        );

        let inner = dsh.join("node_modules/@deepseek-ai/dsh-tools");
        std::fs::create_dir_all(&inner).unwrap();
        assert_eq!(
            first_tools_package(&entry).unwrap(),
            Some(std::fs::canonicalize(inner).unwrap())
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn package_files_cannot_escape_through_symlinks() {
        use std::os::unix::fs::symlink;

        let root = temporary_directory("package-files");
        let package = root.join("package");
        let outside = root.join("outside.js");
        std::fs::create_dir(&package).unwrap();
        std::fs::write(&outside, "// outside\n").unwrap();
        symlink(&outside, package.join("index.js")).unwrap();
        assert_eq!(
            canonical_package_file(
                &std::fs::canonicalize(&package).unwrap(),
                Path::new("index.js")
            )
            .unwrap(),
            None
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[test]
    fn installed_runtime_matrix_builds_protected_commands() {
        let matrix = [
            (
                "RDSH_AUDITED_DSH_RC2",
                "dsh-tools-0.2.0-rc.2",
                "RDSH_AUDITED_RUNTIME_RC2",
            ),
            (
                "RDSH_AUDITED_DSH_ALPHA1",
                "dsh-tools-0.2.1-alpha.1",
                "RDSH_AUDITED_RUNTIME_ALPHA1",
            ),
            (
                "RDSH_AUDITED_DSH_ALPHA3",
                "dsh-tools-0.2.1-alpha.3",
                "RDSH_AUDITED_RUNTIME_ALPHA3",
            ),
            (
                "RDSH_AUDITED_DSH_RC3",
                "dsh-tools-0.2.1-rc.3",
                "RDSH_AUDITED_RUNTIME_RC3",
            ),
        ];
        // One release per run is enough: a machine normally carries a single
        // installed tree, and CI can still provide every pair at once.
        let matrix = matrix
            .into_iter()
            .filter(|(entry, _, runtime)| {
                std::env::var_os(entry).is_some() && std::env::var_os(runtime).is_some()
            })
            .collect::<Vec<_>>();
        if matrix.is_empty() {
            return;
        }
        for (entry_variable, expected_adapter, runtime_variable) in matrix {
            let entry = std::env::var(entry_variable).unwrap();
            let expected_runtime =
                std::fs::canonicalize(std::env::var(runtime_variable).unwrap()).unwrap();
            let command =
                command(&entry, "/usr/bin/node", crate::locale::Locale::Japanese).unwrap();
            let environment = command
                .get_envs()
                .filter_map(|(key, value)| value.map(|value| (key, value)))
                .collect::<std::collections::HashMap<_, _>>();
            assert_eq!(
                environment.get(std::ffi::OsStr::new("RDSH_TOOL_ADAPTER")),
                Some(&std::ffi::OsStr::new(expected_adapter))
            );
            assert_eq!(
                environment.get(std::ffi::OsStr::new("RDSH_TOOL_RUNTIME")),
                Some(&expected_runtime.as_os_str())
            );
            assert_eq!(
                environment.get(std::ffi::OsStr::new("RDSH_SECURITY_LANG")),
                Some(&std::ffi::OsStr::new("ja"))
            );
            assert!(
                !environment.contains_key(std::ffi::OsStr::new("NODE_COMPILE_CACHE")),
                "the compile cache must not leak into the strict path"
            );
            let arguments = command.get_args().collect::<Vec<_>>();
            let preload = Path::new(arguments[1]);
            assert_eq!(arguments[0], "--import");
            assert!(preload.ends_with("preload.mjs"));
            std::fs::remove_dir_all(preload.parent().unwrap()).unwrap();
        }
    }
}
