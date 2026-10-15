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

/// Each invocation has its own Japanese-named home and corrupt settings document.
/// Pure commands must select language without consulting that document.
struct LocalizedFixture {
    root: std::path::PathBuf,
}

impl LocalizedFixture {
    fn new() -> Self {
        static NEXT_FIXTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "rdsh-worker-範囲 検証-{}-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("dsh")).unwrap();
        std::fs::write(root.join("dsh/rdsh.json"), "{broken 日本語".as_bytes()).unwrap();
        Self { root }
    }

    fn run(&self, language: &str, action: &str, input: &[u8]) -> std::process::Output {
        self.invoke(language, &["worker-scope", action], input, true)
    }

    fn invoke(
        &self,
        language: &str,
        args: &[&str],
        input: &[u8],
        explicit: bool,
    ) -> std::process::Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        command
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("APPDATA", self.root.join("appdata"))
            .env("XDG_DATA_HOME", self.root.join("data"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("DSH_HOME", self.root.join("dsh"))
            .env("RDSH_LANG", if explicit { "en" } else { language })
            .env_remove("RDSH_ORIG_BIN")
            .env_remove("RDSH_PASSTHROUGH")
            .env_remove("RDSH_DRY_RUN")
            .env_remove("RDSH_DEFAULT_PROFILE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if explicit {
            command.args(["--language", language]);
        }
        let mut child = command.args(args).spawn().expect("spawn rdsh");
        child.stdin.as_mut().unwrap().write_all(input).unwrap();
        child.stdin.take();
        child.wait_with_output().unwrap()
    }

    fn rejected(&self, language: &str, action: &str, input: &[u8], detail: &str) -> String {
        let output = self.run(language, action, input);
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        let text = String::from_utf8(output.stderr).unwrap();
        assert!(text.contains(detail), "{language}/{action}: {text}");
        text
    }
}

impl Drop for LocalizedFixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).expect("remove owned worker-scope fixture");
    }
}

#[test]
fn languages_preserve_worker_scope_json_and_ignore_unrelated_corrupt_settings() {
    let fixture = LocalizedFixture::new();
    let scope = json!({"worker_id":"editor-ja","role":"edit","read_paths":["."],
        "write_paths":["資料/空 白"],"modules":["editor"],"forbidden_paths":[],"lease_seconds":60});
    let declarations = serde_json::to_vec(&json!([scope, {"worker_id":"bad"}])).unwrap();
    let expected_declarations = concat!(
        r#"[{"ok":true,"value":{"worker_id":"editor-ja","role":"edit","read_paths":["."],"write_paths":["資料/空 白"],"modules":["editor"],"forbidden_paths":[],"lease_seconds":60}},{"ok":false,"code":"invalid_worker_role_or_id"}]"#,
        "\n"
    );
    let policy = serde_json::to_vec(&json!({"write_checks":[{"scope":scope,"files":["資料/空 白/本文.txt","秘密/鍵"]}],
        "intersections":[{"left":scope,"right":scope}],"shared_files":["Cargo.lock","資料/空 白/本文.txt"]})).unwrap();
    let expected_policy = concat!(
        r#"{"write_checks":[[true,false]],"intersections":[["資料/空 白"]],"shared_files":[true,false]}"#,
        "\n"
    );
    for language in ["en", "zh-CN", "ja"] {
        for explicit in [true, false] {
            for (action, input, expected) in [
                ("validate", declarations.as_slice(), expected_declarations),
                ("policy", policy.as_slice(), expected_policy),
            ] {
                let output = fixture.invoke(language, &["worker-scope", action], input, explicit);
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                assert!(output.stderr.is_empty());
                assert_eq!(output.stdout, expected.as_bytes(), "{language}/{action}");
            }
        }
    }
    let ordinary = fixture.invoke("ja", &["settings", "show"], b"", true);
    assert_eq!(ordinary.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&ordinary.stderr).contains("設定を読み込めません"));
    assert_eq!(
        std::fs::read(fixture.root.join("dsh/rdsh.json")).unwrap(),
        "{broken 日本語".as_bytes()
    );
}

