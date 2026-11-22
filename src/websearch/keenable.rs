//! Keenable's keyless and authenticated search endpoints.
use super::{strip_control, Hit};
use crate::locale::Locale;
use reqwest::header::{HeaderValue, CONTENT_TYPE, RETRY_AFTER};
use std::time::Duration;

pub(super) const ENDPOINT: &str = "https://api.keenable.ai/v1/search";
pub(super) const PUBLIC_ENDPOINT: &str = "https://api.keenable.ai/v1/search/public";
const APP_TITLE: &str = "rdsh";
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESULTS: usize = 50;
const MAX_RATE_LIMIT_RETRIES: usize = 1;
const MAX_SERVER_ERROR_RETRIES: usize = 3;
const SERVER_ERROR_BACKOFF_SECONDS: [u64; MAX_SERVER_ERROR_RETRIES] = [1, 2, 4];
const MAX_RETRY_AFTER_SECONDS: u64 = 60;

fn message(locale: Locale, detail: &str) -> anyhow::Error {
    let disclosure = crate::locale::pick(locale, "This provider sends queries to Keenable. Keyless calls use an IP quota, consume no credits, and are logged with the query, IP address, and app title rdsh; keyed calls draw from organization credits.", "此提供方会将查询发送到 Keenable。无密钥请求使用 IP 配额、不消耗额度，并会记录查询、IP 地址和应用标题 rdsh；带密钥请求会消耗组织额度。", "このプロバイダーは検索語を Keenable に送信します。キーなしの呼び出しは IP 単位の上限を使い、クレジットを消費せず、検索語、IP アドレス、アプリ名 rdsh が記録されます。キー付きの呼び出しは組織のクレジットを消費します。");
    let prefix = crate::locale::pick(
        locale,
        "Keenable Web Search",
        "Keenable 网页搜索",
        "Keenable Web 検索",
    );
    anyhow::anyhow!("{prefix}: {detail}. {disclosure}")
}

fn credential_error(locale: Locale) -> anyhow::Error {
    message(
        locale,
        crate::locale::pick(locale, "KEENABLE_API_KEY contains invalid HTTP header characters; no request was sent", "KEENABLE_API_KEY 包含无效的 HTTP 请求头字符；请求尚未发送", "KEENABLE_API_KEY に無効な HTTP ヘッダー文字が含まれています。リクエストは送信されていません"),
    )
}

fn normalize_key(key: Option<&str>, locale: Locale) -> anyhow::Result<Option<String>> {
    let Some(key) = key else {
        return Ok(None);
    };
    let key = key.trim();
    if key.is_empty() {
        return Ok(None);
    }
    if key
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(credential_error(locale));
    }
    HeaderValue::from_str(key).map_err(|_| credential_error(locale))?;
    Ok(Some(key.to_owned()))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RetryAfterSeconds {
    MissingOrInvalid,
    Seconds(u64),
    Overflow,
}

fn retry_after_seconds(response: &reqwest::Response) -> RetryAfterSeconds {
    let Some(header) = response.headers().get(RETRY_AFTER) else {
        return RetryAfterSeconds::MissingOrInvalid;
    };
    let Ok(value) = header.to_str() else {
        return RetryAfterSeconds::MissingOrInvalid;
    };
    let value = value.trim();
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return RetryAfterSeconds::MissingOrInvalid;
    }
    match value.parse() {
        Ok(seconds) => RetryAfterSeconds::Seconds(seconds),
        Err(_) => RetryAfterSeconds::Overflow,
    }
}

fn server_error_wait_seconds(retries: usize, retry_after: Option<u64>) -> u64 {
    let backoff_floor = SERVER_ERROR_BACKOFF_SECONDS[retries];
    retry_after.map_or(backoff_floor, |seconds| backoff_floor.max(seconds))
}

fn retry_after_overflow_detail(locale: Locale, status: u16) -> String {
    crate::locale::pick(locale, format!(
        "HTTP {status}; Retry-After exceeds the supported numeric range. No further automatic retry will be made; wait for the full Retry-After delay from the response before retrying manually"
    ), format!(
        "HTTP {status}；Retry-After 数值超出支持范围。不再执行自动重试；请按响应中的 Retry-After 完整等待后再手动重试"
    ), format!(
        "HTTP {status}；Retry-After の数値が対応範囲を超えています。これ以上の自動再試行は行いません。レスポンスの指定時間をすべて待ってから手動で再試行してください"
    ))
}

