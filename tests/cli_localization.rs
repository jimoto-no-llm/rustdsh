//! Executable tests for localized native-command help and parse diagnostics.
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "rdsh-cli-localization-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join("dsh")).unwrap();
        Self(path)
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        command.env_clear();
        for key in ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .args(args)
            .current_dir(&self.0)
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("DSH_HOME", self.0.join("dsh"));
        command
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }

    fn run_with_stdin(&self, args: &[&str], stdin: &[u8]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        command.env_clear();
        for key in ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = command
            .args(args)
            .current_dir(&self.0)
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("DSH_HOME", self.0.join("dsh"))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child.stdin.take().unwrap().write_all(stdin).unwrap();
        child.wait_with_output().unwrap()
    }

    fn settings(&self, raw: &str) {
        fs::write(self.0.join("dsh/rdsh.json"), raw).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn help_accepts_native_flags_without_required_positionals_in_every_language() {
    let fixture = Fixture::new();
    let commands = [
        (&["tokens", "--help"][..], "--preview"),
        (&["search", "--help"], "--dir"),
        (&["guard", "--help"], "--deny"),
        (&["context", "build", "--help"], "--query"),
    ];
    for (language, heading) in [("en", "Options"), ("zh-CN", "选项"), ("ja", "オプション")] {
        for (command, required_flag) in commands {
            let mut args = vec!["--language", language];
            args.extend_from_slice(command);
            let output = fixture.run(&args);
            assert!(
                output.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(stdout.contains(heading), "{args:?}: {stdout}");
            assert!(stdout.contains(required_flag), "{args:?}: {stdout}");
        }
    }
}

#[test]
fn invalid_option_keeps_the_raw_value_and_labels_the_clap_diagnostic() {
    let fixture = Fixture::new();
    let output = fixture.run(&["--language", "ja", "tokens", "--preview", "not-a-number"]);
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("引数の値が無効です"), "{stderr}");
    assert!(stderr.contains("Clap 診断"), "{stderr}");
    assert!(stderr.contains("not-a-number"), "{stderr}");
}

#[test]
fn version_like_values_after_double_dash_do_not_trigger_version_display() {
    let fixture = Fixture::new();
    for args in [
        &["tokens", "--", "--version"][..],
        &["settings", "--", "--version"],
    ] {
        let output = fixture.run(args);
        assert!(
            !output.status.success(),
            "{args:?} unexpectedly exited through --version: {output:?}"
        );
        assert!(
            !String::from_utf8_lossy(&output.stdout).starts_with("rdsh "),
            "{args:?}: {output:?}"
        );
    }

    fs::write(fixture.0.join("--version"), "abcd日本語").unwrap();
    let tokens = fixture.run(&["tokens", "--", "--version"]);
    assert!(tokens.status.success(), "{tokens:?}");
    assert_eq!(
        String::from_utf8_lossy(&tokens.stdout).trim(),
        "4  --version"
    );
    let setting = fixture.run(&["settings", "set", "context.goal", "--", "--version"]);
    assert!(setting.status.success(), "{setting:?}");
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.0.join("dsh/rdsh.json")).unwrap()).unwrap();
    assert_eq!(saved["context"]["goal"], "--version");

    let source = fixture.0.join("original.rs");
    fs::write(
        &source,
        r#"fn main() { println!("{:?}", std::env::args().skip(1).collect::<Vec<_>>()); }"#,
    )
    .unwrap();
    let executable = fixture.0.join(if cfg!(windows) {
        "original.exe"
    } else {
        "original"
    });
    let compile = Command::new("rustc")
        .args(["--edition=2021", "--crate-name", "fixture_original"])
        .arg(&source)
        .arg("-o")
        .arg(&executable)
        .output()
        .unwrap();
    assert!(compile.status.success(), "{compile:?}");
    // The native fixture is the only executable visible to the delegation.
    // It also satisfies the runtime lookup without loading any Node/DSH code.
    fs::copy(
        &executable,
        fixture
            .0
            .join(if cfg!(windows) { "node.exe" } else { "node" }),
    )
    .unwrap();
    let delegated = fixture
        .command(&["web", "--", "--version"])
        .env("RDSH_ORIG_BIN", &executable)
        .env("PATH", &fixture.0)
        .output()
        .unwrap();
    assert!(delegated.status.success(), "{delegated:?}");
    assert_eq!(
        serde_json::from_slice::<Vec<String>>(&delegated.stdout).unwrap(),
        ["--profile", "web", "--version"]
    );
}

