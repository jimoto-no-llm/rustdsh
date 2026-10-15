use anyhow::{bail, ensure, Context, Result};
use serde_json::{Map, Value};
use std::{
    collections::HashSet,
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(windows)]
static PROCESS_TREE_CONTAINMENT_ACTIVE: AtomicBool = AtomicBool::new(false);
const SAFE_ENV: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "COMSPEC",
    "HOME",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
];

#[derive(Debug)]
struct ProcessOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

pub fn cmd() -> Result<()> {
    #[cfg(windows)]
    let _ = enable_process_tree_containment();

    let request = read_request()?;
    let object = request
        .as_object()
        .context("worker-git request must be a JSON object")?;
    let operation = required_string(object, "op")?;
    let output = match operation {
        "canonical-future" => {
            exact_fields(object, &["op", "path"])?;
            Value::String(path_text(&canonical_future(required_path(
                object, "path",
            )?)?)?)
        }
        "repository" => {
            exact_fields(object, &["op", "root"])?;
            let repo = repository_info(required_path(object, "root")?)?;
            serde_json::json!({
                "root": path_text(&repo.root)?,
                "git_common_dir": path_text(&repo.git_common_dir)?,
                "head_sha": repo.head_sha,
                "branch": repo.branch,
            })
        }
        "source-snapshot" => {
            exact_fields(object, &["op", "root"])?;
            source_snapshot(required_path(object, "root")?)?
        }
        "observe-worktree" => {
            exact_fields(object, &["op", "root", "git_common_dir", "branch", "base"])?;
            observe_worktree(
                required_path(object, "root")?,
                required_path(object, "git_common_dir")?,
                required_string(object, "branch")?,
                required_string(object, "base")?,
            )?
        }
        "dirty-paths" => {
            exact_fields(object, &["op", "root"])?;
            serde_json::json!(dirty_paths(required_path(object, "root")?)?)
        }
        "changed-paths" => {
            exact_fields(object, &["op", "root", "from", "to"])?;
            serde_json::json!(changed_paths(
                required_path(object, "root")?,
                required_string(object, "from")?,
                required_string(object, "to")?,
            )?)
        }
        "tracked-paths" => {
            exact_fields(object, &["op", "root"])?;
            serde_json::json!(tracked_paths(required_path(object, "root")?)?)
        }
        "is-ancestor" => {
            exact_fields(object, &["op", "root", "ancestor", "descendant"])?;
            is_ancestor(
                required_path(object, "root")?,
                required_string(object, "ancestor")?,
                required_string(object, "descendant")?,
            )?;
            Value::Null
        }
        "add-worktree" => {
            exact_fields(object, &["op", "root", "hooks", "branch", "path", "base"])?;
            add_worktree(
                required_path(object, "root")?,
                required_path(object, "hooks")?,
                required_string(object, "branch")?,
                required_path(object, "path")?,
                required_string(object, "base")?,
            )?;
            Value::Null
        }
        _ => bail!("unsupported worker-git operation"),
    };

    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    serde_json::to_writer(&mut stdout, &output)?;
    writeln!(stdout)?;
    Ok(())
}

fn read_request() -> Result<Value> {
    let mut input = Vec::new();
    io::stdin()
        .take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .context("read worker-git request")?;
    if input.len() > MAX_INPUT_BYTES {
        bail!("worker-git request exceeds 2 MiB");
    }
    serde_json::from_slice(&input).context("parse worker-git request")
}

fn exact_fields(object: &Map<String, Value>, allowed: &[&str]) -> Result<()> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        bail!("unknown worker-git request field");
    }
    Ok(())
}

fn required_string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.contains('\0'))
        .with_context(|| format!("worker-git request field {key} must be a string"))
}

fn required_path<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a Path> {
    Ok(Path::new(required_string(object, key)?))
}

fn path_text(path: &Path) -> Result<String> {
    Ok(normalize_windows_path(path)
        .to_str()
        .context("worker-git path is not valid UTF-8")?
        .to_string())
}

