use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn validate(values: Value) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_rdsh"))
        .args(["worker-scope", "validate"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn rdsh");
    serde_json::to_writer(child.stdin.as_mut().unwrap(), &values).unwrap();
    child.stdin.take();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "rdsh failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn policy(values: Value) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_rdsh"))
        .args(["worker-scope", "policy"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn rdsh");
    serde_json::to_writer(child.stdin.as_mut().unwrap(), &values).unwrap();
    child.stdin.take();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "rdsh failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn native_worker_scope_validation_normalizes_paths_and_modules() {
    let output = validate(json!([{
        "worker_id": "editor-a",
        "role": "edit",
        "read_paths": ["src", "."],
        "write_paths": ["src/b", "src/a", "src/a"],
        "modules": ["zeta", "alpha", "alpha"],
        "forbidden_paths": ["src/private"],
        "lease_seconds": 60
    }]));

    assert_eq!(
        output[0],
        json!({
            "ok": true,
            "value": {
                "worker_id": "editor-a",
                "role": "edit",
                "read_paths": [".", "src"],
                "write_paths": ["src/a", "src/b"],
                "modules": ["alpha", "zeta"],
                "forbidden_paths": ["src/private"],
                "lease_seconds": 60
            }
        })
    );
}

#[test]
fn native_worker_scope_validation_returns_existing_policy_error_codes() {
    let output = validate(json!([
        {
            "worker_id": "reviewer",
            "role": "review",
            "read_paths": ["."],
            "write_paths": ["src"],
            "modules": ["review"],
            "forbidden_paths": [],
            "lease_seconds": 60
        },
        {
            "worker_id": "editor-b",
            "role": "edit",
            "read_paths": ["."],
            "write_paths": ["src/../secrets"],
            "modules": ["runtime"],
            "forbidden_paths": [],
            "lease_seconds": 60
        }
    ]));

    assert_eq!(
        output[0],
        json!({ "ok": false, "code": "review_worker_is_read_only" })
    );
    assert_eq!(
        output[1],
        json!({ "ok": false, "code": "invalid_scope_path" })
    );
}

#[test]
fn native_worker_scope_validation_keeps_role_specific_write_defaults() {
    let output = validate(json!([
        {
            "worker_id": "editor-a",
            "role": "edit",
            "read_paths": ["."],
            "modules": ["runtime"],
            "lease_seconds": 60
        },
        {
            "worker_id": "reviewer-a",
            "role": "review",
            "read_paths": ["."],
            "modules": ["runtime"],
            "lease_seconds": 60
        }
    ]));

    assert_eq!(
        output[0],
        json!({ "ok": false, "code": "invalid_scope_paths" })
    );
    assert_eq!(output[1]["ok"], true);
    assert_eq!(output[1]["value"]["write_paths"], json!([]));
}

#[test]
fn native_worker_scope_policy_batches_write_intersection_and_shared_file_checks() {
    let left = json!({
        "worker_id": "editor-a",
        "role": "edit",
        "read_paths": ["."],
        "write_paths": ["src", "Cargo.toml"],
        "modules": ["editor"],
        "forbidden_paths": ["src/private"],
        "lease_seconds": 60
    });
    let right = json!({
        "worker_id": "editor-b",
        "role": "edit",
        "read_paths": ["."],
        "write_paths": ["src/lib.rs", "Cargo.toml"],
        "modules": ["editor"],
        "forbidden_paths": [],
        "lease_seconds": 60
    });

    let output = policy(json!({
        "write_checks": [{
            "scope": left,
            "files": ["src/lib.rs", "src/private/key", "Cargo.toml", ".git/config"]
        }],
        "intersections": [{ "left": left, "right": right }],
        "shared_files": ["Cargo.lock", "src/file.json", ".github/workflows/ci.yml", "misc/package.json"]
    }));

    assert_eq!(
        output,
        json!({
            "write_checks": [[true, false, true, false]],
            "intersections": [["Cargo.toml", "src/lib.rs"]],
            "shared_files": [true, false, true, true]
        })
    );
}

#[test]
fn native_worker_scope_validation_does_not_load_broken_user_settings() {
    let root = std::env::temp_dir().join(format!(
        "rdsh-worker-scope-settings-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("rdsh.json"), "not json").unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_rdsh"))
        .args(["worker-scope", "validate"])
        .env("DSH_HOME", &root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn rdsh");
    child.stdin.as_mut().unwrap().write_all(b"[]").unwrap();
    child.stdin.take();
    let output = child.wait_with_output().unwrap();
    let _ = std::fs::remove_dir_all(root);
    assert!(
        output.status.success(),
        "rdsh loaded unrelated settings: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!([])
    );
}
