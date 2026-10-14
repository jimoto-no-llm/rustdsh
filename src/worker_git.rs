use anyhow::{bail, ensure, Context, Result};
use serde_json::{Map, Value};
use std::{
    collections::HashSet,
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(30);
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
    Ok(path
        .to_str()
        .context("worker-git path is not valid UTF-8")?
        .to_string())
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
            Ok(mut canonical) => {
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
}

fn repository_info(root: &Path) -> Result<RepositoryInfo> {
    let canonical = fs::canonicalize(root).context("resolve worker repository")?;
    let metadata = git_text(
        &canonical,
        &[
            "rev-parse",
            "--show-toplevel",
            "--git-common-dir",
            "HEAD",
            "--abbrev-ref",
            "HEAD",
        ],
    )?;
    let mut lines = metadata.lines();
    let top = fs::canonicalize(lines.next().context("Git project root is unavailable")?)
        .context("resolve Git project root")?;
    ensure!(
        same_path(&canonical, &top),
        "exact_git_project_root_required"
    );

    let common_raw = lines
        .next()
        .context("Git common directory is unavailable")?;
    let common = fs::canonicalize(canonical.join(common_raw.trim()))
        .context("resolve Git common directory")?;
    let head_sha = lines.next().context("Git HEAD is unavailable")?.to_string();
    ensure!(valid_head_sha(&head_sha), "git_head_unavailable");

    let branch = match lines.next().context("Git branch is unavailable")? {
        "HEAD" => None,
        branch => Some(branch.to_string()),
    };
    ensure!(lines.next().is_none(), "unexpected Git metadata output");

    Ok(RepositoryInfo {
        root: canonical,
        git_common_dir: common,
        head_sha,
        branch,
    })
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
    let dirty = dirty_paths(&repo.root)?;
    Ok(serde_json::json!({
        "root": path_text(&repo.root)?,
        "git_common_dir": path_text(&repo.git_common_dir)?,
        "head_sha": repo.head_sha,
        "branch": repo.branch,
        "dirty_paths": dirty,
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
    let dirty = dirty_paths(&current.root)?;
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
        repository_info(&current.root)?.head_sha == current.head_sha,
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
    let hooks = fs::canonicalize(hooks_path).context("resolve empty hooks directory")?;
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
    let output = git_raw_with(&repo.root, |command| {
        command
            .arg("-c")
            .arg(hooks_arg)
            .args(["worktree", "add", "--no-track", "-b", branch, "--"])
            .arg(&target)
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
        left.to_string_lossy()
            .to_lowercase()
            .eq(&right.to_string_lossy().to_lowercase())
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
    let mut child = command.spawn().context("start Git command")?;
    let stdout = child.stdout.take().context("capture Git stdout")?;
    let stderr = child.stderr.take().context("capture Git stderr")?;
    let stdout_reader = thread::spawn(move || read_limited(stdout, max_bytes));
    let stderr_reader = thread::spawn(move || read_limited(stderr, max_bytes));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                bail!("Git command timed out after {} seconds", timeout.as_secs());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(error).context("wait for Git command");
            }
        }
    };
    let (stdout, stdout_overflow) = stdout_reader
        .join()
        .map_err(|_| anyhow::anyhow!("Git stdout reader stopped unexpectedly"))??;
    let (stderr, stderr_overflow) = stderr_reader
        .join()
        .map_err(|_| anyhow::anyhow!("Git stderr reader stopped unexpectedly"))??;
    if stdout_overflow || stderr_overflow {
        bail!("Git output exceeds 2 MiB");
    }
    Ok(ProcessOutput {
        status,
        stdout,
        stderr,
    })
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
    fn nul_status_parsing_keeps_both_names_and_uses_utf16_sort_order() {
        let parsed = parse_dirty_paths("R  new name\0old name\0?? 🦀.txt\0").unwrap();
        assert_eq!(parsed, ["new name", "old name", "🦀.txt"]);
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
}