fn normalize_windows_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(path) = path.to_str() {
            if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
                return PathBuf::from(format!(r"\\{unc}"));
            }
            if let Some(path) = path.strip_prefix(r"\\?\") {
                return PathBuf::from(path);
            }
        }
    }
    path.to_path_buf()
}

fn canonical_future(path: &Path) -> Result<PathBuf> {
    let mut current = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()?.join(path)
    };
    let mut suffix = Vec::new();
    loop {
        match fs::canonicalize(&current) {
            Ok(canonical) => {
                let mut canonical = normalize_windows_path(&canonical);
                for component in suffix.iter().rev() {
                    canonical.push(component);
                }
                return Ok(canonical);
            }
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    && current.parent().is_some_and(|parent| parent != current) =>
            {
                let name = current
                    .file_name()
                    .context("cannot resolve future path")?
                    .to_os_string();
                suffix.push(name);
                current = current
                    .parent()
                    .context("cannot resolve future path")?
                    .to_path_buf();
            }
            Err(error) => return Err(error).context("canonicalize worker path"),
        }
    }
}

struct RepositoryInfo {
    root: PathBuf,
    git_common_dir: PathBuf,
    head_sha: String,
    branch: Option<String>,
    dirty_paths: Vec<String>,
}

fn repository_info(root: &Path) -> Result<RepositoryInfo> {
    let canonical =
        normalize_windows_path(&fs::canonicalize(root).context("resolve worker repository")?);
    let context_output = git_text(
        &canonical,
        &[
            "rev-parse",
            "--show-cdup",
            "--path-format=absolute",
            "--git-common-dir",
            "HEAD",
        ],
    )?;
    let (common_raw, head_sha) = parse_repository_context(&context_output)?;
    let common = normalize_windows_path(
        &fs::canonicalize(&common_raw).context("resolve Git common directory")?,
    );

    let status = git_text(
        &canonical,
        &[
            "status",
            "--porcelain=v1",
            "--branch",
            "--no-ahead-behind",
            "-z",
            "--untracked-files=all",
        ],
    )?;
    let status = parse_status_v1(&status)?;
    ensure!(valid_head_sha(&head_sha), "git_head_unavailable");
    ensure!(status.branch_header, "Git branch is unavailable");

    Ok(RepositoryInfo {
        root: canonical,
        git_common_dir: common,
        head_sha,
        branch: status.branch,
        dirty_paths: status.dirty_paths,
    })
}

fn parse_repository_context(output: &str) -> Result<(PathBuf, String)> {
    let context = output
        .strip_prefix('\n')
        .context("exact_git_project_root_required")?
        .strip_suffix('\n')
        .context("Git common directory is unavailable")?;
    let (common, head) = context
        .rsplit_once('\n')
        .context("Git repository identity is incomplete")?;
    ensure!(
        Path::new(common).is_absolute(),
        "Git common directory is unavailable"
    );
    ensure!(valid_head_sha(head), "git_head_unavailable");
    Ok((PathBuf::from(common), head.to_string()))
}

struct StatusSnapshot {
    branch: Option<String>,
    branch_header: bool,
    dirty_paths: Vec<String>,
}

fn parse_status_v1(status: &str) -> Result<StatusSnapshot> {
    let parts: Vec<&str> = status.split('\0').collect();
    let mut branch = None;
    let mut branch_header = false;
    let mut names = HashSet::new();
    let mut index = 0;
    while index < parts.len() {
        let item = parts[index];
        index += 1;
        if item.is_empty() {
            continue;
        }
        if let Some(value) = item.strip_prefix("## ") {
            ensure!(!branch_header, "git_status_unobservable");
            branch_header = true;
            branch = parse_branch_header(value);
            continue;
        }

        let bytes = item.as_bytes();
        ensure!(
            bytes.len() >= 3 && bytes[2] == b' ',
            "git_status_unobservable"
        );
        names.insert(item[3..].to_string());
        if bytes[..2].contains(&b'R') || bytes[..2].contains(&b'C') {
            let original = parts
                .get(index)
                .filter(|path| !path.is_empty())
                .context("git_status_unobservable")?;
            names.insert((*original).to_string());
            index += 1;
        }
    }
    ensure!(branch_header, "Git branch is unavailable");

    let mut dirty_paths: Vec<String> = names.into_iter().collect();
    dirty_paths.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    Ok(StatusSnapshot {
        branch,
        branch_header,
        dirty_paths,
    })
}

