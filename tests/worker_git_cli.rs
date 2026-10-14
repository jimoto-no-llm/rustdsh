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
    let mut child = Command::new(env!("CARGO_BIN_EXE_rdsh"))
        .arg("worker-git")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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
