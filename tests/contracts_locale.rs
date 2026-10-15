//! Human-facing contract CLI diagnostics do not alter canonical request or response JSON.
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
const LANGUAGES: [&str; 3] = ["en", "zh-CN", "ja"];
const COMMANDS: [&str; 3] = [
    "question-contracts",
    "answer-applications",
    "instruction-queue",
];
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "rdsh-contracts-言語-{}-{}",
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
            .env("APPDATA", self.0.join("appdata"))
            .env("XDG_DATA_HOME", self.0.join("data"))
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env("DSH_HOME", &self.0)
            .env("RDSH_LANG", "en")
            .env_remove("RDSH_ORIG_BIN")
            .env_remove("RDSH_PASSTHROUGH")
            .env_remove("RDSH_DRY_RUN")
            .output()
            .unwrap()
    }
    fn request(&self, language: &str, command: &str, action: &str, bytes: &[u8]) -> Output {
        let file = self.0.join("日本語の要求.json");
        std::fs::write(&file, bytes).unwrap();
        let output = self.run(
            language,
            &[command, action, "--input-file", file.to_str().unwrap()],
        );
        assert_eq!(std::fs::read(file).unwrap(), bytes);
        output
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn pure_contract_commands_keep_canonical_json_and_corrupt_settings_unchanged() {
    let f = Fixture::new();
    let settings = f.0.join("rdsh.json");
    std::fs::write(&settings, "{壊れた設定").unwrap();
    for command in COMMANDS {
        let request = if command == "instruction-queue" {
            br#"{"operation":"validate","state":{"project":{"id":"fixture"},"feedback":[]}}"#
                .as_slice()
        } else {
            br#"{"operation":"validate","state":{"project":{"id":"fixture"},"feedback":[]},"now":"2026-10-15T00:00:00.000Z"}"#.as_slice()
        };
        for language in LANGUAGES {
            let output = f.request(language, command, "validate", request);
            assert!(
                output.status.success(),
                "{command}/{language}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(output.stderr.is_empty());
            assert_eq!(
                output.stdout,
                b"{\"operation\":\"validate\",\"valid\":true}\n"
            );
            assert_eq!(std::fs::read_to_string(&settings).unwrap(), "{壊れた設定");
        }
    }
}
#[test]
fn contract_help_and_json_input_errors_use_the_selected_language() {
    let f = Fixture::new();
    for (language, usage, invalid, unreadable) in [
        ("en", "Usage:", "Input JSON is invalid", "cannot read JSON"),
        ("zh-CN", "用法：", "输入 JSON 无效", "无法读取 JSON"),
        (
            "ja",
            "使い方:",
            "入力JSONが無効です",
            "JSONを読み取れません",
        ),
    ] {
        for command in COMMANDS {
            let help = f.run(language, &[command, "--help"]);
            assert!(help.status.success(), "{command}/{language}");
            let help = String::from_utf8_lossy(&help.stdout);
            assert!(help.contains(usage), "{help}");
            assert!(help.contains(command), "{help}");
            for bytes in [b"{broken".as_slice(), b"\xff".as_slice(), b"[]".as_slice()] {
                let output = f.request(language, command, "validate", bytes);
                assert_eq!(output.status.code(), Some(1));
                assert!(output.stdout.is_empty());
                let error = String::from_utf8_lossy(&output.stderr);
                assert!(error.contains(invalid), "{command}/{language}: {error}");
            }
            let missing = f.0.join("不存在の要求.json");
            let output = f.run(
                language,
                &[
                    command,
                    "validate",
                    "--input-file",
                    missing.to_str().unwrap(),
                ],
            );
            let error = String::from_utf8_lossy(&output.stderr);
            assert_eq!(output.status.code(), Some(1));
            assert!(output.stdout.is_empty());
            assert!(error.contains(unreadable), "{error}");
            assert!(error.contains("不存在の要求.json"), "{error}");
        }
    }
}
#[test]
fn owned_error_context_preserves_engine_messages_and_status() {
    let f = Fixture::new();
    for (language, question, answer, instruction) in [
        ("en", "Question contracts", "", ""),
        ("zh-CN", "问题契约", "回答应用", "指令队列"),
        ("ja", "質問契約", "回答適用", "指示キュー"),
    ] {
        for (command, action, request, prefix, original) in [
            (
                "question-contracts",
                "validate",
                r#"{"operation":"validate","state":{},"now":"invalid"}"#,
                question,
                "Invalid expires_at",
            ),
            (
                "answer-applications",
                "validate",
                r#"{"operation":"validate","state":{"feedback":[{"reply_command_id":"原値"}]}}"#,
                answer,
                "Missing answer application registry (status 400)",
            ),
            (
                "instruction-queue",
                "context",
                r#"{"operation":"context","state":{},"input":{}}"#,
                instruction,
                "Unknown exact run/session recipient",
            ),
        ] {
            let output = f.request(language, command, action, request.as_bytes());
            assert_eq!(output.status.code(), Some(1));
            assert!(output.stdout.is_empty());
            let error = String::from_utf8_lossy(&output.stderr);
            assert!(error.contains(prefix), "{command}/{language}: {error}");
            assert!(error.contains(original), "{command}/{language}: {error}");
        }
    }
}
