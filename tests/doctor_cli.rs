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

/// Doctor with a controlled HOME and PATH, pinned to English so the assertions
/// do not depend on the host locale. With no original, the fallback directories
/// under HOME are what decides (PATH only holds the empty dir).
fn run_doctor_fallback(root: &Path, path: &Path, args: &[&str], original: Option<&Path>) -> Output {
    let home = root.join("home");
    fs::create_dir_all(&home).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
    command
        .arg("doctor")
        .args(args)
        .current_dir(root)
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("LOCALAPPDATA", root.join("local-app-data"))
        .env("DSH_HOME", root.join("dsh"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_DATA_HOME", root.join("data"))
        .env("RDSH_LANG", "en")
        .env_remove("DSH_ORIG_BIN")
        .env("PATH", std::env::join_paths([path]).unwrap());
    match original {
        Some(original) => command.env("RDSH_ORIG_BIN", original),
        None => command.env_remove("RDSH_ORIG_BIN"),
    };
    command.output().unwrap()
}

/// A shim name the fallback scan probes on this platform.
fn shim_name(tool: &str) -> String {
    #[cfg(windows)]
    {
        format!("{tool}.cmd")
    }
    #[cfg(not(windows))]
    {
        tool.to_string()
    }
}

/// A shim that prints one line; only the discovery path is under test, so the
/// body just has to be a runnable program.
fn shim_body(output: &str) -> String {
    #[cfg(windows)]
    {
        format!("@echo {output}\r\n")
    }
    #[cfg(not(windows))]
    {
        format!("#!/bin/sh\necho {output}\n")
    }
}

fn write_shim(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    #[cfg(unix)]
    make_executable(path);
}

#[test]
fn doctor_falls_back_to_a_version_manager_install_outside_path() {
    let root = temp_dir("fallback-nvm");
    let empty_path = root.join("empty-path");
    fs::create_dir_all(&empty_path).unwrap();
    let bin = root
        .join("home")
        .join(".nvm")
        .join("versions")
        .join("node")
        .join("v22.10.0")
        .join("bin");
    fs::create_dir_all(&bin).unwrap();
    let shim = bin.join(shim_name("dsh"));
    write_shim(&shim, &shim_body("stub"));

    let result = run_doctor_fallback(&root, &empty_path, &[], None);
    let output = String::from_utf8_lossy(&result.stdout);
    assert!(
        output.contains("nvm") && output.contains("v22.10.0") && output.contains("dsh"),
        "doctor must resolve the nvm install it cannot see on PATH: {output}"
    );
    assert!(!output.contains("original 'dsh' not found"), "{output}");
    assert!(result.status.success(), "{output}");

    // A version-manager shim that is this very binary must never be taken for
    // the original: the canonical path is the same file.
    #[cfg(unix)]
    {
        fs::remove_file(&shim).unwrap();
        std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_rdsh"), &shim).unwrap();
        let result = run_doctor_fallback(&root, &empty_path, &[], None);
        assert!(
            !result.status.success(),
            "a self-shadowing nvm shim must not be delegated to: {}",
            String::from_utf8_lossy(&result.stdout)
        );
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn doctor_reports_the_pnpm_build_script_policy_and_its_fix() {
    let root = temp_dir("pnpm-policy");
    let empty_path = root.join("empty-path");
    fs::create_dir_all(&empty_path).unwrap();
    let pnpm_bin = root.join("home").join(".local").join("share").join("pnpm");
    fs::create_dir_all(&pnpm_bin).unwrap();
    write_shim(&pnpm_bin.join(shim_name("pnpm")), &shim_body("10.32.0"));

    let result = run_doctor_fallback(&root, &empty_path, &[], None);
    let output = String::from_utf8_lossy(&result.stdout);
    assert!(output.contains("pnpm"), "{output}");
    assert!(
        output.contains("build scripts not pre-approved"),
        "pnpm's default policy blocks dependency builds: {output}"
    );
    assert!(
        output.contains("fix: pnpm approve-builds"),
        "doctor must print the resolution command: {output}"
    );

    // An approved global policy silences the fix.
    let config = root.join("config").join("pnpm");
    fs::create_dir_all(&config).unwrap();
    fs::write(config.join("rc"), "only-built-dependencies[]=sharp\n").unwrap();
    let result = run_doctor_fallback(&root, &empty_path, &[], None);
    let output = String::from_utf8_lossy(&result.stdout);
    assert!(
        output.contains("build scripts allowed by the global config"),
        "{output}"
    );
    assert!(!output.contains("fix: pnpm approve-builds"), "{output}");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn doctor_json_publishes_the_environment_block() {
    let root = temp_dir("doctor-json-env");
    let empty_path = root.join("empty-path");
    fs::create_dir_all(&empty_path).unwrap();
    let pnpm_bin = root.join("home").join(".local").join("share").join("pnpm");
    fs::create_dir_all(&pnpm_bin).unwrap();
    write_shim(&pnpm_bin.join(shim_name("pnpm")), &shim_body("10.32.0"));
    // doctor --json fails without an original dsh; the fallback resolution is
    // covered above, so this stub keeps the JSON contract under test.
    let stub = root.join("stub-dsh");
    write_shim(&stub, &shim_body("stub"));

    let result = run_doctor_fallback(&root, &empty_path, &["--json"], Some(&stub));
    let output = String::from_utf8_lossy(&result.stdout);
    assert!(result.status.success(), "{output}");
    assert!(output.contains("\"environment\":"), "{output}");
    assert!(
        output.contains("\"build_scripts\":\"unapproved\""),
        "{output}"
    );
    assert!(output.contains("\"pnpm\":{\"found\":true"), "{output}");
    assert!(output.contains("pnpm approve-builds"), "{output}");
    fs::remove_dir_all(root).unwrap();
}