fn rate_limit_error(
    locale: Locale,
    retry_after: RetryAfterSeconds,
    retry_limit_reached: bool,
) -> anyhow::Error {
    let detail = crate::locale::pick(locale, match retry_after {
        RetryAfterSeconds::Seconds(seconds) if seconds > MAX_RETRY_AFTER_SECONDS => format!(
            "HTTP 429 rate limit exceeded; Keenable says to wait {seconds} seconds. Automatic waits are limited to {MAX_RETRY_AFTER_SECONDS} seconds, so retry manually after the full wait"
        ),
        RetryAfterSeconds::Seconds(seconds) if retry_limit_reached => format!(
            "HTTP 429 rate limit exceeded again; retry after {seconds} seconds (automatic retry limit reached)"
        ),
        RetryAfterSeconds::Seconds(seconds) => {
            format!("HTTP 429 rate limit exceeded; retry after {seconds} seconds")
        }
        RetryAfterSeconds::MissingOrInvalid => format!(
            "HTTP 429 rate limit exceeded; Retry-After is missing or invalid. Wait at least {MAX_RETRY_AFTER_SECONDS} seconds, then retry manually"
        ),
        RetryAfterSeconds::Overflow => retry_after_overflow_detail(locale, 429),
    }, match retry_after {
        RetryAfterSeconds::Seconds(seconds) if seconds > MAX_RETRY_AFTER_SECONDS => format!(
            "HTTP 429 速率受限；Keenable 指定等待 {seconds} 秒。自动等待上限为 {MAX_RETRY_AFTER_SECONDS} 秒，请完整等待后手动重试"
        ),
        RetryAfterSeconds::Seconds(seconds) if retry_limit_reached => format!(
            "再次遇到 HTTP 429；请等待 {seconds} 秒后手动重试（自动重试次数已用尽）"
        ),
        RetryAfterSeconds::Seconds(seconds) => {
            format!("HTTP 429 速率受限；请等待 {seconds} 秒后重试")
        }
        RetryAfterSeconds::MissingOrInvalid => format!(
            "HTTP 429 速率受限；Retry-After 缺失或无效。请至少等待 {MAX_RETRY_AFTER_SECONDS} 秒后手动重试"
        ),
        RetryAfterSeconds::Overflow => retry_after_overflow_detail(locale, 429),
    }, match retry_after {
        RetryAfterSeconds::Seconds(seconds) if seconds > MAX_RETRY_AFTER_SECONDS => format!(
            "HTTP 429 のレート制限です。Keenable の指定は {seconds} 秒です。自動待機は最大 {MAX_RETRY_AFTER_SECONDS} 秒のため、指定時間を待ってから手動で再試行してください"
        ),
        RetryAfterSeconds::Seconds(seconds) if retry_limit_reached => format!(
            "HTTP 429 が再発しました。{seconds} 秒待ってから手動で再試行してください（自動再試行回数の上限）"
        ),
        RetryAfterSeconds::Seconds(seconds) => {
            format!("HTTP 429 のレート制限です。{seconds} 秒待って再試行してください")
        }
        RetryAfterSeconds::MissingOrInvalid => format!(
            "HTTP 429 のレート制限です。Retry-After がないか不正です。少なくとも {MAX_RETRY_AFTER_SECONDS} 秒待ってから手動で再試行してください"
        ),
        RetryAfterSeconds::Overflow => retry_after_overflow_detail(locale, 429),
    });
    message(locale, &detail)
}

