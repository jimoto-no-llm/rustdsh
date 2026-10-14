//! Wire `rdsh context inject` into a DSH hook config (Claude Code dialect).
//!
//! The injection entry point is a hook command, not a hidden side channel: a
//! `UserPromptSubmit` command hook whose JSON stdout carries
//! `hookSpecificOutput.additionalContext` is the documented, model-visible way
//! to attach context to a turn. This module only edits that config file, and it
//! is idempotent — a second install changes nothing.
//!
//! The file is rewritten as normalized JSON, so a backup is kept beside it on
//! the first write.

use anyhow::Result;
use std::io::Write;
use std::path::{Path, PathBuf};

const BACKUP_SUFFIX: &str = ".bak-rdsh-context";
const EVENT: &str = "UserPromptSubmit";

pub fn default_path() -> String {
    format!("{}/hooks.json", crate::inspect::dsh_home())
}

fn read_config(path: &Path) -> Result<serde_json::Value> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)
            .map_err(|e| anyhow::anyhow!("{}: invalid JSON ({e})", path.display()))?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(anyhow::anyhow!("{}: {e}", path.display())),
    }
}

/// One command entry is ours when it runs this command.
///
/// A substring test would delete an unrelated hook that merely mentions the
/// phrase, so the program name and the two subcommand tokens are both checked.
fn is_ours(command: &serde_json::Value) -> bool {
    command
        .get("command")
        .and_then(|v| v.as_str())
        .is_some_and(command_is_ours)
}

fn command_is_ours(command: &str) -> bool {
    let tokens: Vec<&str> = command.split_whitespace().collect();
    let Some(program) = tokens.first() else {
        return false;
    };
    let program = program.rsplit(['/', '\\']).next().unwrap_or(program);
    if !program.contains("rdsh") {
        return false;
    }
    tokens
        .windows(2)
        .any(|pair| pair[0] == "context" && pair[1] == "inject")
}

fn group_is_ours(group: &serde_json::Value) -> bool {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|cmds| cmds.iter().any(is_ours))
        .unwrap_or(false)
}

/// True when an existing group already runs this command for the event.
fn has_entry(hooks: &serde_json::Value, event: &str) -> bool {
    hooks
        .get(event)
        .and_then(|g| g.as_array())
        .map(|groups| groups.iter().any(group_is_ours))
        .unwrap_or(false)
}

fn entry(command: &str) -> serde_json::Value {
    serde_json::json!({
        "hooks": [
            {
                "type": "command",
                "command": command,
                // The bridge default is 600s; an injected turn should never wait
                // that long for a local scan.
                "timeout": 10
            }
        ]
    })
}

/// Merge the inject hook into `doc`, returning true when something changed.
fn merge(doc: &mut serde_json::Value, command: &str) -> bool {
    if !doc.is_object() {
        *doc = serde_json::json!({});
    }
    let root = doc.as_object_mut().expect("object");
    let hooks = root.entry("hooks").or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    if has_entry(hooks, EVENT) {
        return false;
    }
    let hooks = hooks.as_object_mut().expect("object");
    let list = hooks.entry(EVENT).or_insert_with(|| serde_json::json!([]));
    if !list.is_array() {
        *list = serde_json::json!([]);
    }
    if let Some(arr) = list.as_array_mut() {
        arr.push(entry(command));
    }
    true
}

/// Remove every group that runs this command, returning true when removed.
fn unmerge(doc: &mut serde_json::Value) -> bool {
    let Some(hooks) = doc.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return false;
    };
    let Some(list) = hooks.get_mut(EVENT).and_then(|l| l.as_array_mut()) else {
        return false;
    };
    let before = list.len();
    list.retain(|group| !group_is_ours(group));
    let removed = list.len() != before;
    if list.is_empty() {
        hooks.remove(EVENT);
    }
    removed
}

