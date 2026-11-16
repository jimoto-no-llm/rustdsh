//! Mistral's Chat Completions preset; credentials and network are isolated.
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);
const PATCH: &str = "# preserved\n- id: llm-pi-ai\n  config:\n    providers:\n      other:\n        apiKeyEnv: OTHER_API_KEY\n        models:\n          - id: other-model\n- id: agent-default-model\n  config:\n    provider: other\n    model: other-model\n";

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "rdsh-mistral-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("dsh/profiles/web")).unwrap();
        fs::create_dir_all(root.join("home")).unwrap();
        let fixture = Self(root);
        fs::write(fixture.patch_path(), PATCH).unwrap();
        fixture
    }
    fn patch_path(&self) -> PathBuf {
        self.0.join("dsh/profiles/web/cordis.patch.yml")
    }
    fn run(&self, extra: &[&str], stdin: &str) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        command.env_clear();
        for name in ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let mut child = command
            .args(["provider", "add", "mistral", "--profile", "web", "--json"])
            .args(extra)
            .current_dir(&self.0)
            .env("HOME", self.0.join("home"))
            .env("USERPROFILE", self.0.join("home"))
            .env("DSH_HOME", self.0.join("dsh"))
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env("XDG_DATA_HOME", self.0.join("data"))
            .env("RDSH_ORIG_BIN", self.0.join("no-dsh"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn successful(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn default_route_uses_chat_completions_and_keeps_key_and_existing_profile_private() {
    let fixture = Fixture::new();
    let secret = "synthetic-mistral-secret-012345";
    let output = fixture.run(&["--key-stdin"], &format!("{secret}\n"));
    let report = successful(&output);
    assert_eq!(report["apiKeyEnv"], "MISTRAL_API_KEY");
    assert_eq!(
        report["models"],
        serde_json::json!(["mistral-small-latest"])
    );
    for bytes in [&output.stdout, &output.stderr] {
        assert!(!String::from_utf8_lossy(bytes).contains(secret));
    }
    let patch = fs::read_to_string(fixture.patch_path()).unwrap();
    assert!(patch.contains("      mistral:\n        displayName: Mistral\n"));
    assert!(patch.contains("        api: openai-completions\n"));
    assert!(patch.contains("        baseURL: https://api.mistral.ai/v1\n"));
    assert!(patch.contains("          supportsStore: false\n"));
    assert!(patch.contains("          supportsUsageInStreaming: false\n"));
    assert!(patch.contains("          supportsDeveloperRole: false\n"));
    assert!(patch.contains("          maxTokensField: max_tokens\n"));
    assert!(!patch.contains("mistral-conversations"));
    assert!(!patch.contains(secret));
    assert!(patch.contains("      other:\n        apiKeyEnv: OTHER_API_KEY\n"));
    assert!(patch.ends_with("    provider: other\n    model: other-model\n"));
    let credentials = fixture.0.join("dsh/.credentials.yaml");
    assert!(fs::read_to_string(&credentials).unwrap().contains(secret));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&credentials).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    successful(&fixture.run(&[], ""));
    assert_eq!(fs::read_to_string(fixture.patch_path()).unwrap(), patch);
}

#[test]
fn discovery_excludes_declared_non_chat_models_and_preserves_vision() {
    let fixture = Fixture::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        let mut request = Vec::new();
        let mut byte = [0u8; 1];
        while !request.ends_with(b"\r\n\r\n") {
            assert!(request.len() < 65536);
            assert_eq!(stream.read(&mut byte).unwrap(), 1);
            request.push(byte[0]);
        }
        assert!(String::from_utf8_lossy(&request).starts_with("GET /v1/models HTTP/1.1"));
        let body = r#"{"data":[
          {"id":"mistral-chat","capabilities":{"completion_chat":true,"vision":true}},
          {"id":"mistral-embed","capabilities":{"completion_chat":false}},
          {"id":"codestral-fim","capabilities":{"completion_chat":false,"completion_fim":true}},
          {"id":"malformed","capabilities":{"completion_chat":"true"}},
          {"id":"messages-only","capabilities":{"completion_chat":true},"supported_endpoints":["/v1/messages"]}
        ]}"#;
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
    });
    let output = fixture.run(
        &["--base-url", &base, "--discover", "--key-stdin"],
        "synthetic-test-key\n",
    );
    server.join().unwrap();
    let report = successful(&output);
    assert_eq!(report["models"], serde_json::json!(["mistral-chat"]));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("not one of the documented"));
    let patch = fs::read_to_string(fixture.patch_path()).unwrap();
    assert!(patch.contains("          - id: mistral-chat\n            input: [text, image]\n"));
    assert!(!patch.contains("mistral-embed"));
    assert!(!patch.contains("codestral-fim"));
    assert!(!patch.contains("contextWindow"));
}
