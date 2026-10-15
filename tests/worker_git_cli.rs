use serde_json::{json, Value};
#[cfg(windows)]
use std::ffi::OsString;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("rdsh-worker-git-{}-{id}", std::process::id()));
        fs::create_dir_all(&path).expect("create test temp directory");
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .expect("run git fixture command");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("fixture git output is UTF-8")
        .trim()
        .to_string()
}

fn git_with_input(root: &Path, args: &[&str], input: &[u8]) -> String {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start git fixture command");
    child
        .stdin
        .take()
        .expect("git fixture stdin")
        .write_all(input)
        .expect("write git fixture input");
    let output = child.wait_with_output().expect("read git fixture output");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("fixture git output is UTF-8")
        .trim()
        .to_string()
}

fn init_repo(root: &Path) {
    fs::create_dir_all(root).expect("create repository directory");
    git(root, &["init", "-q"]);
    git(root, &["config", "user.name", "RustDSH test"]);
    git(
        root,
        &["config", "user.email", "rustdsh-test@example.invalid"],
    );
    git(root, &["config", "commit.gpgsign", "false"]);
}

fn invoke(request: Value) -> Output {
    invoke_with_path(request, None)
}

fn invoke_with_path(request: Value, path: Option<&std::ffi::OsStr>) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_rdsh"))
        .arg("worker-git")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .envs(path.into_iter().map(|path| ("PATH", path)))
        .spawn()
        .expect("start rdsh worker-git command");
    child
        .stdin
        .take()
        .expect("worker-git stdin")
        .write_all(request.to_string().as_bytes())
        .expect("write worker-git request");
    child.wait_with_output().expect("read worker-git response")
}

#[cfg(unix)]
fn install_git_counter(temp: &Path) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;

    let real_git = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|directory| directory.join("git"))
        .find(|candidate| candidate.is_file())
        .expect("find real git executable");
    let bin = temp.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let count = temp.join("git-count");
    let wrapper = bin.join("git");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nprintf x >> '{}'\nexec '{}' \"$@\"\n",
            count.display(),
            real_git.display()
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(&wrapper).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&wrapper, permissions).unwrap();
    (bin, count)
}

#[cfg(unix)]
fn path_with_git_counter(bin: &Path) -> std::ffi::OsString {
    let mut paths = vec![bin.to_path_buf()];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    std::env::join_paths(paths).expect("join PATH entries")
}

#[cfg(windows)]
fn windows_process_is_running(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };

    unsafe {
        let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if process.is_null() {
            return false;
        }
        let running = WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
        CloseHandle(process);
        running
    }
}

#[cfg(windows)]
fn terminate_windows_test_process(pid: u32) {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
            PROCESS_TERMINATE,
        },
    };

    unsafe {
        let process = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid);
        if process.is_null() {
            return;
        }
        TerminateProcess(process, 1);
        WaitForSingleObject(process, 1_000);
        CloseHandle(process);
    }
}

