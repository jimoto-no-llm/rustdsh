//! Native replacement for plugins/workflow-board/source-patch.mjs.
//! Git owns patch parsing and blob hashing; no filters, builds or reset commands.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const LIMIT: u64 = 16 * 1024 * 1024;
const MANIFEST: &str = include_str!("../plugins/workflow-board/manifest.json");
const PATCH: &[u8] = include_bytes!("../plugins/workflow-board/workflow-board.patch");

#[derive(Debug)]
struct PatchError(&'static str);
type Result<T> = std::result::Result<T, PatchError>;
type Git = dyn Fn(&Path, &[&str], Option<&[u8]>) -> Result<Output>;
fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn git(source: &Path, args: &[&str], input: Option<&[u8]>) -> Result<Output> {
    let mut command = Command::new("git");
    command
        .args(["-c", "core.fsmonitor=false", "-C"])
        .arg(source)
        .args(args)
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| PatchError("GIT_UNAVAILABLE"))?;
    let writer = input.map(|bytes| {
        let mut stdin = child.stdin.take().expect("piped stdin");
        let bytes = bytes.to_vec();
        // Drain stdout/stderr concurrently with stdin, including large patches.
        std::thread::spawn(move || stdin.write_all(&bytes))
    });
    let output = child
        .wait_with_output()
        .map_err(|_| PatchError("GIT_UNAVAILABLE"))?;
    if let Some(writer) = writer {
        // A rejected patch can close stdin early; preserve Git's own failure.
        let written = writer.join().map_err(|_| PatchError("GIT_UNAVAILABLE"))?;
        if output.status.success() && written.is_err() {
            return Err(PatchError("GIT_UNAVAILABLE"));
        }
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success()
        && (stderr.contains("detected dubious ownership") || stderr.contains("unsafe repository"))
    {
        return Err(PatchError("SOURCE_UNSAFE"));
    }
    Ok(output)
}

fn successful(output: Output, code: &'static str) -> Result<Vec<u8>> {
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(PatchError(code))
    }
}
fn text(bytes: &[u8]) -> Result<&str> {
    std::str::from_utf8(bytes).map_err(|_| PatchError("MANIFEST_INVALID"))
}
fn oid(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 40
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
fn safe_path(s: &str) -> bool {
    !s.bytes()
        .any(|c| c < 32 || c == 127 || c == b'\\' || c == b':')
        && s.split('/')
            .all(|p| !p.is_empty() && p != "." && p != ".." && !p.eq_ignore_ascii_case(".git"))
}
fn validate(manifest: &Value) -> Result<Vec<&str>> {
    let files = manifest["files"]
        .as_array()
        .ok_or(PatchError("MANIFEST_INVALID"))?;
    let paths: Vec<&str> = files.iter().filter_map(Value::as_str).collect();
    let blobs = manifest["file_blobs"]
        .as_object()
        .ok_or(PatchError("MANIFEST_INVALID"))?;
    let unique: BTreeSet<&str> = paths.iter().copied().collect();
    if !oid(&manifest["base_commit"])
        || !oid(&manifest["board_commit"])
        || paths.is_empty()
        || paths.len() != files.len()
        || unique.len() != files.len()
        || !paths
            .iter()
            .all(|p| safe_path(p) && oid(&manifest["file_blobs"][p]))
        || unique != blobs.keys().map(String::as_str).collect()
    {
        return Err(PatchError("MANIFEST_INVALID"));
    }
    Ok(paths)
}

fn matches_board(source: &Path, paths: &[&str], manifest: &Value, run_git: &Git) -> bool {
    paths.iter().all(|name| {
        let check = || -> Result<bool> {
            let file = source.join(name);
            let metadata =
                std::fs::symlink_metadata(&file).map_err(|_| PatchError("VERIFY_FAILED"))?;
            if !metadata.is_file() || std::fs::canonicalize(&file).ok().as_ref() != Some(&file) {
                return Ok(false);
            }
            let bytes = std::fs::read(&file).map_err(|_| PatchError("VERIFY_FAILED"))?;
            // --stdin has no pathname, so repository clean filters cannot run.
            let hash = |bytes: &[u8]| -> Result<bool> {
                let got = successful(
                    run_git(
                        source,
                        &["hash-object", "--stdin", "--no-filters"],
                        Some(bytes),
                    )?,
                    "VERIFY_FAILED",
                )?;
                Ok(text(&got)?.trim() == manifest["file_blobs"][name].as_str().unwrap())
            };
            if hash(&bytes)? {
                return Ok(true);
            }
            if bytes.contains(&0) {
                return Ok(false);
            }
            let mut lf = Vec::with_capacity(bytes.len());
            let mut index = 0;
            while index < bytes.len() {
                if bytes[index..].starts_with(b"\r\n") {
                    index += 1;
                }
                lf.push(bytes[index]);
                index += 1;
            }
            hash(&lf)
        };
        check().unwrap_or(false)
    })
}

fn prepare(
    source: &Path,
    apply: bool,
    manifest: &Value,
    patch: &[u8],
    run_git: &Git,
) -> Result<Value> {
    let mut paths = validate(manifest)?;
    if manifest["patch_sha256"].as_str() != Some(sha256(patch).as_str()) {
        return Err(PatchError("PATCH_INTEGRITY"));
    }
    let board = manifest["board_commit"].as_str().unwrap();
    if !patch.starts_with(format!("From {board} ").as_bytes()) {
        return Err(PatchError("PATCH_COMMIT"));
    }
    let source = std::fs::canonicalize(source).map_err(|_| PatchError("SOURCE_MISSING"))?;
    let top = successful(
        run_git(&source, &["rev-parse", "--show-toplevel"], None)?,
        "SOURCE_NOT_GIT",
    )?;
    let top =
        std::fs::canonicalize(text(&top)?.trim()).map_err(|_| PatchError("SOURCE_NOT_ROOT"))?;
    if top != source {
        return Err(PatchError("SOURCE_NOT_ROOT"));
    }
    let head = successful(
        run_git(&source, &["rev-parse", "HEAD"], None)?,
        "HEAD_UNAVAILABLE",
    )?;
    let head = text(&head)?.trim();
    if Some(head) != manifest["base_commit"].as_str() {
        return Err(PatchError("UNSUPPORTED_BASE"));
    }
    let stats = successful(
        run_git(&source, &["apply", "--numstat", "-z", "-"], Some(patch))?,
        "PATCH_INVALID",
    )?;
    let mut actual: Vec<&str> = text(&stats)?
        .split('\0')
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.splitn(3, '\t').nth(2))
        .collect();
    paths.sort_unstable();
    actual.sort_unstable();
    if actual != paths {
        return Err(PatchError("PATCH_SCOPE"));
    }
    let outcome = |state| json!({"state": state, "base_commit": head, "board_commit": board, "files": paths.len()});
    let status = successful(
        run_git(
            &source,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            None,
        )?,
        "STATUS_UNAVAILABLE",
    )?;
    let changes: Vec<&str> = text(&status)?
        .split('\0')
        .filter(|s| !s.is_empty())
        .collect();
    let only_board = changes.iter().all(|s| {
        s.get(..2)
            .is_some_and(|state| [" M", "M ", "A ", "??"].contains(&state))
            && s.get(3..).is_some_and(|p| paths.contains(&p))
    });
    if only_board
        && matches_board(&source, &paths, manifest, run_git)
        && run_git(
            &source,
            &["apply", "--reverse", "--check", "--whitespace=nowarn", "-"],
            Some(patch),
        )?
        .status
        .success()
    {
        return Ok(outcome("already-applied"));
    }
    if !changes.is_empty() {
        return Err(PatchError("SOURCE_DIRTY"));
    }
    successful(
        run_git(
            &source,
            &["apply", "--check", "--whitespace=nowarn", "-"],
            Some(patch),
        )?,
        "PATCH_CONFLICT",
    )?;
    if !apply {
        return Ok(outcome("ready"));
    }
    successful(
        run_git(&source, &["apply", "--whitespace=nowarn", "-"], Some(patch))?,
        "APPLY_FAILED",
    )?;
    successful(
        run_git(
            &source,
            &["apply", "--reverse", "--check", "--whitespace=nowarn", "-"],
            Some(patch),
        )?,
        "VERIFY_FAILED",
    )?;
    if !matches_board(&source, &paths, manifest, run_git) {
        return Err(PatchError("VERIFY_FAILED"));
    }
    Ok(outcome("applied"))
}

