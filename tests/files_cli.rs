use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("rdsh-files-cli-{}-{id}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        std::fs::create_dir(path.join("sessions")).unwrap();
        Self(std::fs::canonicalize(path).unwrap())
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_rdsh"))
            .args(args)
            .current_dir(&self.0)
            .env_clear()
            .envs(std::env::vars_os().filter(|(name, _)| {
                [
                    "PATH",
                    "SystemRoot",
                    "WINDIR",
                    "COMSPEC",
                    "PATHEXT",
                    "TEMP",
                    "TMP",
                ]
                .iter()
                .any(|allowed| name.to_string_lossy().eq_ignore_ascii_case(allowed))
            }))
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("DSH_HOME", &self.0)
            .env("LANG", "C")
            .output()
            .unwrap()
    }

    fn write_session(&self, relative: &str, entries: &[Value]) -> PathBuf {
        let path = self.0.join("sessions").join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text: String = entries.iter().map(|value| format!("{value}\n")).collect();
        std::fs::write(&path, text).unwrap();
        path
    }

    fn list(&self, session: Option<&str>) -> Value {
        let mut args = vec!["files", "list", "--json"];
        if let Some(session) = session {
            args.extend(["--session", session]);
        }
        let output = self.run(&args);
        assert!(output.status.success(), "{output:?}");
        serde_json::from_slice(&output.stdout).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn presented(path: &Path) -> Value {
    json!({"type": "presented", "files": [{"path": path}]})
}

#[test]
fn default_destination_never_truncates_the_original() {
    let fixture = Fixture::new();
    let source = fixture.0.join("report.txt");
    std::fs::write(&source, b"the only copy").unwrap();
    fixture.write_session("delivery.json", &[presented(&source)]);

    let output = fixture.run(&["files", "get", source.to_str().unwrap()]);
    assert_eq!(std::fs::read(&source).unwrap(), b"the only copy");
    assert!(!output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("already exists"));
}

#[test]
fn copy_refuses_existing_files_and_hard_links_even_with_force() {
    let fixture = Fixture::new();
    let source = fixture.0.join("source.txt");
    let other = fixture.0.join("other.txt");
    let alias = fixture.0.join("alias.txt");
    std::fs::write(&source, b"source").unwrap();
    std::fs::write(&other, b"keep me").unwrap();
    std::fs::hard_link(&source, &alias).unwrap();
    for target in [&source, &other, &alias] {
        let output = fixture.run(&[
            "files",
            "get",
            source.to_str().unwrap(),
            "--force",
            "--out",
            target.to_str().unwrap(),
        ]);
        assert!(!output.status.success(), "{output:?}");
        assert_eq!(std::fs::read(&source).unwrap(), b"source");
        assert_eq!(std::fs::read(&other).unwrap(), b"keep me");
    }
}

#[cfg(unix)]
#[test]
fn copy_never_follows_a_destination_symlink() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let source = fixture.0.join("source.txt");
    let missing = fixture.0.join("missing.txt");
    let link = fixture.0.join("link.txt");
    std::fs::write(&source, b"source").unwrap();
    for target in [&source, &missing] {
        symlink(target, &link).unwrap();
        let output = fixture.run(&[
            "files",
            "get",
            source.to_str().unwrap(),
            "--force",
            "--out",
            link.to_str().unwrap(),
        ]);
        assert!(!output.status.success(), "{output:?}");
        assert_eq!(std::fs::read(&source).unwrap(), b"source");
        assert!(!missing.exists());
        assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
        std::fs::remove_file(&link).unwrap();
    }
}