fn response(output: Output) -> Value {
    assert!(
        output.status.success(),
        "worker-git failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("worker-git response is JSON")
}

#[cfg(windows)]
fn canonical_existing_prefix(path: &Path) -> (PathBuf, Vec<OsString>) {
    let mut current = path.to_path_buf();
    let mut suffix = Vec::new();
    while !current.exists() {
        suffix.push(
            current
                .file_name()
                .expect("future path component")
                .to_os_string(),
        );
        current = current
            .parent()
            .expect("future path has an existing ancestor")
            .to_path_buf();
    }
    suffix.reverse();
    (
        current
            .canonicalize()
            .expect("canonicalize existing prefix"),
        suffix,
    )
}

#[test]
fn repository_and_git_path_operations_preserve_nul_framing() {
    let temp = TempDir::new();
    let root = temp.0.join("repo");
    init_repo(&root);
    fs::write(root.join("old name.txt"), "old\n").unwrap();
    fs::write(root.join("tracked.txt"), "before\n").unwrap();
    git(&root, &["add", "--all"]);
    git(&root, &["commit", "-qm", "initial"]);
    let base = git(&root, &["rev-parse", "HEAD"]);

    fs::write(root.join("tracked.txt"), "after\n").unwrap();
    fs::write(root.join("space name.txt"), "untracked\n").unwrap();
    git(&root, &["mv", "old name.txt", "new name.txt"]);

    let dirty = response(invoke(json!({"op":"dirty-paths","root":root})));
    assert_eq!(
        dirty,
        json!([
            "new name.txt",
            "old name.txt",
            "space name.txt",
            "tracked.txt"
        ])
    );

    let tracked = response(invoke(json!({"op":"tracked-paths","root":root})));
    assert_eq!(tracked, json!(["new name.txt", "tracked.txt"]));

    git(&root, &["add", "--all"]);
    git(&root, &["commit", "-qm", "rename and edit"]);
    let head = git(&root, &["rev-parse", "HEAD"]);
    let changed = response(invoke(
        json!({"op":"changed-paths","root":root,"from":base,"to":head}),
    ));
    assert_eq!(
        changed,
        json!([
            "new name.txt",
            "old name.txt",
            "space name.txt",
            "tracked.txt"
        ])
    );

    let repository = response(invoke(json!({"op":"repository","root":root})));
    #[cfg(windows)]
    assert_eq!(
        fs::canonicalize(repository["root"].as_str().unwrap()).unwrap(),
        root.canonicalize().unwrap()
    );
    #[cfg(not(windows))]
    assert_eq!(
        repository["root"],
        root.canonicalize().unwrap().to_str().unwrap()
    );
    assert_eq!(repository["head_sha"], head);
    assert!(repository["git_common_dir"].as_str().is_some());
    assert!(repository["branch"].is_string() || repository["branch"].is_null());

    let source = response(invoke(json!({"op":"source-snapshot","root":root})));
    assert_eq!(source["head_sha"], head);
    assert_eq!(source["dirty_paths"], json!([]));

    let observed = response(invoke(json!({
        "op":"observe-worktree",
        "root":root,
        "git_common_dir":repository["git_common_dir"],
        "branch":repository["branch"],
        "base":base
    })));
    assert_eq!(observed["head_sha"], head);
    assert_eq!(observed["committed_paths"], changed);
    assert_eq!(observed["dirty_paths"], json!([]));

    response(invoke(
        json!({"op":"is-ancestor","root":root,"ancestor":base,"descendant":head}),
    ));
}

#[cfg(windows)]
#[test]
fn worker_git_terminates_git_descendants_when_the_bridge_exits() {
    use std::{thread, time::Duration};

    let temp = TempDir::new();
    let root = temp.0.join("repo");
    init_repo(&root);
    let fake_bin = temp.0.join("fake-git-bin");
    fs::create_dir_all(&fake_bin).unwrap();
    let fake_git = fake_bin.join("git.exe");
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("worker_git_descendant.rs");
    let compile = Command::new("rustc")
        .arg("--edition=2024")
        .arg(fixture)
        .arg("-o")
        .arg(&fake_git)
        .output()
        .expect("compile fake Git executable");
    assert!(
        compile.status.success(),
        "compile fake Git failed: {}",
        String::from_utf8_lossy(&compile.stderr)
    );
    let path = std::env::join_paths([fake_bin]).expect("build fake Git PATH");

    let result = invoke_with_path(json!({"op":"repository","root":root}), Some(&path));
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let repository = response(result);
    assert_eq!(
        repository["head_sha"],
        "0123456789abcdef0123456789abcdef01234567"
    );

    let pid_file = root.join(".git").join("worker-git-descendants");
    let pids: Vec<u32> = fs::read_to_string(pid_file)
        .expect("read descendant PIDs")
        .lines()
        .map(|pid| pid.parse().expect("valid descendant PID"))
        .collect();
    assert_eq!(pids.len(), 2);

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut running: Vec<u32> = pids
        .into_iter()
        .filter(|pid| windows_process_is_running(*pid))
        .collect();
    while !running.is_empty() && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
        running.retain(|pid| windows_process_is_running(*pid));
    }
    for pid in &running {
        terminate_windows_test_process(*pid);
    }
    assert!(
        running.is_empty(),
        "worker Git left descendant processes alive: {running:?}"
    );
}

