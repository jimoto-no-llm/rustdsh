//! Read-only model choices from configured profiles and the installed harness.
//! No provider credentials, login tokens or network requests are returned.
use super::*;
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Choice {
    pub provider: String,
    pub model: String,
    pub profiles: Vec<String>,
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && !id.chars().any(char::is_control)
}
fn add(out: &mut Vec<Choice>, provider: &str, model: &str, profile: &str) {
    if !valid_id(provider) || !valid_id(model) || provider == "rdsh-local" {
        return;
    }
    if let Some(entry) = out
        .iter_mut()
        .find(|c| c.provider == provider && c.model == model)
    {
        if !entry.profiles.iter().any(|p| p == profile) {
            entry.profiles.push(profile.into());
        }
    } else {
        out.push(Choice {
            provider: provider.into(),
            model: model.into(),
            profiles: vec![profile.into()],
        });
    }
}

fn builtin_choices() -> Vec<Choice> {
    let refs = crate::auth::stored_refs();
    let pairs = [
        ("openai", "OPENAI_API_KEY"),
        ("anthropic", "ANTHROPIC_API_KEY"),
        ("deepseek", "DEEPSEEK_API_KEY"),
        ("google", "GEMINI_API_KEY"),
        ("xai", "XAI_API_KEY"),
        ("groq", "GROQ_API_KEY"),
        ("mistral", "MISTRAL_API_KEY"),
        ("openrouter", "OPENROUTER_API_KEY"),
        ("kimi-coding", "KIMI_API_KEY"),
    ];
    let mut providers: Vec<&str> = pairs
        .iter()
        .filter(|(_, key)| {
            refs.contains_key(*key) || std::env::var(key).is_ok_and(|v| !v.trim().is_empty())
        })
        .map(|(id, _)| *id)
        .collect();
    if crate::auth::has_owned_provider("openai-codex") {
        providers.insert(0, "openai-codex");
    }
    if providers.is_empty() {
        return Vec::new();
    }
    let Some(entry) = crate::passthrough::find_original_dsh() else {
        return Vec::new();
    };
    let Some(node) = crate::passthrough::find_node_bin() else {
        return Vec::new();
    };
    struct Cache {
        key: String,
        at: std::time::Instant,
        choices: Vec<Choice>,
    }
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Option<Cache>>> = std::sync::OnceLock::new();
    let key = format!("{}:{entry}:{node}", providers.join(","));
    let mut cache = CACHE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if let Some(cached) = cache
        .as_ref()
        .filter(|c| c.key == key && c.at.elapsed() < std::time::Duration::from_secs(30))
    {
        return cached.choices.clone();
    }
    let result = (|| -> anyhow::Result<Vec<Choice>> {
        let scratch = super::Scratch::new()?;
        let script = scratch.0.join("catalog.mjs");
        std::fs::write(&script, include_str!("../setup-model-catalog.mjs"))?;
        let mut command = std::process::Command::new(node);
        command
            .arg("--experimental-import-meta-resolve")
            .arg(script)
            .arg(entry)
            .arg(serde_json::to_string(&providers)?);
        super::runtime_environment(&mut command)?;
        let bytes = crate::dsh_env::run_bounded_capture(
            command,
            512 * 1024,
            std::time::Duration::from_secs(5),
        )
        .context("CATALOG_UNAVAILABLE")?;
        Ok(serde_json::from_slice(&bytes)?)
    })()
    .unwrap_or_default();
    *cache = Some(Cache {
        key,
        at: std::time::Instant::now(),
        choices: result.clone(),
    });
    result
}
pub(super) fn choices() -> Vec<Choice> {
    let locale = crate::locale::Locale::English;
    let mut out = builtin_choices();
    if let Ok(profiles) = crate::models::profile_paths(None) {
        for (profile, path) in profiles {
            if !matches!(profile.as_str(), "web" | "tui") {
                continue;
            }
            if !std::fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() <= 1024 * 1024) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(path) else {
                continue;
            };
            for provider in crate::providers::configured_route_ids(&profile, locale) {
                if let Ok(models) = crate::models::listed_models(&text, &provider) {
                    for (model, _) in models {
                        add(&mut out, &provider, &model, &profile);
                    }
                }
            }
        }
    }
    let status: serde_json::Value =
        serde_json::from_str(&crate::auth::setup_status_json()).unwrap_or_default();
    if let Some(defaults) = status.get("defaults").and_then(Value::as_array) {
        for item in defaults {
            if item["state"] == "ok" {
                if let (Some(provider), Some(model), Some(profile)) = (
                    item["provider"].as_str(),
                    item["model"].as_str(),
                    item["profile"].as_str(),
                ) {
                    if matches!(profile, "web" | "tui") {
                        add(&mut out, provider, model, profile);
                    }
                }
            }
        }
    }
    // Deterministic choices; retain the displayed ID so no model is guessed.
    out.sort_by(|a, b| (&a.provider, &a.model).cmp(&(&b.provider, &b.model)));
    out.truncate(128);
    out
}
use serde_json::Value;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn choices_merge_profiles_and_refuse_controls() {
        let mut choices = Vec::new();
        add(&mut choices, "provider", "model", "web");
        add(&mut choices, "provider", "model", "tui");
        add(&mut choices, "bad\nprovider", "x", "web");
        assert_eq!(choices.len(), 1);
        assert_eq!(choices[0].profiles, vec!["web", "tui"]);
    }
}