fn write_atomic(path: &Path, doc: &serde_json::Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let backup = PathBuf::from(format!("{}{BACKUP_SUFFIX}", path.display()));
    if path.exists() && !backup.exists() {
        std::fs::copy(path, &backup)?;
    }
    let body = format!("{}\n", serde_json::to_string_pretty(doc)?);
    // Same policy as the memory store: owner-only, unpredictable temp name.
    let tmp = PathBuf::from(format!(
        "{}.tmp-rdsh-{}",
        path.display(),
        crate::local_http::random_token()?
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<()> {
        let mut file = options.open(&tmp)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// `rdsh context hook`: install / status / remove.
pub fn cmd_hook(
    action: &str,
    path: Option<String>,
    rdsh_bin: Option<String>,
    dry_run: bool,
    json: bool,
) -> Result<()> {
    let path = PathBuf::from(path.unwrap_or_else(default_path));
    let bin = rdsh_bin.unwrap_or_else(|| "rdsh".to_string());
    let command = format!("{bin} context inject --event user-prompt-submit");
    let mut doc = read_config(&path)?;
    match action {
        "install" => {
            let changed = merge(&mut doc, &command);
            if dry_run {
                println!("{}", serde_json::to_string_pretty(&doc)?);
                eprintln!(
                    "[rdsh context hook] dry-run: {}",
                    if changed {
                        "would add the UserPromptSubmit hook"
                    } else {
                        "already installed"
                    }
                );
                return Ok(());
            }
            if changed {
                write_atomic(&path, &doc)?;
                eprintln!(
                    "[rdsh context hook] installed in {} (backup: {}{BACKUP_SUFFIX})",
                    path.display(),
                    path.display()
                );
            } else {
                eprintln!(
                    "[rdsh context hook] already installed in {}",
                    path.display()
                );
            }
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "path": path.display().to_string(),
                        "changed": changed,
                        "command": command,
                    })
                );
            }
            Ok(())
        }
        "remove" => {
            let changed = unmerge(&mut doc);
            if dry_run {
                println!("{}", serde_json::to_string_pretty(&doc)?);
                eprintln!(
                    "[rdsh context hook] dry-run: {}",
                    if changed {
                        "would remove the hook"
                    } else {
                        "nothing to remove"
                    }
                );
                return Ok(());
            }
            if changed {
                write_atomic(&path, &doc)?;
                eprintln!("[rdsh context hook] removed from {}", path.display());
            } else {
                eprintln!(
                    "[rdsh context hook] no rdsh context hook in {}",
                    path.display()
                );
            }
            Ok(())
        }
        "status" => {
            let installed = doc
                .get("hooks")
                .map(|h| has_entry(h, EVENT))
                .unwrap_or(false);
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "path": path.display().to_string(),
                        "installed": installed,
                        "exists": path.exists(),
                    })
                );
            } else {
                println!(
                    "hook: {} ({})",
                    if installed {
                        "installed"
                    } else {
                        "not installed"
                    },
                    path.display()
                );
            }
            if !installed {
                eprintln!(
                    "[rdsh context hook] install with: rdsh context hook install --path {}",
                    path.display()
                );
            }
            Ok(())
        }
        other => anyhow::bail!("unknown action: {other} (try: install, status, remove)"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_is_idempotent_and_keeps_other_keys() {
        let mut doc = serde_json::json!({"hooks": {"PreToolUse": [{"hooks": []}]}, "other": 1});
        assert!(merge(&mut doc, "rdsh context inject"));
        assert!(!merge(&mut doc, "rdsh context inject"));
        assert_eq!(doc["other"], 1);
        assert!(doc["hooks"]["PreToolUse"].is_array());
        let groups = doc["hooks"]["UserPromptSubmit"].as_array().expect("array");
        assert_eq!(groups.len(), 1);
        assert!(groups[0]["hooks"][0]["command"]
            .as_str()
            .expect("command")
            .contains("context inject"));
    }

    #[test]
    fn unmerge_removes_only_our_entry() {
        let mut doc = serde_json::json!({"hooks": {"UserPromptSubmit": [
            {"hooks": [{"type": "command", "command": "other-hook"}]}
        ]}});
        merge(&mut doc, "rdsh context inject");
        assert_eq!(
            doc["hooks"]["UserPromptSubmit"]
                .as_array()
                .expect("array")
                .len(),
            2
        );
        assert!(unmerge(&mut doc));
        let left = doc["hooks"]["UserPromptSubmit"].as_array().expect("array");
        assert_eq!(left.len(), 1);
        assert_eq!(left[0]["hooks"][0]["command"], "other-hook");
        assert!(!unmerge(&mut doc));
    }

    #[test]
    fn unrelated_hooks_that_mention_the_phrase_are_kept() {
        let mut doc = serde_json::json!({"hooks": {"UserPromptSubmit": [
            {"hooks": [{"type": "command", "command": "my-tool audit context inject-log"}]}
        ]}});
        assert!(!unmerge(&mut doc));
        assert_eq!(
            doc["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"],
            "my-tool audit context inject-log"
        );
    }

    #[test]
    fn a_differently_located_rdsh_binary_is_still_ours() {
        let mut doc = serde_json::json!({});
        assert!(merge(
            &mut doc,
            "/opt/rdsh/bin/rdsh context inject --event user-prompt-submit"
        ));
        assert!(!merge(
            &mut doc,
            "/opt/rdsh/bin/rdsh context inject --event user-prompt-submit"
        ));
        assert!(unmerge(&mut doc));
    }

    #[test]
    fn non_object_document_is_replaced_not_failed() {
        let mut doc = serde_json::json!([]);
        assert!(merge(&mut doc, "rdsh context inject"));
        assert!(doc["hooks"]["UserPromptSubmit"].is_array());
    }
}