#[test]
fn malformed_worker_scope_documents_have_localized_context_and_raw_parser_reasons() {
    let fixture = LocalizedFixture::new();
    for (
        language,
        parse_declarations,
        parse_policy,
        declarations_array,
        policy_object,
        too_large,
    ) in [
        (
            "en",
            "parse worker scope declarations",
            "parse worker scope policy batch",
            "worker scope declarations must be a JSON array",
            "worker scope policy batch must be a JSON object",
            "worker scope input exceeds 2 MiB",
        ),
        (
            "zh-CN",
            "解析工作进程范围声明",
            "解析工作进程范围策略批次",
            "工作进程范围声明必须是 JSON 数组",
            "工作进程范围策略批次必须是 JSON 对象",
            "工作进程范围输入超过 2 MiB",
        ),
        (
            "ja",
            "ワーカー範囲の宣言を解析",
            "ワーカー範囲のポリシーバッチを解析",
            "ワーカー範囲の宣言はJSON配列である必要があります",
            "ワーカー範囲のポリシーバッチはJSONオブジェクトである必要があります",
            "ワーカー範囲の入力が2 MiBを超えています",
        ),
    ] {
        for (action, context) in [("validate", parse_declarations), ("policy", parse_policy)] {
            let text = fixture.rejected(language, action, b"{broken", context);
            assert!(text.contains("key must be a string at line 1 column 2"));
            fixture.rejected(language, action, &[0xff], context);
        }
        fixture.rejected(language, "validate", b"{}", declarations_array);
        fixture.rejected(language, "policy", b"[]", policy_object);
        fixture.rejected(
            language,
            "validate",
            &vec![b' '; 2 * 1024 * 1024 + 1],
            too_large,
        );
    }
}

#[test]
fn worker_scope_policy_structure_errors_localize_without_translating_codes_or_field_names() {
    let fixture = LocalizedFixture::new();
    let scope = json!({"worker_id":"editor-ja","role":"edit","read_paths":["."],
        "write_paths":["資料"],"modules":["editor"],"lease_seconds":60});
    let cases = [
        (
            json!({"future":[]}),
            [
                "unknown worker scope policy batch field",
                "未知的工作进程范围策略批次字段",
                "不明なワーカー範囲ポリシーバッチのフィールドです",
            ],
        ),
        (
            json!({"write_checks":[null]}),
            [
                "write check must be a JSON object",
                "写入检查必须是 JSON 对象",
                "書き込みチェックはJSONオブジェクトである必要があります",
            ],
        ),
        (
            json!({"write_checks":[{"future":true}]}),
            [
                "unknown write check field",
                "未知的写入检查字段",
                "不明な書き込みチェックのフィールドです",
            ],
        ),
        (
            json!({"write_checks":[{}]}),
            [
                "write check is missing scope",
                "写入检查缺少 scope",
                "書き込みチェックにscopeがありません",
            ],
        ),
        (
            json!({"write_checks":[{"scope":{},"files":[]}]}),
            [
                "invalid write check scope",
                "写入检查范围无效",
                "書き込みチェックの範囲が無効です",
            ],
        ),
        (
            json!({"write_checks":[{"scope":scope}]}),
            [
                "write check files must be a JSON array",
                "写入检查的 files 必须是 JSON 数组",
                "書き込みチェックのfilesはJSON配列である必要があります",
            ],
        ),
        (
            json!({"write_checks":[{"scope":scope,"files":[42]}]}),
            [
                "write check file must be a string",
                "写入检查的文件必须是字符串",
                "書き込みチェックのファイルは文字列である必要があります",
            ],
        ),
        (
            json!({"intersections":[null]}),
            [
                "scope intersection must be a JSON object",
                "范围交集必须是 JSON 对象",
                "範囲の交差はJSONオブジェクトである必要があります",
            ],
        ),
        (
            json!({"intersections":[{"future":true}]}),
            [
                "unknown scope intersection field",
                "未知的范围交集字段",
                "不明な範囲の交差フィールドです",
            ],
        ),
        (
            json!({"intersections":[{}]}),
            [
                "scope intersection is missing left",
                "范围交集缺少 left",
                "範囲の交差にleftがありません",
            ],
        ),
        (
            json!({"intersections":[{"left":{}}]}),
            [
                "invalid left scope",
                "left 范围无效",
                "leftの範囲が無効です",
            ],
        ),
        (
            json!({"intersections":[{"left":scope}]}),
            [
                "scope intersection is missing right",
                "范围交集缺少 right",
                "範囲の交差にrightがありません",
            ],
        ),
        (
            json!({"intersections":[{"left":scope,"right":{}}]}),
            [
                "invalid right scope",
                "right 范围无效",
                "rightの範囲が無効です",
            ],
        ),
        (
            json!({"shared_files":[42]}),
            [
                "shared file path must be a string",
                "共享文件路径必须是字符串",
                "共有ファイルのパスは文字列である必要があります",
            ],
        ),
    ];
    for (index, language) in ["en", "zh-CN", "ja"].into_iter().enumerate() {
        for (input, expected) in &cases {
            let text = fixture.rejected(
                language,
                "policy",
                &serde_json::to_vec(input).unwrap(),
                expected[index],
            );
            if input == &json!({"write_checks":[{"scope":{},"files":[]}]}) {
                assert!(text.contains("invalid_worker_role_or_id"));
            }
        }
        for key in ["write_checks", "intersections", "shared_files"] {
            let detail = [
                "must be a JSON array",
                "必须是 JSON 数组",
                "はJSON配列である必要があります",
            ][index];
            let text = fixture.rejected(
                language,
                "policy",
                &serde_json::to_vec(&json!({key:42})).unwrap(),
                detail,
            );
            assert!(text.contains(key));
            let detail = ["too many values in", "值过多", "値が多すぎます"][index];
            let text = fixture.rejected(
                language,
                "policy",
                &serde_json::to_vec(&json!({key:vec![Value::Null;4097]})).unwrap(),
                detail,
            );
            assert!(text.contains(key));
        }
    }
}

