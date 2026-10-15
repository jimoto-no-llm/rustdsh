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

fn setup_json(fixture: &Fixture, envs: &[(&str, &str)], extra: &[&str]) -> Value {
    let mut args = vec!["setup", "--json"];
    args.extend_from_slice(extra);
    let out = fixture.run_with(&args, envs, b"");
    ok(&out);
    serde_json::from_slice(&out.stdout).unwrap()
}

/// What `rdsh auth` says about the profiles' default models.
fn default_state(fixture: &Fixture, envs: &[(&str, &str)]) -> String {
    let out = fixture.run_with(&["auth"], envs, b"");
    ok(&out);
    text(&out)
}

#[test]
fn an_exported_route_key_without_a_route_is_not_a_connection() {
    for key in ["HAI_API_KEY", "LOCAL_OPENAI_API_KEY", "SARASHINA_API_KEY"] {
        let fixture = Fixture::new();
        fixture.set_patch(PATCH);
        let base = setup_json(&fixture, &[], &[]);
        assert_eq!(base["needed"], true);
        let v = setup_json(&fixture, &[(key, "sk-not-real")], &[]);
        assert_eq!(v["needed"], true, "{key}: {v}");
        let shown = default_state(&fixture, &[(key, "sk-not-real")]);
        assert!(shown.contains("credential missing"), "{key}: {shown}");
        // `--yes` does not save it, so nothing makes the profile look connected.
        let v = setup_json(&fixture, &[(key, "sk-not-real")], &["--yes"]);
        assert_eq!(v["needed"], true, "{key}: {v}");
        assert!(v["persisted_env_keys"].as_array().unwrap().is_empty());
        assert!(fixture.creds().is_empty());
    }
}

#[test]
fn a_stored_route_key_without_a_route_is_not_a_connection() {
    let fixture = Fixture::new();
    fixture.set_patch(PATCH);
    fs::write(
        fixture.0.join("dsh/.credentials.yaml"),
        "version: 1\nrefs:\n  HAI_API_KEY: 'sk-not-real'\n",
    )
    .unwrap();
    let v = setup_json(&fixture, &[], &[]);
    assert_eq!(v["needed"], true, "{v}");
    assert!(default_state(&fixture, &[]).contains("credential missing"));
}

#[cfg(unix)]
#[test]
fn the_first_run_banner_is_not_suppressed_by_a_route_key_alone() {
    let fixture = Fixture::new();
    fixture.set_patch(PATCH);
    let banner = |envs: &[(&str, &str)]| {
        let mut all = vec![("RDSH_ORIG_BIN", "/bin/true"), ("LANG", "en_US.UTF-8")];
        all.extend_from_slice(envs);
        let out = fixture.run_with(&["--profile", "tui", "boot"], &all, b"");
        String::from_utf8_lossy(&out.stderr).contains("first-run setup needed")
    };
    assert!(banner(&[]));
    assert!(banner(&[("HAI_API_KEY", "sk-not-real")]));
    // A well-known key still counts.
    assert!(!banner(&[("DEEPSEEK_API_KEY", "sk-not-real")]));
}

#[test]
fn a_route_key_counts_once_the_default_route_uses_it() {
    let fixture = Fixture::new();
    fixture.set_patch(
        "- id: llm-pi-ai\n  config:\n    providers:\n      hai:\n        apiKeyEnv: HAI_API_KEY\n        models:\n          - id: m1\n- id: agent-default-model\n  config:\n    provider: hai\n    model: m1\n",
    );
    let none = setup_json(&fixture, &[], &[]);
    assert_eq!(none["needed"], true);
    let v = setup_json(&fixture, &[("HAI_API_KEY", "sk-not-real")], &[]);
    assert_eq!(v["needed"], false, "{v}");
    let shown = default_state(&fixture, &[("HAI_API_KEY", "sk-not-real")]);
    assert!(shown.contains("credential ok"), "{shown}");
}

#[test]
fn an_unrelated_ok_default_does_not_let_an_unregistered_route_key_skip_setup() {
    let fixture = Fixture::new();
    // The default is openai-codex without apiKeyEnv; its only credential is
    // an un-imported key in the external Codex store (state `ok`).
    fixture.set_patch(
        "- id: llm-pi-ai\n  config:\n    providers:\n      other:\n        apiKeyEnv: OTHER_API_KEY\n        models:\n          - id: x\n- id: agent-default-model\n  config:\n    provider: openai-codex\n    model: gpt-5\n",
    );
    fs::create_dir_all(fixture.0.join("home/.codex")).unwrap();
    fs::write(
        fixture.0.join("home/.codex/auth.json"),
        "{\"OPENAI_API_KEY\": \"sk-not-real\"}",
    )
    .unwrap();
    for key in ["HAI_API_KEY", "LOCAL_OPENAI_API_KEY", "SARASHINA_API_KEY"] {
        let without = setup_json(&fixture, &[], &[]);
        let with = setup_json(&fixture, &[(key, "sk-not-real")], &[]);
        assert_eq!(without["needed"], with["needed"], "{key}: {with}");
        assert_eq!(without["needed"], true, "{key}: {without}");
    }
}

