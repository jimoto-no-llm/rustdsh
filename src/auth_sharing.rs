//! Explicit, source-and-provider scoped consent for persistent credential copies.
//! Missing or invalid policy never enables the legacy "import everything" path.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const POLICY_NAME: &str = "rdsh-auth-sharing.json";
const LOCK_NAME: &str = ".rdsh-auth-sharing.lock";

#[derive(clap::Args, Debug)]
pub struct AuthArgs {
    /// Copy only the selected credentials into the DSH credential store
    #[arg(long = "import")]
    pub import: bool,
    #[arg(long)]
    pub json: bool,
    /// Import this provider once without enabling future credential copies
    #[arg(long)]
    pub provider: Option<String>,
    /// Limit a one-time import to this credential source
    #[arg(long)]
    pub source: Option<String>,
    /// Import only this named API-key reference once
    #[arg(long = "ref")]
    pub key_ref: Option<String>,
    /// Allow future imports of one SOURCE:CREDENTIAL (repeatable)
    #[arg(long, value_name = "SOURCE:CREDENTIAL")]
    pub select: Vec<String>,
    /// Stop future imports; existing DSH copies and provider grants are retained
    #[arg(long, value_name = "SOURCE:CREDENTIAL")]
    pub unselect: Vec<String>,
}

#[derive(Default)]
pub struct SharingPolicy {
    pub selected: BTreeSet<String>,
}

fn valid_selector(value: &str) -> bool {
    let Some((source, credential)) = value.split_once(':') else {
        return false;
    };
    match source {
        "codex" => matches!(credential, "openai-codex" | "OPENAI_API_KEY"),
        "env" => matches!(
            credential,
            "DEEPSEEK_API_KEY" | "OPENAI_API_KEY" | "ANTHROPIC_API_KEY"
        ),
        "opencode" => {
            credential.len() <= 128
                && credential.starts_with(|c: char| c.is_ascii_lowercase())
                && credential
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
                // OpenCode's openai entry maps to DSH's openai-codex record.
                && credential != "openai"
        }
        _ => false,
    }
}

pub fn policy_path(root: &str) -> PathBuf {
    Path::new(root).join(POLICY_NAME)
}

impl SharingPolicy {
    pub fn load(root: &str) -> anyhow::Result<Self> {
        let path = policy_path(root);
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(_) => {
                anyhow::bail!("credential sharing policy is unreadable; imports are disabled")
            }
        };
        anyhow::ensure!(
            bytes.len() <= 65536,
            "credential sharing policy is oversized; imports are disabled"
        );
        // Do not include parser errors or policy contents in diagnostics.
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
            anyhow::anyhow!("invalid credential sharing policy; imports are disabled")
        })?;
        let obj = value.as_object().ok_or_else(|| {
            anyhow::anyhow!("invalid credential sharing policy; imports are disabled")
        })?;
        anyhow::ensure!(
            obj.len() == 2 && obj.get("version").and_then(|v| v.as_u64()) == Some(1),
            "unsupported credential sharing policy; imports are disabled"
        );
        let entries = obj
            .get("selected")
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                anyhow::anyhow!("invalid credential sharing selection; imports are disabled")
            })?;
        anyhow::ensure!(
            entries.len() <= 256,
            "credential sharing selection is oversized; imports are disabled"
        );
        let mut policy = Self::default();
        for entry in entries {
            let selector = entry
                .as_str()
                .filter(|s| valid_selector(s))
                .ok_or_else(|| {
                    anyhow::anyhow!("invalid credential sharing selector; imports are disabled")
                })?;
            anyhow::ensure!(
                policy.selected.insert(selector.to_string()),
                "duplicate credential sharing selector; imports are disabled"
            );
        }
        Ok(policy)
    }

    pub fn allows(&self, source: &str, credential: &str) -> bool {
        self.selected.contains(&format!("{source}:{credential}"))
    }

    pub fn change(&mut self, select: &[String], unselect: &[String]) -> anyhow::Result<()> {
        for selector in select.iter().chain(unselect) {
            anyhow::ensure!(
                valid_selector(selector),
                "expected a supported SOURCE:CREDENTIAL selector; run rdsh auth for the inventory"
            );
        }
        anyhow::ensure!(
            !select.iter().any(|s| unselect.contains(s)),
            "cannot select and unselect the same credential in one command"
        );
        for selector in select {
            self.selected.insert(selector.clone());
        }
        for selector in unselect {
            self.selected.remove(selector);
        }
        anyhow::ensure!(self.selected.len() <= 256, "too many selected credentials");
        Ok(())
    }

    pub fn save(&self, root: &str) -> anyhow::Result<()> {
        let value = serde_json::json!({"version": 1, "selected": self.selected});
        // Same atomic private-file writer as credentials; the policy has no secrets.
        crate::auth::write_creds(
            policy_path(root).to_str().ok_or_else(|| {
                anyhow::anyhow!("credential sharing policy path is not valid Unicode")
            })?,
            &(serde_json::to_string_pretty(&value)? + "\n"),
        )
    }
}

/// Serialize consent changes and credential writes. Never steal an existing
/// lock: a crashed writer requires an explicit check before removing its lock.
pub struct SharingLock {
    path: PathBuf,
    file: Option<std::fs::File>,
}

impl SharingLock {
    pub fn acquire(root: &str) -> anyhow::Result<Self> {
        std::fs::create_dir_all(root)?;
        let path = Path::new(root).join(LOCK_NAME);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path).map_err(|_| {
            anyhow::anyhow!(
                "credential sharing is locked; retry after other rdsh auth/setup writers finish; \
                 after a crash, verify no writer is active before removing .rdsh-auth-sharing.lock"
            )
        })?;
        let mut lock = Self {
            path,
            file: Some(file),
        };
        use std::io::Write;
        writeln!(lock.file.as_mut().unwrap(), "pid={}", std::process::id())?;
        Ok(lock)
    }
}

impl Drop for SharingLock {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consent_is_specific_to_both_source_and_credential() {
        let mut policy = SharingPolicy::default();
        assert!(!policy.allows("codex", "openai-codex"));
        policy.change(&["codex:openai-codex".into()], &[]).unwrap();
        assert!(policy.allows("codex", "openai-codex"));
        assert!(!policy.allows("opencode", "openai-codex"));
        assert!(!policy.allows("codex", "OPENAI_API_KEY"));
        policy.change(&[], &["codex:openai-codex".into()]).unwrap();
        assert!(!policy.allows("codex", "openai-codex"));
    }

    #[test]
    fn selectors_cannot_be_wildcards_or_arbitrary_secret_text() {
        for selector in [
            "codex:*",
            "*:openai-codex",
            "env:UNRELATED_TOKEN",
            "opencode:openai",
            "opencode:bad\nselector",
            "secret-value",
        ] {
            assert!(!valid_selector(selector));
        }
        assert!(valid_selector("opencode:openai-codex"));
        assert!(valid_selector("env:OPENAI_API_KEY"));
        assert!(valid_selector("opencode:anthropic"));
    }

    #[test]
    fn lock_does_not_allow_overlapping_writes() {
        let root = std::env::temp_dir().join(format!(
            "rdsh-sharing-lock-{}",
            crate::local_http::random_token().unwrap()
        ));
        let root_str = root.to_str().unwrap();
        let lock = SharingLock::acquire(root_str).unwrap();
        assert!(SharingLock::acquire(root_str).is_err());
        drop(lock);
        drop(SharingLock::acquire(root_str).unwrap());
        std::fs::remove_dir(root).unwrap();
    }
}
