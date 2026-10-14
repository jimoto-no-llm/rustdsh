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

    fn run(&self, args: &[&str]) -> Output {
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
            .env("DSH_HOME", self.0.join("dsh"))
            .output()
            .unwrap()
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
        vec!["search", "needle", "--dir", search_dir.to_str().unwrap()],
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
}

#[test]
fn native_command_errors_keep_unicode_values_in_chinese_and_japanese() {
    let fixture = Fixture::new();
    let missing = fixture.0.join("不存在_日本語_値.txt");
    let missing = missing.to_str().unwrap();
    fixture.settings(
        r#"{"extras":{"enable":["search-web"]},"search":{"searxng_url":"https://例.invalid/検索"}}"#,
    );
    for (language, error_label, file_error, directory_error, web_error) in [
        (
            "zh-CN",
            "错误",
            "无法读取文件",
            "无法访问搜索目录",
            "仅支持 http:// SearXNG URL",
        ),
        (
            "ja",
            "エラー",
            "ファイルを読み込めません",
            "検索ディレクトリにアクセスできません",
            "http:// の SearXNG URL のみ対応です",
        ),
    ] {
        let cases = [
            (vec!["tokens", missing], file_error),
            (vec!["prune", "--max-tokens", "8", missing], file_error),
            (vec!["compact", missing, "--max-tokens", "8"], file_error),
            (vec!["search", "needle", "--dir", missing], directory_error),
            (vec!["search-web", "値_日本語"], web_error),
        ];
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
fn localized_context_desktop_and_logs_errors_keep_raw_unicode_values() {
    let fixture = Fixture::new();
    let missing = fixture.0.join("存在しない_路径_日本語.log");
    fs::create_dir(fixture.0.join("dsh/logs")).unwrap();
    fixture.settings(r#"{"beta":{"context_engine":true}}"#);
    fs::write(
        fixture.0.join("dsh/rdsh-context.json"),
        format!(r#"{{"working_files":["{}"]}}"#, missing.display()),
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
        ("zh-CN", "凭据导入需要", "原始 dsh"),
        ("ja", "認証情報のインポートには", "元の dsh"),
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