#[test]
fn nested_and_blank_before_colon_definitions_are_handled_safely() {
    // A nested definition: refused, file unchanged.
    let fixture = Fixture::new();
    let nested = "- insert:\n    - id: llm-pi-ai\n      config:\n        providers:\n          other:\n            baseURL: http://o\n  config:\n    unrelated: 1\n";
    fixture.set_patch(nested);
    let out = fixture.run_with(
        &[
            "provider",
            "add",
            "hai",
            "--profile",
            "tui",
            "--model",
            "m1",
        ],
        &[("HAI_API_KEY", "sk-not-real")],
        b"",
    );
    assert_eq!(out.status.code(), Some(1), "{}", text(&out));
    assert!(String::from_utf8_lossy(&out.stderr).contains("by hand"));
    assert_eq!(fixture.patch(), nested);
    // Blanks before the colon: the edit goes into the existing entry.
    let spaced = PATCH.replace("- id: llm-pi-ai", "- id : llm-pi-ai");
    fixture.set_patch(&spaced);
    let out = fixture.run_with(
        &[
            "provider",
            "add",
            "hai",
            "--profile",
            "tui",
            "--model",
            "m1",
        ],
        &[("HAI_API_KEY", "sk-not-real")],
        b"",
    );
    ok(&out);
    let after = fixture.patch();
    assert_eq!(after.matches("llm-pi-ai").count(), 1, "{after}");
    assert!(after.contains("apiKeyEnv: OTHER_API_KEY") && after.contains("      hai:\n"));
}

#[test]
fn quoted_and_commented_ids_and_wide_indents_keep_every_route() {
    for (head, width) in [
        ("- id: llm-pi-ai # custom routes", 2usize),
        ("- id: \"llm-pi-ai\"", 4),
        ("- id: 'llm-pi-ai'", 3),
        ("- id:   llm-pi-ai", 1),
    ] {
        let pad = |n: usize| " ".repeat(n);
        let text = format!(
            "{head}\n  config:\n{}providers:\n{}other:\n{}apiKeyEnv: OTHER_API_KEY\n{}models:\n{}- id: x\n",
            pad(2 + width),
            pad(2 + 2 * width),
            pad(2 + 3 * width),
            pad(2 + 3 * width),
            pad(2 + 4 * width),
        );
        let fixture = Fixture::new();
        fixture.set_patch(&text);
        let out = fixture.run_with(
            &["provider", "add", "sarashina", "--profile", "tui"],
            &[("SARASHINA_API_KEY", "sk-not-real")],
            b"",
        );
        ok(&out);
        let after = fixture.patch();
        assert!(after.starts_with(&text), "{head}");
        assert_eq!(after.matches("llm-pi-ai").count(), 1, "{head}\n{after}");
        let list = fixture.run(&["provider", "list", "--profile", "tui", "--json"]);
        ok(&list);
        let s = String::from_utf8_lossy(&list.stdout).into_owned();
        assert!(s.contains("\"configured\":true"), "{head}: {s}");
    }
}

#[test]
fn an_id_that_cannot_be_read_is_refused_without_writing() {
    let fixture = Fixture::new();
    let text = "- {id: llm-pi-ai, config: {providers: {}}}\n";
    fixture.set_patch(text);
    let out = fixture.run_with(
        &[
            "provider",
            "add",
            "hai",
            "--profile",
            "tui",
            "--model",
            "m1",
        ],
        &[("HAI_API_KEY", "sk-not-real")],
        b"",
    );
    assert_eq!(out.status.code(), Some(1), "{}", text_of(&out));
    assert!(String::from_utf8_lossy(&out.stderr).contains("by hand"));
    assert_eq!(fixture.patch(), text);
}

fn text_of(out: &Output) -> String {
    text(out)
}

#[test]
fn entry_scalar_spellings_preserve_other_routes() {
    for head in [
        "- id: llm-pi-ai # custom routes",
        "- id: 'llm-pi-ai'",
        "- id: \"llm-pi-ai\" # custom routes",
        "- id:   llm-pi-ai  ",
        "- id : llm-pi-ai",
        "- 'id': 'llm-pi-ai'",
        r#"- id: "llm-pi-\u0061i""#,
        "- name: '@deepseek-ai/dsh-llm-pi-ai' # custom routes",
        "- enabled: true\n  id: 'llm-pi-ai' # custom routes",
    ] {
        let f = Fixture::new();
        let original = PATCH.replacen("- id: llm-pi-ai", head, 1).replacen(
            "        apiKeyEnv: OTHER_API_KEY\n",
            "        baseURL: http://127.0.0.1:1/v1\n        apiKeyEnv: OTHER_API_KEY\n",
            1,
        );
        f.set_patch(&original);
        let args = ["provider", "add", "sarashina", "--profile", "tui", "--json"];
        ok(&f.run(&args));
        let want = original.replacen(
            "          - id: x\n",
            &format!("          - id: x\n{SARASHINA_BLOCK}"),
            1,
        );
        assert_eq!(f.patch(), want, "{head}");
        let again = f.run(&args);
        ok(&again);
        let v: Value = serde_json::from_slice(&again.stdout).unwrap();
        assert_eq!(v["change"], "exists", "{head}");
        assert_eq!(f.patch(), want, "{head}");
        let list = f.run(&["provider", "list", "--json"]);
        ok(&list);
        let v: Value = serde_json::from_slice(&list.stdout).unwrap();
        let routes = v["profiles"][0]["routes"].as_array().unwrap();
        assert!(routes.iter().any(|route| route["id"] == "other"), "{head}");
        assert!(
            routes.iter().any(|route| route["id"] == "sarashina"),
            "{head}"
        );
    }
}

