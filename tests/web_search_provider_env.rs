//! The delegated web-search provider pin is opt-in and never overrides the
//! caller's environment. Every case uses --dry-run, so no DSH process starts.
#![cfg(unix)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The id the `dsh-web-search-searxng` plugin registers (`SEARXNG_PROVIDER_ID`).
const PROVIDER: &str = "searxng";

fn temp_dir(tag: &str) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "rdsh-provider-env-{tag}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(path.join("dsh")).unwrap();
    // A shell stub is enough: --dry-run never executes it.
    let original = path.join("orig-dsh");
    fs::write(&original, "#!/bin/sh\nexit 0\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&original, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn run(root: &Path, extra: &[&str], provider: Option<&str>) -> String {
    let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
    command
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("DSH_HOME", root.join("dsh"))
        .env("DSH_ORIG_BIN", root.join("orig-dsh"))
        .env_remove("DSH_WEB_SEARCH_PROVIDER")
        .arg("--dry-run")
        .args(extra)
        .arg("tui");
    if let Some(provider) = provider {
        command.env("DSH_WEB_SEARCH_PROVIDER", provider);
    }
    let output = command.output().unwrap();
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn a_configured_provider_is_exported_to_the_delegated_run() {
    let root = temp_dir("set");
    fs::write(
        root.join("dsh/rdsh.json"),
        serde_json::json!({"search": {"dsh_search_provider": PROVIDER}}).to_string(),
    )
    .unwrap();
    let out = run(&root, &[], None);
    assert!(
        out.contains(&format!("DSH_WEB_SEARCH_PROVIDER=\"{PROVIDER}\"")),
        "{out}"
    );
    // The privacy default still rides along on the same command.
    assert!(out.contains("DSH_TELEMETRY_DISABLED"), "{out}");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn an_unset_setting_and_the_callers_own_value_both_export_nothing() {
    let root = temp_dir("unset");
    fs::write(root.join("dsh/rdsh.json"), "{}").unwrap();
    let out = run(&root, &[], None);
    assert!(!out.contains("DSH_WEB_SEARCH_PROVIDER"), "{out}");

    fs::write(
        root.join("dsh/rdsh.json"),
        serde_json::json!({"search": {"dsh_search_provider": PROVIDER}}).to_string(),
    )
    .unwrap();
    let out = run(&root, &[], Some("exa"));
    assert!(!out.contains("DSH_WEB_SEARCH_PROVIDER"), "{out}");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn passthrough_and_an_unregistered_id_are_handled_explicitly() {
    let root = temp_dir("passthrough");
    fs::write(
        root.join("dsh/rdsh.json"),
        serde_json::json!({"search": {"dsh_search_provider": PROVIDER}}).to_string(),
    )
    .unwrap();
    // --passthrough drops the slim env but keeps the pin (privacy-default rule).
    let out = run(&root, &["--passthrough"], None);
    assert!(out.contains("DSH_WEB_SEARCH_PROVIDER"), "{out}");
    assert!(!out.contains("RDSH_SLIM"), "{out}");

    // A value that is not a provider id is refused, not passed to the child.
    fs::write(
        root.join("dsh/rdsh.json"),
        serde_json::json!({"search": {"dsh_search_provider": "local searxng"}}).to_string(),
    )
    .unwrap();
    let out = run(&root, &[], None);
    assert!(!out.contains("DSH_WEB_SEARCH_PROVIDER"), "{out}");
    let _ = fs::remove_dir_all(root);
}
