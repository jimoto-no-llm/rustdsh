//! `rdsh provider` against the real binary in an isolated HOME / DSH_HOME.
//! The only network is a throwaway server on 127.0.0.1.
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread;

static NEXT: AtomicUsize = AtomicUsize::new(0);

#[test]
fn overflowing_chunk_size_is_a_cli_error_without_profile_writes() {
    let fixture = Fixture::new();
    fixture.set_patch(PATCH);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            assert!(head.len() < 64 * 1024);
            assert_eq!(stream.read(&mut byte).unwrap(), 1);
            head.push(byte[0]);
        }
        let response = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:X}\r\nxx",
            usize::MAX
        );
        stream.write_all(response.as_bytes()).unwrap();
    });
    let out = fixture.run(&[
        "provider",
        "add",
        "local-openai",
        "--profile",
        "tui",
        "--base-url",
        &base,
        "--discover",
        "--no-key",
        "--json",
    ]);
    server.join().unwrap();
    assert_eq!(out.status.code(), Some(1), "{}", text(&out));
    assert!(String::from_utf8_lossy(&out.stderr).contains("bad chunked body"));
    assert!(out.stdout.is_empty());
    assert_eq!(fixture.patch(), PATCH);
    assert!(fixture.creds().is_empty());
}

const PATCH: &str = "# my profile\n- id: llm-pi-ai\n  config:\n    # custom routes\n    providers:\n      other:\n        apiKeyEnv: OTHER_API_KEY\n        models:\n          - id: x\n- id: agent-default-model\n  config:\n    provider: other\n    model: x\n";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "rdsh-provider-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("dsh/profiles/tui")).unwrap();
        fs::create_dir_all(root.join("home")).unwrap();
        Self(root)
    }

    fn patch_path(&self) -> PathBuf {
        self.0.join("dsh/profiles/tui/cordis.patch.yml")
    }

    fn patch(&self) -> String {
        fs::read_to_string(self.patch_path()).unwrap()
    }

    fn set_patch(&self, text: &str) {
        fs::write(self.patch_path(), text).unwrap();
    }

    fn creds(&self) -> String {
        fs::read_to_string(self.0.join("dsh/.credentials.yaml")).unwrap_or_default()
    }

    fn command(&self, args: &[&str], envs: &[(&str, &str)]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        cmd.env_clear();
        for key in ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"] {
            if let Some(v) = std::env::var_os(key) {
                cmd.env(key, v);
            }
        }
        cmd.args(args)
            .current_dir(&self.0)
            .env("HOME", self.0.join("home"))
            .env("USERPROFILE", self.0.join("home"))
            .env("DSH_HOME", self.0.join("dsh"))
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env("XDG_DATA_HOME", self.0.join("data"))
            .env("RDSH_ORIG_BIN", self.0.join("no-original-dsh"));
        for (k, v) in envs {
            cmd.env(k, v);
        }
        cmd
    }

    fn run(&self, args: &[&str]) -> Output {
        self.run_with(args, &[], b"")
    }

    fn run_with(&self, args: &[&str], envs: &[(&str, &str)], stdin: &[u8]) -> Output {
        let mut child = self
            .command(args, envs)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(stdin).unwrap();
        child.wait_with_output().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn text(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

fn ok(out: &Output) {
    assert!(out.status.success(), "{}", text(out));
}

/// Serve one canned JSON body per connection; each request head is reported.
fn mock_server(body: &'static str) -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if stream.read(&mut byte).unwrap_or(0) == 0 {
                    break;
                }
                head.push(byte[0]);
            }
            let _ = tx.send(String::from_utf8_lossy(&head).into_owned());
            // Chunked, as llama.cpp and others answer an HTTP/1.1 client.
            let (a, b) = body.split_at(body.len() / 2);
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{a}\r\n{:x}\r\n{b}\r\n0\r\n\r\n",
                a.len(),
                b.len()
            );
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    (base, rx)
}

