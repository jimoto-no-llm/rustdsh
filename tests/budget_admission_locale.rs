//! Locale-owned CLI presentation keeps admission JSON and caller text unchanged.
use serde_json::json;
use std::{
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "rdsh-budget-言語-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn run(&self, language: &str, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_rdsh"))
            .args(["--language", language])
            .args(args)
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("DSH_HOME", &self.0)
            .env("RDSH_LANG", "en")
            .output()
            .unwrap()
    }
    fn request(&self, language: &str, action: &str, bytes: &[u8]) -> Output {
        let file = self.0.join("予算の要求.json");
        std::fs::write(&file, bytes).unwrap();
        self.run(
            language,
            &[
                "budget-admission",
                action,
                "--input-file",
                file.to_str().unwrap(),
            ],
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
const LANGUAGES: [&str; 3] = ["en", "zh-CN", "ja"];
#[test]
fn pure_commands_keep_json_and_corrupt_settings_identical_in_all_languages() {
    let f = Fixture::new();
    let settings = f.0.join("rdsh.json");
    std::fs::write(&settings, "{壊れた設定").unwrap();
    for action in ["validate", "public"] {
        let request = json!({"operation":action,"state":{"schema":1,"project":{"id":"日本語-project"}},"now":"2026-10-15T00:00:00Z"});
        let mut expected = None;
        for language in LANGUAGES {
            let bytes = format!("\u{feff}{request}");
            let result = f.request(language, action, bytes.as_bytes());
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            assert!(result.stderr.is_empty());
            match &expected {
                Some(value) => assert_eq!(&result.stdout, value),
                None => expected = Some(result.stdout),
            }
            assert_eq!(std::fs::read_to_string(&settings).unwrap(), "{壊れた設定");
        }
    }
}
#[test]
fn help_and_input_diagnostics_use_the_selected_language() {
    let f = Fixture::new();
    for (language, about, invalid, missing, large) in [
        (
            "en",
            "Admission budget book",
            "Input JSON is invalid",
            "cannot read JSON",
            "Input JSON must be a regular file of at most 128 MiB",
        ),
        (
            "zh-CN",
            "预算准入",
            "输入 JSON 无效",
            "无法读取 JSON",
            "输入 JSON 必须是最多 128 MiB 的常规文件",
        ),
        (
            "ja",
            "予算受付",
            "入力JSONが無効です",
            "JSONを読み取れません",
            "入力JSONは128 MiB以下の通常ファイルである必要があります",
        ),
    ] {
        let help = f.run(language, &["budget-admission", "--help"]);
        assert!(help.status.success());
        assert!(String::from_utf8_lossy(&help.stdout).contains(about));
        for bytes in [b"{broken".as_slice(), b"\xff".as_slice(), b"[]".as_slice()] {
            let result = f.request(language, "validate", bytes);
            assert_eq!(result.status.code(), Some(1));
            assert!(result.stdout.is_empty());
            assert!(String::from_utf8_lossy(&result.stderr).contains(invalid));
        }
        let file = f.0.join("不存在の要求.json");
        let result = f.run(
            language,
            &[
                "budget-admission",
                "validate",
                "--input-file",
                file.to_str().unwrap(),
            ],
        );
        let error = String::from_utf8_lossy(&result.stderr);
        assert_eq!(result.status.code(), Some(1));
        assert!(error.contains(missing));
        assert!(error.contains("不存在の要求.json"));
        let huge = f.0.join("巨大な要求.json");
        std::fs::File::create(&huge)
            .unwrap()
            .set_len(128 * 1024 * 1024 + 1)
            .unwrap();
        let result = f.run(
            language,
            &[
                "budget-admission",
                "validate",
                "--input-file",
                huge.to_str().unwrap(),
            ],
        );
        assert_eq!(result.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&result.stderr).contains(large));
    }
}
#[test]
fn owned_error_prefix_changes_but_machine_error_codes_do_not() {
    let f = Fixture::new();
    let request = json!({"operation":"policy","state":{"schema":1,"project":{"id":"日本語"}},"input":{},"now":"2026-10-15T00:00:00Z"});
    for (language, prefix) in [
        ("en", "Budget admission: "),
        ("zh-CN", "预算准入："),
        ("ja", "予算受付: "),
    ] {
        let result = f.request(language, "apply", request.to_string().as_bytes());
        assert_eq!(result.status.code(), Some(1));
        assert!(result.stdout.is_empty());
        let error = String::from_utf8_lossy(&result.stderr);
        assert!(error.contains(prefix), "{error}");
        assert!(error.contains("budget_invalid_"), "{error}");
    }
}
