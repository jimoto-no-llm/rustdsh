use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new(raw: &str) -> Self {
        let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("rdsh-settings-cli-{}-{id}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("rdsh.json"), raw).unwrap();
        Self(path)
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_rdsh"))
            .args(args)
            .env("DSH_HOME", &self.0)
            .output()
            .unwrap()
    }

    fn read(&self) -> String {
        std::fs::read_to_string(self.0.join("rdsh.json")).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn force_init_recovers_corrupt_settings_and_loads_defaults() {
    for raw in ["{broken", "", "null", "[]", "false", "42", "\"text\""] {
        let fixture = Fixture::new(raw);
        let output = fixture.run(&["settings", "init", "--force"]);
        assert!(output.status.success(), "{:?}", output);
        let settings: serde_json::Value = serde_json::from_str(&fixture.read()).unwrap();
        assert_eq!(settings["schema"], 1);
        assert_eq!(settings["extras"]["enable"], serde_json::json!([]));
        assert!(fixture
            .run(&["settings", "show", "--json"])
            .status
            .success());
    }
}

#[test]
fn ordinary_commands_do_not_overwrite_corrupt_settings() {
    for args in [
        vec!["settings", "init"],
        vec!["settings", "set", "search.max", "42"],
        vec!["guard"],
    ] {
        for raw in ["{broken", "", "null", "[]", "false", "42", "\"text\""] {
            let fixture = Fixture::new(raw);
            assert!(
                !fixture.run(&args).status.success(),
                "accepted {raw} for {args:?}"
            );
            assert_eq!(fixture.read(), raw);
        }
    }
}

#[test]
fn init_without_force_preserves_existing_valid_settings() {
    let raw = r#"{"guard":{"deny":["danger*"]}}"#;
    let fixture = Fixture::new(raw);
    assert_eq!(fixture.run(&["settings", "init"]).status.code(), Some(2));
    assert_eq!(fixture.read(), raw);
}