#[test]
fn model_continuation_keys_align_with_the_id_at_every_indent_width() {
    for step in [1usize, 2, 3, 4] {
        let f = Fixture::new();
        let at = |depth: usize| " ".repeat(4 + step * depth);
        let original = format!(
            "- id: llm-pi-ai\n  config:\n    providers:\n{}other:\n{}apiKeyEnv: OTHER_API_KEY\n{}models:\n{}- id: x\n- id: agent-default-model\n  config:\n    provider: other\n    model: x\n",
            at(1), at(2), at(2), at(3),
        );
        f.set_patch(&original);
        ok(&f.run(&["provider", "add", "sarashina", "--profile", "tui"]));
        let patch = f.patch();
        let item = at(3);
        let continuation = format!("{item}  ");
        assert!(
            patch.contains(&format!(
                "{item}- id: sarashina3-mini\n{continuation}name: Sarashina3 mini\n{continuation}contextWindow: 128000\n{continuation}maxTokens: 8000\n{continuation}input: [text]\n"
            )),
            "step={step}: {patch}",
        );
        assert!(patch.starts_with(original.split("- id: agent-default-model").next().unwrap()));
        assert!(patch.ends_with(
            "- id: agent-default-model\n  config:\n    provider: other\n    model: x\n"
        ));
        ok(&f.run(&[
            "provider",
            "add",
            "sarashina",
            "--profile",
            "tui",
            "--model",
            "sarashina3-mini",
            "--replace",
            "--dry-run",
        ]));
        assert_eq!(f.patch(), patch);
        ok(&f.run(&[
            "provider",
            "add",
            "sarashina",
            "--profile",
            "tui",
            "--model",
            "sarashina3-mini",
            "--replace",
        ]));
        assert!(f
            .patch()
            .contains(&format!("{continuation}contextWindow: 128000\n")));
        assert!(!f.patch().contains("sarashina3-nano"));
    }
}

#[test]
fn inserted_llm_entries_are_refused_without_profile_or_key_writes() {
    for identifier in [
        "name: '@deepseek-ai/dsh-llm-pi-ai' # inserted plugin",
        "id: llm-pi-ai",
    ] {
        let f = Fixture::new();
        let original = format!(
            "- insert:\n    - {identifier}\n      config:\n        providers:\n          other:\n            apiKeyEnv: OTHER_API_KEY\n            models:\n              - id: x\n"
        );
        f.set_patch(&original);
        for flags in [vec![], vec!["--dry-run"], vec!["--replace"]] {
            let mut args = vec!["provider", "add", "sarashina", "--profile", "tui", "--json"];
            args.extend(flags);
            let out = f.run_with(&args, &[("SARASHINA_API_KEY", "synthetic-env-key")], b"");
            assert_eq!(out.status.code(), Some(1), "{}", text(&out));
            assert!(text(&out).contains("insert"), "{}", text(&out));
            assert!(text(&out).contains("by hand"), "{}", text(&out));
            assert!(!text(&out).contains("synthetic-env-key"));
            assert_eq!(f.patch(), original);
            assert!(f.creds().is_empty());
        }
    }
}

#[test]
fn ambiguous_entry_layouts_are_refused_without_changing_existing_keys() {
    for original in [
        PATCH.replacen("id: llm-pi-ai", "id: &plugin llm-pi-ai", 1),
        PATCH.replacen("id: llm-pi-ai", "id: >-\n    llm-pi-ai", 1),
        format!("{PATCH}{PATCH}"),
        "- {id: llm-pi-ai, config: {providers: {other: {models: [{id: x}]}}}}\n".to_string(),
        "- config:\n    providers:\n      other:\n        models:\n          - id: x\n  id: llm-pi-ai\n".to_string(),
        "- id: previous\n  config: &shared\n    providers:\n      other:\n        models:\n          - id: x\n- id: llm-pi-ai\n  config:\n    <<: *shared\n".to_string(),
        "- id: previous\n  config: &shared\n    id: llm-pi-ai\n    config:\n      providers:\n        other:\n          models:\n            - id: x\n- <<: *shared\n".to_string(),
        "- ? id\n  : llm-pi-ai\n  config:\n    providers:\n      other:\n        models:\n          - id: x\n".to_string(),
        "- insert:\n    - {id: llm-pi-ai, config: {providers: {other: {models: [{id: x}]}}}}\n".to_string(),
        "- insert:\n    - name: unrelated-plugin\n      config: &shared\n        id: llm-pi-ai\n    - *shared\n".to_string(),
        "- insert:\n    - ? id\n      : llm-pi-ai\n      config:\n        providers:\n          other:\n            models:\n              - id: x\n".to_string(),
        "- id: llm-pi-ai\n  config:\n    providers:\n      - id: other\n        models:\n          - id: x\n".to_string(),
        "- id: llm-pi-ai\n  config:\n    providers:\n    - id: other\n      models:\n        - id: x\n".to_string(),
        "- id: llm-pi-ai\n  config:\n    - providers:\n        other:\n          models:\n            - id: x\n".to_string(),
        "- id: llm-pi-ai\n  config:\n  - providers:\n      other:\n        models:\n          - id: x\n".to_string(),
    ] {
        let f = Fixture::new();
        f.set_patch(&original);
        let credentials = "version: 1\nrefs:\n  LOCAL_OPENAI_API_KEY: synthetic-existing-key\n";
        fs::write(f.0.join("dsh/.credentials.yaml"), credentials).unwrap();
        let out = f.run_with(
            &["provider", "add", "sarashina", "--profile", "tui", "--key-stdin"],
            &[],
            b"synthetic-new-key\n",
        );
        assert_eq!(out.status.code(), Some(1), "{}", text(&out));
        assert!(text(&out).contains("by hand"), "{}", text(&out));
        assert!(!text(&out).contains("synthetic-new-key"));
        assert_eq!(f.patch(), original);
        assert_eq!(f.creds(), credentials);
    }
}