#[test]
fn hai_add_keeps_other_bytes_is_idempotent_and_dry_run_writes_nothing() {
    let f = Fixture::new();
    f.set_patch(PATCH);
    let dry = f.run(&[
        "provider",
        "add",
        "hai",
        "--profile",
        "tui",
        "--model",
        "deepseek-v4-flash",
        "--dry-run",
    ]);
    ok(&dry);
    assert_eq!(f.patch(), PATCH);
    assert!(f.creds().is_empty());
    assert!(text(&dry).contains("hai:"));

    let out = f.run(&[
        "provider",
        "add",
        "hai",
        "--profile",
        "tui",
        "--model",
        "deepseek-v4-flash",
    ]);
    ok(&out);
    let patch = f.patch();
    let want = PATCH.replacen(
        "          - id: x\n",
        "          - id: x\n      hai:\n        displayName: HAI\n        apiKeyEnv: HAI_API_KEY\n        api: openai-completions\n        baseURL: https://hai-api.hcloud.ltd/v1\n        models:\n          - id: deepseek-v4-flash\n",
        1,
    );
    assert_eq!(patch, want);
    assert!(
        text(&out).contains("HAI_API_KEY is missing"),
        "{}",
        text(&out)
    );

    let again = f.run(&[
        "provider",
        "add",
        "hai",
        "--profile",
        "tui",
        "--model",
        "deepseek-v4-flash",
        "--json",
    ]);
    ok(&again);
    assert_eq!(f.patch(), want);
    let v: Value = serde_json::from_slice(&again.stdout).unwrap();
    assert_eq!(v["change"], "exists");
    assert_eq!(v["written"], false);

    // --replace --dry-run reports the rewrite but leaves the file alone.
    let replace = f.run(&[
        "provider",
        "add",
        "hai",
        "--profile",
        "tui",
        "--model",
        "other",
        "--replace",
        "--dry-run",
        "--json",
    ]);
    ok(&replace);
    let v: Value = serde_json::from_slice(&replace.stdout).unwrap();
    assert_eq!(v["change"], "replaced");
    assert_eq!(f.patch(), want);
}

#[test]
fn default_profile_follows_the_existing_rules() {
    let f = Fixture::new();
    f.set_patch(PATCH);
    // A local "tui" profile is the fallback when nothing else is configured.
    ok(&f.run(&["provider", "add", "hai", "--model", "m1"]));
    assert!(f.patch().contains("      hai:\n"));
    let missing = f.run(&[
        "provider",
        "add",
        "hai",
        "--profile",
        "nope",
        "--model",
        "m1",
    ]);
    assert!(!missing.status.success());
    let bad = f.run(&[
        "provider",
        "add",
        "hai",
        "--profile",
        "../tui",
        "--model",
        "m1",
    ]);
    assert!(!bad.status.success());
}

