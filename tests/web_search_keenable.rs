//! Keenable CLI selection tests never call the hosted API.
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "rdsh-keenable-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("dsh")).unwrap();
        fs::write(
            root.join("dsh/rdsh.json"),
            serde_json::json!({"features":{"search-web":true}}).to_string(),
        )
        .unwrap();
        Self(root)
    }

    fn command(&self, language: &str, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        command.env_clear();
        for name in ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .current_dir(&self.0)
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("DSH_HOME", self.0.join("dsh"))
            .args(["--language", language, "search-web"])
            .args(args);
        command
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn failed(output: Output) -> String {
    assert!(!output.status.success(), "{output:?}");
    assert!(output.stdout.is_empty(), "{output:?}");
    String::from_utf8(output.stderr).unwrap()
}

#[test]
fn help_advertises_explicit_provider_and_external_query_accounting() {
    let fixture = Fixture::new();
    let output = fixture.command("en", &["--help"]).output().unwrap();
    assert!(output.status.success(), "{output:?}");
    let help = String::from_utf8(output.stdout).unwrap();
    for text in [
        "--provider",
        "searxng",
        "ollama",
        "keenable",
        "KEENABLE_API_KEY",
        "query",
        "organization credits",
        "IP quota",
    ] {
        assert!(help.contains(text), "missing {text:?} in {help}");
    }
}

#[test]
fn malformed_key_errors_are_localized_and_do_not_echo_query_or_key() {
    let fixture = Fixture::new();
    for (language, expected, disclosure) in [
        (
            "en",
            "invalid HTTP header",
            "This provider sends queries to Keenable",
        ),
        (
            "zh-CN",
            "无效的 HTTP 请求头",
            "此提供方会将查询发送到 Keenable",
        ),
        (
            "ja",
            "無効な HTTP ヘッダー文字",
            "このプロバイダーは検索語を Keenable に送信します",
        ),
    ] {
        let error = failed(
            fixture
                .command(language, &["private query", "--provider", "keenable"])
                .env("KEENABLE_API_KEY", "fixture-secret\r\nInjected: value")
                .output()
                .unwrap(),
        );
        assert!(error.contains("KEENABLE_API_KEY"), "{error}");
        assert!(error.contains(expected), "{error}");
        assert!(error.contains(disclosure), "{error}");
        for secret in ["fixture-secret", "private query"] {
            assert!(!error.contains(secret), "{error}");
        }
        assert!(!error.contains("SearXNG"), "{error}");
        assert!(!error.contains("Ollama"), "{error}");
    }
}
