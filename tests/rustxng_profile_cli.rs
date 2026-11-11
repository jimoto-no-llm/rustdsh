//! Persistent profile selection through the public settings CLI; no sidecar/network.
use std::{
    path::PathBuf,
    process::{Command, Output},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("rdsh-rustxng-profile-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("rdsh.json"), "{}").unwrap();
        Self(root)
    }
    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_rdsh"))
            .args(args)
            .env_clear()
            .envs(std::env::vars_os().filter(|(name, _)| {
                [
                    "PATH",
                    "SystemRoot",
                    "WINDIR",
                    "COMSPEC",
                    "PATHEXT",
                    "TEMP",
                    "TMP",
                ]
                .iter()
                .any(|key| name.to_string_lossy().eq_ignore_ascii_case(key))
            }))
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("DSH_HOME", &self.0)
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env("XDG_DATA_HOME", self.0.join("data"))
            .env("LANG", "C")
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
fn profile_settings_persist_and_invalid_changes_leave_the_document_untouched() {
    let fixture = Fixture::new();
    for profile in ["full", "clean", "standard"] {
        let output = fixture.run(&["settings", "set", "search.rustxng_profile", profile]);
        assert!(output.status.success(), "{output:?}");
        let value: serde_json::Value = serde_json::from_str(&fixture.read()).unwrap();
        assert_eq!(value["search"]["rustxng_profile"], profile);
    }
    let previous = fixture.read();
    for invalid in ["custom", "FULL", "", "full --bind 0.0.0.0"] {
        let output = fixture.run(&["settings", "set", "search.rustxng_profile", invalid]);
        assert!(!output.status.success(), "{output:?}");
        assert_eq!(fixture.read(), previous);
    }
    assert!(fixture
        .run(&["settings", "set", "search.rustxng_profile", "full"])
        .status
        .success());
    assert!(fixture
        .run(&["settings", "unset", "search.rustxng_profile"])
        .status
        .success());
    let value: serde_json::Value = serde_json::from_str(&fixture.read()).unwrap();
    assert_eq!(value["search"]["rustxng_profile"], "standard");
}