fn parse_branch_header(header: &str) -> Option<String> {
    if header == "HEAD (no branch)" {
        return None;
    }
    let branch = header
        .strip_prefix("No commits yet on ")
        .or_else(|| header.strip_prefix("Initial commit on "))
        .unwrap_or(header);
    let branch = branch
        .split_once("...")
        .map_or(branch, |(branch, _)| branch);
    let branch = branch.split_once(" [").map_or(branch, |(branch, _)| branch);
    (!branch.is_empty()).then(|| branch.to_string())
}

fn current_head_sha(root: &Path) -> Result<String> {
    let output = git_text(root, &["rev-parse", "--verify", "HEAD"])?;
    let head = output
        .strip_suffix('\n')
        .context("Git repository identity is incomplete")?;
    ensure!(valid_head_sha(head), "git_head_unavailable");
    Ok(head.to_string())
}

fn dirty_paths(root: &Path) -> Result<Vec<String>> {
    let status = git_text(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    parse_dirty_paths(&status)
}

fn parse_dirty_paths(status: &str) -> Result<Vec<String>> {
    let parts: Vec<&str> = status.split('\0').collect();
    let mut names = HashSet::new();
    let mut index = 0;
    while index < parts.len() {
        let item = parts[index];
        index += 1;
        if item.is_empty() {
            continue;
        }
        let bytes = item.as_bytes();
        ensure!(
            bytes.len() >= 4 && bytes[2] == b' ',
            "git_status_unobservable"
        );
        names.insert(item[3..].to_string());
        if bytes[..2].contains(&b'R') || bytes[..2].contains(&b'C') {
            let original = parts
                .get(index)
                .filter(|path| !path.is_empty())
                .context("git_status_unobservable")?;
            names.insert((*original).to_string());
            index += 1;
        }
    }
    let mut names: Vec<String> = names.into_iter().collect();
    names.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    Ok(names)
}

fn changed_paths(root: &Path, from: &str, to: &str) -> Result<Vec<String>> {
    ensure!(
        valid_head_sha(from) && valid_head_sha(to),
        "invalid_git_comparison"
    );
    let diff = git_text(
        root,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--name-only",
            "-z",
            from,
            to,
            "--",
        ],
    )?;
    let mut paths: Vec<String> = diff
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect();
    paths.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    Ok(paths)
}

fn tracked_paths(root: &Path) -> Result<Vec<String>> {
    let tracked = git_text(root, &["ls-files", "-z", "--cached"])?;
    Ok(tracked
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect())
}

fn source_snapshot(root: &Path) -> Result<Value> {
    let repo = repository_info(root)?;
    Ok(serde_json::json!({
        "root": path_text(&repo.root)?,
        "git_common_dir": path_text(&repo.git_common_dir)?,
        "head_sha": repo.head_sha,
        "branch": repo.branch,
        "dirty_paths": repo.dirty_paths,
    }))
}

fn observe_worktree(
    root: &Path,
    expected_common: &Path,
    expected_branch: &str,
    base: &str,
) -> Result<Value> {
    ensure!(valid_head_sha(base), "invalid_git_comparison");
    let current = repository_info(root)?;
    ensure!(
        same_path(&current.git_common_dir, expected_common)
            && current.branch.as_deref() == Some(expected_branch),
        "worker_worktree_identity_changed"
    );
    is_ancestor(&current.root, base, &current.head_sha)?;
    let dirty = current.dirty_paths;
    let committed = changed_paths(&current.root, base, &current.head_sha)?;
    let mut changed: Vec<String> = dirty
        .iter()
        .chain(committed.iter())
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    changed.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    ensure!(
        current_head_sha(&current.root)? == current.head_sha,
        "worker_head_changed_during_scan"
    );
    Ok(serde_json::json!({
        "head_sha": current.head_sha,
        "dirty_paths": dirty,
        "committed_paths": committed,
        "changed_paths": changed,
    }))
}