fn run(source: Option<String>, apply: bool, json_stdin: bool) -> Result<Value> {
    if json_stdin {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| PatchError("USAGE"))?;
        if bytes.len() as u64 > LIMIT {
            return Err(PatchError("USAGE"));
        }
        let input: Value = serde_json::from_slice(&bytes).map_err(|_| PatchError("USAGE"))?;
        let source = input["source"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(PatchError("USAGE"))?;
        let patch = input["patch"].as_str().ok_or(PatchError("USAGE"))?;
        let apply = input["apply"].as_bool().ok_or(PatchError("USAGE"))?;
        prepare(
            Path::new(source),
            apply,
            &input["manifest"],
            patch.as_bytes(),
            &git,
        )
    } else {
        let source = source
            .filter(|s| !s.is_empty())
            .ok_or(PatchError("USAGE"))?;
        let manifest =
            serde_json::from_str(MANIFEST).map_err(|_| PatchError("MANIFEST_INVALID"))?;
        prepare(&PathBuf::from(source), apply, &manifest, PATCH, &git)
    }
}

pub fn cmd(source: Option<String>, apply: bool, json_stdin: bool) -> anyhow::Result<()> {
    match run(source, apply, json_stdin) {
        Ok(value) => println!("{value}"),
        Err(PatchError(code)) => {
            // Machine errors retain the Node adapter contract; never echo source contents.
            eprintln!(
                "{}",
                json!({"error": code, "message": "Inspect the selected source checkout before retrying."})
            );
            std::process::exit(1);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> (Fixture, Value, Vec<u8>) {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).unwrap();
        let root = std::env::temp_dir().join(format!(
            "rdsh-native-board-{:x}",
            u128::from_le_bytes(nonce)
        ));
        std::fs::create_dir(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let run = |args: &[&str]| successful(git(&root, args, None).unwrap(), "fixture").unwrap();
        run(&["init", "-q"]);
        std::fs::write(root.join(".gitattributes"), "* text=auto eol=lf\n").unwrap();
        let before = (0..20).map(|n| format!("line {n}\n")).collect::<String>() + "started\n";
        std::fs::write(root.join("card.txt"), &before).unwrap();
        run(&["add", "."]);
        let commit = [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@local.invalid",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-qm",
        ];
        let mut args = commit.to_vec();
        args.push("base");
        run(&args);
        let base = String::from_utf8(run(&["rev-parse", "HEAD"]))
            .unwrap()
            .trim()
            .to_owned();
        std::fs::write(root.join("card.txt"), before + "completed\n").unwrap();
        run(&["add", "card.txt"]);
        *args.last_mut().unwrap() = "board";
        run(&args);
        let board = String::from_utf8(run(&["rev-parse", "HEAD"]))
            .unwrap()
            .trim()
            .to_owned();
        let patch = run(&["format-patch", "--stdout", "--binary", "-1", &board]);
        let blob = String::from_utf8(run(&["rev-parse", &format!("{board}:card.txt")]))
            .unwrap()
            .trim()
            .to_owned();
        // Only a test-owned repository is reset.
        run(&["reset", "--hard", &base]);
        let manifest = json!({"base_commit": base, "board_commit": board,
            "patch_sha256": sha256(&patch),
            "files": ["card.txt"], "file_blobs": {"card.txt": blob}});
        (Fixture(root), manifest, patch)
    }
    #[test]
    fn write_failure_preserves_source_and_reports_apply_failed() {
        let (f, manifest, patch) = fixture();
        let before = std::fs::read(f.0.join("card.txt")).unwrap();
        let run = |source: &Path, args: &[&str], input: Option<&[u8]>| {
            if args == ["apply", "--whitespace=nowarn", "-"] {
                git(
                    source,
                    &["rev-parse", "--verify", "nonexistent-fixture-ref"],
                    None,
                )
            } else {
                git(source, args, input)
            }
        };
        assert_eq!(
            prepare(&f.0, true, &manifest, &patch, &run).unwrap_err().0,
            "APPLY_FAILED"
        );
        assert_eq!(std::fs::read(f.0.join("card.txt")).unwrap(), before);
    }
    #[test]
    fn post_write_change_outside_hunk_is_retained_and_reports_verify_failed() {
        let (f, manifest, patch) = fixture();
        let run = |source: &Path, args: &[&str], input: Option<&[u8]>| {
            let out = git(source, args, input)?;
            if args == ["apply", "--whitespace=nowarn", "-"] && out.status.success() {
                let file = source.join("card.txt");
                let bytes = std::fs::read_to_string(&file)
                    .unwrap()
                    .replace("line 0\n", "concurrent edit\n");
                std::fs::write(file, bytes).unwrap();
            }
            Ok(out)
        };
        assert_eq!(
            prepare(&f.0, true, &manifest, &patch, &run).unwrap_err().0,
            "VERIFY_FAILED"
        );
        assert!(std::fs::read_to_string(f.0.join("card.txt"))
            .unwrap()
            .starts_with("concurrent edit\n"));
    }
    #[test]
    fn manifest_rejects_unsafe_unpinned_duplicate_and_nonstring_paths() {
        let original: Value = serde_json::from_str(MANIFEST).unwrap();
        assert_eq!(validate(&original).unwrap().len(), 18);
        for path in [
            "../outside",
            "/absolute",
            ".GiT/config",
            "a\\b",
            "C:/x",
            "a//b",
            "a/./b",
            "a\n",
        ] {
            let mut v = original.clone();
            v["files"] = json!([path]);
            v["file_blobs"] = json!({path: "1".repeat(40)});
            assert_eq!(validate(&v).unwrap_err().0, "MANIFEST_INVALID");
        }
        for files in [json!(["x", "x"]), json!([1]), json!([])] {
            let mut v = original.clone();
            v["files"] = files;
            assert_eq!(validate(&v).unwrap_err().0, "MANIFEST_INVALID");
        }
    }
}