#[test]
fn the_key_is_stored_but_never_printed() {
    let f = Fixture::new();
    f.set_patch(PATCH);
    let secret = "sk-test-secret-0123456789";
    let out = f.run_with(
        &[
            "provider",
            "add",
            "hai",
            "--profile",
            "tui",
            "--model",
            "m1",
            "--json",
        ],
        &[("HAI_API_KEY", secret)],
        b"",
    );
    ok(&out);
    assert!(!text(&out).contains(secret));
    assert!(!f.patch().contains(secret));
    assert!(f.creds().contains("HAI_API_KEY"));
    assert!(f.creds().contains(secret));
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["key"], "stored");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(f.0.join("dsh/.credentials.yaml"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    let f = Fixture::new();
    f.set_patch(PATCH);
    let stdin_secret = "sk-from-stdin-9876543210";
    let out = f.run_with(
        &[
            "provider",
            "add",
            "hai",
            "--profile",
            "tui",
            "--model",
            "m1",
            "--key-stdin",
        ],
        &[],
        format!("{stdin_secret}\n").as_bytes(),
    );
    ok(&out);
    assert!(!text(&out).contains(stdin_secret));
    assert!(f.creds().contains(stdin_secret));
}

#[test]
fn from_opencode_reads_jsonc_models_and_ignores_the_api_key() {
    let f = Fixture::new();
    f.set_patch(PATCH);
    let dir = f.0.join("config/opencode");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("opencode.jsonc"),
        r#"{
  // HAI
  "provider": {
    "hai": {
      "options": {
        "baseURL": "http://127.0.0.1:18080/v1", // serial proxy
        "apiKey": "sk-opencode-must-not-copy",
      },
      "models": {
        "deepseek-v4-flash": {
          "name": "DeepSeek V4 Flash (HAI)",
          "limit": { "context": 1048576, "output": 16384 },
          "modalities": { "input": ["text", "image"] },
        },
      },
    },
  },
}
"#,
    )
    .unwrap();
    let out = f.run(&[
        "provider",
        "add",
        "hai",
        "--profile",
        "tui",
        "--from-opencode",
        "--json",
    ]);
    ok(&out);
    let patch = f.patch();
    assert!(
        patch.contains("baseURL: http://127.0.0.1:18080/v1\n"),
        "{patch}"
    );
    assert!(patch.contains("name: DeepSeek V4 Flash (HAI)\n"));
    assert!(patch.contains("contextWindow: 1048576\n"));
    assert!(patch.contains("input: [text, image]\n"));
    assert!(!text(&out).contains("sk-opencode"));
    assert!(!patch.contains("sk-opencode"));
    assert!(!f.creds().contains("sk-opencode"));
}

