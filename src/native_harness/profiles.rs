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
impl Registry {
    pub fn load(profile: &str, catalog: Option<PathBuf>) -> Result<Self> {
        if !safe_id(profile) {
            bail!("NATIVE_PROFILE_NAME_INVALID");
        }
        let root = PathBuf::from(crate::inspect::dsh_home())
            .join("profiles")
            .join(profile);
        Self::load_from(&root, catalog.or_else(catalog_dir).as_deref(), |env| {
            std::env::var(env)
                .ok()
                .filter(|v| !v.is_empty())
                .or_else(|| crate::models::credential_ref(env))
        })
    }
    fn load_from(
        root: &Path,
        catalog: Option<&Path>,
        key: impl Fn(&str) -> Option<String>,
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
        let Some(routes) = routes else {
            return Ok(Self {
                diagnostics: vec![
                    "選択プロファイルに明示的なllm-pi-ai providers設定がありません".into(),
                ],
                ..Self::default()
            });
        };
        let mut registry = Self::default();
        for (id, config) in routes {
            if !safe_id(&id) {
                registry
                    .diagnostics
                    .push("未対応のプロバイダーIDを除外しました".into());
                continue;
            }
            let catalog_models: Vec<Value> = catalog
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
                .unwrap_or_default();
            let models = config
                .get("models")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_else(|| catalog_models.clone());
            let key_name = scalar(&config, "apiKeyEnv");
            let auth = key_name.and_then(&key);
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
                let unavailable = if config["unsupported"] == true || model["unsupported"] == true {
                    Some("このルートの追加設定にはnative未対応の項目があります".into())
                } else if endpoint(base, api, mid).is_err() {
                    Some("未対応APIまたは不正・未指定の接続先です（OAuth専用APIは未対応）".into())
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
            });
        }
        Ok(registry)
    }
    pub fn public(&self) -> Vec<Value> {
        self.routes.iter().map(|r| json!({"id":r.id,"name":format!("DSH登録 · {}",r.name),"models":r.models.iter().map(|m| json!({"id":m.id,"name":m.name,"unavailable":m.unavailable})).collect::<Vec<_>>()})).collect()
    }
    pub fn allowed(&self, provider: &str, model: &str) -> bool {
        self.find(provider, model)
            .is_some_and(|(_, m)| m.unavailable.is_none())
    }
    fn find(&self, provider: &str, model: &str) -> Option<(&Route, &Model)> {
        let route = self.routes.iter().find(|r| r.id == provider)?;
        Some((route, route.models.iter().find(|m| m.id == model)?))
    }
    pub async fn generate(&self, provider: &str, model: &str, prompt: &str) -> Result<String> {
        let (route, model) = self
            .find(provider, model)
            .filter(|(_, m)| m.unavailable.is_none())
            .ok_or_else(|| anyhow::anyhow!("NATIVE_MODEL_UNAVAILABLE"))?;
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
        Ok(text)
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
                let (mut stream, _) = loop {
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
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = vec![];
                let (end, length) = loop {
                    let mut b = [0; 4096];
                    let n = stream.read(&mut b).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&b[..n]);
                    if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let length: usize = headers
                            .lines()
                            .find_map(|l| {
                                l.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|s| s.trim().parse().unwrap())
                            })
                            .unwrap();
                        break (end + 4, length);
                    }
                };
                while bytes.len() < end + length {
                    let mut b = [0; 4096];
                    let n = stream.read(&mut b).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&b[..n]);
                }
                requests.push((
                    String::from_utf8(bytes[..end].to_vec()).unwrap(),
                    serde_json::from_slice(&bytes[end..end + length]).unwrap(),
                ));
                let body = serde_json::to_vec(&reply).unwrap();
                write!(stream,"HTTP/1.1 {code} Test\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",body.len()).unwrap();
                stream.write_all(&body).unwrap();
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