fn server_error_error(
    locale: Locale,
    status: reqwest::StatusCode,
    retry_after: RetryAfterSeconds,
    retries: usize,
) -> anyhow::Error {
    let status = status.as_u16();
    let exhausted = retries >= MAX_SERVER_ERROR_RETRIES;
    let detail = crate::locale::pick(locale, match retry_after {
        RetryAfterSeconds::Seconds(seconds) if seconds > MAX_RETRY_AFTER_SECONDS => format!(
            "HTTP {status} server error; Keenable requests a wait of {seconds} seconds. Automatic waits are limited to {MAX_RETRY_AFTER_SECONDS} seconds, so retry manually after the full wait"
        ),
        RetryAfterSeconds::Seconds(seconds) if exhausted => format!(
            "HTTP {status} persisted after {retries} retries; wait {seconds} seconds before retrying manually (retry limit reached)"
        ),
        RetryAfterSeconds::MissingOrInvalid if exhausted => format!(
            "HTTP {status} persisted after {retries} retries; no valid Retry-After was provided. Retry manually later"
        ),
        RetryAfterSeconds::Overflow => retry_after_overflow_detail(locale, status),
        RetryAfterSeconds::Seconds(seconds) => {
            format!("HTTP {status} server error; retry after {seconds} seconds")
        }
        RetryAfterSeconds::MissingOrInvalid => {
            format!("HTTP {status} server error; retry manually later")
        }
    }, match retry_after {
        RetryAfterSeconds::Seconds(seconds) if seconds > MAX_RETRY_AFTER_SECONDS => format!(
            "HTTP {status} 服务器错误；Keenable 指定等待 {seconds} 秒。自动等待上限为 {MAX_RETRY_AFTER_SECONDS} 秒，请等待完整时长后手动重试"
        ),
        RetryAfterSeconds::Seconds(seconds) if exhausted => format!(
            "HTTP {status} 在 {retries} 次重试后仍失败；请等待 {seconds} 秒后手动重试（已达重试上限）"
        ),
        RetryAfterSeconds::MissingOrInvalid if exhausted => format!(
            "HTTP {status} 在 {retries} 次重试后仍失败；Retry-After 缺失或无效，请稍后手动重试"
        ),
        RetryAfterSeconds::Overflow => retry_after_overflow_detail(locale, status),
        RetryAfterSeconds::Seconds(seconds) => {
            format!("HTTP {status} 服务器错误；请等待 {seconds} 秒后重试")
        }
        RetryAfterSeconds::MissingOrInvalid => {
            format!("HTTP {status} 服务器错误；请稍后手动重试")
        }
    }, match retry_after {
        RetryAfterSeconds::Seconds(seconds) if seconds > MAX_RETRY_AFTER_SECONDS => format!(
            "HTTP {status} のサーバーエラーです。Keenable の指定は {seconds} 秒です。自動待機は最大 {MAX_RETRY_AFTER_SECONDS} 秒のため、指定時間を待ってから手動で再試行してください"
        ),
        RetryAfterSeconds::Seconds(seconds) if exhausted => format!(
            "HTTP {status} は {retries} 回再試行しても解消しませんでした。{seconds} 秒待ってから手動で再試行してください（再試行上限）"
        ),
        RetryAfterSeconds::MissingOrInvalid if exhausted => format!(
            "HTTP {status} は {retries} 回再試行しても解消しませんでした。Retry-After がないか不正です。後ほど手動で再試行してください"
        ),
        RetryAfterSeconds::Overflow => retry_after_overflow_detail(locale, status),
        RetryAfterSeconds::Seconds(seconds) => {
            format!("HTTP {status} のサーバーエラーです。{seconds} 秒待って再試行してください")
        }
        RetryAfterSeconds::MissingOrInvalid => {
            format!("HTTP {status} のサーバーエラーです。後ほど手動で再試行してください")
        }
    });
    message(locale, &detail)
}

fn payment_required_error(locale: Locale, has_api_key: bool) -> anyhow::Error {
    let detail = match (locale, has_api_key) {
        (Locale::English, true) => {
            "HTTP 402 insufficient_credits; add credits to the organization before retrying"
        }
        (Locale::English, false) => {
            "HTTP 402; resolve the service payment requirement before retrying"
        }
        (Locale::Chinese, true) => "HTTP 402 insufficient_credits；请为组织补充额度后再重试",
        (Locale::Chinese, false) => "HTTP 402；请先处理服务的付费要求再重试",
        (Locale::Japanese, true) => {
            "HTTP 402 insufficient_credits；組織クレジットを追加してから再試行してください"
        }
        (Locale::Japanese, false) => {
            "HTTP 402；サービスの支払い要件を解消してから再試行してください"
        }
    };
    message(locale, detail)
}

pub(super) fn search(
    query: &str,
    limit: usize,
    locale: Locale,
) -> anyhow::Result<(String, Vec<Hit>)> {
    let raw_key = match std::env::var_os("KEENABLE_API_KEY") {
        Some(value) => Some(value.into_string().map_err(|_| credential_error(locale))?),
        None => None,
    };
    let key = normalize_key(raw_key.as_deref(), locale)?;
    let endpoint = if key.is_some() {
        ENDPOINT
    } else {
        PUBLIC_ENDPOINT
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| message(locale, "the HTTP runtime failed to start"))?;
    let hits = runtime.block_on(fetch(
        endpoint,
        key.as_deref(),
        query,
        limit,
        locale,
        REQUEST_TIMEOUT,
    ))?;
    Ok((endpoint.to_string(), hits))
}

