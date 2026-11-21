//! Retired Anthropic API/OAuth selections are upgraded to the explicit CLI route.
use serde_json::{json, Value};

pub(super) fn provider(id: &str) -> &str {
    if id == "anthropic" {
        "claude-cli"
    } else {
        id
    }
}

pub(super) fn catalog(mut value: Value) -> Value {
    if let Some(groups) = value["groups"].as_array_mut() {
        groups.retain(|group| group["id"] != "anthropic");
    }
    if let Some(providers) = value["routableProviders"].as_array_mut() {
        providers.retain(|id| id != "anthropic");
    }
    if value["default"]["provider"] == "anthropic" {
        value["default"]["provider"] = json!("claude-cli");
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retired_models_are_hidden_and_legacy_defaults_keep_the_model_on_cli() {
        let value = catalog(
            json!({"default":{"provider":"anthropic","model":"claude-opus-5-5"},
            "routableProviders":["anthropic","claude-cli","other"],
            "groups":[{"id":"anthropic","models":[{"id":"old"}]},{"id":"claude-cli","models":[{"id":"claude-opus-5-5"}]},{"id":"other","models":[]}]}),
        );
        assert_eq!(value["groups"].as_array().unwrap().len(), 2);
        assert_eq!(
            value["default"],
            json!({"provider":"claude-cli","model":"claude-opus-5-5"})
        );
        assert_eq!(value["routableProviders"], json!(["claude-cli", "other"]));
        assert_eq!(provider("anthropic"), "claude-cli");
        assert_eq!(provider("other"), "other");
    }
}