#[test]
fn worker_scope_help_uses_selected_language_and_preserves_command_spellings() {
    let fixture = LocalizedFixture::new();
    for (language, declarations, policy) in [
        (
            "en",
            "Read a JSON array of declarations",
            "Evaluate write paths",
        ),
        ("zh-CN", "读取声明的 JSON 数组", "批量判断写入路径"),
        (
            "ja",
            "宣言のJSON配列を読み取り",
            "書き込み範囲・範囲の交差・共有ファイル判定を一括実行",
        ),
    ] {
        for (args, expected) in [
            (vec!["worker-scope", "--help"], declarations),
            (vec!["worker-scope", "validate", "--help"], declarations),
            (vec!["worker-scope", "policy", "--help"], policy),
        ] {
            let output = fixture.invoke(language, &args, b"", true);
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(output.stderr.is_empty());
            let help = String::from_utf8(output.stdout).unwrap();
            assert!(help.contains(expected), "{language}: {help}");
            assert!(help.contains("worker-scope"));
        }
    }
}

#[cfg(unix)]
#[test]
fn worker_scope_io_failures_keep_operating_system_reasons_under_localized_context() {
    use std::os::fd::FromRawFd;
    let fixture = LocalizedFixture::new();
    for (language, read, write) in [
        (
            "en",
            "read worker scope declarations",
            "write worker scope results",
        ),
        ("zh-CN", "读取工作进程范围声明", "写入工作进程范围结果"),
        (
            "ja",
            "ワーカー範囲の宣言を読み取り",
            "ワーカー範囲の結果を書き込み",
        ),
    ] {
        let mut directory = std::fs::File::open(&fixture.root).unwrap();
        let raw_read_error = std::io::Read::read(&mut directory, &mut [0])
            .unwrap_err()
            .to_string();
        let output = Command::new(env!("CARGO_BIN_EXE_rdsh"))
            .args(["--language", language, "worker-scope", "validate"])
            .env("DSH_HOME", fixture.root.join("dsh"))
            .stdin(Stdio::from(directory))
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains(read), "{language}: {stderr}");
        assert!(stderr.contains(&raw_read_error), "{language}: {stderr}");

        let mut descriptors = [-1; 2];
        // Both newly owned descriptors are converted to Files exactly once.
        assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
        let reader = unsafe { std::fs::File::from_raw_fd(descriptors[0]) };
        let writer = unsafe { std::fs::File::from_raw_fd(descriptors[1]) };
        drop(reader);
        let raw_write_error = (&writer).write_all(b"[]").unwrap_err().to_string();
        let mut child = Command::new(env!("CARGO_BIN_EXE_rdsh"))
            .args(["--language", language, "worker-scope", "validate"])
            .env("DSH_HOME", fixture.root.join("dsh"))
            .stdin(Stdio::piped())
            .stdout(Stdio::from(writer))
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(b"[]").unwrap();
        let output = child.wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains(write), "{language}: {stderr}");
        assert!(stderr.contains(&raw_write_error), "{language}: {stderr}");
    }
}
