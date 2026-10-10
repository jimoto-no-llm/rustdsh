use std::path::PathBuf;
use std::process::Command;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "rdsh-auth-json-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn setup_json_stays_parseable_while_saving_a_key() {
    let fixture = Fixture::new();
    let dsh_home = fixture.0.join("dsh");
    let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
    command
        .args(["setup", "--yes", "--json"])
        .env_clear()
        .env("HOME", &fixture.0)
        .env("USERPROFILE", &fixture.0)
        .env("APPDATA", fixture.0.join("appdata"))
        .env("XDG_CONFIG_HOME", fixture.0.join("config"))
        .env("XDG_DATA_HOME", fixture.0.join("data"))
        .env("DSH_HOME", &dsh_home)
        .env("DEEPSEEK_API_KEY", "synthetic-auth-cli-fixture");
    // Retain only OS locations needed by whoami/icacls, never a real login
    // store or provider environment. The test contacts no provider.
    #[cfg(target_os = "windows")]
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", &system_root);
        command.env("PATH", PathBuf::from(system_root).join("System32"));
    }
    let output = command.output().unwrap();
    assert!(output.status.success(), "{:?}", output);
    let status: serde_json::Value = serde_json::from_slice(&output.stdout)
        .expect("setup --json must emit only a JSON document, including on Windows");
    assert_eq!(status["needed"], false);
    assert_eq!(
        status["persisted_env_keys"],
        serde_json::json!(["DEEPSEEK_API_KEY"])
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("synthetic-auth-cli-fixture"));
    let credentials = std::fs::read_to_string(dsh_home.join(".credentials.yaml")).unwrap();
    assert!(credentials.contains("synthetic-auth-cli-fixture"));
}
