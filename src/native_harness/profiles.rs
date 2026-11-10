//! DSH configuration and JSON catalog sharing, without starting a DSH runtime.
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

const LIMIT: usize = 8 * 1024 * 1024;
#[derive(Default)]
pub struct Registry {
    pub routes: Vec<Route>,
    pub diagnostics: Vec<String>,
}
pub struct Route {
    pub id: String,
    pub name: String,
    pub models: Vec<Model>,
    pub key: Option<String>,
    pub oauth: Option<crate::auth::native_oauth::Grant>,
    pub claude: bool,
}
pub struct Model {
    pub id: String,
    pub name: String,
    pub api: String,
    pub base: String,
    pub max_tokens: u64,
    pub token_field: String,
    pub unavailable: Option<String>,
}
fn read(path: &Path) -> Result<String> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    let mut bytes = vec![];
    file.take(LIMIT as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > LIMIT {
        bail!("NATIVE_CONFIG_SIZE_LIMIT");
    }
    String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("NATIVE_CONFIG_ENCODING"))
}
fn scalar<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}
fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
}
fn endpoint(base: &str, api: &str, model: &str) -> Result<reqwest::Url> {
    let mut url =
        reqwest::Url::parse(base).map_err(|_| anyhow::anyhow!("NATIVE_ENDPOINT_INVALID"))?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("NATIVE_ENDPOINT_INVALID");
    }
    let google_suffix;
    let suffix = match api {
        "openai-completions" => "chat/completions",
        "openai-responses" => "responses",
        "anthropic-messages" => "messages",
        "google-generative-ai" => {
            let model = model.strip_prefix("models/").unwrap_or(model);
            if !safe_id(model) {
                bail!("NATIVE_MODEL_ID_INVALID");
            }
            google_suffix = format!("models/{model}:generateContent");
            &google_suffix
        }
        _ => bail!("NATIVE_PROTOCOL_UNSUPPORTED"),
    };
    let path = url.path().trim_end_matches('/');
    let path = if api == "anthropic-messages" && !path.ends_with("/v1") {
        format!("{path}/v1/{suffix}")
    } else {
        format!("{path}/{suffix}")
    };
    url.set_path(&path);
    Ok(url)
}
fn catalog_dir() -> Option<PathBuf> {
    // Locate data beside the installed launcher. Never evaluate its JavaScript.
    let entry = PathBuf::from(crate::passthrough::find_original_dsh()?)
        .canonicalize()
        .ok()?;
    for ancestor in entry.ancestors().skip(1).take(5) {
        let data = ancestor.join("node_modules/@earendil-works/pi-ai/dist/providers/data");
        if data.is_dir() {
            return Some(data);
        }
    }
    None
}
/// Read provider metadata only; never evaluate the installed JavaScript.
fn catalog_models(catalog: Option<&Path>, id: &str) -> Vec<Value> {
    catalog
        .and_then(|p| read(&p.join(format!("{id}.json"))).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .map(|groups| {
            // pi-ai flattenModelCatalog uses Object.assign: later APIs win.
            let mut models = serde_json::Map::new();
            for group in groups.into_values().filter_map(|v| v.as_object().cloned()) {
                models.extend(group);
            }
            models.into_values().collect()
        })
        .unwrap_or_default()
}

/// Claude Code owns authentication and transport; legacy HTTP/OAuth options
/// contribute no authority to this inference-only CLI route.
fn claude_route(catalog: Option<&Path>, legacy: Option<&Value>, available: bool) -> Route {
    let resolve = |items: Vec<Value>| {
        let mut seen = HashSet::new();
        items.into_iter().filter_map(|model| {
            let id = scalar(&model, "id")?;
            if id.starts_with('-') || id.len() > 200 || !id.bytes().all(|c| c.is_ascii_graphic())
                || !seen.insert(id.to_owned()) {return None;}
            Some(Model {
                id: id.into(),
                name: scalar(&model,"name").unwrap_or(id).into(),
                api: "claude-cli".into(), base: "cli://claude".into(),
                max_tokens: model["maxTokens"].as_u64().unwrap_or(4096).clamp(1,8192),
                token_field: String::new(),
                unavailable: (!available).then(|| "claude CLIが必要です（ログイン後にnative-web/native-tuiを再起動してください）".into()),
            })
        }).collect::<Vec<_>>()
    };
    let mut models = resolve(catalog_models(catalog, "anthropic"));
    if models.is_empty() {
        models = resolve(
            legacy
                .and_then(|v| v["models"].as_array())
                .cloned()
                .unwrap_or_default(),
        );
    }
    if models.is_empty() {
        models = resolve(
            [
                ("opus", "Claude Opus"),
                ("sonnet", "Claude Sonnet"),
                ("haiku", "Claude Haiku"),
            ]
            .into_iter()
            .map(|(id, name)| json!({"id":id,"name":name}))
            .collect(),
        );
    }
    Route {
        id: "dsh:claude-cli".into(),
        name: "Claude CLI (claude -p)".into(),
        models,
        key: None,
        oauth: None,
        claude: true,
    }
}

impl Registry {
    pub fn load(profile: &str, catalog: Option<PathBuf>) -> Result<Self> {
        if !safe_id(profile) {
            bail!("NATIVE_PROFILE_NAME_INVALID");
        }
        let root = PathBuf::from(crate::inspect::dsh_home())
            .join("profiles")
            .join(profile);
        Self::load_with_transports(
            &root,
            catalog.or_else(catalog_dir).as_deref(),
            |env| {
                std::env::var(env)
                    .ok()
                    .filter(|v| !v.is_empty())
                    .or_else(|| crate::models::credential_ref(env))
            },
            crate::auth::native_oauth::load,
            crate::auth::command_on_path("claude"),
        )
    }
    #[cfg(test)]
    fn load_from(
        root: &Path,
        catalog: Option<&Path>,
        key: impl Fn(&str) -> Option<String>,
    ) -> Result<Self> {
        Self::load_with_transports(root, catalog, key, |_| Ok(None), false)
    }
    fn load_with_transports(
        root: &Path,
        catalog: Option<&Path>,
        key: impl Fn(&str) -> Option<String>,
        oauth: impl Fn(&str) -> Result<Option<crate::auth::native_oauth::Grant>>,
        claude_available: bool,
    ) -> Result<Self> {
        if !root.is_dir() {
            bail!("NATIVE_PROFILE_NOT_FOUND");
        }
        let mut routes = None;
        for name in ["cordis.yml", "cordis.patch.yml"] {
            let path = root.join(name);
            if path.exists() {
                // Do not surface parser errors containing configuration/secret values.
                let text =
                    read(&path).map_err(|_| anyhow::anyhow!("NATIVE_PROFILE_READ_FAILED"))?;
                if let Some(found) = crate::providers::native::read_routes(&text)
                    .map_err(|_| anyhow::anyhow!("NATIVE_PROFILE_LAYOUT_UNSUPPORTED"))?
                {
                    routes = Some(found);
                }
            }
        }
        let mut registry = Self::default();
        if routes.is_none() {
            registry
                .diagnostics
                .push("選択プロファイルに明示的なllm-pi-ai providers設定がありません".into());
        }
        let routes = routes.unwrap_or_default();
        let claude = claude_route(
            catalog,
            routes.get("anthropic").or_else(|| routes.get("claude-cli")),
            claude_available,
        );
        for (id, config) in routes {
            // Both the retired provider and the public CLI id are reserved for
            // the independent CLI route. Do not resolve any of their credentials.
            if matches!(id.as_str(), "anthropic" | "claude-cli") {
                continue;
            }
            if !safe_id(&id) {
                registry
                    .diagnostics
                    .push("未対応のプロバイダーIDを除外しました".into());
                continue;
            }
            let catalog_models = catalog_models(catalog, &id);
            let models = config
                .get("models")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_else(|| catalog_models.clone());
            let key_name = scalar(&config, "apiKeyEnv");
            let grant = if key_name.is_none() && id == "openai-codex" {
                oauth(&id)
            } else {
                Ok(None)
            };
            let oauth_error = grant.as_ref().err().map(|e| e.to_string());
            let grant = grant.ok().flatten();
            let auth = key_name
                .and_then(&key)
                .or_else(|| grant.as_ref().map(|g| g.access.clone()));
            let mut seen = HashSet::new();
            let mut resolved = vec![];
            for model in models {
                let Some(mid) = scalar(&model, "id") else {
                    continue;
                };
                if !seen.insert(mid.to_owned()) {
                    continue;
                }
                let base_model = catalog_models.iter().find(|v| scalar(v, "id") == Some(mid));
                let api = scalar(&config, "api")
                    .or_else(|| scalar(&model, "api"))
                    .or_else(|| base_model.and_then(|v| scalar(v, "api")))
                    .unwrap_or("");
                let base = scalar(&config, "baseURL")
                    .or_else(|| scalar(&model, "baseURL"))
                    .or_else(|| scalar(&model, "baseUrl"))
                    .or_else(|| base_model.and_then(|v| scalar(v, "baseUrl")))
                    .unwrap_or("");
                let oauth_endpoint = super::oauth::supported(&id, api, base);
                let transport_ok = config.get("transport").is_none()
                    || (id == "openai-codex"
                        && api == "openai-codex-responses"
                        && scalar(&config, "transport") == Some("sse"));
                let unavailable = if config["unsupported"] == true
                    || model["unsupported"] == true
                    || !transport_ok
                {
                    Some("このルートの追加設定にはnative未対応の項目があります".into())
                } else if oauth_endpoint && key_name.is_none() {
                    if let Some(error) = &oauth_error {
                        Some(format!(
                            "{error}: 共有済みCodex認証を更新しnative-webを再起動してください"
                        ))
                    } else {
                        grant.is_none().then(|| "共有済みCodex OAuth認証が必要です（rdsh authで共有を選択してください）".into())
                    }
                } else if endpoint(base, api, mid).is_err() || (grant.is_some() && !oauth_endpoint)
                {
                    Some("未対応APIまたは不正・未指定の接続先です".into())
                } else if key_name.is_none() || auth.is_none() {
                    Some("apiKeyEnvと既存の環境変数またはcredential refが必要です".into())
                } else {
                    None
                };
                let name = scalar(&model, "name")
                    .or_else(|| base_model.and_then(|v| scalar(v, "name")))
                    .unwrap_or(mid)
                    .to_owned();
                let max_tokens = model
                    .get("maxTokens")
                    .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
                    .or_else(|| base_model.and_then(|v| v["maxTokens"].as_u64()))
                    .unwrap_or(4096)
                    .clamp(1, 8192);
                let token_field = base_model
                    .and_then(|v| v["compat"]["maxTokensField"].as_str())
                    .filter(|s| ["max_tokens", "max_completion_tokens"].contains(s))
                    .unwrap_or(
                        if reqwest::Url::parse(base)
                            .ok()
                            .and_then(|u| u.host_str().map(str::to_owned))
                            .as_deref()
                            == Some("api.openai.com")
                        {
                            "max_completion_tokens"
                        } else {
                            "max_tokens"
                        },
                    )
                    .to_owned();
                resolved.push(Model {
                    id: mid.into(),
                    name,
                    api: api.into(),
                    base: base.into(),
                    max_tokens,
                    token_field,
                    unavailable,
                });
            }
            if resolved.is_empty() {
                registry.diagnostics.push(format!(
                    "{id}: 明示モデルまたはインストール済みJSONカタログがありません"
                ));
            }
            registry.routes.push(Route {
                id: format!("dsh:{id}"),
                name: scalar(&config, "displayName").unwrap_or(&id).into(),
                models: resolved,
                key: auth,
                oauth: grant,
                claude: false,
            });
        }
        registry.routes.push(claude);
        Ok(registry)
    }
    pub fn public(&self) -> Vec<Value> {
        self.routes.iter().map(|r| json!({"id":r.id,"name":if r.claude {r.name.clone()} else {format!("DSH登録 · {}",r.name)},"models":r.models.iter().map(|m| json!({"id":m.id,"name":m.name,"unavailable":m.unavailable})).collect::<Vec<_>>()})).collect()
    }
    pub fn allowed(&self, provider: &str, model: &str) -> bool {
        self.find(provider, model)
            .is_some_and(|(_, m)| m.unavailable.is_none())
    }
    fn find(&self, provider: &str, model: &str) -> Option<(&Route, &Model)> {
        // Old saved native selections are aliases only, never published routes.
        let provider = if provider == "dsh:anthropic" {
            "dsh:claude-cli"
        } else {
            provider
        };
        let route = self.routes.iter().find(|r| r.id == provider)?;
        Some((route, route.models.iter().find(|m| m.id == model)?))
    }
    #[cfg(test)]
    pub async fn generate(&self, provider: &str, model: &str, prompt: &str) -> Result<String> {
        Ok(self
            .generate_with_usage(provider, model, prompt)
            .await?
            .text)
    }
    pub async fn generate_turn_with_usage(
        &self,
        provider: &str,
        model: &str,
        prompt: &str,
    ) -> Result<super::usage::Generation> {
        let (route, selected) = self
            .find(provider, model)
            .filter(|(_, m)| m.unavailable.is_none())
            .ok_or_else(|| anyhow::anyhow!("NATIVE_MODEL_UNAVAILABLE"))?;
        if route.claude {
            return super::claude::generate_turn_with_usage(&selected.id, prompt).await;
        }
        self.generate_with_usage(provider, model, prompt).await
    }
    pub async fn generate_with_usage(
        &self,
        provider: &str,
        model: &str,
        prompt: &str,
    ) -> Result<super::usage::Generation> {
        let (route, model) = self
            .find(provider, model)
            .filter(|(_, m)| m.unavailable.is_none())
            .ok_or_else(|| anyhow::anyhow!("NATIVE_MODEL_UNAVAILABLE"))?;
        if route.claude {
            return super::claude::generate_with_usage(&model.id, prompt).await;
        }
        if let Some(grant) = &route.oauth {
            return super::oauth::generate_with_usage(grant, "openai-codex", &model.id, prompt)
                .await;
        }
        let url = endpoint(&model.base, &model.api, &model.id)?;
        let mut body = match model.api.as_str() {
            "openai-completions" => {
                json!({"model":model.id,"messages":[{"role":"user","content":prompt}],"stream":false})
            }
            "openai-responses" => {
                json!({"model":model.id,"input":prompt,"stream":false,"store":false,"max_output_tokens":model.max_tokens})
            }
            "anthropic-messages" => {
                json!({"model":model.id,"max_tokens":model.max_tokens,"messages":[{"role":"user","content":prompt}],"stream":false})
            }
            "google-generative-ai" => {
                json!({"contents":[{"role":"user","parts":[{"text":prompt}]}],"generationConfig":{"maxOutputTokens":model.max_tokens}})
            }
            _ => bail!("NATIVE_PROTOCOL_UNSUPPORTED"),
        };
        if model.api == "openai-completions" {
            body[&model.token_field] = json!(model.max_tokens);
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|_| anyhow::anyhow!("NATIVE_HTTP_SETUP_FAILED"))?;
        let mut request = client.post(url).header("content-type", "application/json");
        if let Some(key) = &route.key {
            request = if model.api == "google-generative-ai" {
                request.header("x-goog-api-key", key)
            } else if model.api == "anthropic-messages" {
                request
                    .header("x-api-key", key)
                    .header("anthropic-version", "2023-06-01")
            } else {
                request.bearer_auth(key)
            };
        }
        let mut response = request
            .body(serde_json::to_vec(&body)?)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("NATIVE_HTTP_REQUEST_FAILED"))?;
        if !response.status().is_success() {
            bail!("NATIVE_HTTP_STATUS_{}", response.status().as_u16());
        }
        let mut bytes = vec![];
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("NATIVE_HTTP_READ_FAILED"))?
        {
            if bytes.len() + chunk.len() > LIMIT {
                bail!("NATIVE_HTTP_OUTPUT_LIMIT");
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("NATIVE_HTTP_INVALID_JSON"))?;
        let text =
            match model.api.as_str() {
                "openai-completions" => value["choices"][0]["message"]["content"]
                    .as_str()
                    .map(str::to_owned),
                "openai-responses" => value["output"].as_array().map(|items| {
                    items
                        .iter()
                        .filter(|v| v["type"] == "message")
                        .filter_map(|v| v["content"].as_array())
                        .flatten()
                        .filter(|v| v["type"] == "output_text")
                        .filter_map(|v| v["text"].as_str())
                        .collect::<String>()
                }),
                "anthropic-messages" => value["content"].as_array().map(|items| {
                    items
                        .iter()
                        .filter(|v| v["type"] == "text")
                        .filter_map(|v| v["text"].as_str())
                        .collect::<String>()
                }),
                "google-generative-ai" => value["candidates"][0]["content"]["parts"]
                    .as_array()
                    .map(|parts| {
                        parts
                            .iter()
                            .filter(|v| v["thought"] != true)
                            .filter_map(|v| v["text"].as_str())
                            .collect::<String>()
                    }),
                _ => None,
            }
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("NATIVE_HTTP_NO_TEXT"))?;
        Ok(super::usage::Generation {
            text,
            usage: super::usage::Usage::parse(&model.api, &value),
        })
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::io::{Read, Write};
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "rdsh-shared-models-{}",
                crate::local_http::random_token().unwrap()
            ));
            std::fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn write(&self, name: &str, text: &str) {
            std::fs::write(self.0.join(name), text).unwrap();
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn oauth_grant() -> crate::auth::native_oauth::Grant {
        crate::auth::native_oauth::Grant {
            access: "synthetic-oauth".into(),
            expires: i64::MAX,
            account_id: Some("synthetic-account".into()),
        }
    }
    #[test]
    fn codex_sse_and_claude_print_routes_do_not_require_api_key_refs() {
        let root = Scratch::new();
        let codex = "- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        transport: sse\n        api: openai-codex-responses\n        baseURL: https://chatgpt.com/backend-api\n        models:\n          - id: gpt-test\n";
        root.write("cordis.patch.yml", codex);
        let r = Registry::load_with_transports(
            &root.0,
            None,
            |_| None,
            |_| Ok(Some(oauth_grant())),
            false,
        )
        .unwrap();
        assert!(r.allowed("dsh:openai-codex", "gpt-test"));
        assert!(!serde_json::to_string(&r.public())
            .unwrap()
            .contains("synthetic-oauth"));
        for changed in [
            codex.replace("transport: sse", "transport: websocket"),
            codex.replace("https://chatgpt.com/backend-api", "https://other.invalid"),
            codex.replace("transport: sse", "headers: {}"),
        ] {
            root.write("cordis.patch.yml", &changed);
            let r = Registry::load_with_transports(
                &root.0,
                None,
                |_| None,
                |_| Ok(Some(oauth_grant())),
                false,
            )
            .unwrap();
            assert!(!r.allowed("dsh:openai-codex", "gpt-test"));
        }
        let claude = codex
            .replace("openai-codex:", "anthropic:")
            .replace("        transport: sse\n", "")
            .replace("openai-codex-responses", "anthropic-messages")
            .replace(
                "https://chatgpt.com/backend-api",
                "https://api.anthropic.com",
            );
        root.write("cordis.patch.yml", &claude);
        let r = Registry::load_with_transports(
            &root.0,
            None,
            |_| None,
            |_| panic!("Claude must not read OAuth grants"),
            true,
        )
        .unwrap();
        assert!(r.allowed("dsh:anthropic", "gpt-test"));
        assert!(r.routes[0].claude);
        let missing =
            Registry::load_with_transports(&root.0, None, |_| None, |_| Ok(None), false).unwrap();
        assert!(!missing.allowed("dsh:anthropic", "gpt-test"));
        root.write(
            "cordis.patch.yml",
            &claude.replace(
                "        api:",
                "        apiKeyEnv: EXPLICIT_KEY\n        api:",
            ),
        );
        let explicit =
            Registry::load_with_transports(&root.0, None, |_| None, |_| Ok(None), true).unwrap();
        assert!(explicit.allowed("dsh:claude-cli", "gpt-test"));
        assert!(explicit.allowed("dsh:anthropic", "gpt-test"));
    }
    #[test]
    fn reported_transport_only_codex_and_empty_anthropic_routes_use_installed_catalog() {
        let root = Scratch::new();
        root.write("cordis.patch.yml", "- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        transport: sse\n      anthropic: {}\n");
        root.write("openai-codex.json", &json!({"openai-codex-responses":{"test-codex":{"id":"test-codex","api":"openai-codex-responses","baseUrl":"https://chatgpt.com/backend-api"}}}).to_string());
        root.write("anthropic.json", &json!({"anthropic-messages":{"test-claude":{"id":"test-claude","api":"anthropic-messages","baseUrl":"https://api.anthropic.com"}}}).to_string());
        let r = Registry::load_with_transports(
            &root.0,
            Some(&root.0),
            |_| None,
            |_| Ok(Some(oauth_grant())),
            true,
        )
        .unwrap();
        assert!(r.allowed("dsh:openai-codex", "test-codex"));
        assert!(r.allowed("dsh:anthropic", "test-claude"));
        assert!(r.diagnostics.is_empty());
    }
    #[test]
    fn anthropic_always_uses_cli_and_never_resolves_legacy_credentials() {
        let root = Scratch::new();
        root.write("cordis.patch.yml","- id: llm-pi-ai\n  config:\n    providers:\n      anthropic:\n        apiKeyEnv: ANTHROPIC_API_KEY\n        api: anthropic-messages\n        baseURL: https://legacy.invalid\n        headers: {}\n        transport: websocket\n        models:\n          - id: claude-custom\n            name: Legacy Model\n");
        let registry = Registry::load_with_transports(
            &root.0,
            None,
            |_| panic!("Anthropic must not resolve API key env or credential refs"),
            |_| panic!("Anthropic must not resolve DSH OAuth"),
            true,
        )
        .unwrap();
        let (route, model) = registry.find("dsh:claude-cli", "claude-custom").unwrap();
        assert!(route.claude);
        assert!(route.key.is_none());
        assert!(route.oauth.is_none());
        assert_eq!(model.api, "claude-cli");
        assert_eq!(model.base, "cli://claude");
        assert!(registry.allowed("dsh:anthropic", "claude-custom"));
        assert_eq!(
            registry
                .find("dsh:anthropic", "claude-custom")
                .unwrap()
                .0
                .id,
            "dsh:claude-cli"
        );
        let public = serde_json::to_string(&registry.public()).unwrap();
        assert!(public.contains("claude -p"));
        assert!(!public.contains("dsh:anthropic"));
        assert!(!public.contains("ANTHROPIC_API_KEY"));
        assert!(!public.contains("legacy.invalid"));
    }
    #[test]
    fn claude_catalog_discovery_survives_retiring_the_anthropic_api_route() {
        let root = Scratch::new();
        root.write("cordis.patch.yml","- id: llm-pi-ai\n  config:\n    providers:\n      test:\n        apiKeyEnv: TEST_KEY\n        api: openai-completions\n        baseURL: https://example.invalid/v1\n        models:\n          - id: test-model\n");
        root.write("anthropic.json",&json!({"anthropic-messages":{"claude-catalog":{"id":"claude-catalog","name":"Catalog Claude","api":"anthropic-messages","baseUrl":"https://legacy.invalid","headers":{"Authorization":"must-not-copy"}}}}).to_string());
        let registry = Registry::load_with_transports(
            &root.0,
            Some(&root.0),
            |name| {
                assert_eq!(name, "TEST_KEY");
                Some("synthetic-key".into())
            },
            |_| panic!("no OAuth route"),
            true,
        )
        .unwrap();
        assert!(registry.allowed("dsh:test", "test-model"));
        assert!(registry.allowed("dsh:claude-cli", "claude-catalog"));
        let (route, model) = registry.find("dsh:claude-cli", "claude-catalog").unwrap();
        assert_eq!(model.name, "Catalog Claude");
        assert!(route.key.is_none());
        assert!(route.oauth.is_none());
        assert_eq!(model.base, "cli://claude");
        assert!(!serde_json::to_string(&registry.public())
            .unwrap()
            .contains("dsh:anthropic"));
    }
    #[test]
    fn claude_route_without_api_configuration_uses_cli_aliases() {
        let root = Scratch::new();
        for contents in [
            None,
            Some("[]\n"),
            Some("- id: llm-pi-ai\n  config:\n    providers:\n      anthropic: {}\n"),
        ] {
            if let Some(contents) = contents {
                root.write("cordis.patch.yml", contents);
            }
            let registry = Registry::load_with_transports(
                &root.0,
                None,
                |_| panic!("no keys"),
                |_| panic!("no OAuth"),
                true,
            )
            .unwrap();
            for alias in ["opus", "sonnet", "haiku"] {
                assert!(registry.allowed("dsh:claude-cli", alias));
            }
            assert!(registry.routes.iter().all(|r| r.id != "dsh:anthropic"));
        }
        let missing = Registry::load_with_transports(
            &root.0,
            None,
            |_| panic!("no keys"),
            |_| panic!("no OAuth"),
            false,
        )
        .unwrap();
        assert!(!missing.allowed("dsh:claude-cli", "opus"));
    }
    #[test]
    fn installed_claude_catalog_overrides_legacy_models_and_http_metadata() {
        let root = Scratch::new();
        root.write("cordis.patch.yml","- id: llm-pi-ai\n  config:\n    providers:\n      anthropic:\n        apiKeyEnv: LEGACY_KEY\n        models:\n          - id: old-model\n");
        root.write("anthropic.json",&json!({"anthropic-messages":{"claude-current":{"id":"claude-current","api":"bad","baseUrl":"https://bad.invalid"}}}).to_string());
        let registry = Registry::load_with_transports(
            &root.0,
            Some(&root.0),
            |_| panic!("no keys"),
            |_| panic!("no OAuth"),
            true,
        )
        .unwrap();
        assert!(registry.allowed("dsh:claude-cli", "claude-current"));
        assert!(!registry.allowed("dsh:claude-cli", "old-model"));
    }
    fn patch(api: &str, base: &str) -> String {
        format!("- id: llm-pi-ai\n  config:\n    providers:\n      test:\n        api: {api}\n        baseURL: '{base}'\n        apiKeyEnv: TEST_API_KEY\n        models:\n          - id: test-model\n            name: Test Model\n")
    }
    pub fn mock(
        replies: Vec<(u16, Value)>,
    ) -> (String, std::thread::JoinHandle<Vec<(String, Value)>>) {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!(
            "http://127.0.0.1:{}/v1",
            listener.local_addr().unwrap().port()
        );
        let thread = std::thread::spawn(move || {
            let mut requests = vec![];
            for (code, reply) in replies {
                let start = std::time::Instant::now();
                // A connection that dies before its headers arrive is not the
                // request this reply belongs to. Wait for the next one instead of
                // spending the reply on a probe the client already abandoned.
                let (mut stream, mut bytes, end) = loop {
                    let accepted = loop {
                        match listener.accept() {
                            Ok(s) => break s,
                            Err(e)
                                if e.kind() == std::io::ErrorKind::WouldBlock
                                    && start.elapsed() < Duration::from_secs(10) =>
                            {
                                std::thread::sleep(Duration::from_millis(5))
                            }
                            Err(e) => panic!("mock accept: {e}"),
                        }
                    };
                    let (mut stream, _) = accepted;
                    // The listener is non-blocking so accept() can poll, and on
                    // Windows the accepted socket inherits that flag: read() then
                    // returns WSAEWOULDBLOCK instead of waiting out the timeout.
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    let mut last_error = None;
                    loop {
                        let mut b = [0; 4096];
                        match stream.read(&mut b) {
                            Ok(0) => break,
                            Ok(n) => bytes.extend_from_slice(&b[..n]),
                            Err(e) => {
                                eprintln!("mock: read stopped: {e} ({} bytes)", bytes.len());
                                last_error = Some(e);
                                break;
                            }
                        }
                        if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    match bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                        Some(end) => break (stream, bytes, end),
                        None => {
                            eprintln!("mock: request without headers: {last_error:?}");
                            assert!(
                                start.elapsed() < Duration::from_secs(10),
                                "mock: no complete request arrived"
                            );
                        }
                    }
                };
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length: usize = headers
                    .lines()
                    .find_map(|l| {
                        l.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|s| s.trim().parse().unwrap())
                    })
                    .expect("mock request needs a content-length");
                let body_start = end + 4;
                let body_end = body_start + length;
                // Headers and body can arrive in separate segments; a short body
                // here used to panic the mock thread and leave the client waiting.
                while bytes.len() < body_end {
                    let mut b = [0; 4096];
                    match stream.read(&mut b) {
                        Ok(0) => break,
                        Ok(n) => bytes.extend_from_slice(&b[..n]),
                        Err(e) => {
                            eprintln!("mock: body read stopped: {e} ({} bytes)", bytes.len());
                            break;
                        }
                    }
                }
                assert!(
                    bytes.len() >= body_end,
                    "mock: short body ({} of {length} bytes)",
                    bytes.len().saturating_sub(body_start)
                );
                requests.push((
                    String::from_utf8(bytes[..body_start].to_vec()).unwrap(),
                    serde_json::from_slice(&bytes[body_start..body_end]).unwrap(),
                ));
                let body = serde_json::to_vec(&reply).unwrap();
                // The client can be gone already (it reset the request); a closed
                // connection is not a reason to fail the test.
                let head = format!("HTTP/1.1 {code} Test\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n", body.len());
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
            requests
        });
        (url, thread)
    }
    pub fn registry(api: &str, base: &str) -> Registry {
        let root = Scratch::new();
        root.write("cordis.patch.yml", &patch(api, base));
        Registry::load_from(&root.0, None, |_| Some("synthetic-api-secret".into())).unwrap()
    }
    #[test]
    fn catalog_defaults_explicit_replacement_and_credentials_stay_private() {
        let root = Scratch::new();
        root.write("cordis.patch.yml","- id: llm-pi-ai\n  config:\n    providers:\n      test:\n        apiKeyEnv: TEST_API_KEY\n");
        root.write("test.json",&json!({"old-api":{"test-model":{"id":"test-model","api":"bad","baseUrl":"https://bad.invalid"}},"openai-completions":{"test-model":{"id":"test-model","name":"Catalog Name","api":"openai-completions","baseUrl":"https://example.invalid/v1"}}}).to_string());
        let r = Registry::load_from(&root.0, Some(&root.0), |name| {
            assert_eq!(name, "TEST_API_KEY");
            Some("synthetic-api-secret".into())
        })
        .unwrap();
        assert!(r.allowed("dsh:test", "test-model"));
        assert_eq!(r.routes[0].models[0].name, "Catalog Name");
        let public = serde_json::to_string(&r.public()).unwrap();
        assert!(!public.contains("synthetic-api-secret"));
        assert!(!public.contains("baseUrl"));
        root.write(
            "cordis.patch.yml",
            &patch("openai-completions", "https://other.invalid/v1")
                .replace("test-model", "new-model"),
        );
        let r = Registry::load_from(&root.0, Some(&root.0), |_| None).unwrap();
        assert_eq!(r.routes[0].models.len(), 1);
        assert_eq!(r.routes[0].models[0].id, "new-model");
        assert!(!r.allowed("dsh:test", "new-model"));
    }
    #[test]
    fn patch_replaces_config_and_unsupported_settings_fail_closed() {
        let root = Scratch::new();
        root.write(
            "cordis.yml",
            &patch("openai-completions", "https://base.invalid/v1"),
        );
        root.write(
            "cordis.patch.yml",
            &patch("openai-codex-responses", "https://patch.invalid/v1"),
        );
        let r = Registry::load_from(&root.0, None, |_| Some("key".into())).unwrap();
        assert!(!r.allowed("dsh:test", "test-model"));
        assert_eq!(r.routes[0].models[0].base, "https://patch.invalid/v1");
        root.write(
            "cordis.patch.yml",
            &patch("openai-completions", "https://patch.invalid/v1")
                .replace("        api:", "        reasoning: high\n        api:"),
        );
        let r = Registry::load_from(&root.0, None, |_| Some("key".into())).unwrap();
        assert!(!r.allowed("dsh:test", "test-model"));
        root.write(
            "cordis.patch.yml",
            &patch("openai-completions", "https://patch.invalid/v1")
                .replace("        api:", "        api: bad\n        api:"),
        );
        assert!(Registry::load_from(&root.0, None, |_| None).is_err());
    }
    #[tokio::test]
    async fn direct_http_protocols_and_error_redaction() {
        let _env_lock = crate::rustxng::tests::env_lock();
        let turn = r#"{"version":1,"text":"OK","toolCalls":[]}"#;
        for (api, path, response) in [
            (
                "openai-completions",
                "/v1/chat/completions",
                json!({"choices":[{"message":{"content":turn}}]}),
            ),
            (
                "openai-responses",
                "/v1/responses",
                json!({"output":[{"type":"message","content":[{"type":"output_text","text":turn}]}]}),
            ),
            (
                "anthropic-messages",
                "/v1/messages",
                json!({"content":[{"type":"text","text":turn}]}),
            ),
        ] {
            let (url, server) = mock(vec![(200, response)]);
            let r = registry(api, &url);
            assert_eq!(
                r.generate("dsh:test", "test-model", "USER INPUT")
                    .await
                    .unwrap(),
                turn
            );
            let requests = server.join().unwrap();
            let (headers, body) = &requests[0];
            assert!(headers.starts_with(&format!("POST {path} HTTP/1.1")));
            assert_eq!(body["model"], "test-model");
            if api == "openai-responses" {
                assert_eq!(body["input"], "USER INPUT");
                assert_eq!(body["max_output_tokens"], 4096);
                assert_eq!(body["store"], false);
            } else {
                assert_eq!(body["messages"][0]["content"], "USER INPUT");
                assert_eq!(body["max_tokens"], 4096);
            }

            assert!(!body.to_string().contains("synthetic-api-secret"));
            if api == "anthropic-messages" {
                assert!(headers.contains("x-api-key: synthetic-api-secret"));
                assert!(headers.contains("anthropic-version: 2023-06-01"));
            } else {
                assert!(headers.contains("authorization: Bearer synthetic-api-secret"));
            }
        }
        for code in [302, 401, 429] {
            let (url, server) = mock(vec![(
                code,
                json!({"error":"synthetic-api-secret private body"}),
            )]);
            let r = registry("openai-completions", &url);
            assert_eq!(
                r.generate("dsh:test", "test-model", "input")
                    .await
                    .unwrap_err()
                    .to_string(),
                format!("NATIVE_HTTP_STATUS_{code}")
            );
            server.join().unwrap();
        }
    }
    #[test]
    fn endpoint_rejects_credentials_queries_and_unknown_protocols() {
        for base in [
            "https://user:secret@example.invalid/v1",
            "file:///tmp/key",
            "https://example.invalid/v1?key=secret",
            "https://example.invalid/v1#fragment",
        ] {
            assert!(endpoint(base, "openai-completions", "test-model").is_err());
        }
        assert!(endpoint(
            "https://example.invalid",
            "openai-codex-responses",
            "test-model"
        )
        .is_err());
    }
    #[tokio::test]
    async fn google_direct_transport_keeps_key_in_header_and_filters_thought_parts() {
        let _env_lock = crate::rustxng::tests::env_lock();
        let turn = r#"{"version":1,"text":"Google OK","toolCalls":[]}"#;
        let (url, server) = mock(vec![(
            200,
            json!({"candidates":[{"content":{"parts":[{"thought":true,"text":"private reasoning"},{"text":turn}]}}]}),
        )]);
        let r = registry("google-generative-ai", &url);
        assert_eq!(
            r.generate("dsh:test", "test-model", "USER INPUT")
                .await
                .unwrap(),
            turn
        );
        let requests = server.join().unwrap();
        assert!(requests[0]
            .0
            .starts_with("POST /v1/models/test-model:generateContent HTTP/1.1"));
        assert!(requests[0]
            .0
            .contains("x-goog-api-key: synthetic-api-secret"));
        assert_eq!(
            requests[0].1["contents"][0]["parts"][0]["text"],
            "USER INPUT"
        );
        assert_eq!(requests[0].1["generationConfig"]["maxOutputTokens"], 4096);
        assert!(!requests[0].1.to_string().contains("synthetic-api-secret"));
        assert!(endpoint(&url, "google-generative-ai", "../bad").is_err());
    }
}
