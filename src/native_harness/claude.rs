//! Claude Code is an inference-only child; Rust owns conversation and tools.
mod schema;
use super::sdk::{run_process, TemporaryRoot};
use anyhow::{bail, Result};
use serde_json::Value;
use tokio::process::Command;

const LIMIT: usize = 8 * 1024 * 1024;

fn command(binary: &std::ffi::OsStr, model: &str, cwd: &std::path::Path) -> Command {
    let mut command = Command::new(binary);
    command.args([
        "-p", "--output-format", "json", "--model", model,
        "--tools", "", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
        "--disable-slash-commands", "--no-session-persistence", "--max-turns", "1",
        "--setting-sources", "", "--settings", "{\"disableAllHooks\":true}",
        "--system-prompt", "Return only the response requested by the user. Do not execute tools. Rust rdsh manages conversation and tool execution.",
    ]).current_dir(cwd).env_clear();
    // Keep the CLI's own existing login/keychain, but never copy DSH grants or
    // inherit injected prompts, Node hooks, nested-session markers or MCP config.
    for name in [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "TMPDIR",
        "TEMP",
        "TMP",
        "SystemRoot",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CONFIG_DIR",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    // --bare would disable OAuth/keychain authentication, so it is deliberately
    // not used. The CLI's permission checks and managed policy remain active.
    command
}

fn turn_command(binary: &std::ffi::OsStr, model: &str, cwd: &std::path::Path) -> Command {
    let mut child = command(binary, model, cwd);
    child
        .arg("--json-schema")
        .arg(schema::turn().to_string())
        .env("MAX_STRUCTURED_OUTPUT_RETRIES", "1");
    child
}

pub(super) async fn generate_with_usage(
    model: &str,
    prompt: &str,
) -> Result<super::usage::Generation> {
    generate_with(std::ffi::OsStr::new("claude"), model, prompt).await
}

pub(super) async fn generate_turn_with_usage(
    model: &str,
    prompt: &str,
) -> Result<super::usage::Generation> {
    generate(std::ffi::OsStr::new("claude"), model, prompt, true).await
}

async fn generate_with(
    binary: &std::ffi::OsStr,
    model: &str,
    prompt: &str,
) -> Result<super::usage::Generation> {
    generate(binary, model, prompt, false).await
}

async fn generate(
    binary: &std::ffi::OsStr,
    model: &str,
    prompt: &str,
    structured: bool,
) -> Result<super::usage::Generation> {
    if model.is_empty()
        || model.starts_with('-')
        || model.len() > 200
        || !model.bytes().all(|c| c.is_ascii_graphic())
        || prompt.is_empty()
        || prompt.len() > LIMIT
    {
        bail!("CLAUDE_INVALID_REQUEST");
    }
    let root = TemporaryRoot::create()?;
    let child = if structured {
        turn_command(binary, model, &root.0)
    } else {
        command(binary, model, &root.0)
    };
    let (status, stdout, _stderr) = run_process(child, prompt.as_bytes(), 180, LIMIT).await?;
    if structured {
        decode_output(status, &stdout, true)
    } else {
        decode_generation(status, &stdout)
    }
}

#[cfg(test)]
fn decode(status: i32, bytes: &[u8]) -> Result<String> {
    Ok(decode_generation(status, bytes)?.text)
}
fn decode_generation(status: i32, bytes: &[u8]) -> Result<super::usage::Generation> {
    decode_output(status, bytes, false)
}
fn decode_output(status: i32, bytes: &[u8], structured: bool) -> Result<super::usage::Generation> {
    let result: Value =
        serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("CLAUDE_INVALID_RESPONSE"))?;
    if status != 0
        || result["is_error"] != false
        || result["type"] != "result"
        || result["subtype"] != "success"
    {
        bail!("CLAUDE_REQUEST_FAILED");
    }
    // The CLI records its schema formatter as another turn, even with
    // --max-turns 1. It has no execution capability; all regular tools stay off.
    let valid_turns = if structured {
        matches!(result["num_turns"].as_u64(), Some(1 | 2))
    } else {
        result["num_turns"].as_u64() == Some(1)
    };
    if !valid_turns
        || result
            .get("permission_denials")
            .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
    {
        bail!("CLAUDE_TOOL_DETECTED");
    }
    if structured {
        let output = result["structured_output"]
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("CLAUDE_STRUCTURED_RESPONSE_MISSING"))?;
        return Ok(super::usage::Generation {
            text: serde_json::to_string(output)?,
            usage: super::usage::Usage::parse("anthropic-messages", &result),
        });
    }
    let text = result["result"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("CLAUDE_EMPTY_RESPONSE"))?;
    // Claude may fence an otherwise valid JSON turn even when asked for raw
    // JSON. Remove only a fence enclosing the entire reply. Rust's existing
    // turn/schema/tool validation still runs; never extract JSON from prose.
    let text = text.trim();
    let text = [
        ("```json\n", "\n```"),
        ("```\n", "\n```"),
        ("```json\r\n", "\r\n```"),
        ("```\r\n", "\r\n```"),
    ]
    .into_iter()
    .find_map(|(start, end)| text.strip_prefix(start).and_then(|s| s.strip_suffix(end)))
    .unwrap_or(text);
    Ok(super::usage::Generation {
        text: text.to_owned(),
        usage: super::usage::Usage::parse("anthropic-messages", &result),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn structured_turn_requires_the_schema_result_and_keeps_rust_validation() {
        let turn = json!({"version":1,"text":"RECOVERED","toolCalls":[]});
        let mut reply = json!({"type":"result","subtype":"success","is_error":false,
            "result":"non-JSON prose is not the structured payload","num_turns":2,
            "permission_denials":[],"structured_output":turn});
        let decoded = decode_output(0, &serde_json::to_vec(&reply).unwrap(), true).unwrap();
        assert_eq!(
            super::super::engine::parse_turn(&decoded.text)
                .unwrap()
                .text,
            "RECOVERED"
        );
        assert!(decode_generation(0, &serde_json::to_vec(&reply).unwrap()).is_err());
        reply["structured_output"]["extra"] = json!(true);
        let decoded = decode_output(0, &serde_json::to_vec(&reply).unwrap(), true).unwrap();
        assert!(super::super::engine::parse_turn(&decoded.text).is_err());
        reply.as_object_mut().unwrap().remove("structured_output");
        assert_eq!(
            decode_output(0, &serde_json::to_vec(&reply).unwrap(), true)
                .err()
                .unwrap()
                .to_string(),
            "CLAUDE_STRUCTURED_RESPONSE_MISSING"
        );
    }
    #[test]
    fn schema_formatting_never_permits_cli_tools_or_unbounded_turns() {
        let child = turn_command(
            std::ffi::OsStr::new("claude"),
            "test",
            std::path::Path::new("empty"),
        );
        let args: Vec<_> = child
            .as_std()
            .get_args()
            .map(|s| s.to_str().unwrap())
            .collect();
        assert!(args.windows(2).any(|a| a == ["--tools", ""]));
        assert!(args.windows(2).any(|a| a == ["--max-turns", "1"]));
        let schema = args.windows(2).find(|a| a[0] == "--json-schema").unwrap()[1];
        let value: Value = serde_json::from_str(schema).unwrap();
        let names: Vec<_> = value["properties"]["toolCalls"]["items"]["anyOf"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["properties"]["name"]["const"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["read", "write", "devin_cli", "model_call"]);
        for (turns, denials) in [
            (3, json!([])),
            (2, json!([{"tool_name":"Read"}])),
            (2, json!({})),
        ] {
            let reply = json!({"type":"result","subtype":"success","is_error":false,
                "result":"","num_turns":turns,"permission_denials":denials,
                "structured_output":{"version":1,"text":"text","toolCalls":[]}});
            assert_eq!(
                decode_output(0, &serde_json::to_vec(&reply).unwrap(), true)
                    .err()
                    .unwrap()
                    .to_string(),
                "CLAUDE_TOOL_DETECTED"
            );
        }
    }
    #[test]
    fn cli_usage_preserves_cache_read_and_write_in_total_input() {
        let reply = json!({"type":"result","subtype":"success","is_error":false,"result":"answer","num_turns":1,"permission_denials":[],"usage":{"input_tokens":10,"cache_read_input_tokens":80,"cache_creation_input_tokens":10,"output_tokens":7}});
        let result = decode_generation(0, &serde_json::to_vec(&reply).unwrap()).unwrap();
        assert_eq!(result.usage.input_tokens, Some(100));
        assert_eq!(result.usage.cache_read_tokens, Some(80));
        assert_eq!(result.usage.output_tokens, Some(7));
    }
    #[test]
    fn child_has_no_tools_mcp_hooks_sessions_or_permission_bypass() {
        let command = command(
            std::ffi::OsStr::new("claude"),
            "test-model",
            std::path::Path::new("empty"),
        );
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|a| a.to_str().unwrap())
            .collect();
        for pair in [
            ["--tools", ""],
            ["--setting-sources", ""],
            ["--max-turns", "1"],
            ["--mcp-config", "{\"mcpServers\":{}}"],
            ["--settings", "{\"disableAllHooks\":true}"],
        ] {
            assert!(args.windows(2).any(|w| w == pair));
        }
        assert!(args.contains(&"-p"));
        assert!(!args.contains(&"--bare"));
        assert!(!args.iter().any(|a| a.contains("skip-permissions")));
        assert_eq!(
            command.as_std().get_current_dir(),
            Some(std::path::Path::new("empty"))
        );
        assert!(!command
            .as_std()
            .get_envs()
            .any(|(name, value)| value.is_some()
                && matches!(
                    name.to_str(),
                    Some("NODE_OPTIONS" | "CLAUDECODE" | "DSH_HOME")
                )));
    }
    #[test]
    fn success_is_text_only_and_cli_diagnostics_are_never_echoed() {
        let mut reply = json!({"type":"result","subtype":"success","is_error":false,"result":"answer","num_turns":1,"permission_denials":[]});
        assert_eq!(
            decode(0, &serde_json::to_vec(&reply).unwrap()).unwrap(),
            "answer"
        );
        reply["permission_denials"] = json!([{"tool_name":"Bash"}]);
        assert_eq!(
            decode(0, &serde_json::to_vec(&reply).unwrap())
                .err()
                .unwrap()
                .to_string(),
            "CLAUDE_TOOL_DETECTED"
        );
        assert!(!decode(1, b"secret-cli-diagnostic")
            .err()
            .unwrap()
            .to_string()
            .contains("secret"));
    }
    #[test]
    fn whole_reply_fences_are_removed_but_rust_validation_remains_strict() {
        let turn = r#"{"version":1,"text":"RDSH_LIVE_OK","toolCalls":[]}"#;
        let wrap = |text: &str| {
            serde_json::to_vec(&json!({"type":"result","subtype":"success","is_error":false,"result":text,"num_turns":1,"permission_denials":[]})).unwrap()
        };
        for reply in [
            turn.to_string(),
            format!("```json\n{turn}\n```"),
            format!("```\n{turn}\n```"),
            format!(" \n```json\r\n{turn}\r\n```\n "),
        ] {
            let decoded = decode(0, &wrap(&reply)).unwrap();
            assert_eq!(decoded, turn);
            assert!(super::super::engine::parse_turn(&decoded).is_ok());
        }
        for invalid in [format!("Here is JSON:\n```json\n{turn}\n```"), format!("```json\n{turn}\n```\nExtra prose"), format!("```json\n{turn}\n```\n```json\n{turn}\n```"), "```json\n{\"version\":1,\"text\":\"bad\",\"toolCalls\":[],\"extra\":true}\n```".into(), "```json\n{\"version\":1,\"text\":\"\",\"toolCalls\":[{\"id\":\"x\",\"name\":\"read\",\"arguments\":{\"path\":\"../secret\"}}]}\n```".into()] {
            let decoded = decode(0, &wrap(&invalid)).unwrap();
            assert!(super::super::engine::parse_turn(&decoded).is_err());
        }
    }
    #[tokio::test]
    #[cfg(unix)]
    async fn print_child_receives_prompt_on_stdin_and_isolated_cwd_is_removed() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = TemporaryRoot::create().unwrap();
        let binary = fixture.0.join("claude-fixture");
        std::fs::write(&binary, r#"#!/bin/sh
pwd > "$0.cwd"
cat > "$0.stdin"
printf '%s' '{"type":"result","subtype":"success","is_error":false,"result":"fixture answer","num_turns":1,"permission_denials":[]}'
"#).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            generate_with(binary.as_os_str(), "test-model", "fixture prompt")
                .await
                .unwrap()
                .text,
            "fixture answer"
        );
        assert_eq!(
            std::fs::read_to_string(fixture.0.join("claude-fixture.stdin")).unwrap(),
            "fixture prompt"
        );
        let cwd = std::fs::read_to_string(fixture.0.join("claude-fixture.cwd")).unwrap();
        assert!(
            !std::path::Path::new(cwd.trim()).exists(),
            "temporary inference cwd is cleaned up"
        );
        assert_ne!(cwd.trim(), fixture.0.to_str().unwrap());
    }
}