#[test]
fn local_openai_discovers_models_from_a_mock_server() {
    let f = Fixture::new();
    f.set_patch(PATCH);
    let (base, requests) = mock_server(r#"{"data":[{"id":"m1"},{"id":"m2"}]}"#);
    let secret = "sk-local-secret-5555";
    let out = f.run_with(
        &[
            "provider",
            "add",
            "local-openai",
            "--profile",
            "tui",
            "--base-url",
            &base,
            "--discover",
            "--json",
        ],
        &[("LOCAL_OPENAI_API_KEY", secret)],
        b"",
    );
    ok(&out);
    let head = requests.recv().unwrap();
    assert!(head.starts_with("GET /v1/models HTTP/1.1"), "{head}");
    assert!(
        head.contains(&format!("Authorization: Bearer {secret}")),
        "{head}"
    );
    assert!(!text(&out).contains(secret));
    let patch = f.patch();
    assert!(patch.contains("      local-openai:\n"));
    assert!(patch.contains("apiKeyEnv: LOCAL_OPENAI_API_KEY\n"));
    assert!(patch.contains("- id: m1\n") && patch.contains("- id: m2\n"));
    assert!(patch.starts_with("# my profile\n- id: llm-pi-ai\n"));

    // A second server under another id coexists with the first.
    let (base2, _rx) = mock_server(r#"{"models":[{"name":"llama3:latest"}]}"#);
    ok(&f.run(&[
        "provider",
        "add",
        "local-openai",
        "--profile",
        "tui",
        "--id",
        "home-gpu",
        "--base-url",
        &base2,
        "--discover",
        "--no-key",
    ]));
    let patch = f.patch();
    assert!(patch.contains("      home-gpu:\n"));
    assert!(patch.contains("apiKeyEnv: HOME_GPU_API_KEY\n"));
    assert!(patch.contains("- id: llama3:latest\n"));
    assert!(patch.contains("      local-openai:\n"));
    assert!(f.creds().contains("HOME_GPU_API_KEY"));

    let list = f.run(&["provider", "list", "--json"]);
    ok(&list);
    let v: Value = serde_json::from_slice(&list.stdout).unwrap();
    let routes = v["profiles"][0]["routes"].as_array().unwrap();
    let find = |id: &str| routes.iter().find(|r| r["id"] == id).unwrap().clone();
    assert_eq!(find("hai")["configured"], false);
    assert_eq!(find("local-openai")["configured"], true);
    assert_eq!(find("local-openai")["models"], 2);
    assert_eq!(find("home-gpu")["configured"], true);
    assert_eq!(find("home-gpu")["key"], "present");
    assert!(!String::from_utf8_lossy(&list.stdout).contains(secret));
}

#[test]
fn invalid_input_is_refused_before_anything_is_written() {
    let f = Fixture::new();
    f.set_patch(PATCH);
    for args in [
        vec!["--base-url", "host:8080/v1"],
        vec!["--base-url", "http://user:pw@host/v1"],
        vec!["--base-url", "http://host/v1 x"],
        vec!["--base-url", "http://host/v1\n"],
        vec!["--base-url", "http://host/v1", "--id", "Home"],
        vec!["--base-url", "http://host/v1", "--id", "1gpu"],
        vec!["--base-url", "http://host/v1", "--id", "a_b"],
        vec!["--base-url", "http://host/v1", "--key-stdin", "--no-key"],
        vec![],
    ] {
        let mut argv = vec![
            "provider",
            "add",
            "local-openai",
            "--profile",
            "tui",
            "--model",
            "m1",
        ];
        argv.extend(args.iter());
        let out = f.run(&argv);
        assert!(!out.status.success(), "{args:?}: {}", text(&out));
        assert_eq!(f.patch(), PATCH, "{args:?}");
        assert!(f.creds().is_empty(), "{args:?}");
    }
    // No models at all: fail without writing.
    let out = f.run(&["provider", "add", "hai", "--profile", "tui"]);
    assert!(!out.status.success());
    assert!(text(&out).contains("no models"));
    assert_eq!(f.patch(), PATCH);
    // hai has a fixed route and needs a key.
    assert!(!f
        .run(&[
            "provider",
            "add",
            "hai",
            "--profile",
            "tui",
            "--model",
            "m",
            "--no-key"
        ])
        .status
        .success());
}

#[test]
fn an_inline_providers_mapping_is_refused_with_the_yaml_to_add() {
    let f = Fixture::new();
    let inline = "- id: llm-pi-ai\n  config:\n    providers: {}\n";
    f.set_patch(inline);
    let out = f.run(&[
        "provider",
        "add",
        "hai",
        "--profile",
        "tui",
        "--model",
        "m1",
    ]);
    assert!(!out.status.success());
    let msg = text(&out);
    assert!(
        msg.contains("add this under llm-pi-ai config providers by hand"),
        "{msg}"
    );
    assert!(
        msg.contains("baseURL: https://hai-api.hcloud.ltd/v1"),
        "{msg}"
    );
    assert_eq!(f.patch(), inline);
}

#[test]
fn auth_reports_the_new_routes_as_ok_or_missing_with_the_key_name() {
    let f = Fixture::new();
    f.set_patch("- id: agent-default-model\n  config:\n    provider: hai\n    model: m1\n");
    ok(&f.run(&[
        "provider",
        "add",
        "hai",
        "--profile",
        "tui",
        "--model",
        "m1",
    ]));
    let out = f.run(&["auth"]);
    ok(&out);
    let s = text(&out);
    assert!(
        s.contains("hai/m1 (key HAI_API_KEY, credential missing"),
        "{s}"
    );
    let out = f.run_with(&["auth"], &[("HAI_API_KEY", "sk-env-only")], b"");
    assert!(
        text(&out).contains("hai/m1 (key HAI_API_KEY, credential ok"),
        "{}",
        text(&out)
    );

    // --no-key stores a placeholder, so the route is connected.
    let f = Fixture::new();
    f.set_patch(
        "- id: agent-default-model\n  config:\n    provider: local-openai\n    model: m1\n",
    );
    ok(&f.run(&[
        "provider",
        "add",
        "local-openai",
        "--profile",
        "tui",
        "--base-url",
        "http://127.0.0.1:1/v1",
        "--model",
        "m1",
        "--no-key",
    ]));
    let s = text(&f.run(&["auth"]));
    assert!(
        s.contains("local-openai/m1 (key LOCAL_OPENAI_API_KEY, credential ok"),
        "{s}"
    );
}

const SARASHINA_BLOCK: &str = "      sarashina:\n        displayName: Sarashina\n        apiKeyEnv: SARASHINA_API_KEY\n        api: openai-completions\n        baseURL: https://api.sarashina.ai/v1\n        compat:\n          supportsStore: false\n          supportsUsageInStreaming: false\n        models:\n          - id: sarashina3-mini\n            name: Sarashina3 mini\n            contextWindow: 128000\n            maxTokens: 8000\n            input: [text]\n          - id: sarashina3-nano\n            name: Sarashina3 nano\n            contextWindow: 128000\n            maxTokens: 8000\n            input: [text]\n";

#[test]
fn sarashina_writes_compat_and_both_models_and_is_idempotent() {
    let f = Fixture::new();
    f.set_patch(PATCH);
    let args = ["provider", "add", "sarashina", "--profile", "tui"];
    let first = f.run(&args);
    ok(&first);
    let want = PATCH.replacen(
        "          - id: x\n",
        &format!("          - id: x\n{SARASHINA_BLOCK}"),
        1,
    );
    assert_eq!(f.patch(), want);
    let second = f.run(&args);
    ok(&second);
    assert_eq!(f.patch(), want);
    assert!(text(&second).contains("already configured"));
    // --replace on identical content is a no-op too.
    let again = f.run(&[
        "provider",
        "add",
        "sarashina",
        "--profile",
        "tui",
        "--replace",
    ]);
    ok(&again);
    assert_eq!(f.patch(), want);
    let list = f.run(&["provider", "list"]);
    ok(&list);
    assert!(text(&list).contains("sarashina"));
}

#[test]
fn sarashina_model_flag_clamps_max_tokens_and_notes_unknown_ids() {
    let f = Fixture::new();
    let out = f.run(&[
        "provider",
        "add",
        "sarashina",
        "--profile",
        "tui",
        "--model",
        "sarashina3-guard",
    ]);
    ok(&out);
    assert!(text(&out).contains("sarashina3-mini"));
    let patch = f.patch();
    assert!(patch.contains("          - id: sarashina3-guard\n            maxTokens: 8000\n"));
    assert!(!patch.contains("sarashina3-nano"));
    assert!(!patch.contains("contextWindow"));
    assert!(patch.contains("        compat:\n          supportsStore: false\n"));
}

#[test]
fn sarashina_refuses_discover_before_writing() {
    let f = Fixture::new();
    f.set_patch(PATCH);
    let out = f.run(&[
        "provider",
        "add",
        "sarashina",
        "--profile",
        "tui",
        "--discover",
    ]);
    assert!(!out.status.success());
    assert!(text(&out).contains("GET /models"));
    assert_eq!(f.patch(), PATCH);
    assert!(f.creds().is_empty());
}

#[test]
fn sarashina_key_from_env_is_stored_but_never_printed() {
    let f = Fixture::new();
    let secret = "sk-sarashina-test-0123456789";
    let envs = [("SARASHINA_API_KEY", secret)];
    let json = f.run_with(
        &["provider", "add", "sarashina", "--profile", "tui", "--json"],
        &envs,
        b"",
    );
    ok(&json);
    assert!(!text(&json).contains(secret));
    assert!(!f.patch().contains(secret));
    assert!(f.creds().contains("SARASHINA_API_KEY"));
    let v: Value = serde_json::from_slice(&json.stdout).unwrap();
    assert_eq!(v["key"], "stored");
    assert_eq!(v["apiKeyEnv"], "SARASHINA_API_KEY");
    assert_eq!(v["models"][0], "sarashina3-mini");
    let plain = f.run_with(
        &[
            "provider",
            "add",
            "sarashina",
            "--profile",
            "tui",
            "--replace",
        ],
        &envs,
        b"",
    );
    ok(&plain);
    assert!(!text(&plain).contains(secret));
}