#[test]
fn source_snapshot_accepts_twenty_thousand_dirty_paths_within_git_output_limit() {
    use std::fmt::Write as _;

    let temp = TempDir::new();
    let root = temp.0.join("repo");
    init_repo(&root);
    let blob = git_with_input(&root, &["hash-object", "-w", "--stdin"], b"tracked\n");

    let mut index = String::with_capacity(20_000 * 64);
    for number in 0..20_000 {
        writeln!(index, "100644 {blob}\tfile-{number:05}.txt").unwrap();
    }
    git_with_input(&root, &["update-index", "--index-info"], index.as_bytes());
    let tree = git(&root, &["write-tree"]);
    let commit = git_with_input(
        &root,
        &["commit-tree", &tree, "-m", "large dirty-path fixture"],
        b"",
    );
    git(&root, &["update-ref", "HEAD", &commit]);

    let v1 = git(
        &root,
        &[
            "status",
            "--porcelain=v1",
            "--branch",
            "--no-ahead-behind",
            "-z",
            "--untracked-files=all",
        ],
    );
    let v2 = git(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--no-ahead-behind",
            "-z",
            "--untracked-files=all",
        ],
    );
    let git_output_limit = 2 * 1024 * 1024;
    assert!(v1.len() < git_output_limit);
    assert!(v2.len() > git_output_limit);

    let source = response(invoke(json!({"op":"source-snapshot","root":root})));
    let paths = source["dirty_paths"].as_array().unwrap();
    assert_eq!(paths.len(), 20_000);
    assert_eq!(paths.first().unwrap(), "file-00000.txt");
    assert_eq!(paths.last().unwrap(), "file-19999.txt");
}

#[cfg(unix)]
#[test]
fn source_snapshot_and_worktree_observation_minimize_git_process_starts() {
    let temp = TempDir::new();
    let root = temp.0.join("repo");
    init_repo(&root);
    fs::write(root.join("tracked.txt"), "base\n").unwrap();
    git(&root, &["add", "--all"]);
    git(&root, &["commit", "-qm", "initial"]);
    let base = git(&root, &["rev-parse", "HEAD"]);
    let repository = response(invoke(json!({"op":"repository","root":root})));
    let (bin, count) = install_git_counter(&temp.0);
    let path = path_with_git_counter(&bin);

    let source = response(invoke_with_path(
        json!({"op":"source-snapshot","root":root}),
        Some(&path),
    ));
    assert_eq!(source["head_sha"], base);
    assert_eq!(fs::read(&count).unwrap().len(), 2);

    fs::write(&count, "").unwrap();
    let observed = response(invoke_with_path(
        json!({
            "op":"observe-worktree",
            "root":root,
            "git_common_dir":repository["git_common_dir"],
            "branch":repository["branch"],
            "base":base
        }),
        Some(&path),
    ));
    assert_eq!(observed["head_sha"], base);
    assert_eq!(fs::read(&count).unwrap().len(), 5);
}

#[cfg(unix)]
#[test]
fn repository_metadata_preserves_newlines_in_repository_paths() {
    let temp = TempDir::new();
    let root = temp.0.join("repo\nwith newline");
    init_repo(&root);
    fs::write(root.join("tracked.txt"), "base\n").unwrap();
    git(&root, &["add", "--all"]);
    git(&root, &["commit", "-qm", "initial"]);

    let repository = response(invoke(json!({"op":"repository","root":root})));
    let canonical = root.canonicalize().unwrap();
    assert_eq!(repository["root"], canonical.to_str().unwrap());
    assert_eq!(
        repository["git_common_dir"],
        canonical.join(".git").to_str().unwrap()
    );
}

#[cfg(unix)]
#[test]
fn linked_worktree_metadata_preserves_newlines_in_common_directory() {
    let temp = TempDir::new();
    let repository_root = temp.0.join("repo\nwith newline");
    init_repo(&repository_root);
    fs::write(repository_root.join("tracked.txt"), "base\n").unwrap();
    git(&repository_root, &["add", "--all"]);
    git(&repository_root, &["commit", "-qm", "initial"]);
    let head = git(&repository_root, &["rev-parse", "HEAD"]);

    let worktree = temp.0.join("worker");
    git(
        &repository_root,
        &[
            "worktree",
            "add",
            "-b",
            "rdsh-worker",
            worktree.to_str().unwrap(),
            "HEAD",
        ],
    );

    let repository = response(invoke(json!({"op":"repository","root":worktree})));
    let common = repository_root.canonicalize().unwrap().join(".git");
    assert_eq!(
        repository["root"],
        worktree.canonicalize().unwrap().to_str().unwrap()
    );
    assert_eq!(repository["git_common_dir"], common.to_str().unwrap());
    assert_eq!(repository["head_sha"], head);
    assert_eq!(repository["branch"], "rdsh-worker");

    let observed = response(invoke(json!({
        "op":"observe-worktree",
        "root":worktree,
        "git_common_dir":common,
        "branch":"rdsh-worker",
        "base":head
    })));
    assert_eq!(observed["head_sha"], head);
}

