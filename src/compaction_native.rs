//! Provider-native compaction routes, checked against what a profile serves.
//!
//! A route may name a provider-native method in `rdsh-compaction.json` only
//! when the composed profile carries an enabled `rdsh-llm-native` row that
//! serves the same provider and model with a compaction trigger. The rows of
//! the capability table (RQ-07) come from that listing, so a method is never
//! accepted on the strength of the settings file alone, and never replaced by
//! a summary when the profile does not serve it.

use native_compaction::{
    Capability, CapabilityTable, Method, NativeKind, Placement, ResultForm, Trigger,
};

/// Id of the row the adapter plugin inserts.
pub const ADAPTER_ROW_ID: &str = "rdsh-llm-native";

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    for quote in ['\'', '"'] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return value[1..value.len() - 1].replace("''", "'");
        }
    }
    value.to_string()
}

/// One model the adapter row serves with a compaction trigger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Served {
    pub provider: String,
    pub model: String,
    pub kind: NativeKind,
}

/// The compaction form a route speaks, from its `api` and the model's
/// `compaction` setting. An unknown `api` serves nothing.
fn kind_of(api: Option<&str>, form: Option<&str>) -> Option<NativeKind> {
    Some(match (api.unwrap_or("openai-responses"), form) {
        ("openai-responses", None) => NativeKind::OpenAiStandalone,
        ("xai-responses", None) => NativeKind::XaiStandalone,
        ("anthropic-messages", None | Some("on_demand")) => NativeKind::AnthropicOnDemand,
        ("anthropic-messages", Some("threshold")) => NativeKind::AnthropicThreshold,
        _ => return None,
    })
}

/// Models the adapter row serves with `compactAtTokens`.
///
/// The dump is DSH's own block-style rendering, read the same way the overlay
/// reads it: by indentation. Anything that is not the documented shape yields
/// nothing, which refuses the route instead of guessing.
pub fn served_routes(composed: &str) -> Vec<Served> {
    struct Model {
        id: String,
        trigger: bool,
        form: Option<String>,
    }
    let mut served = Vec::new();
    for entry in crate::webui_gzip::split_entries(composed) {
        let lines: Vec<&str> = entry.lines().collect();
        if lines.first().map(|line| line.trim_end()) != Some(&format!("- id: {ADAPTER_ROW_ID}")[..])
        {
            continue;
        }
        if lines
            .iter()
            .any(|line| indent_of(line) == 2 && line.trim() == "disabled: true")
        {
            continue;
        }
        let Some(start) = lines
            .iter()
            .position(|line| indent_of(line) == 4 && line.trim() == "providers:")
        else {
            continue;
        };
        let mut provider: Option<String> = None;
        let mut api: Option<String> = None;
        let mut models: Vec<Model> = Vec::new();
        let mut flush =
            |provider: &Option<String>, api: &Option<String>, models: &mut Vec<Model>| {
                if let Some(provider) = provider {
                    for model in models.drain(..).filter(|model| model.trigger) {
                        if let Some(kind) = kind_of(api.as_deref(), model.form.as_deref()) {
                            served.push(Served {
                                provider: provider.clone(),
                                model: model.id,
                                kind,
                            });
                        }
                    }
                }
                models.clear();
            };
        for line in &lines[start + 1..] {
            let text = line.trim();
            if text.is_empty() || text.starts_with('#') {
                continue;
            }
            match indent_of(line) {
                0..=4 => break,
                6 => {
                    flush(&provider, &api, &mut models);
                    provider = text.strip_suffix(':').map(unquote);
                    api = None;
                }
                8 => {
                    if let Some(value) = text.strip_prefix("api:") {
                        api = Some(unquote(value));
                    }
                }
                10 => {
                    if let Some(id) = text.strip_prefix("- id:") {
                        models.push(Model {
                            id: unquote(id),
                            trigger: false,
                            form: None,
                        });
                    }
                }
                12 => {
                    if let Some(model) = models.last_mut() {
                        if text.starts_with("compactAtTokens:") {
                            model.trigger = true;
                        } else if let Some(value) = text.strip_prefix("compaction:") {
                            model.form = Some(unquote(value));
                        }
                    }
                }
                _ => {}
            }
        }
        flush(&provider, &api, &mut models);
    }
    served
}

/// The capability table for one composed profile.
pub fn table_for(composed: &str) -> CapabilityTable {
    let entries = served_routes(composed)
        .into_iter()
        .map(|served| {
            let mut row = Capability::host_summary(&served.provider, &served.model);
            row.method = Method::ProviderNative(served.kind);
            row.triggers = vec![Trigger::Threshold];
            row.placement = Placement::HeadVerbatim;
            row.result_form = match served.kind {
                NativeKind::AnthropicOnDemand | NativeKind::AnthropicThreshold => {
                    ResultForm::ReadableSigned
                }
                _ => ResultForm::OpaqueEncrypted,
            };
            row
        })
        .collect();
    CapabilityTable { entries }
}