fn is_ancestor(root: &Path, ancestor: &str, descendant: &str) -> Result<()> {
    ensure!(
        valid_head_sha(ancestor) && valid_head_sha(descendant),
        "invalid_git_comparison"
    );
    let output = git_raw(root, &["merge-base", "--is-ancestor", ancestor, descendant])?;
    if output.status.success() {
        Ok(())
    } else {
        bail!(git_failure(&output));
    }
}

fn add_worktree(
    root: &Path,
    hooks_path: &Path,
    branch: &str,
    path: &Path,
    base: &str,
) -> Result<()> {
    ensure!(valid_head_sha(base), "invalid_git_comparison");
    ensure!(!branch.is_empty(), "invalid_worker_branch");
    let repo = repository_info(root)?;
    let hooks = normalize_windows_path(
        &fs::canonicalize(hooks_path).context("resolve empty hooks directory")?,
    );
    ensure!(
        same_path(hooks_path, &hooks),
        "worker_hooks_directory_unavailable"
    );
    ensure!(hooks.is_dir(), "worker_hooks_directory_unavailable");
    ensure!(
        fs::read_dir(&hooks)?.next().is_none(),
        "worker_hooks_directory_not_empty"
    );
    let target = canonical_future(path)?;
    ensure!(same_path(path, &target), "worker_worktree_path_changed");
    let hooks_arg = format!("core.hooksPath={}", path_text(&hooks)?);
    let target_for_git = normalize_windows_path(&target);
    let output = git_raw_with(&repo.root, |command| {
        command
            .arg("-c")
            .arg(hooks_arg)
            .args(["worktree", "add", "--no-track", "-b", branch, "--"])
            .arg(&target_for_git)
            .arg(base);
    })?;
    ensure!(output.status.success(), "{}", git_failure(&output));
    Ok(())
}