#[test]
fn escaped_identifiers_and_mapping_keys_keep_supported_route_operations() {
    let report = |out: Output| -> Value {
        ok(&out);
        serde_json::from_slice(&out.stdout).unwrap()
    };
    for original in [
        PATCH.replacen("id: llm-pi-ai", r#"id: "llm-pi-\x61i""#, 1),
        PATCH.replacen("id: llm-pi-ai", r#""\u0069d": llm-pi-ai"#, 1),
        PATCH.replacen("  config:", r#"  "\u0063onfig":"#, 1),
        PATCH.replacen("    providers:", r#"    "\u0070roviders":"#, 1),
    ] {
        let f = Fixture::new();
        f.set_patch(&original);
        let args = ["provider", "add", "sarashina", "--profile", "tui", "--json"];
        assert_eq!(report(f.run(&args))["change"], "added");
        let written = f.patch();
        assert!(written.contains("      other:\n"));
        assert!(written.contains("      sarashina:\n"));
        assert!(written.contains("    provider: other\n    model: x\n"));
        assert_eq!(report(f.run(&args))["change"], "exists");
        assert_eq!(f.patch(), written);
        assert!(!f.0.join("dsh/.credentials.yaml").exists());
    }
    let f = Fixture::new();
    let original = PATCH.replacen("      other:", r#"      "sarashi\u006ea":"#, 1);
    f.set_patch(&original);
    let args = ["provider", "add", "sarashina", "--profile", "tui", "--json"];
    assert_eq!(report(f.run(&args))["change"], "exists");
    assert_eq!(f.patch(), original);
    let mut replace = args.to_vec();
    replace.push("--replace");
    let mut dry = replace.clone();
    dry.push("--dry-run");
    assert_eq!(report(f.run(&dry))["change"], "replaced");
    assert_eq!(f.patch(), original);
    assert_eq!(report(f.run(&replace))["change"], "replaced");
    let written = f.patch();
    assert_eq!(report(f.run(&replace))["change"], "unchanged");
    assert_eq!(f.patch(), written);
    assert!(!f.0.join("dsh/.credentials.yaml").exists());
}

#[test]
fn tagged_keys_and_duplicate_entry_keys_are_refused_before_writes() {
    for original in [
        "- id: unrelated\n  config:\n    saved: &target\n      id: llm-pi-ai\n      config:\n        providers:\n          old:\n            models: [keep]\n- disabled: false\n  !!merge '<<': *target\n".to_string(),
        "- id: llm-pi-ai\n  config:\n    providers:\n      old:\n        models: [keep]\n  config:\n    providers:\n      replacement:\n        models: [retained]\n".to_string(),
        "- id: llm-pi-ai\n  id: unrelated\n  config:\n    providers:\n      old:\n        models: [keep]\n".to_string(),
        "- name: '@deepseek-ai/dsh-llm-pi-ai'\n  name: unrelated\n  config:\n    providers:\n      old:\n        models: [keep]\n".to_string(),
        PATCH.replacen("id: llm-pi-ai", "&entry-key id: llm-pi-ai", 1),
        PATCH.replacen("  config:", "  !!str config:", 1),
        PATCH.replacen("    providers:", "    !!str providers:", 1),
        PATCH.replacen("      other:", "      !!str sarashina:", 1),
        "- id: unrelated\n  config:\n    key: &id-key id\n- *id-key : llm-pi-ai\n  config:\n    providers:\n      old:\n        models: [keep]\n".to_string(),
        "- id: llm-pi-ai\n  'id': unrelated\n  config:\n    providers:\n      old:\n        models: [keep]\n".to_string(),
    ] {
        let f = Fixture::new();
        f.set_patch(&original);
        let credentials = "version: 1\nrefs:\n  LOCAL_OPENAI_API_KEY: synthetic-existing-key\n";
        fs::write(f.0.join("dsh/.credentials.yaml"), credentials).unwrap();
        for flags in [vec![], vec!["--dry-run"], vec!["--replace"]] {
            let mut args = vec![
                "provider", "add", "sarashina", "--profile", "tui", "--key-stdin",
            ];
            args.extend(flags);
            let out = f.run_with(&args, &[], b"synthetic-new-key\n");
            assert_eq!(out.status.code(), Some(1), "{}", text(&out));
            assert!(text(&out).contains("by hand"), "{}", text(&out));
            assert!(!text(&out).contains("synthetic-new-key"));
            assert_eq!(f.patch(), original);
            assert_eq!(f.creds(), credentials);
        }
    }
}

#[test]
fn unrelated_insert_and_nested_names_are_kept_without_becoming_the_target() {
    for original in [
        "- insert:\n    - id: llm-muse-code-subscription\n      name: /fixture/muse/index.js\n      config:\n        museCommand: /fixture/muse\n",
        "- id: unrelated\n  config:\n    name: '@deepseek-ai/dsh-llm-pi-ai'\n",
        "- insert:\n    - id: unrelated-plugin\n      name: /fixture/unrelated/index.js\n      config:\n        models:\n          - id: llm-pi-ai\n",
        "- insert:\n    - id: unrelated-plugin\n      name: /fixture/unrelated/index.js\n      config:\n        name: '@deepseek-ai/dsh-llm-pi-ai'\n",
    ] {
        let f = Fixture::new();
        f.set_patch(original);
        let args = ["provider", "add", "sarashina", "--profile", "tui", "--json"];
        ok(&f.run(&args));
        let patch = f.patch();
        assert!(patch.starts_with(original));
        assert!(patch[original.len()..].starts_with("- id: llm-pi-ai\n  config:\n    providers:\n"));
        let again = f.run(&args);
        ok(&again);
        let v: Value = serde_json::from_slice(&again.stdout).unwrap();
        assert_eq!(v["change"], "exists");
        assert_eq!(f.patch(), patch);
    }
}

#[test]
fn unicode_whitespace_is_part_of_the_plugin_identifier() {
    let f = Fixture::new();
    let original = PATCH.replacen("id: llm-pi-ai", "id: \u{a0}llm-pi-ai\u{a0}", 1);
    f.set_patch(&original);
    let args = ["provider", "add", "sarashina", "--profile", "tui", "--json"];
    ok(&f.run(&args));
    let patch = f.patch();
    assert!(patch.starts_with(&original), "{patch}");
    assert!(patch[original.len()..].starts_with("- id: llm-pi-ai\n"));
    ok(&f.run(&args));
    assert_eq!(f.patch(), patch);
}

#[test]
fn block_scalar_prompts_are_preserved_as_text() {
    for style in ["|", "|-", ">", ">+", "|2-", ">+2", "|1"] {
        for insert in [false, true] {
            let f = Fixture::new();
            let (entry, indent) = if insert {
                (
                    "- insert:\n    - id: unrelated-plugin\n      config:\n",
                    "        ",
                )
            } else {
                ("- id: unrelated-plugin\n  config:\n", "    ")
            };
            let original = format!(
                "{PATCH}{entry}{indent}prompt: {style}\n{indent}  <<: this is ordinary prompt text\n{indent}  \"\\u0070roviders\": ordinary prompt text\n{indent}  id: llm-pi-ai\n"
            );
            f.set_patch(&original);
            let args = ["provider", "add", "sarashina", "--profile", "tui", "--json"];
            ok(&f.run(&args));
            let want = original.replacen(
                "          - id: x\n",
                &format!("          - id: x\n{SARASHINA_BLOCK}"),
                1,
            );
            assert_eq!(f.patch(), want, "style={style}, insert={insert}");
            ok(&f.run(&args));
            assert_eq!(f.patch(), want);
        }
        let f = Fixture::new();
        let original = format!(
            "- id: llm-pi-ai\n  config:\n    prompt: {style}\n      # this is ordinary prompt text\n\n"
        );
        f.set_patch(&original);
        ok(&f.run(&["provider", "add", "sarashina", "--profile", "tui"]));
        assert!(
            f.patch().starts_with(&original),
            "style={style}: {}",
            f.patch()
        );
    }
}

#[test]
fn sequence_block_scalar_prompts_are_preserved_as_text() {
    for style in ["|", "|-", ">", ">+", "|2-", ">+2", "|1"] {
        for insert in [false, true] {
            let f = Fixture::new();
            let (entry, indent) = if insert {
                (
                    "- insert:\n    - id: unrelated-plugin\n      config:\n",
                    "        ",
                )
            } else {
                ("- id: unrelated-plugin\n  config:\n", "    ")
            };
            let original = format!(
                "{PATCH}{entry}{indent}prompts:\n{indent}  - {style}\n{indent}    <<: ordinary prompt text\n{indent}    id: llm-pi-ai\n{indent}    config:\n{indent}    providers:\n{indent}    \"\\u0070roviders\": ordinary prompt text\n{indent}  - {style}\n{indent}    # this is ordinary prompt text\n\n"
            );
            f.set_patch(&original);
            let args = ["provider", "add", "sarashina", "--profile", "tui", "--json"];
            ok(&f.run(&args));
            let want = original.replacen(
                "          - id: x\n",
                &format!("          - id: x\n{SARASHINA_BLOCK}"),
                1,
            );
            assert_eq!(f.patch(), want, "style={style}, insert={insert}");
            ok(&f.run(&args));
            assert_eq!(f.patch(), want);
        }
        for body in ["      # this is ordinary prompt text\n\n", "\n\n"] {
            let f = Fixture::new();
            let original =
                format!("- id: llm-pi-ai\n  config:\n    prompts:\n    - {style}\n{body}");
            f.set_patch(&original);
            ok(&f.run(&["provider", "add", "sarashina", "--profile", "tui"]));
            assert!(
                f.patch().starts_with(&original),
                "style={style}: {}",
                f.patch()
            );
        }
    }
}
#[test]
fn duplicate_nested_keys_and_scalar_entries_are_refused_before_writes() {
    for original in [
        PATCH.replace("        apiKeyEnv: OTHER_API_KEY", "        baseURL: http://127.0.0.1:1/v1\n        baseURL: http://127.0.0.1:2/v1\n        apiKeyEnv: OTHER_API_KEY"),
        PATCH.replace("          - id: x", "          - id: x\n            name: first\n            name: last"),
        "- literal-plugin\n".to_string(),
        "- insert:\n    - literal-plugin\n".to_string(),
    ] {
        let fixture = Fixture::new();
        fixture.set_patch(&original);
        let credentials = "version: 1\nrefs:\n  LOCAL_OPENAI_API_KEY: synthetic-existing-key\n";
        fs::write(fixture.0.join("dsh/.credentials.yaml"), credentials).unwrap();
        for flags in [vec![], vec!["--dry-run"], vec!["--replace"]] {
            let mut args = vec!["provider", "add", "sarashina", "--profile", "tui", "--key-stdin"];
            args.extend(flags);
            let out = fixture.run_with(&args, &[], b"synthetic-new-key\n");
            assert_eq!(out.status.code(), Some(1), "{}", text(&out));
            assert!(text(&out).contains("by hand"), "{}", text(&out));
            assert_eq!(fixture.patch(), original);
            assert_eq!(fixture.creds(), credentials);
        }
    }
}

#[test]
fn unicode_whitespace_in_plain_mapping_keys_is_refused_before_writes() {
    for whitespace in ['\u{a0}', '\u{2003}'] {
        let fixture = Fixture::new();
        let original = PATCH.replacen(
            "- id: llm-pi-ai",
            &format!("- {whitespace}id: llm-pi-ai"),
            1,
        );
        fixture.set_patch(&original);
        let credentials = "version: 1\nrefs:\n  LOCAL_OPENAI_API_KEY: synthetic-existing-key\n";
        fs::write(fixture.0.join("dsh/.credentials.yaml"), credentials).unwrap();
        for flags in [vec![], vec!["--dry-run"], vec!["--replace"]] {
            let mut args = vec![
                "provider",
                "add",
                "sarashina",
                "--profile",
                "tui",
                "--key-stdin",
            ];
            args.extend(flags);
            let out = fixture.run_with(&args, &[], b"synthetic-new-key\n");
            assert_eq!(out.status.code(), Some(1), "{}", text(&out));
            assert!(text(&out).contains("by hand"), "{}", text(&out));
            assert_eq!(fixture.patch(), original);
            assert_eq!(fixture.creds(), credentials);
        }
        let text =
            format!("- id: unrelated\n  config:\n    prompt: |\n      {whitespace}id: llm-pi-ai\n");
        fixture.set_patch(&text);
        ok(&fixture.run(&["provider", "add", "sarashina", "--profile", "tui"]));
        assert!(fixture.patch().starts_with(&text));
    }
}

#[test]
fn list_keeps_routes_when_other_plugins_use_unsupported_write_forms() {
    for settings in [
        "    labels: {name: retained, value: unchanged}\n",
        "    origin: &label retained\n    copied: *label\n",
        "    note: !!str retained\n",
        "    note: \"first\n      continuation\"\n",
    ] {
        let fixture = Fixture::new();
        let routes = PATCH.replacen(
            "      other:\n",
            "      hai:\n        baseURL: http://127.0.0.1:2/v1\n        models:\n          - id: existing-hai\n      other:\n        baseURL: http://127.0.0.1:1/v1\n",
            1,
        );
        let original = format!("{routes}- id: unrelated\n  config:\n{settings}");
        fixture.set_patch(&original);
        let credentials = "version: 1\nrefs:\n  OTHER_API_KEY: test\n";
        fs::write(fixture.0.join("dsh/.credentials.yaml"), credentials).unwrap();

        let output = fixture.run(&["provider", "list", "--json"]);
        ok(&output);
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        let listed = value["profiles"][0]["routes"].as_array().unwrap();
        for (id, url) in [
            ("other", "http://127.0.0.1:1/v1"),
            ("hai", "http://127.0.0.1:2/v1"),
        ] {
            let route = listed.iter().find(|route| route["id"] == id);
            assert!(route.is_some(), "{id} is missing for {settings}: {value}");
            let route = route.unwrap();
            assert_eq!(route["configured"], true, "{settings}: {value}");
            assert_eq!(route["models"], 1);
            assert_eq!(route["baseURL"], url);
        }
        let output = fixture.run(&["provider", "list"]);
        ok(&output);
        assert!(text(&output).contains("other"), "{}", text(&output));
        assert!(text(&output).contains("OTHER_API_KEY"));
        assert_eq!(fixture.patch(), original);
        assert_eq!(fixture.creds(), credentials);

        for flags in [vec![], vec!["--dry-run"], vec!["--replace"]] {
            let mut args = vec![
                "provider",
                "add",
                "sarashina",
                "--profile",
                "tui",
                "--key-stdin",
            ];
            args.extend(flags);
            let output = fixture.run_with(&args, &[], b"replacement\n");
            assert_eq!(output.status.code(), Some(1), "{}", text(&output));
            assert!(text(&output).contains("by hand"), "{}", text(&output));
            assert_eq!(fixture.patch(), original);
            assert_eq!(fixture.creds(), credentials);
        }
    }
}

#[test]
fn appending_after_unterminated_block_scalars_refuses_before_writes() {
    for style in [
        "|",
        "|+",
        ">",
        ">+",
        "|2",
        "|2+",
        "|+2",
        ">2",
        ">2+",
        ">+2",
        "| # note-with-dash",
        "|+ # note-with-dash",
        "> # note-with-dash",
        ">+ # note-with-dash",
    ] {
        for sequence in [false, true] {
            let original = if sequence {
                format!(
                    "- id: unrelated\n  config:\n    prompts:\n    - {style}\n      say llm-pi-ai"
                )
            } else {
                format!("- id: unrelated\n  config:\n    prompt: {style}\n      say llm-pi-ai")
            };
            for crlf in [false, true] {
                let original = if crlf {
                    original.replace('\n', "\r\n")
                } else {
                    original.clone()
                };
                let fixture = Fixture::new();
                fixture.set_patch(&original);
                let credentials = "version: 1\nrefs:\n  OTHER_API_KEY: test\n";
                fs::write(fixture.0.join("dsh/.credentials.yaml"), credentials).unwrap();
                for flags in [vec![], vec!["--dry-run"], vec!["--replace"]] {
                    let mut args = vec![
                        "provider",
                        "add",
                        "sarashina",
                        "--profile",
                        "tui",
                        "--key-stdin",
                    ];
                    args.extend(flags);
                    let output = fixture.run_with(&args, &[], b"replacement\n");
                    assert_eq!(output.status.code(), Some(1), "{}", text(&output));
                    assert!(text(&output).contains("by hand"), "{}", text(&output));
                    assert_eq!(fixture.patch(), original);
                    assert_eq!(fixture.creds(), credentials);
                }
            }
        }
    }
}

#[test]
fn final_scalar_boundaries_that_preserve_values_keep_supported_operations() {
    let mut endings = Vec::new();
    for style in ["|-", ">-", "|2-", "|-2", ">2-", ">-2"] {
        endings.push(format!(
            "- id: unrelated\n  config:\n    prompt: {style}\n      say llm-pi-ai"
        ));
    }
    for style in ["|", "|+", ">", ">+"] {
        endings.push(format!("- id: unrelated\n  config:\n    prompt: {style}"));
        endings.push(format!("- id: unrelated\n  config:\n    prompt: {style}\n"));
        for end in ["\n", "\n\n"] {
            endings.push(format!(
                "- id: unrelated\n  config:\n    prompt: {style}\n      say llm-pi-ai{end}"
            ));
        }
    }
    for style in ["|", ">"] {
        endings.push(format!(
            "- id: unrelated\n  config:\n    prompt: {style}\n      "
        ));
        endings.push(format!(
            "- id: unrelated\n  config:\n    prompt: {style}\n      say llm-pi-ai\n      "
        ));
    }
    for original in endings {
        let fixture = Fixture::new();
        fixture.set_patch(&original);
        let args = ["provider", "add", "sarashina", "--profile", "tui", "--json"];
        let mut dry = args.to_vec();
        dry.push("--dry-run");
        ok(&fixture.run(&dry));
        assert_eq!(fixture.patch(), original);
        ok(&fixture.run(&args));
        assert!(fixture.patch().starts_with(&original));
        let written = fixture.patch();
        ok(&fixture.run(&args));
        assert_eq!(fixture.patch(), written);
    }

    for style in ["|", "|+", ">", ">+"] {
        let fixture = Fixture::new();
        let tail = format!("- id: unrelated\n  config:\n    prompt: {style}\n      say llm-pi-ai");
        fixture.set_patch(&format!("{PATCH}{tail}"));
        let args = ["provider", "add", "sarashina", "--profile", "tui", "--json"];
        ok(&fixture.run(&args));
        assert!(fixture.patch().ends_with(&tail));
        let mut replace = args.to_vec();
        replace.extend(["--replace", "--model", "sarashina3-mini"]);
        let written = fixture.patch();
        let mut dry = replace.clone();
        dry.push("--dry-run");
        ok(&fixture.run(&dry));
        assert_eq!(fixture.patch(), written);
        ok(&fixture.run(&replace));
        assert!(fixture.patch().ends_with(&tail));
        let written = fixture.patch();
        ok(&fixture.run(&replace));
        assert_eq!(fixture.patch(), written);
    }
}

fn entries_ending_in_scalar(style: &str, ending: &str) -> [String; 3] {
    [
        format!("- id: llm-pi-ai\n  note: {style}\n    say llm-pi-ai{ending}"),
        format!("- id: llm-pi-ai\n  config:\n    note: {style}\n      say llm-pi-ai{ending}"),
        format!("- id: llm-pi-ai\n  config:\n    providers:\n      other:\n        baseURL: http://127.0.0.1:1/v1\n        apiKeyEnv: OTHER_API_KEY\n        models:\n          - id: keep\n        note: {style}\n          say llm-pi-ai{ending}"),
    ]
}

#[test]
fn every_container_append_refuses_to_change_an_unterminated_scalar() {
    for style in ["|", "|+", ">", ">+", "| # note-with-dash", ">+2"] {
        for original in entries_ending_in_scalar(style, "") {
            for crlf in [false, true] {
                let original = if crlf {
                    original.replace('\n', "\r\n")
                } else {
                    original.clone()
                };
                let fixture = Fixture::new();
                fixture.set_patch(&original);
                let credentials = "version: 1\nrefs:\n  OTHER_API_KEY: test\n";
                fs::write(fixture.0.join("dsh/.credentials.yaml"), credentials).unwrap();
                for flags in [vec![], vec!["--dry-run"], vec!["--replace"]] {
                    let mut args = vec![
                        "provider",
                        "add",
                        "sarashina",
                        "--profile",
                        "tui",
                        "--key-stdin",
                    ];
                    args.extend(flags);
                    let output = fixture.run_with(&args, &[], b"replacement\n");
                    assert_eq!(output.status.code(), Some(1), "{}", text(&output));
                    assert!(text(&output).contains("by hand"), "{}", text(&output));
                    assert_eq!(fixture.patch(), original);
                    assert_eq!(fixture.creds(), credentials);
                }
            }
        }
    }
}

#[test]
fn safe_container_appends_and_explicit_route_replacement_still_work() {
    let mut originals = Vec::new();
    for style in ["|-", ">-", "|2-", "|-2", ">2-", ">-2"] {
        originals.extend(entries_ending_in_scalar(style, ""));
    }
    for style in ["|", "|+", ">", ">+"] {
        for ending in ["\n", "\n\n"] {
            originals.extend(entries_ending_in_scalar(style, ending));
        }
    }
    for original in originals {
        let fixture = Fixture::new();
        fixture.set_patch(&original);
        let args = ["provider", "add", "sarashina", "--profile", "tui", "--json"];
        let mut dry = args.to_vec();
        dry.push("--dry-run");
        ok(&fixture.run(&dry));
        assert_eq!(fixture.patch(), original);
        ok(&fixture.run(&args));
        assert!(fixture.patch().starts_with(&original));
        let written = fixture.patch();
        ok(&fixture.run(&args));
        assert_eq!(fixture.patch(), written);
    }

    for style in ["|", "|+", ">", ">+"] {
        let fixture = Fixture::new();
        let original = format!(
            "- id: llm-pi-ai\n  config:\n    providers:\n      sarashina:\n        baseURL: http://127.0.0.1:1/v1\n        models:\n          - id: old\n        note: {style}\n          replaced intentionally"
        );
        fixture.set_patch(&original);
        let args = [
            "provider",
            "add",
            "sarashina",
            "--profile",
            "tui",
            "--replace",
            "--json",
        ];
        let mut dry = args.to_vec();
        dry.push("--dry-run");
        ok(&fixture.run(&dry));
        assert_eq!(fixture.patch(), original);
        ok(&fixture.run(&args));
        assert!(!fixture.patch().contains("replaced intentionally"));
    }
}

fn entries_with_scalar_whitespace(style: &str, shape: &str) -> Vec<String> {
    [
        ("- id: unrelated\n  config:\n    note: ", 4),
        ("- id: llm-pi-ai\n  note: ", 2),
        ("- id: llm-pi-ai\n  config:\n    note: ", 4),
        ("- id: llm-pi-ai\n  config:\n    providers:\n      other:\n        baseURL: http://127.0.0.1:1/v1\n        models:\n          - id: keep\n        note: ", 8),
    ]
    .into_iter()
    .map(|(header, parent)| {
        let step = style.chars().find_map(|c| c.to_digit(10)).unwrap_or(2) as usize;
        let padding = " ".repeat(parent + step);
        let content = match shape {
            "tab" => format!("{padding}\t"),
            "extra" => format!("{padding}kept\n{padding}  "),
            "empty" => padding.clone(),
            "blank" => format!("{padding}kept\n{padding}"),
            _ => unreachable!(),
        };
        format!("{header}{style} # comment-with-dash\n{content}")
    })
    .collect()
}

#[test]
fn meaningful_scalar_whitespace_is_not_an_empty_final_line() {
    for style in ["|", ">", "|2", ">2", "|9"] {
        for shape in ["tab", "extra"] {
            for original in entries_with_scalar_whitespace(style, shape) {
                for crlf in [false, true] {
                    let original = if crlf {
                        original.replace('\n', "\r\n")
                    } else {
                        original.clone()
                    };
                    let fixture = Fixture::new();
                    fixture.set_patch(&original);
                    let credentials = "version: 1\nrefs:\n  OTHER_API_KEY: test\n";
                    fs::write(fixture.0.join("dsh/.credentials.yaml"), credentials).unwrap();
                    for flags in [vec![], vec!["--dry-run"], vec!["--replace"]] {
                        let mut args = vec![
                            "provider",
                            "add",
                            "sarashina",
                            "--profile",
                            "tui",
                            "--key-stdin",
                        ];
                        args.extend(flags);
                        let output = fixture.run_with(&args, &[], b"replacement\n");
                        assert_eq!(output.status.code(), Some(1), "{}", text(&output));
                        assert!(text(&output).contains("by hand"), "{}", text(&output));
                        assert_eq!(fixture.patch(), original);
                        assert_eq!(fixture.creds(), credentials);
                    }
                }
            }
        }
    }
}

#[test]
fn empty_scalar_lines_and_stripped_whitespace_still_allow_append() {
    for style in ["|", ">", "|2", ">2", "|-", ">-", "|2-", "|-2", ">2-", ">-2"] {
        let shapes = if style.contains('-') {
            vec!["empty", "blank", "tab", "extra"]
        } else {
            vec!["empty", "blank"]
        };
        for shape in shapes {
            for original in entries_with_scalar_whitespace(style, shape) {
                let fixture = Fixture::new();
                fixture.set_patch(&original);
                let args = ["provider", "add", "sarashina", "--profile", "tui", "--json"];
                let mut dry = args.to_vec();
                dry.push("--dry-run");
                ok(&fixture.run(&dry));
                assert_eq!(fixture.patch(), original);
                ok(&fixture.run(&args));
                assert!(fixture.patch().starts_with(&original));
                let written = fixture.patch();
                ok(&fixture.run(&args));
                assert_eq!(fixture.patch(), written);
            }
        }
    }
}