/// Check every provider-native route of the settings against the profile.
/// The reason names the entry by index and never echoes provider or model.
pub fn check_routes(
    options: &crate::compaction_config::Options,
    composed: &str,
) -> Result<(), String> {
    let table = table_for(composed);
    for (index, route) in options.routes.iter().enumerate() {
        let Some(method @ Method::ProviderNative(_)) =
            crate::compaction_config::method_named(&route.method)
        else {
            continue;
        };
        if table
            .require(&route.provider, &route.model, method, Trigger::Threshold)
            .is_err()
        {
            return Err(format!(
                "routes[{index}] names a provider-native method this profile does not serve; attach {ADAPTER_ROW_ID} with compactAtTokens for that model"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `dsh --dump-config` with the adapter attached, trimmed.
    const DUMP: &str = "\
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
# == rdsh-llm-native, patched by /home/profiles/headless/cordis.patch.yml
- id: rdsh-llm-native
  name: rdsh-llm-native
  config:
    providers:
      native:
        baseURL: http://127.0.0.1:61416/v1
        apiKeyEnv: RDSH_NATIVE_KEY
        models:
          - id: emulated-model
            name: Emulated
            contextWindow: 262144
            compactAtTokens: 3000
          - id: 'no-trigger'
            contextWindow: 262144
      other:
        baseURL: https://api.example/v1
        models:
          - id: \"big\"
            compactAtTokens: 150000
      claude:
        api: anthropic-messages
        baseURL: https://api.example/v1
        models:
          - id: on-demand
            compactAtTokens: 150000
          - id: threshold
            compactAtTokens: 150000
            compaction: threshold
      grok:
        api: xai-responses
        baseURL: https://api.example/v1
        models:
          - id: g
            compactAtTokens: 150000
      unknown-api:
        api: gemini
        baseURL: https://api.example/v1
        models:
          - id: x
            compactAtTokens: 150000
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
";

    fn options(routes: serde_json::Value) -> crate::compaction_config::Options {
        crate::compaction_config::Options::parse(&serde_json::json!({ "routes": routes })).unwrap()
    }

    #[test]
    fn only_models_with_a_trigger_on_an_enabled_row_are_served() {
        let served = |provider: &str, model: &str, kind| Served {
            provider: provider.to_string(),
            model: model.to_string(),
            kind,
        };
        assert_eq!(
            served_routes(DUMP),
            vec![
                served("native", "emulated-model", NativeKind::OpenAiStandalone),
                served("other", "big", NativeKind::OpenAiStandalone),
                served("claude", "on-demand", NativeKind::AnthropicOnDemand),
                served("claude", "threshold", NativeKind::AnthropicThreshold),
                served("grok", "g", NativeKind::XaiStandalone),
            ]
        );
        let disabled = DUMP.replace(
            "  name: rdsh-llm-native\n",
            "  name: rdsh-llm-native\n  disabled: true\n",
        );
        assert!(served_routes(&disabled).is_empty());
        assert!(served_routes("- id: compaction-basic\n").is_empty());
        // A row whose config is not the documented block shape serves nothing.
        assert!(served_routes("- id: rdsh-llm-native\n  config: {}\n").is_empty());
    }

    #[test]
    fn a_native_route_needs_the_profile_to_serve_exactly_that_model() {
        let served = options(serde_json::json!([
            {"provider": "native", "model": "emulated-model", "method": "openai_standalone"},
            {"provider": "deepseek", "model": "flash", "method": "off"}
        ]));
        assert_eq!(check_routes(&served, DUMP), Ok(()));
        let forms = options(serde_json::json!([
            {"provider": "claude", "model": "on-demand", "method": "anthropic_on_demand"},
            {"provider": "claude", "model": "threshold", "method": "anthropic_threshold"},
            {"provider": "grok", "model": "g", "method": "xai_standalone"}
        ]));
        assert_eq!(check_routes(&forms, DUMP), Ok(()));

        let reason = "names a provider-native method this profile does not serve; attach rdsh-llm-native with compactAtTokens for that model";
        for (provider, model, method) in [
            ("native", "no-trigger", "openai_standalone"),
            ("native", "missing", "openai_standalone"),
            ("deepseek", "emulated-model", "openai_standalone"),
            // The method must be the form that route speaks.
            ("native", "emulated-model", "anthropic_threshold"),
            ("native", "emulated-model", "openai_in_stream"),
            ("claude", "on-demand", "anthropic_threshold"),
            ("claude", "threshold", "anthropic_on_demand"),
            ("grok", "g", "openai_standalone"),
            ("unknown-api", "x", "openai_standalone"),
        ] {
            let unserved = options(serde_json::json!([
                {"provider": "deepseek", "model": "flash", "method": "dsh_summary"},
                {"provider": provider, "model": model, "method": method}
            ]));
            assert_eq!(
                check_routes(&unserved, DUMP),
                Err(format!("routes[1] {reason}")),
                "{provider}/{model} {method}"
            );
        }
        // Without the adapter row nothing native is accepted.
        assert!(check_routes(&served, "- id: compaction-basic\n").is_err());
    }
}