#[test]
fn canonical_future_resolves_existing_parents_and_add_worktree_uses_isolated_hooks() {
    let temp = TempDir::new();
    let root = temp.0.join("repo");
    init_repo(&root);
    fs::write(root.join("tracked.txt"), "base\n").unwrap();
    git(&root, &["add", "--all"]);
    git(&root, &["commit", "-qm", "initial"]);
    let base = git(&root, &["rev-parse", "HEAD"]);

    let future = root.join("future").join("child");
    let resolved = response(invoke(json!({"op":"canonical-future","path":future})))
        .as_str()
        .unwrap()
        .to_string();
    #[cfg(windows)]
    {
        let (resolved_root, suffix) = canonical_existing_prefix(Path::new(&resolved));
        assert_eq!(resolved_root, root.canonicalize().unwrap());
        assert_eq!(suffix, [OsString::from("future"), OsString::from("child")]);
    }
    #[cfg(not(windows))]
    assert_eq!(
        resolved,
        root.canonicalize()
            .unwrap()
            .join("future")
            .join("child")
            .to_str()
            .unwrap()
    );

    #[cfg(windows)]
    let worktree_parent = temp.0.clone();
    #[cfg(not(windows))]
    let worktree_parent = temp.0.canonicalize().unwrap();
    let hooks = worktree_parent.join("empty-hooks");
    let worktree = worktree_parent.join("workers").join("worker-a");
    fs::create_dir_all(&hooks).unwrap();
    fs::create_dir_all(worktree.parent().unwrap()).unwrap();
    response(invoke(json!({
        "op":"add-worktree",
        "root":root,
        "hooks":hooks,
        "branch":"rdsh-worker-a",
        "path":worktree,
        "base":base
    })));
    assert!(worktree.join(".git").exists());
    assert_eq!(
        git(&worktree, &["branch", "--show-current"]),
        "rdsh-worker-a"
    );
}

#[test]
fn worker_git_rejects_unknown_fields_and_invalid_comparisons() {
    let unknown = invoke(json!({"op":"tracked-paths","root":"/tmp","extra":true}));
    assert!(!unknown.status.success());
    assert!(String::from_utf8_lossy(&unknown.stderr).contains("unknown"));

    let invalid_sha =
        invoke(json!({"op":"changed-paths","root":"/tmp","from":"BAD","to":"also-bad"}));
    assert!(!invalid_sha.status.success());
    assert!(String::from_utf8_lossy(&invalid_sha.stderr).contains("comparison"));
}

#[test]
fn detached_repository_has_no_branch_name() {
    let temp = TempDir::new();
    let root = temp.0.join("repo");
    init_repo(&root);
    fs::write(root.join("tracked.txt"), "base\n").unwrap();
    git(&root, &["add", "--all"]);
    git(&root, &["commit", "-qm", "initial"]);
    git(&root, &["checkout", "--detach", "HEAD"]);

    let repository = response(invoke(json!({"op":"repository","root":root})));
    assert_eq!(repository["branch"], Value::Null);
}

#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn git_paths_with_invalid_utf8_fail_closed() {
    use std::os::unix::ffi::OsStringExt;

    let temp = TempDir::new();
    let root = temp.0.join("repo");
    init_repo(&root);
    let invalid_name = std::ffi::OsString::from_vec(b"bad-\xff-name".to_vec());
    fs::write(root.join(invalid_name), "invalid UTF-8 path\n").unwrap();

    let output = invoke(json!({"op":"dirty-paths","root":root}));
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr)
        .to_lowercase()
        .contains("utf-8"));
}