fn valid_head_sha(value: &str) -> bool {
    (40..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        let left = normalize_windows_path(left);
        let right = normalize_windows_path(right);
        if left
            .to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
        {
            return true;
        }
        match (canonical_future(&left), canonical_future(&right)) {
            (Ok(left), Ok(right)) => left
                .to_string_lossy()
                .eq_ignore_ascii_case(&right.to_string_lossy()),
            _ => false,
        }
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn git_text(root: &Path, args: &[&str]) -> Result<String> {
    let output = git_raw(root, args)?;
    if !output.status.success() {
        bail!(git_failure(&output));
    }
    decode_stdout(output.stdout)
}

fn git_raw(root: &Path, args: &[&str]) -> Result<ProcessOutput> {
    git_raw_with(root, |command| {
        command.args(args);
    })
}

fn git_raw_with(root: &Path, configure: impl FnOnce(&mut Command)) -> Result<ProcessOutput> {
    let mut command = Command::new("git");
    command.arg("-C").arg(root);
    configure(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.env_clear();
    for key in SAFE_ENV {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    run_bounded(command, GIT_TIMEOUT, MAX_OUTPUT_BYTES)
}

fn run_bounded(mut command: Command, timeout: Duration, max_bytes: usize) -> Result<ProcessOutput> {
    configure_process_tree(&mut command);
    let mut child = command.spawn().context("start Git command")?;
    let mut process_tree = match ProcessTreeGuard::attach(&mut child) {
        Ok(process_tree) => process_tree,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error).context("isolate Git command process tree");
        }
    };
    let stdout = child.stdout.take().context("capture Git stdout")?;
    let stderr = child.stderr.take().context("capture Git stderr")?;
    let (stdout_tx, stdout_rx) = mpsc::sync_channel(1);
    let (stderr_tx, stderr_rx) = mpsc::sync_channel(1);
    let stdout_reader = thread::spawn(move || {
        let _ = stdout_tx.send(read_limited(stdout, max_bytes));
    });
    let stderr_reader = thread::spawn(move || {
        let _ = stderr_tx.send(read_limited(stderr, max_bytes));
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                process_tree.terminate(&mut child);
                let _ = child.wait();
                bail!("Git command timed out after {} seconds", timeout.as_secs());
            }
            Err(error) => {
                process_tree.terminate(&mut child);
                let _ = child.wait();
                return Err(error).context("wait for Git command");
            }
        }
    };
    let remaining = timeout.saturating_sub(started.elapsed());
    let stdout_result = match stdout_rx.recv_timeout(remaining) {
        Ok(result) => result,
        Err(_) => {
            process_tree.terminate(&mut child);
            let _ = child.wait();
            bail!("Git command timed out after {} seconds", timeout.as_secs());
        }
    };
    let remaining = timeout.saturating_sub(started.elapsed());
    let stderr_result = match stderr_rx.recv_timeout(remaining) {
        Ok(result) => result,
        Err(_) => {
            process_tree.terminate(&mut child);
            let _ = child.wait();
            bail!("Git command timed out after {} seconds", timeout.as_secs());
        }
    };
    stdout_reader
        .join()
        .map_err(|_| anyhow::anyhow!("Git stdout reader stopped unexpectedly"))?;
    stderr_reader
        .join()
        .map_err(|_| anyhow::anyhow!("Git stderr reader stopped unexpectedly"))?;
    let (stdout, stdout_overflow) = stdout_result?;
    let (stderr, stderr_overflow) = stderr_result?;
    if stdout_overflow || stderr_overflow {
        bail!("Git output exceeds 2 MiB");
    }
    Ok(ProcessOutput {
        status,
        stdout,
        stderr,
    })
}

#[cfg(unix)]
fn configure_process_tree(command: &mut Command) {
    command.process_group(0);
}

#[cfg(windows)]
fn configure_process_tree(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    let flags = if PROCESS_TREE_CONTAINMENT_ACTIVE.load(Ordering::Relaxed) {
        CREATE_NO_WINDOW
    } else {
        CREATE_NO_WINDOW | windows_sys::Win32::System::Threading::CREATE_SUSPENDED
    };
    command.creation_flags(flags);
}

#[cfg(not(any(unix, windows)))]
fn configure_process_tree(_command: &mut Command) {}

#[cfg(unix)]
struct ProcessTreeGuard {
    process_group: i32,
    terminated: bool,
}

#[cfg(unix)]
impl ProcessTreeGuard {
    fn attach(child: &mut std::process::Child) -> io::Result<Self> {
        Ok(Self {
            process_group: child.id() as i32,
            terminated: false,
        })
    }

    fn terminate(&mut self, child: &mut std::process::Child) {
        let result = unsafe { libc::kill(-self.process_group, libc::SIGKILL) };
        if result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            self.terminated = true;
        }
        let _ = child.kill();
    }
}

#[cfg(unix)]
impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        if !self.terminated {
            unsafe {
                libc::kill(-self.process_group, libc::SIGKILL);
            }
        }
    }
}

#[cfg(windows)]
struct ProcessTreeGuard {
    job: Option<windows_sys::Win32::Foundation::HANDLE>,
}