// Production supplies only the fixed Keenable endpoints. The endpoint parameter
// is private to this module so unit tests can use a local HTTP fixture.
async fn fetch(
    endpoint: &str,
    key: Option<&str>,
    query: &str,
    limit: usize,
    locale: Locale,
    timeout: Duration,
) -> anyhow::Result<Vec<Hit>> {
    let key = normalize_key(key, locale)?;
    let mut key_header = key
        .as_deref()
        .map(HeaderValue::from_str)
        .transpose()
        .map_err(|_| credential_error(locale))?;
    if let Some(value) = &mut key_header {
        value.set_sensitive(true);
    }
    let title_header = HeaderValue::from_str(APP_TITLE)
        .map_err(|_| message(locale, "the app title is not a valid HTTP header"))?;

    let network_error = || {
        message(
            locale,
            crate::locale::pick(locale, "the request failed or timed out; check your network and try again", "请求失败或超时；请检查网络后重试", "リクエストが失敗またはタイムアウトしました。ネットワークを確認して再試行してください"),
        )
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(timeout)
        .timeout(timeout)
        .user_agent(format!("rdsh/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| network_error())?;

    let body = serde_json::json!({
        "query": query,
        "max_results": limit.clamp(1, MAX_RESULTS),
    });
    let mut rate_limit_retries = 0;
    let mut server_error_retries = 0;
    let mut response = loop {
        let mut request = client
            .post(endpoint)
            .header(CONTENT_TYPE, "application/json")
            .json(&body);
        if let Some(key) = &key_header {
            let mut key = key.clone();
            key.set_sensitive(true);
            request = request.header("X-API-Key", key);
        } else {
            request = request.header("X-Keenable-Title", title_header.clone());
        }
        let response = request.send().await.map_err(|_| network_error())?;
        let status = response.status();

        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let retry_after = retry_after_seconds(&response);
            if rate_limit_retries < MAX_RATE_LIMIT_RETRIES {
                if let RetryAfterSeconds::Seconds(seconds) = retry_after {
                    if seconds <= MAX_RETRY_AFTER_SECONDS {
                        drop(response);
                        rate_limit_retries += 1;
                        tokio::time::sleep(Duration::from_secs(seconds)).await;
                        continue;
                    }
                }
            }
            return Err(rate_limit_error(
                locale,
                retry_after,
                rate_limit_retries >= MAX_RATE_LIMIT_RETRIES,
            ));
        }
        if status == reqwest::StatusCode::PAYMENT_REQUIRED {
            return Err(payment_required_error(locale, key_header.is_some()));
        }
        if status.is_server_error() {
            let retry_after = retry_after_seconds(&response);
            let retry_after_seconds = match retry_after {
                RetryAfterSeconds::Seconds(seconds) => Some(seconds),
                RetryAfterSeconds::MissingOrInvalid => None,
                RetryAfterSeconds::Overflow => {
                    return Err(server_error_error(
                        locale,
                        status,
                        retry_after,
                        server_error_retries,
                    ));
                }
            };
            if retry_after_seconds.is_some_and(|seconds| seconds > MAX_RETRY_AFTER_SECONDS)
                || server_error_retries >= MAX_SERVER_ERROR_RETRIES
            {
                return Err(server_error_error(
                    locale,
                    status,
                    retry_after,
                    server_error_retries,
                ));
            }
            let wait_seconds = server_error_wait_seconds(server_error_retries, retry_after_seconds);
            drop(response);
            server_error_retries += 1;
            tokio::time::sleep(Duration::from_secs(wait_seconds)).await;
            continue;
        }
        if !status.is_success() {
            return Err(message(locale, &format!("HTTP {}", status.as_u16())));
        }
        break response;
    };
    let too_large = || message(locale, "response exceeds 2 MiB");
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BODY_BYTES as u64)
    {
        return Err(too_large());
    }
    let mut response_body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| network_error())? {
        if response_body.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
            return Err(too_large());
        }
        response_body.extend_from_slice(&chunk);
    }

    #[derive(serde::Deserialize)]
    struct ResultItem {
        title: String,
        url: String,
        snippet: String,
    }
    #[derive(serde::Deserialize)]
    struct SearchResponse {
        results: Vec<ResultItem>,
    }
    let response: SearchResponse = serde_json::from_slice(&response_body).map_err(|_| {
        message(
            locale,
            match locale {
                Locale::English => {
                    "invalid response; expected results with title, url, and snippet"
                }
                Locale::Chinese => "响应无效；需要包含 title、url 和 snippet 的 results",
                Locale::Japanese => {
                    "レスポンスが不正です。title、url、snippet を含む results が必要です"
                }
            },
        )
    })?;
    Ok(response
        .results
        .into_iter()
        .take(limit.clamp(1, MAX_RESULTS))
        .map(|hit| Hit {
            title: strip_control(&hit.title),
            url: strip_control(&hit.url),
            content: strip_control(&hit.snippet),
        })
        .collect())
}

#[cfg(test)]
mod tests;