#[test]
fn help_does_not_hide_invalid_settings() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("dsh/rdsh.json"), "{").unwrap();
    let output = fixture.run(&["--language", "ja", "tokens", "--help"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("設定を読み込めません"),
        "{:?}",
        output
    );
}

#[test]
fn settings_and_guard_errors_localize_without_changing_raw_values_or_json_reasons() {
    let fixture = Fixture::new();
    let malformed = "{\n  invalid\n";
    fixture.settings(malformed);
    let default = fixture.run(&["settings", "show"]);
    let english = fixture.run(&["--language", "en", "settings", "show"]);
    assert_eq!(english.status.code(), default.status.code());
    assert_eq!(english.stderr, default.stderr);
    for (language, invalid_settings) in [("zh-CN", "无效的设置文件"), ("ja", "無効な設定ファイル")]
    {
        let output = fixture.run(&["--language", language, "settings", "show"]);
        assert_eq!(output.status.code(), Some(1), "{output:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(invalid_settings), "{stderr}");
        assert!(stderr.contains("rdsh.json"), "{stderr}");
        assert!(stderr.contains("line"), "{stderr}");
        assert_eq!(
            fs::read_to_string(fixture.0.join("dsh/rdsh.json")).unwrap(),
            malformed
        );
    }

    fixture.settings("{}");
    for (language, range_error) in [
        ("zh-CN", "serve.port 超出 u16 范围"),
        ("ja", "serve.port は u16 の範囲外です"),
    ] {
        let output = fixture.run(&[
            "--language",
            language,
            "settings",
            "set",
            "serve.port",
            "70000",
        ]);
        assert_eq!(output.status.code(), Some(1), "{output:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(range_error), "{stderr}");
        assert!(stderr.contains("70000"), "{stderr}");
    }

    for (language, unknown_key) in [("zh-CN", "未知的设置键"), ("ja", "不明な設定キー")]
    {
        for action in [
            vec!["settings", "set", "未知_日本語", "raw_日本語"],
            vec!["settings", "unset", "未知_日本語"],
        ] {
            let mut args = vec!["--language", language];
            args.extend_from_slice(&action);
            let output = fixture.run(&args);
            assert_eq!(output.status.code(), Some(1), "{output:?}");
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(stderr.contains(unknown_key), "{stderr}");
            assert!(stderr.contains("未知_日本語"), "{stderr}");
        }
    }

    let policy = fixture.0.join("策略_日本語.json");
    fs::write(&policy, br#"{"schema":2,"rules":[]}"#).unwrap();
    let default =
        fixture.run_with_stdin(&["guard", "--policy-file", policy.to_str().unwrap()], b"{}");
    let english = fixture.run_with_stdin(
        &[
            "--language",
            "en",
            "guard",
            "--policy-file",
            policy.to_str().unwrap(),
        ],
        b"{}",
    );
    assert_eq!(english.status.code(), default.status.code());
    assert_eq!(english.stderr, default.stderr);
    for (language, invalid_policy) in [
        ("zh-CN", "不支持的策略架构"),
        ("ja", "未対応のポリシースキーマ"),
    ] {
        let args = [
            "--language",
            language,
            "guard",
            "--policy-file",
            policy.to_str().unwrap(),
        ];
        let output = fixture.run_with_stdin(&args, b"{}");
        assert_eq!(output.status.code(), Some(2), "{output:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(invalid_policy), "{stderr}");

        let mut json_args = args.to_vec();
        json_args.insert(3, "--json");
        let json = fixture.run_with_stdin(&json_args, b"{}");
        assert!(json.status.success(), "{json:?}");
        assert_eq!(
            json.stdout,
            b"{\"decision\":\"block\",\"classification\":\"unknown\",\"reason\":\"policy_unavailable\"}\n",
            "{language}"
        );
    }
}

#[test]
fn native_results_stay_identical_while_human_labels_change_language() {
    let fixture = Fixture::new();
    let token_file = fixture.0.join("計算_日本語.txt");
    fs::write(&token_file, "abc日本語\n").unwrap();
    let prune_file = fixture.0.join("剪定_日本語.txt");
    fs::write(&prune_file, "abcdef".repeat(2_000)).unwrap();
    let compact_file = fixture.0.join("圧縮_日本語.jsonl");
    fs::write(
        &compact_file,
        format!("{{\"role\":\"system\"}}\n{}", "message\n".repeat(2_000)),
    )
    .unwrap();
    let search_dir = fixture.0.join("検索_日本語");
    fs::create_dir(&search_dir).unwrap();
    fs::write(search_dir.join("結果_日本語.txt"), "needle 日本語\n").unwrap();

    for args in [
        vec!["tokens", token_file.to_str().unwrap()],
        vec!["prune", "--max-tokens", "24", prune_file.to_str().unwrap()],
        vec![
            "compact",
            compact_file.to_str().unwrap(),
            "--max-tokens",
            "64",
        ],
    ] {
        let english = fixture.run(&args);
        assert!(english.status.success(), "{args:?}: {english:?}");
        for language in ["zh-CN", "ja"] {
            let mut localized_args = vec!["--language", language];
            localized_args.extend_from_slice(&args);
            let localized = fixture.run(&localized_args);
            assert!(
                localized.status.success(),
                "{localized_args:?}: {localized:?}"
            );
            assert_eq!(localized.stdout, english.stdout, "{localized_args:?}");
        }
    }

    let search = ["search", "needle", "--dir", search_dir.to_str().unwrap()];
    if cfg!(unix) {
        let english = fixture.run(&search);
        assert!(english.status.success(), "{search:?}: {english:?}");
        for language in ["zh-CN", "ja"] {
            let localized = fixture.run(&[
                "--language",
                language,
                "search",
                "needle",
                "--dir",
                search_dir.to_str().unwrap(),
            ]);
            assert!(localized.status.success(), "{language}: {localized:?}");
            assert_eq!(localized.stdout, english.stdout, "{language}");
        }
    } else {
        for (language, unavailable) in [
            (
                "en",
                "RDSH_SECURITY: secure native search is unavailable on this platform",
            ),
            ("zh-CN", "RDSH_SECURITY：此平台无法使用安全原生搜索"),
            (
                "ja",
                "RDSH_SECURITY: このプラットフォームでは安全なネイティブ検索を利用できません",
            ),
        ] {
            let output = fixture.run(&[
                "--language",
                language,
                "search",
                "needle",
                "--dir",
                search_dir.to_str().unwrap(),
            ]);
            assert_eq!(output.status.code(), Some(1), "{language}: {output:?}");
            assert!(output.stdout.is_empty(), "{language}: {output:?}");
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(stderr.contains("RDSH_SECURITY"), "{language}: {stderr}");
            assert!(stderr.contains(unavailable), "{language}: {stderr}");
        }
    }
}

#[test]
fn native_command_errors_keep_unicode_values_in_chinese_and_japanese() {
    let fixture = Fixture::new();
    let missing = fixture.0.join("不存在_日本語_値.txt");
    let missing = missing.to_str().unwrap();
    fixture.settings(
        r#"{"extras":{"enable":["search-web"]},"search":{"searxng_url":"https://例.invalid/検索"}}"#,
    );
    for (language, error_label, file_error, directory_error, web_error, unavailable) in [
        (
            "zh-CN",
            "错误",
            "无法读取文件",
            "无法访问搜索目录",
            "仅支持 http:// SearXNG URL",
            "RDSH_SECURITY：此平台无法使用安全原生搜索",
        ),
        (
            "ja",
            "エラー",
            "ファイルを読み込めません",
            "検索ディレクトリにアクセスできません",
            "http:// の SearXNG URL のみ対応です",
            "RDSH_SECURITY: このプラットフォームでは安全なネイティブ検索を利用できません",
        ),
    ] {
        let mut cases = vec![
            (vec!["tokens", missing], file_error),
            (vec!["prune", "--max-tokens", "8", missing], file_error),
            (vec!["compact", missing, "--max-tokens", "8"], file_error),
            (vec!["search-web", "値_日本語"], web_error),
        ];
        if cfg!(unix) {
            cases.push((vec!["search", "needle", "--dir", missing], directory_error));
        }
        for (command, localized_error) in cases {
            let mut args = vec!["--language", language];
            args.extend_from_slice(&command);
            let output = fixture.run(&args);
            assert!(!output.status.success(), "{args:?}: {output:?}");
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(stderr.contains(error_label), "{args:?}: {stderr}");
            assert!(stderr.contains(localized_error), "{args:?}: {stderr}");
            let expected = if command[0] == "search-web" {
                "https://例.invalid/検索"
            } else {
                missing
            };
            assert!(stderr.contains(expected), "{args:?}: {stderr}");
        }
        if !cfg!(unix) {
            let output =
                fixture.run(&["--language", language, "search", "needle", "--dir", missing]);
            assert_eq!(output.status.code(), Some(1), "{output:?}");
            assert!(output.stdout.is_empty(), "{output:?}");
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(stderr.contains(error_label), "{stderr}");
            assert!(stderr.contains("RDSH_SECURITY"), "{stderr}");
            assert!(stderr.contains(unavailable), "{stderr}");
        }
    }
}

#[test]
fn structured_compute_and_guard_json_stay_wire_compatible_across_languages() {
    let fixture = Fixture::new();
    fixture.settings(r#"{"beta":{"context_engine":true}}"#);
    let request = r#"{"v":1,"id":"日本語","op":"tokens.estimate","text":"same value"}
"#;
    let english = fixture.run_with_stdin(&["compute", "--once"], request.as_bytes());
    assert!(english.status.success(), "{english:?}");
    let mut expected: serde_json::Value = serde_json::from_slice(&english.stdout).unwrap();
    expected.as_object_mut().unwrap().remove("elapsed_us");
    for language in ["zh-CN", "ja"] {
        let output = fixture.run_with_stdin(
            &["--language", language, "compute", "--once"],
            request.as_bytes(),
        );
        assert!(output.status.success(), "{output:?}");
        let mut actual: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        actual.as_object_mut().unwrap().remove("elapsed_us");
        assert_eq!(actual, expected, "{language}");

        let guard = fixture.run_with_stdin(
            &["--language", language, "guard", "--json"],
            r#"{"tool_name":"Read","tool_input":{"file_path":"値_日本語"}}
"#
            .as_bytes(),
        );
        assert!(guard.status.success(), "{guard:?}");
        assert_eq!(guard.stdout, b"{}\n", "{language}");

        for args in [
            vec!["context", "build", "--json"],
            vec!["sessions", "--json"],
            vec!["desktop", "status", "--json"],
        ] {
            let default = fixture.run(&args);
            assert!(default.status.success(), "{args:?}: {default:?}");
            let mut localized_args = vec!["--language", language];
            localized_args.extend_from_slice(&args);
            let localized = fixture.run(&localized_args);
            assert!(
                localized.status.success(),
                "{localized_args:?}: {localized:?}"
            );
            assert_eq!(localized.stdout, default.stdout, "{localized_args:?}");
        }
    }
}

#[test]
fn guard_json_parse_and_size_reasons_stay_canonical_english() {
    let fixture = Fixture::new();
    let oversized = vec![b'x'; 1024 * 1024 + 1];
    for (input, reason) in [
        (&b"{"[..], "rdsh guard: invalid JSON input"),
        (&oversized[..], "rdsh guard: unreadable or oversized input"),
    ] {
        let english = fixture.run_with_stdin(&["guard", "--json", "--deny", "needle"], input);
        assert!(english.status.success(), "{english:?}");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&english.stdout).unwrap(),
            serde_json::json!({"decision": "block", "reason": reason})
        );
        for language in ["zh-CN", "ja"] {
            let output = fixture.run_with_stdin(
                &[
                    "--language",
                    language,
                    "guard",
                    "--json",
                    "--deny",
                    "needle",
                ],
                input,
            );
            assert!(output.status.success(), "{language}: {output:?}");
            assert_eq!(output.stdout, english.stdout, "{language}");
        }
    }
}

#[test]
fn localized_context_desktop_and_logs_errors_keep_raw_unicode_values() {
    let fixture = Fixture::new();
    let missing = fixture.0.join("存在しない_路径_日本語.log");
    fs::create_dir(fixture.0.join("dsh/logs")).unwrap();
    fixture.settings(r#"{"beta":{"context_engine":true}}"#);
    fs::write(
        fixture.0.join("dsh/rdsh-context.json"),
        serde_json::json!({ "working_files": [missing] }).to_string(),
    )
    .unwrap();

    for (language, context_text, desktop_text, logs_text) in [
        (
            "zh-CN",
            "缺失文件",
            "桌面配置文件没有启用的 rdsh 插件",
            "无法读取日志文件",
        ),
        (
            "ja",
            "見つからないファイル",
            "デスクトッププロファイルに有効な rdsh プラグインがありません",
            "ログファイルを読み込めません",
        ),
    ] {
        let context = fixture.run(&["--language", language, "context", "status"]);
        assert!(context.status.success(), "{context:?}");
        let context_stdout = String::from_utf8_lossy(&context.stdout);
        assert!(context_stdout.contains(context_text), "{context_stdout}");
        assert!(
            context_stdout.contains(missing.to_str().unwrap()),
            "{context_stdout}"
        );

        let desktop = fixture.run(&[
            "--language",
            language,
            "desktop",
            "verify",
            "--require",
            "插件_日本語",
        ]);
        assert!(!desktop.status.success(), "{desktop:?}");
        let desktop_stderr = String::from_utf8_lossy(&desktop.stderr);
        assert!(desktop_stderr.contains(desktop_text), "{desktop_stderr}");
        assert!(desktop_stderr.contains("插件_日本語"), "{desktop_stderr}");

        let logs = fixture.run(&[
            "--language",
            language,
            "logs",
            "--file",
            missing.to_str().unwrap(),
        ]);
        assert!(!logs.status.success(), "{logs:?}");
        let logs_stderr = String::from_utf8_lossy(&logs.stderr);
        assert!(logs_stderr.contains(logs_text), "{logs_stderr}");
        assert!(
            logs_stderr.contains(missing.to_str().unwrap()),
            "{logs_stderr}"
        );
    }
}

#[test]
fn english_native_presentations_match_the_default_locale() {
    let fixture = Fixture::new();
    for (args, input) in [
        (vec!["profiles"], None),
        (vec!["logs"], None),
        (vec!["context", "status"], None),
        (vec!["desktop", "status"], None),
        (vec!["guard", "--deny", "needle"], Some("needle\n")),
    ] {
        let default = match input {
            Some(input) => fixture.run_with_stdin(&args, input.as_bytes()),
            None => fixture.run(&args),
        };
        let mut english_args = vec!["--language", "en"];
        english_args.extend_from_slice(&args);
        let english = match input {
            Some(input) => fixture.run_with_stdin(&english_args, input.as_bytes()),
            None => fixture.run(&english_args),
        };
        assert_eq!(english.status.code(), default.status.code(), "{args:?}");
        assert_eq!(english.stdout, default.stdout, "{args:?}");
        assert_eq!(english.stderr, default.stderr, "{args:?}");
    }
}

#[test]
fn main_native_labels_and_errors_are_localized_without_changing_json() {
    let fixture = Fixture::new();
    for (language, feature_heading, feature_summary, bench_error) in [
        ("zh-CN", "功能", "本地只读仪表板", "--n 必须 >= 1"),
        (
            "ja",
            "機能",
            "ローカル読み取り専用ダッシュボード",
            "--n は 1 以上である必要があります",
        ),
    ] {
        let features = fixture.run(&["--language", language, "features"]);
        assert!(features.status.success(), "{features:?}");
        assert!(
            String::from_utf8_lossy(&features.stdout).contains(feature_heading),
            "{:?}",
            features
        );
        assert!(
            String::from_utf8_lossy(&features.stdout).contains(feature_summary),
            "{:?}",
            features
        );

        let bench = fixture.run(&["--language", language, "bench", "--n", "0"]);
        assert!(!bench.status.success(), "{bench:?}");
        assert!(
            String::from_utf8_lossy(&bench.stderr).contains(bench_error),
            "{:?}",
            bench
        );

        let default_json = fixture.run(&["features", "--json"]);
        let localized_json = fixture.run(&["--language", language, "features", "--json"]);
        assert!(default_json.status.success(), "{default_json:?}");
        assert_eq!(localized_json.stdout, default_json.stdout, "{language}");
    }
}

#[test]
fn auth_and_doctor_errors_are_localized_and_keep_raw_configuration() {
    let fixture = Fixture::new();
    for (language, auth_error, doctor_label) in [
        ("zh-CN", "未选择凭据共享", "原始 dsh"),
        ("ja", "共有する認証情報が選択されていません", "元の dsh"),
    ] {
        let auth = fixture.run(&["--language", language, "auth", "--import"]);
        assert_eq!(auth.status.code(), Some(1), "{auth:?}");
        assert!(
            String::from_utf8_lossy(&auth.stderr).contains(auth_error),
            "{auth:?}"
        );

        let doctor = fixture.run(&["--language", language, "doctor"]);
        assert!(
            String::from_utf8_lossy(&doctor.stdout).contains(doctor_label),
            "{doctor:?}"
        );
    }
}

#[test]
fn integrated_provider_and_new_native_help_cover_every_language() {
    let fixture = Fixture::new();
    let commands: &[&[&str]] = &[
        &["--help"],
        &["provider", "--help"],
        &["provider", "list", "--help"],
        &["provider", "add", "--help"],
        &["auth", "--help"],
        &["update", "auto", "status", "--help"],
        &["subagents", "plan", "--help"],
        &["task-outcomes", "--help"],
        &["serial-proxy", "--help"],
    ];
    for (language, heading) in [("en", "Options"), ("zh-CN", "选项"), ("ja", "オプション")] {
        for command in commands {
            let mut args = vec!["--language", language];
            args.extend_from_slice(command);
            let output = fixture.run(&args);
            assert!(
                output.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(stdout.contains(heading), "{args:?}: {stdout}");
            if command == &["provider", "add", "--help"] {
                for flag in [
                    "--model",
                    "--from-opencode",
                    "--discover",
                    "--key-stdin",
                    "--no-key",
                    "--replace",
                ] {
                    assert!(stdout.contains(flag), "{language}: {stdout}");
                }
            }
            if command == &["auth", "--help"] {
                assert!(
                    stdout.contains("--select") && stdout.contains("--unselect"),
                    "{stdout}"
                );
            }
        }
    }
}

#[test]
fn provider_human_labels_and_protocol_json_resolve_languages_independently() {
    let fixture = Fixture::new();
    let mut json_outputs = Vec::new();
    for (language, heading) in [
        ("en", "presets:"),
        ("zh-CN", "预设："),
        ("ja", "プリセット:"),
    ] {
        let output = fixture.run(&["--language", language, "provider", "list"]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains(heading));
        let output = fixture.run(&["--language", language, "provider", "list", "--json"]);
        assert!(output.status.success());
        json_outputs.push(output.stdout);
    }
    assert_eq!(json_outputs[0], json_outputs[1]);
    assert_eq!(json_outputs[0], json_outputs[2]);
}

#[test]
fn auth_selection_failure_is_localized_without_copying_credentials() {
    let fixture = Fixture::new();
    for (language, label) in [
        ("en", "no credential sharing selected"),
        ("zh-CN", "未选择凭据共享"),
        ("ja", "共有する認証情報が選択されていません"),
    ] {
        let output = fixture.run(&["--language", language, "auth", "--import"]);
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(label),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!fixture.0.join("dsh/.credentials.yaml").exists());
    }
}

/// logs ディレクトリが無いときの英語表示は #617 前の原文のままであること。
/// 汎用の NoDirectory を使うと "no logs dir at" になり、非英語では kind が
/// 未翻訳のまま混ざる。
#[test]
fn missing_logs_keeps_the_original_english_string() {
    let fixture = Fixture::new();
    let output = fixture.run(&["logs"]);
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("no logs at"), "{stdout}");
    assert!(!stdout.contains("no logs dir at"), "{stdout}");
}