#[cfg(windows)]
impl ProcessTreeGuard {
    fn attach(child: &mut std::process::Child) -> io::Result<Self> {
        if PROCESS_TREE_CONTAINMENT_ACTIVE.load(Ordering::Relaxed) {
            // Git inherits the worker's job before it starts, so this operation
            // avoids a system-wide thread snapshot for every Git subprocess.
            return Ok(Self { job: None });
        }

        use std::{
            mem::{size_of, zeroed},
            os::windows::io::AsRawHandle,
            ptr::null,
        };
        use windows_sys::Win32::{
            Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                    THREADENTRY32,
                },
                JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
                Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
            },
        };

        struct Handle(HANDLE);
        impl Drop for Handle {
            fn drop(&mut self) {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
        impl Handle {
            fn into_raw(self) -> HANDLE {
                let handle = self.0;
                std::mem::forget(self);
                handle
            }
        }

        unsafe {
            let job = CreateJobObjectW(null(), null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Handle(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let process = child.as_raw_handle() as HANDLE;
            if AssignProcessToJobObject(job.0, process) == 0 {
                return Err(io::Error::last_os_error());
            }

            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let snapshot = Handle(snapshot);
            let mut entry = THREADENTRY32 {
                dwSize: size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            let mut primary_thread = None;
            if Thread32First(snapshot.0, &mut entry) != 0 {
                loop {
                    if entry.th32OwnerProcessID == child.id() {
                        primary_thread = Some(entry.th32ThreadID);
                        break;
                    }
                    if Thread32Next(snapshot.0, &mut entry) == 0 {
                        break;
                    }
                }
            }
            let thread_id = primary_thread.ok_or_else(io::Error::last_os_error)?;
            let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id);
            if thread.is_null() {
                return Err(io::Error::last_os_error());
            }
            let thread = Handle(thread);
            if ResumeThread(thread.0) == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            Ok(Self {
                job: Some(job.into_raw()),
            })
        }
    }

    fn terminate(&mut self, child: &mut std::process::Child) {
        if let Some(job) = self.job {
            unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(job, 1);
            }
        }
        let _ = child.kill();
    }
}

#[cfg(windows)]
impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        if let Some(job) = self.job {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(job);
            }
        }
    }
}

#[cfg(windows)]
fn enable_process_tree_containment() -> io::Result<()> {
    use std::{mem::zeroed, ptr::null};
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::GetCurrentProcess,
        },
    };

    unsafe {
        let job = CreateJobObjectW(null(), null());
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            let error = io::Error::last_os_error();
            CloseHandle(job);
            return Err(error);
        }
        if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            let error = io::Error::last_os_error();
            CloseHandle(job);
            return Err(error);
        }

        // Keep the kill-on-close handle open until this one-request bridge
        // process exits. Windows then terminates any Git descendants still
        // inside the job. Closing it here would also terminate this process.
        PROCESS_TREE_CONTAINMENT_ACTIVE.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
struct ProcessTreeGuard;

#[cfg(not(any(unix, windows)))]
impl ProcessTreeGuard {
    fn attach(_child: &mut std::process::Child) -> io::Result<Self> {
        Ok(Self)
    }

    fn terminate(&self, child: &mut std::process::Child) {
        let _ = child.kill();
    }
}

fn read_limited(mut reader: impl Read, max_bytes: usize) -> io::Result<(Vec<u8>, bool)> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let remaining = max_bytes.saturating_add(1).saturating_sub(output.len());
        output.extend_from_slice(&buffer[..count.min(remaining)]);
    }
    let overflow = output.len() > max_bytes;
    if overflow {
        output.truncate(max_bytes);
    }
    Ok((output, overflow))
}

fn decode_stdout(stdout: Vec<u8>) -> Result<String> {
    String::from_utf8(stdout).context("Git output is not valid UTF-8")
}

