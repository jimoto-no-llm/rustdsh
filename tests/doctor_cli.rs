use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_dir(tag: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "rdsh-doctor-cli-{tag}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn run_doctor(root: &Path, cwd: &Path, path: &Path, original: &str) -> Output {
    let home = root.join("home");
    fs::create_dir_all(&home).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
    command
        .arg("doctor")
        .current_dir(cwd)
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("LOCALAPPDATA", root.join("local-app-data"))
        .env("DSH_HOME", root.join("dsh"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_DATA_HOME", root.join("data"))
        .env("RDSH_ORIG_BIN", original)
        .env_remove("DSH_ORIG_BIN")
        .env("PATH", std::env::join_paths([path]).unwrap());
    command.output().unwrap()
}

#[cfg(unix)]
#[test]
fn doctor_resolves_bare_original_override_from_path_not_working_directory() {
    let root = temp_dir("path-override");
    let cwd = root.join("cwd");
    let path_dir = root.join("path");
    let empty_path = root.join("empty-path");
    fs::create_dir_all(&cwd).unwrap();
    fs::create_dir_all(&path_dir).unwrap();
    fs::create_dir_all(&empty_path).unwrap();

    let on_path = path_dir.join("dsh-original");
    fs::write(&on_path, "#!/bin/sh\nexit 0\n").unwrap();
    make_executable(&on_path);
    let path_result = run_doctor(&root, &cwd, &path_dir, "dsh-original");
    let path_output = String::from_utf8_lossy(&path_result.stdout);
    assert!(
        !path_output.contains("RDSH_ORIG_BIN=dsh-original is not a usable"),
        "{path_output}"
    );

    let only_in_cwd = cwd.join("dsh-original");
    fs::write(&only_in_cwd, "#!/bin/sh\nexit 0\n").unwrap();
    make_executable(&only_in_cwd);
    let cwd_result = run_doctor(&root, &cwd, &empty_path, "dsh-original");
    let cwd_output = String::from_utf8_lossy(&cwd_result.stdout);
    assert!(
        cwd_output.contains("RDSH_ORIG_BIN=dsh-original is not a usable"),
        "{cwd_output}"
    );

    let missing_result = run_doctor(&root, &cwd, &empty_path, "missing-dsh");
    let missing_output = String::from_utf8_lossy(&missing_result.stdout);
    assert!(
        missing_output.contains("RDSH_ORIG_BIN=missing-dsh is not a usable"),
        "{missing_output}"
    );
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn doctor_accepts_bare_js_original_override_from_current_directory() {
    let root = temp_dir("js-cwd-override");
    let cwd = root.join("cwd");
    let path_dir = root.join("path");
    fs::create_dir_all(&cwd).unwrap();
    fs::create_dir_all(&path_dir).unwrap();

    let entry = cwd.join("entry.js");
    fs::write(&entry, "process.exit(0);\n").unwrap();
    let result = run_doctor(&root, &cwd, &path_dir, "entry.js");
    let output = String::from_utf8_lossy(&result.stdout);
    assert!(
        !output.contains("RDSH_ORIG_BIN=entry.js is not a usable"),
        "Node receives a bare JS entrypoint as a file argument resolved from CWD: {output}"
    );
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn doctor_does_not_resolve_bare_js_original_override_from_path() {
    let root = temp_dir("js-path-override");
    let cwd = root.join("cwd");
    let path_dir = root.join("path");
    fs::create_dir_all(&cwd).unwrap();
    fs::create_dir_all(&path_dir).unwrap();

    let entry = path_dir.join("entry.js");
    fs::write(&entry, "process.exit(0);\n").unwrap();
    make_executable(&entry);
    let result = run_doctor(&root, &cwd, &path_dir, "entry.js");
    let output = String::from_utf8_lossy(&result.stdout);
    assert!(
        output.contains("RDSH_ORIG_BIN=entry.js is not a usable"),
        "Node treats a bare JS argument as a CWD file, not a PATH command: {output}"
    );
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn doctor_scans_the_windows_installer_wrapper_directory() {
    let root = temp_dir("windows-wrapper-dir");
    let cwd = root.join("cwd");
    let path = root.join("path");
    let local_bin = root.join("local-app-data").join("rdsh").join("bin");
    fs::create_dir_all(&cwd).unwrap();
    fs::create_dir_all(&path).unwrap();
    fs::create_dir_all(&local_bin).unwrap();
    let original = root.join("dsh-original.exe");
    fs::write(&original, b"fixture").unwrap();
    let broken = local_bin.join("dsh-broken.cmd");
    fs::write(&broken, "#!/rdsh-test-interpreter-missing\n").unwrap();

    let result = run_doctor(&root, &cwd, &path, &original.to_string_lossy());
    let output = String::from_utf8_lossy(&result.stdout);
    assert!(output.contains("dsh-broken.cmd needs"), "{output}");
    assert!(
        output.contains(&broken.display().to_string()),
        "diagnostic must show the Windows installer wrapper directory: {output}"
    );
    fs::remove_dir_all(root).unwrap();
}
