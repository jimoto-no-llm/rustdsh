use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("rdsh-doctor-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(root.join("dsh/profiles")).unwrap();
        Self(root)
    }
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        command.env_clear();
        command
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("DSH_HOME", self.0.join("dsh"))
            .env("PATH", self.0.join("bin"));
        if let Some(system_root) = std::env::var_os("SYSTEMROOT") {
            command.env("SYSTEMROOT", system_root);
        }
        command
    }
    fn original(&self) -> PathBuf {
        let path = self.0.join(if cfg!(windows) {
            "original.cmd"
        } else {
            "original"
        });
        executable(&path, "#!/bin/sh\necho fixture-original\n");
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn executable(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}
fn report(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|_| panic!("doctor did not emit JSON; exit {:?}", output.status.code()))
}

#[test]
fn json_is_read_only_and_does_not_probe_the_original_or_expose_credentials() {
    let f = Fixture::new();
    let original = f.original();
    let marker = f.0.join("original-was-run");
    executable(
        &original,
        &format!("#!/bin/sh\nprintf called > '{}'\n", marker.display()),
    );
    for profile in ["web", "desktop"] {
        std::fs::create_dir_all(f.0.join("dsh/profiles").join(profile)).unwrap();
    }
    std::fs::write(f.0.join("dsh/profiles/README"), "not a profile").unwrap();
    std::fs::write(
        f.0.join("dsh/.credentials.yaml"),
        "fixture-secret-never-echo",
    )
    .unwrap();
    let output = f
        .command()
        .args(["doctor", "--json"])
        .env("RDSH_ORIG_BIN", &original)
        .output()
        .unwrap();
    assert!(output.status.success());
    let value = report(&output);
    assert_eq!(value["schema"], 1);
    assert_eq!(value["ok"], true);
    assert_eq!(value["original"]["probed"], false);
    assert_eq!(value["profiles"]["count"], 2);
    assert!(!String::from_utf8_lossy(&output.stdout).contains("fixture-secret-never-echo"));
    assert!(!marker.exists());
    assert!(!f.0.join("dsh/rdsh.json").exists());
}

#[test]
fn missing_original_still_emits_a_json_report_and_exits_unsuccessfully() {
    let f = Fixture::new();
    let output = f.command().args(["doctor", "--json"]).output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    let value = report(&output);
    assert_eq!(value["ok"], false);
    assert_eq!(value["original"]["found"], false);
    assert!(value["original"]["path"].is_null());
}

#[test]
fn javascript_original_reports_a_missing_node_without_launching_it() {
    let f = Fixture::new();
    let original = f.0.join("original.js");
    std::fs::write(&original, "throw new Error('must never run');").unwrap();
    let output = f
        .command()
        .args(["doctor", "--json"])
        .env("RDSH_ORIG_BIN", original)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let value = report(&output);
    assert_eq!(value["original"]["found"], true);
    assert_eq!(value["node"]["required"], true);
    assert_eq!(value["node"]["found"], false);
}

#[test]
fn nonexistent_override_is_not_reported_as_an_installed_original() {
    let f = Fixture::new();
    let output = f
        .command()
        .args(["doctor", "--json"])
        .env("RDSH_ORIG_BIN", f.0.join("missing-original"))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(report(&output)["original"]["found"], false);
}

#[test]
fn json_uses_the_same_matching_node_tree_as_delegation() {
    let f = Fixture::new();
    let os = if cfg!(windows) {
        "win"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    let tree = f.0.join(format!(".local/opt/node-v99.0.0-{os}-{arch}"));
    std::fs::create_dir_all(tree.join("bin")).unwrap();
    std::fs::create_dir_all(tree.join("lib")).unwrap();
    let original = tree.join("lib/original.js");
    std::fs::write(&original, "throw new Error('must never run');").unwrap();
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let node = tree.join("bin").join(node_name);
    let marker = f.0.join("node-was-run");
    executable(
        &node,
        &format!(
            "#!/bin/sh\nprintf called > '{}'\nexit 99\n",
            marker.display()
        ),
    );
    executable(&f.0.join("bin").join(node_name), "#!/bin/sh\nexit 98\n");
    let output = f
        .command()
        .args(["doctor", "--json"])
        .env("RDSH_ORIG_BIN", original)
        .output()
        .unwrap();
    assert!(output.status.success());
    let value = report(&output);
    assert_eq!(value["node"]["required"], true);
    let reported = Path::new(value["node"]["path"].as_str().unwrap());
    assert_eq!(
        std::fs::canonicalize(reported).unwrap(),
        std::fs::canonicalize(node).unwrap()
    );
    assert!(!marker.exists());
}

#[cfg(unix)]
#[test]
fn a_later_rdsh_alias_does_not_shadow_the_first_executable_dsh() {
    let f = Fixture::new();
    let original = f.original();
    executable(&f.0.join("bin/dsh"), "#!/bin/sh\nexit 0\n");
    let later = f.0.join("later");
    std::fs::create_dir(&later).unwrap();
    std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_rdsh"), later.join("dsh")).unwrap();
    let path = std::env::join_paths([f.0.join("bin"), later]).unwrap();
    let output = f
        .command()
        .args(["doctor", "--json"])
        .env("RDSH_ORIG_BIN", original)
        .env("PATH", path)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(report(&output)["path_shadowed"], false);
}

#[cfg(unix)]
#[test]
fn explicit_js_launchers_and_comments_do_not_count_as_broken_path_wrappers() {
    let f = Fixture::new();
    let original = f.original();
    let local_bin = f.0.join(".local/bin");
    std::fs::create_dir_all(&local_bin).unwrap();
    executable(
        &local_bin.join("safe"),
        "#!/bin/sh\n# node on dsh is dangerous\nexec node /opt/dsh/index.js\n",
    );
    executable(
        &local_bin.join("broken"),
        "#!/bin/sh\nexec node \"$(command -v dsh)\"\n",
    );
    let output = f
        .command()
        .args(["doctor", "--json"])
        .env("RDSH_ORIG_BIN", original)
        .output()
        .unwrap();
    let warnings = report(&output)["warnings"].as_array().unwrap().clone();
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].as_str().unwrap().contains("broken"));
}

#[cfg(unix)]
#[test]
fn plaintext_diagnosis_does_not_wait_for_a_slow_original_version() {
    let f = Fixture::new();
    let original = f.original();
    executable(
        &original,
        "#!/bin/sh\n/bin/sleep 3\necho delayed-version-fixture\n",
    );
    let output = f
        .command()
        .arg("doctor")
        .env("RDSH_ORIG_BIN", original)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("delayed-version-fixture"));
}

#[cfg(unix)]
#[test]
fn plaintext_preserves_a_successful_original_version() {
    let f = Fixture::new();
    let output = f
        .command()
        .arg("doctor")
        .env("RDSH_ORIG_BIN", f.original())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("dsh version: fixture-original"));
}

#[cfg(unix)]
#[test]
fn an_exited_original_cannot_extend_the_deadline_through_an_inherited_pipe() {
    let f = Fixture::new();
    let original = f.original();
    executable(
        &original,
        "#!/bin/sh\n/bin/sleep 3 &\necho retained-pipe-fixture\nexit 0\n",
    );
    let output = f
        .command()
        .arg("doctor")
        .env("RDSH_ORIG_BIN", original)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("retained-pipe-fixture"));
}