fn git_failure(output: &ProcessOutput) -> String {
    let code = output
        .status
        .code()
        .map_or_else(|| "signal".to_string(), |code| code.to_string());
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim();
    if detail.is_empty() {
        format!("Git command failed with exit code {code}")
    } else {
        format!("Git command failed with exit code {code}: {detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn repository_context_preserves_newlines_in_common_dir() {
        let head = "0123456789abcdef0123456789abcdef01234567";
        let output = format!("\n/tmp/repo\nname/.git\n{head}\n");
        assert_eq!(
            parse_repository_context(&output).unwrap(),
            (PathBuf::from("/tmp/repo\nname/.git"), head.to_string())
        );
    }

    #[test]
    fn repository_context_rejects_non_root_working_directories() {
        let output = "../\n/tmp/repo/.git\n0123456789abcdef0123456789abcdef01234567\n";
        assert_eq!(
            parse_repository_context(output).unwrap_err().to_string(),
            "exact_git_project_root_required"
        );
    }

    #[test]
    fn porcelain_v1_status_preserves_branch_and_rename_paths() {
        let status = concat!(
            "## feature/test...origin/feature/test [ahead 1]\0",
            " M modified path.txt\0",
            "R  new name.txt\0old name.txt\0",
            "?? untracked\nname.txt\0"
        );
        let parsed = parse_status_v1(status).unwrap();
        assert_eq!(parsed.branch.as_deref(), Some("feature/test"));
        assert_eq!(
            parsed.dirty_paths,
            [
                "modified path.txt",
                "new name.txt",
                "old name.txt",
                "untracked\nname.txt"
            ]
        );
    }

    #[test]
    fn porcelain_v1_status_keeps_twenty_thousand_dirty_paths_under_output_limit() {
        use std::fmt::Write as _;

        let mut status = String::from("## main\0");
        for index in 0..20_000 {
            write!(status, " M file-{index:05}.txt\0").unwrap();
        }
        assert!(status.len() < MAX_OUTPUT_BYTES);

        let parsed = parse_status_v1(&status).unwrap();
        assert_eq!(parsed.branch.as_deref(), Some("main"));
        assert_eq!(parsed.dirty_paths.len(), 20_000);
    }

    #[test]
    fn porcelain_v1_status_uses_no_branch_for_detached_head() {
        let parsed = parse_status_v1("## HEAD (no branch)\0").unwrap();
        assert_eq!(parsed.branch, None);
        assert!(parsed.dirty_paths.is_empty());
    }

    #[test]
    fn nul_status_parsing_keeps_both_names_and_uses_utf16_sort_order() {
        let parsed = parse_dirty_paths("R  new name\0old name\0?? 🦀.txt\0").unwrap();
        assert_eq!(parsed, ["new name", "old name", "🦀.txt"]);
    }

    #[cfg(windows)]
    #[test]
    fn windows_verbatim_and_unc_paths_match_normal_paths() {
        assert!(same_path(
            Path::new(r"\\?\C:\Users\runner\repo"),
            Path::new(r"C:\Users\runner\repo")
        ));
        assert!(same_path(
            Path::new(r"\\?\UNC\server\share\repo"),
            Path::new(r"\\server\share\repo")
        ));
        assert_eq!(
            normalize_windows_path(Path::new(r"\\?\C:\Users\runner\repo")),
            PathBuf::from(r"C:\Users\runner\repo")
        );
        assert_eq!(
            normalize_windows_path(Path::new(r"\\?\UNC\server\share\repo")),
            PathBuf::from(r"\\server\share\repo")
        );
    }

    #[test]
    fn bounded_reader_stops_storing_after_limit_but_drains_input() {
        let input = Cursor::new(b"0123456789".to_vec());
        let (output, overflow) = read_limited(input, 5).unwrap();
        assert_eq!(output, b"01234");
        assert!(overflow);
    }

    #[test]
    fn git_output_decoder_rejects_invalid_utf8() {
        assert!(decode_stdout(vec![b'a', 0xff]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn command_timeout_kills_the_child() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "exec sleep 5"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let start = Instant::now();
        let error = run_bounded(command, Duration::from_millis(25), 1024).unwrap_err();
        assert!(error.to_string().contains("timed out"), "{error:?}");
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn command_timeout_kills_descendants_that_hold_pipes_open() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 3 & wait"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let start = Instant::now();
        let error = run_bounded(command, Duration::from_millis(100), 1024).unwrap_err();
        assert!(error.to_string().contains("timed out"), "{error:?}");
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[cfg(unix)]
    #[test]
    fn command_exit_does_not_wait_for_descendants_that_hold_pipes_open() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 3 & exit 0"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let start = Instant::now();
        let error = run_bounded(command, Duration::from_millis(100), 1024).unwrap_err();
        assert!(error.to_string().contains("timed out"), "{error:?}");
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
