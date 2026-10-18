//! Hosted REST contract: https://docs.ollama.com/capabilities/web-search
use super::Hit;
use crate::locale::Locale;
use std::time::Duration;

pub(super) const ENDPOINT: &str = "https://ollama.com/api/web_search";
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

fn message(locale: Locale, en: &str, zh: &str, ja: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "Ollama Web Search: {}",
        match locale {
            Locale::English => en,
            Locale::Chinese => zh,
            Locale::Japanese => ja,
        }
    )
}

fn credential_error(locale: Locale) -> anyhow::Error {
    message(
        locale,
        "set a valid OLLAMA_API_KEY before using --provider ollama",
        "使用 --provider ollama 前请设置有效的 OLLAMA_API_KEY",
        "--provider ollama を使う前に有効な OLLAMA_API_KEY を設定してください",
    )
}

pub(super) fn search(query: &str, limit: usize, locale: Locale) -> anyhow::Result<Vec<Hit>> {
    let key = std::env::var("OLLAMA_API_KEY").map_err(|_| credential_error(locale))?;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(fetch(
            ENDPOINT,
            &key,
            query,
            limit,
            locale,
            Duration::from_secs(15),
        ))
}

// Only tests can select a different endpoint. Do not route the search credential
// through OLLAMA_HOST, inference profiles, or URLs returned by search results.
async fn fetch(
    endpoint: &str,
    key: &str,
    query: &str,
    limit: usize,
    locale: Locale,
    timeout: Duration,
) -> anyhow::Result<Vec<Hit>> {
    use reqwest::header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE};
    let key = key.trim();
    anyhow::ensure!(
        !key.is_empty() && !key.chars().any(|c| c.is_control() || c.is_whitespace()),
        "{}",
        credential_error(locale)
    );
    let mut authorization =
        HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| credential_error(locale))?;
    authorization.set_sensitive(true);
    let network_error = || {
        message(
            locale,
            "request failed or timed out; check your network and try again",
            "请求失败或超时；请检查网络后重试",
            "リクエストが失敗またはタイムアウトしました。ネットワークを確認して再試行してください",
        )
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .user_agent(format!("rdsh/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| network_error())?;
    let mut response = client
        .post(endpoint)
        .header(AUTHORIZATION, authorization)
        .header(CONTENT_TYPE, "application/json")
        .body(serde_json::json!({"query": query, "max_results": limit.clamp(1, 10)}).to_string())
        .send()
        .await
        .map_err(|_| network_error())?;
    // Never print remote error bodies: they can echo credentials or queries.
    let status = response.status();
    anyhow::ensure!(
        status.is_success(),
        "Ollama Web Search: HTTP {}",
        status.as_u16()
    );
    let too_large = || {
        message(
            locale,
            "response exceeds 2 MiB",
            "响应超过 2 MiB",
            "レスポンスが 2 MiB を超えました",
        )
    };
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BODY_BYTES as u64)
    {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| network_error())? {
        if body.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    #[derive(serde::Deserialize)]
    struct ResultItem {
        title: String,
        url: String,
        content: String,
    }
    #[derive(serde::Deserialize)]
    struct Response {
        results: Vec<ResultItem>,
    }
    let response: Response = serde_json::from_slice(&body).map_err(|_| {
        message(
            locale,
            "invalid search response (expected results with title, url and content)",
            "搜索响应无效（需要 results 以及 title、url 和 content）",
            "検索レスポンスが不正です（results と title、url、content が必要です）",
        )
    })?;
    Ok(response
        .results
        .into_iter()
        .take(limit.clamp(1, 10))
        .map(|hit| Hit {
            title: hit.title,
            url: hit.url,
            content: hit.content,
        })
        .collect())
}

#[cfg(test)]
mod tests;