#[test]
fn copy_to_a_new_destination_preserves_binary_contents() {
    let fixture = Fixture::new();
    let source = fixture.0.join("source.bin");
    let data = b"\0\xff\x80binary\r\n";
    std::fs::write(&source, data).unwrap();
    std::fs::hard_link(&source, fixture.0.join("source-link.bin")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    fixture.write_session("delivery.json", &[presented(&source)]);
    let output = fixture.run(&[
        "files",
        "get",
        source.to_str().unwrap(),
        "--out",
        "copy.bin",
    ]);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(std::fs::read(&source).unwrap(), data);
    assert_eq!(std::fs::read(fixture.0.join("copy.bin")).unwrap(), data);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(fixture.0.join("copy.bin"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn real_dsh_jsonl_uses_the_session_working_directory() {
    let fixture = Fixture::new();
    let workspace = fixture.0.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(workspace.join("report.txt"), b"report").unwrap();
    let path = fixture.write_session(
        "project/session-id/session.v4.jsonl",
        &[
            json!({
                "type": "session", "version": 4, "id": "session-id", "createdAt": 0,
                "isSeeded": false, "delegationDepth": 0, "cwd": workspace,
            }),
            json!({
                "type": "deliverables/presented", "seq": 0, "time": 1,
                "data": {"turn": 0, "callId": "call-1", "files": [
                    {"path": "report.txt", "description": "first"},
                ]},
            }),
            json!({
                "type": "tool/result", "seq": 1, "time": 2,
                "data": {"result": {
                    "type": "presented", "files": [{"path": fixture.0.join("secret.txt")}],
                }},
            }),
            json!({
                "type": "deliverables/presented", "seq": 2, "time": 3,
                "data": {"turn": 0, "callId": "call-2", "files": [
                    {"path": "report.txt", "description": "final"},
                ]},
            }),
        ],
    );
    for session in [None, Some("session-id")] {
        let listed = fixture.list(session);
        assert_eq!(listed["session"], "session-id");
        assert_eq!(
            listed["files"],
            json!([{
                "path":workspace.join("report.txt"), "description":"final", "bytes":6, "exists":true,
            }])
        );
    }
    let output = fixture.run(&[
        "files",
        "get",
        workspace.join("report.txt").to_str().unwrap(),
        "--session",
        "session-id",
        "--out",
        "download.txt",
    ]);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        std::fs::read(fixture.0.join("download.txt")).unwrap(),
        b"report"
    );

    if let Ok(output) = Command::new("zstd").arg("--version").output() {
        if output.status.success() {
            let compressed = path.with_extension("jsonl.zstd");
            // The zstd CLI is an optional helper: runners without a working
            // `-o` handling skip this block instead of failing the core
            // files get/list assertions above.
            let compressed_ok = Command::new("zstd")
                .args(["-q", "-f", "-o"])
                .arg(&compressed)
                .arg(&path)
                .status()
                .map(|status| status.success())
                .unwrap_or(false);
            if compressed_ok {
                std::fs::remove_file(path).unwrap();
                assert_eq!(
                    fixture.list(Some("session-id"))["files"][0]["description"],
                    "final"
                );
            }
        }
    }
}

#[test]
fn legacy_json_session_reports_its_id() {
    let fixture = Fixture::new();
    fixture.write_session(
        "legacy-id.json",
        &[presented(&fixture.0.join("report.txt"))],
    );
    assert_eq!(fixture.list(Some("legacy-id"))["session"], "legacy-id");
}

#[test]
fn explicit_session_cannot_escape_the_sessions_directory() {
    let fixture = Fixture::new();
    std::fs::write(
        fixture.0.join("outside.json"),
        presented(&fixture.0.join("secret.txt")).to_string(),
    )
    .unwrap();
    for id in ["../outside", "..\\outside", ".", ".."] {
        let output = fixture.run(&["files", "list", "--json", "--session", id]);
        assert!(!output.status.success(), "accepted {id}: {output:?}");
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn newest_transcript_is_selected_within_a_session_directory() {
    let fixture = Fixture::new();
    let older = fixture.write_session(
        "project/session-id/session.v3.jsonl",
        &[presented(&fixture.0.join("old"))],
    );
    let newer = fixture.write_session(
        "project/session-id/session.v4.jsonl",
        &[presented(&fixture.0.join("new"))],
    );
    for (path, seconds) in [(older, 1), (newer, 2)] {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds)),
            )
            .unwrap();
    }
    assert_eq!(
        fixture.list(Some("session-id"))["files"][0]["path"],
        json!(fixture.0.join("new"))
    );
}

#[test]
fn encoded_session_ids_use_dsh_directory_names() {
    let fixture = Fixture::new();
    let id = "session /😀";
    fixture.write_session(
        "project/session~0020~002F~D83D~DE00/session.v4.jsonl",
        &[
            json!({"type": "session", "id": id, "cwd": fixture.0}),
            presented(&fixture.0.join("report.txt")),
        ],
    );
    assert_eq!(fixture.list(Some(id))["session"], id);
}

#[test]
fn relative_deliverables_without_a_session_cwd_are_rejected() {
    let fixture = Fixture::new();
    std::fs::write(fixture.0.join("report.txt"), b"wrong workspace").unwrap();
    fixture.write_session(
        "session-id/session.jsonl",
        &[presented(Path::new("report.txt"))],
    );
    let output = fixture.run(&["files", "list", "--json"]);
    assert!(!output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("session working directory"));
}

#[test]
fn partial_tail_is_ignored_but_corrupt_complete_rows_are_rejected() {
    let fixture = Fixture::new();
    let path = fixture.write_session(
        "session-id/session.jsonl",
        &[presented(&fixture.0.join("report.txt"))],
    );
    let mut file = std::fs::File::options().append(true).open(path).unwrap();
    file.write_all(b"{\"type\":\"presented\"").unwrap();
    assert_eq!(fixture.list(None)["files"].as_array().unwrap().len(), 1);
    file.write_all(b"\n").unwrap();
    let output = fixture.run(&["files", "list", "--json"]);
    assert!(!output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("is not JSON"));
}

#[test]
fn oversized_plain_transcripts_fail_before_parsing() {
    let fixture = Fixture::new();
    let path = fixture.write_session("session-id/session.jsonl", &[]);
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_len(256 * 1024 * 1024 + 1)
        .unwrap();
    let output = fixture.run(&["files", "list", "--json"]);
    assert!(!output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("transcript byte limit"));
}

#[cfg(unix)]
#[test]
fn transcripts_outside_the_session_root_are_not_followed() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let outside = fixture.0.join("outside");
    std::fs::create_dir(&outside).unwrap();
    let text = presented(&fixture.0.join("secret.txt")).to_string();
    std::fs::write(outside.join("session.jsonl"), &text).unwrap();
    std::fs::write(outside.join("legacy.json"), &text).unwrap();
    symlink(&outside, fixture.0.join("sessions/session-id")).unwrap();
    symlink(
        outside.join("legacy.json"),
        fixture.0.join("sessions/legacy.json"),
    )
    .unwrap();
    for session in ["session-id", "legacy"] {
        let output = fixture.run(&["files", "list", "--json", "--session", session]);
        assert!(!output.status.success(), "{output:?}");
        assert!(output.stdout.is_empty());
    }
}
