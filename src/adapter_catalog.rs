use serde_json::{json, Map, Value};

pub fn catalog() -> Value {
    let adapters: Vec<_> = ["dsh", "codex", "claude", "kimi"]
        .into_iter()
        .map(|id| {
            let dsh = id == "dsh";
            let operations: Map<String, Value> = [
                ("start", "session/new"),
                ("resume", "session/resume"),
                ("send", "session/prompt"),
                ("interrupt", "session/cancel"),
                (
                    "stop",
                    "cancel input, session/close and EOF, scoped kernel termination, descendant verification",
                ),
                ("usage", "session/update:usage_update"),
            ]
            .into_iter()
            .map(|(name, method)| {
                (
                    name.to_owned(),
                    json!({
                        "status": if dsh { "requires_version_and_protocol_check" } else { "unsupported" },
                        "method": if dsh { Some(method) } else { None },
                    }),
                )
            })
            .collect();
            json!({
                "id": id,
                "protocol": if dsh { Some("acp-stdio-v1") } else { None },
                "verified_versions": if dsh { vec!["0.2.0-rc.2", "0.2.2-rc.5"] } else { vec![] },
                "verification": if dsh {
                    "versioned wire fixtures and isolated DSH ACP lifecycle smoke"
                } else {
                    "no implementation or verified CLI version"
                },
                "operations": operations,
            })
        })
        .collect();
    json!({ "adapters": adapters })
}

pub fn cmd_adapter_catalog() -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(&catalog())?);
    Ok(())
}
