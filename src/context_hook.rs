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
use clap::Parser;
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
    let Some(tokens) = shell_tokens(command).or_else(|| powershell_tokens(command)) else {
        return false;
    };
    let Some(program) = tokens.first() else {
        return false;
    };
    if !rdsh_named(program) {
        return false;
    }
    matches!(
        crate::Cli::try_parse_from(tokens)
            .ok()
            .and_then(|cli| cli.command),
        Some(crate::Commands::Context {
            action: crate::ContextAction::Inject { .. }
        })
    )
}

fn rdsh_named(program: &str) -> bool {
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    name.strip_suffix(".exe").unwrap_or(name) == "rdsh"
}

// Recognize POSIX quoted words without executing expansions or shell syntax.
// Malformed or compound commands are conservatively left to their owner.
fn shell_tokens(command: &str) -> Option<Vec<String>> {
    let mut chars = command.chars().peekable();
    let mut tokens = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut started = false;
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            (Some('\''), _) => word.push(c),
            (_, '\\') => {
                let next = chars.next()?;
                if quote == Some('"') && !matches!(next, '$' | '`' | '"' | '\\' | '\n') {
                    word.push('\\');
                }
                if next != '\n' {
                    word.push(next);
                }
                started = true;
            }
            (None, '\'' | '"') => {
                quote = Some(c);
                started = true;
            }
            (None, ';' | '&' | '|' | '(' | ')' | '<' | '>' | '\n')
            | (None | Some('"'), '$' | '`') => return None,
            (None, c) if c.is_whitespace() => {
                if started {
                    tokens.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            _ => {
                word.push(c);
                started = true;
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if started {
        tokens.push(word);
    }
    Some(tokens)
}

fn powershell_tokens(command: &str) -> Option<Vec<String>> {
    let mut chars = command.chars().peekable();
    if chars.next()? != '&' || !chars.next()?.is_whitespace() {
        return None;
    }
    while chars.peek().is_some_and(|c| c.is_whitespace()) {
        chars.next();
    }
    if chars.next()? != '\'' {
        return None;
    }
    let mut program = String::new();
    let mut closed = false;
    while let Some(c) = chars.next() {
        if c == '\'' {
            if chars.peek() == Some(&'\'') {
                chars.next();
                program.push('\'');
            } else {
                closed = true;
                break;
            }
        } else {
            program.push(c);
        }
    }
    if !closed || !chars.next()?.is_whitespace() {
        return None;
    }
    let mut tokens = vec![program];
    let remainder: String = chars.collect();
    for token in remainder.split_whitespace() {
        if token
            .chars()
            .any(|c| matches!(c, ';' | '&' | '|' | '(' | ')' | '<' | '>' | '$' | '`'))
        {
            return None;
        }
        tokens.push(token.to_string());
    }
    Some(tokens)
}

#[derive(Clone, Copy)]
enum ShellDialect {
    Posix,
    PowerShell,
}

fn inject_command(bin: &str) -> String {
    let dialect = if cfg!(windows) {
        ShellDialect::PowerShell
    } else {
        ShellDialect::Posix
    };
    inject_command_for(bin, dialect)
}

fn inject_command_for(bin: &str, dialect: ShellDialect) -> String {
    if matches!(dialect, ShellDialect::PowerShell) {
        return format!(
            "& '{}' context inject --event user-prompt-submit",
            bin.replace('\'', "''")
        );
    }
    let bin = if !bin.is_empty()
        && bin
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-/:".contains(&b))
    {
        bin.to_string()
    } else {
        format!("'{}'", bin.replace('\'', "'\\''"))
    };
    format!("{bin} context inject --event user-prompt-submit")
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

/// Remove this command without touching anyone else's hooks, returning true
/// when something was removed.
///
/// Removal works per command, not per group: a group that also hosts other
/// hooks keeps them, and only a group left empty is dropped.
fn unmerge(doc: &mut serde_json::Value) -> bool {
    let Some(hooks) = doc.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return false;
    };
    let Some(list) = hooks.get_mut(EVENT).and_then(|l| l.as_array_mut()) else {
        return false;
    };
    let mut removed = false;
    let mut kept: Vec<serde_json::Value> = Vec::with_capacity(list.len());
    for mut group in std::mem::take(list) {
        let mut empty = false;
        if let Some(commands) = group.get_mut("hooks").and_then(|h| h.as_array_mut()) {
            let before = commands.len();
            commands.retain(|command| !is_ours(command));
            removed |= commands.len() != before;
            empty = commands.is_empty();
        }
        if !empty {
            kept.push(group);
        }
    }
    *list = kept;
    let event_empty = list.is_empty();
    if event_empty {
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
    let command = inject_command(&bin);
    let mut doc = read_config(&path)?;
    match action {
        "install" => {
            if !rdsh_named(&bin) {
                eprintln!("note: --rdsh should point at an rdsh-named binary so re-installs stay idempotent");
            }
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
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "path": path.display().to_string(),
                        "changed": changed,
                    })
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
    fn removal_keeps_other_commands_in_the_same_group() {
        let mut doc = serde_json::json!({"hooks": {"UserPromptSubmit": [
            {"hooks": [
                {"type": "command", "command": "other-tool audit"},
                {"type": "command", "command": "rdsh context inject --event user-prompt-submit"}
            ]}
        ]}});
        assert!(unmerge(&mut doc));
        let groups = doc["hooks"]["UserPromptSubmit"].as_array().expect("array");
        assert_eq!(groups.len(), 1, "the group still holds another hook");
        let commands = groups[0]["hooks"].as_array().expect("commands");
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0]["command"], "other-tool audit");
    }

    #[test]
    fn unrelated_hooks_that_mention_the_phrase_are_kept() {
        let mut doc = serde_json::json!({"hooks": {"UserPromptSubmit": [
            {"hooks": [
                {"type": "command", "command": "my-tool audit context inject-log"},
                {"type": "command", "command": "my-rdsh-auditor context inject"}
            ]}
        ]}});
        assert!(!unmerge(&mut doc));
        assert_eq!(
            doc["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"],
            "my-tool audit context inject-log"
        );
        assert_eq!(
            doc["hooks"]["UserPromptSubmit"][0]["hooks"][1]["command"],
            "my-rdsh-auditor context inject"
        );
    }

    #[test]
    fn ownership_requires_exact_binary_name_and_adjacent_subcommands() {
        for command in [
            "rdsh context inject",
            "/opt/bin/rdsh.exe --profile web context inject",
            "\"/opt/program files/rdsh\" context inject",
            "'C:\\Program Files\\rdsh.exe' context inject",
        ] {
            assert!(command_is_ours(command), "{command}");
        }
        for command in [
            "my-rdsh-auditor context inject",
            "/opt/dsh-native context inject",
            "rdsh context other inject",
            "rdsh context inject-log",
            "rdsh audit; echo context inject",
            "'rdsh context inject",
        ] {
            assert!(!command_is_ours(command), "{command}");
        }
    }

    #[test]
    fn ownership_checks_the_parsed_command_not_nested_argument_values() {
        for command in ["rdsh tokens context inject", "rdsh boot -- context inject"] {
            assert!(!command_is_ours(command), "{command}");
        }
        assert!(command_is_ours("rdsh --profile web context inject"));
    }

    #[test]
    fn quoted_binary_paths_remain_idempotent_and_removable() {
        for bin in [
            "/opt/program files/rdsh",
            "/opt/user's tools/rdsh",
            "/opt/$(echo x);tools/rdsh",
        ] {
            let command = inject_command_for(bin, ShellDialect::Posix);
            assert!(command.starts_with('\''));
            assert_eq!(shell_tokens(&command).unwrap()[0], bin);
            let mut doc = serde_json::json!({});
            assert!(merge(&mut doc, &command));
            assert!(is_ours(&doc["hooks"][EVENT][0]["hooks"][0]));
            assert!(!merge(&mut doc, &command));
            assert!(unmerge(&mut doc));
        }
        assert_eq!(
            inject_command_for("/opt/user's tools/rdsh", ShellDialect::Posix),
            "'/opt/user'\\''s tools/rdsh' context inject --event user-prompt-submit"
        );
        assert_eq!(
            inject_command_for("/opt/bin/rdsh", ShellDialect::Posix),
            "/opt/bin/rdsh context inject --event user-prompt-submit"
        );
    }

    #[test]
    fn powershell_absolute_paths_with_spaces_are_owned_and_removable() {
        let bin = r"C:\Users\O'Neil\Program Files\rdsh.exe";
        let command = inject_command_for(bin, ShellDialect::PowerShell);
        assert_eq!(
            command,
            "& 'C:\\Users\\O''Neil\\Program Files\\rdsh.exe' context inject --event user-prompt-submit"
        );
        assert_eq!(
            powershell_tokens(&command).unwrap(),
            vec![bin, "context", "inject", "--event", "user-prompt-submit"]
        );
        let mut doc = serde_json::json!({});
        assert!(merge(&mut doc, &command));
        assert!(is_ours(&doc["hooks"][EVENT][0]["hooks"][0]));
        assert!(!merge(&mut doc, &command));
        assert!(unmerge(&mut doc));
    }

    #[test]
    fn install_quotes_the_rdsh_argument() {
        let dir = std::env::temp_dir().join(format!(
            "rdsh-context-hook-test-{}",
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("hooks.json");
        let bin = "/opt/program files/rdsh";
        cmd_hook(
            "install",
            Some(path.to_string_lossy().into_owned()),
            Some(bin.to_string()),
            false,
            false,
        )
        .unwrap();
        let doc = read_config(&path).unwrap();
        let hook = &doc["hooks"][EVENT][0]["hooks"][0];
        let expected = if cfg!(windows) {
            "& '/opt/program files/rdsh' context inject --event user-prompt-submit"
        } else {
            "'/opt/program files/rdsh' context inject --event user-prompt-submit"
        };
        assert_eq!(hook["command"], expected);
        assert!(is_ours(hook));
        std::fs::remove_dir_all(dir).unwrap();
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
