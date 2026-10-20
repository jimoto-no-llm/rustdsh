//! `rdsh search-web`: SearXNG by default, or explicitly selected Ollama search.
//! SearXNG needs no API key and retains its HTML-based HTTP client; a local
//! rustxng sidecar is the same protocol, so it rides the same client. Ollama
//! uses the hosted HTTPS API with `OLLAMA_API_KEY`; providers never fall back
//! to one another, so a local search cannot silently become a cloud request.

mod ollama;

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
pub enum Provider {
    Searxng,
    Ollama,
}

/// Which SearXNG-compatible engine `search-web` should resolve.
///
/// `Auto` keeps the historical environment order and only then tries a local
/// rustxng. An explicit `Searxng` never spawns rustxng, so a scripted run
/// keeps today's behaviour exactly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum Engine {
    Auto,
    Searxng,
    Rustxng,
}

/// How one engine serves results: SearXNG renders result markup, while
/// rustxng keeps that markup incompatible on purpose and publishes JSON.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Format {
    Html,
    Json,
}

fn format_for(engine: Engine) -> Format {
    match engine {
        Engine::Rustxng => Format::Json,
        Engine::Searxng | Engine::Auto => Format::Html,
    }
}

/// Parse the JSON result document rustxng serves (and SearXNG serves when the
/// json format is enabled): {"results":[{"url","title","content"}...]}.
fn parse_json(body: &str, limit: usize) -> anyhow::Result<Vec<Hit>> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|error| anyhow::anyhow!("the search engine did not return JSON: {error}"))?;
    let Some(results) = value.get("results").and_then(serde_json::Value::as_array) else {
        anyhow::bail!("the search engine JSON has no results array");
    };
    let mut hits = Vec::new();
    for item in results {
        let Some(url) = item.get("url").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if url.is_empty() || !url.starts_with("http") {
            continue;
        }
        let title = item
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(url);
        let content = item
            .get("content")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        hits.push(Hit {
            title: title.trim().to_string(),
            url: url.to_string(),
            content: content.trim().to_string(),
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

pub fn help(locale: crate::locale::Locale) -> &'static str {
    match locale {
        crate::locale::Locale::English => "search-web is on by default; disable with: rdsh features off search-web\nOllama: set OLLAMA_API_KEY, then use --provider ollama (up to 10 results).\nEngines: --engine auto|searxng|rustxng. auto resolves SEARXNG_URL, then RUSTXNG_URL, then a local rustxng, then http://127.0.0.1:8888.\nLocal rustxng: rdsh rustxng install fetches the latest release into ~/.local/bin (or set RUSTXNG_BIN); rdsh starts the sidecar itself; --engine searxng never spawns it.\nWeb Search API service guide: Tavily https://www.tavily.com/\nTavily quickstart: https://docs.tavily.com/documentation/quickstart\nBuilt-in providers: searxng, ollama. Tavily is a service reference.\nSearXNG down? --auto-start runs docker-compose.searxng.yml (loopback only).\nDocs: https://github.com/jimoto-no-llm/rustdsh/blob/main/docs/WEB-SEARCH.md",
        crate::locale::Locale::Chinese => "search-web 默认开启；如需关闭：rdsh features off search-web\nOllama：设置 OLLAMA_API_KEY 后使用 --provider ollama（最多10条结果）。\n搜索引擎：--engine auto|searxng|rustxng。auto 依次使用 SEARXNG_URL、RUSTXNG_URL、本地 rustxng，最后是 http://127.0.0.1:8888。\n本地 rustxng：rdsh rustxng install 会把最新版安装到 ~/.local/bin（也可设置 RUSTXNG_BIN）；由 rdsh 启动该服务；--engine searxng 不会启动它。\nWeb Search API 服务指南：Tavily https://www.tavily.com/\nTavily 入门：https://docs.tavily.com/documentation/quickstart\n内置提供方：searxng、ollama。Tavily 为服务介绍。\nSearXNG 未启动时：--auto-start 会运行 docker-compose.searxng.yml（仅回环地址）。\n文档：https://github.com/jimoto-no-llm/rustdsh/blob/main/docs/WEB-SEARCH.md",
        crate::locale::Locale::Japanese => "search-web は既定で有効です。無効化: rdsh features off search-web\nOllama: OLLAMA_API_KEY を設定し --provider ollama を指定（最大10件）。\nエンジン: --engine auto|searxng|rustxng。auto は SEARXNG_URL、RUSTXNG_URL、ローカル rustxng、http://127.0.0.1:8888 の順に解決します。\nローカル rustxng: rdsh rustxng install が最新リリースを ~/.local/bin へ導入します（RUSTXNG_BIN でも可）。rdsh がサイドカーを起動します。--engine searxng は起動しません。\nWeb Search API サービスの案内: Tavily https://www.tavily.com/\nTavily 入門: https://docs.tavily.com/documentation/quickstart\n組み込み検索先: searxng、ollama。Tavily はサービスの紹介です。\nSearXNG が停止中: --auto-start が docker-compose.searxng.yml を起動します（ループバック限定）。\n利用手順: https://github.com/jimoto-no-llm/rustdsh/blob/main/docs/WEB-SEARCH.md",
    }
}

pub(crate) fn default_base() -> String {
    match std::env::var("SEARXNG_URL") {
        Ok(s) => {
            let s = s.trim_end_matches('/').to_string();
            if s.is_empty() {
                "http://127.0.0.1:8888".to_string()
            } else {
                s
            }
        }
        Err(_) => {
            let u = crate::rdsh_config::load().search.searxng_url;
            let u = u.trim().trim_end_matches('/').to_string();
            if u.is_empty() {
                "http://127.0.0.1:8888".to_string()
            } else {
                u
            }
        }
    }
}

/// Wrapper around the loopback health probe: the unit tests swap this so the
/// resolution order can be checked without a listener.
fn engine_health(base: &str) -> bool {
    crate::rustxng::health(base)
}

/// Resolve the SearXNG-compatible base URL for one search.
///
/// `Auto` walks SEARXNG_URL, RUSTXNG_URL, a local rustxng (started on demand),
/// then the historical http://127.0.0.1:8888 default. `Searxng` still honours
/// SEARXNG_URL and then the `rdsh.json` search.searxng_url override, but never
/// starts rustxng. `Rustxng` uses RUSTXNG_URL, else a local rustxng, and never
/// falls through to a different engine.
pub(crate) fn resolve_base(engine: Engine) -> anyhow::Result<String> {
    resolve_base_with(engine, engine_health)
}

fn resolve_base_with(engine: Engine, health: impl Fn(&str) -> bool) -> anyhow::Result<String> {
    match engine {
        Engine::Searxng => Ok(default_base()),
        Engine::Rustxng => match crate::rustxng::base_url() {
            Some(url) => Ok(url),
            None => crate::rustxng::ensure().map_err(anyhow::Error::new),
        },
        Engine::Auto => {
            if let Some(url) = env_url("SEARXNG_URL") {
                return Ok(url);
            }
            if let Some(url) = env_url("RUSTXNG_URL") {
                return Ok(url);
            }
            // A healthy instance is reused; a missing binary or a process that
            // never answered falls back to the historical default, whose own
            // connection error names both variables.
            if let Ok(base) = crate::rustxng::ensure() {
                if health(&base) {
                    return Ok(base);
                }
            }
            Ok(default_base())
        }
    }
}

/// One trimmed, trailing-slash-free environment URL, when it is set.
fn env_url(name: &str) -> Option<String> {
    let value = std::env::var(name).ok()?;
    let value = value.trim().trim_end_matches('/').to_string();
    (!value.is_empty()).then_some(value)
}

pub(crate) fn encode_query(s: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else if b == b' ' {
            out.push('+');
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// Split an `http://host[:port][/prefix]` base URL.
pub(crate) fn split_base(
    base: &str,
    locale: crate::locale::Locale,
) -> anyhow::Result<(String, u16, String)> {
    // The configured endpoint is a human-selected capability, not a URL from
    // search results. Preserve remote instances, but never interpolate request
    // separators, userinfo, queries, or fragments into the HTTP request.
    anyhow::ensure!(
        !base.chars().any(|c| c.is_control() || c.is_whitespace())
            && !base.contains(['@', '?', '#']),
        "{}",
        crate::locale::native_message(locale, crate::locale::NativeMessage::InvalidSearxUrl)
    );
    let rest = base.strip_prefix("http://").ok_or_else(|| {
        anyhow::anyhow!(
            "{}: {base}",
            crate::locale::native_message(locale, crate::locale::NativeMessage::OnlyHttpSearxUrl)
        )
    })?;
    let (hostport, prefix) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, String::new()),
    };
    let (host, port_text) = if hostport.starts_with('[') {
        let end = hostport.find(']').ok_or_else(|| {
            anyhow::anyhow!(
                "{}",
                crate::locale::native_message(
                    locale,
                    crate::locale::NativeMessage::InvalidIpv6SearxHost
                )
            )
        })?;
        hostport[1..end]
            .parse::<std::net::Ipv6Addr>()
            .map_err(|_| {
                anyhow::anyhow!(
                    "{}",
                    crate::locale::native_message(
                        locale,
                        crate::locale::NativeMessage::InvalidIpv6SearxHost
                    )
                )
            })?;
        (&hostport[..=end], &hostport[end + 1..])
    } else {
        let end = hostport.find(':').unwrap_or(hostport.len());
        let host = &hostport[..end];
        anyhow::ensure!(
            !host.is_empty()
                && host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b)),
            "{}",
            crate::locale::native_message(locale, crate::locale::NativeMessage::InvalidSearxHost)
        );
        (host, &hostport[end..])
    };
    let port = if port_text.is_empty() {
        80
    } else {
        port_text
            .strip_prefix(':')
            .and_then(|s| s.parse::<u16>().ok())
            .filter(|port| *port != 0)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "{}",
                    crate::locale::native_message(
                        locale,
                        crate::locale::NativeMessage::InvalidSearxPort
                    )
                )
            })?
    };
    Ok((host.to_string(), port, prefix))
}

/// Loopback check for the SearXNG warning: 127/8, ::1 and localhost names.
/// Bracketed IPv6 literals (as kept by split_base) are unwrapped first.
pub(crate) fn is_loopback_host(host: &str) -> bool {
    let h = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);
    h == "localhost"
        || h.parse::<std::net::Ipv4Addr>()
            .is_ok_and(|ip| ip.is_loopback())
        || h.parse::<std::net::Ipv6Addr>()
            .is_ok_and(|ip| ip.is_loopback())
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Hit {
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) content: String,
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut tag = false;
    let mut prev_space = true;
    for c in s.chars() {
        match c {
            '<' => tag = true,
            '>' => {
                tag = false;
                prev_space = true;
            }
            _ if tag => {}
            _ if c.is_whitespace() => {
                if !prev_space {
                    out.push(' ');
                    prev_space = true;
                }
            }
            _ => {
                out.push(c);
                prev_space = false;
            }
        }
    }
    out.trim().to_string()
}

fn decode_entities(s: &str) -> String {
    let mut out = s
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'");
    let mut search = 0;
    while let Some(offset) = out[search..].find("&#") {
        let i = search + offset;
        let rest = &out[i + 2..];
        let Some(end) = rest.find(';') else {
            break;
        };
        let num = &rest[..end];
        let ch = if num.len() > 8 || num.contains('&') {
            None
        } else if let Some(hex) = num.strip_prefix(['x', 'X']) {
            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
        } else {
            num.parse::<u32>().ok().and_then(char::from_u32)
        };
        match ch {
            Some(c) => {
                out.replace_range(i..i + 2 + end + 1, &c.to_string());
                search = i + c.len_utf8();
            }
            None => search = i + 2,
        }
    }
    out
}

fn clean(s: &str) -> String {
    decode_entities(&strip_tags(s))
}

/// First `href` + link text inside an `<article>` block whose `class`
/// attribute marks it as a result. Only the start tag's class tokens decide:
/// body text (title/URL/snippet) must never affect classification.
fn parse_html(h: &str, limit: usize) -> Vec<Hit> {
    let mut hits = Vec::new();
    let mut rest = h;
    while let Some(a) = rest.find("<article") {
        let block = &rest[a..];
        let end = block
            .find("</article>")
            .map(|i| i + 10)
            .unwrap_or(block.len());
        let blk = &block[..end];
        rest = &block[end.min(block.len())..];
        // Classify by the article start tag's class tokens only: title, URL
        // and snippet text must never affect the decision (#382).
        let head = &blk[..blk
            .find('>')
            .map(|i| i + 1)
            .unwrap_or(blk.len())
            .min(blk.len())];
        let class = attr(head, "class").unwrap_or_default();
        let tokens: Vec<&str> = class.split_whitespace().collect();
        if !tokens.iter().any(|t| t.contains("result")) {
            continue;
        }
        if tokens.iter().any(|t| t.contains("correction")) {
            continue;
        }
        let href = match find_href(blk) {
            Some(u) => u,
            None => continue,
        };
        let title = match find_link_text(blk) {
            Some(t) => clean(&t),
            None => continue,
        };
        if title.is_empty() || href.is_empty() {
            continue;
        }
        let content = find_snippet(blk).map(|s| clean(&s)).unwrap_or_default();
        hits.push(Hit {
            title,
            url: href,
            content,
        });
        if hits.len() >= limit.max(1) {
            break;
        }
    }
    hits
}

fn find_href(blk: &str) -> Option<String> {
    let mut rest = blk;
    while let Some(a) = rest.find("<a") {
        let tag = &rest[a..];
        let close = tag.find('>')?;
        let head = &tag[..close];
        if let Some(u) = attr(head, "href").filter(|u| !u.is_empty() && !u.starts_with('#')) {
            return Some(decode_entities(&u));
        }
        rest = &tag[close + 1..];
    }
    None
}

/// Text of the same anchor `find_href` returns (first link with a real href).
fn find_link_text(blk: &str) -> Option<String> {
    let mut rest = blk;
    while let Some(a) = rest.find("<a") {
        let tag = &rest[a..];
        let close = tag.find('>')?;
        let head = &tag[..close];
        let ok = attr(head, "href").is_some_and(|u| !u.is_empty() && !u.starts_with('#'));
        let after = &tag[close + 1..];
        if ok {
            let end = after.find("</a>").unwrap_or(after.len());
            return Some(after[..end].to_string());
        }
        rest = after;
    }
    None
}

fn attr(tag_head: &str, name: &str) -> Option<String> {
    // Matches name="..." or name='...' without quote escapes in source.
    const SQ: u8 = b'\'';
    let mut rest = tag_head;
    while let Some(i) = rest.find(name) {
        let after = &rest[i + name.len()..];
        let b = after.as_bytes();
        if b.len() < 2 || b[0] != b'=' || (b[1] != b'"' && b[1] != SQ) {
            let step = after.chars().next().map_or(0, char::len_utf8);
            rest = &after[step..];
            continue;
        }
        let v = &after[2..];
        let end = v.find(b[1] as char).unwrap_or(v.len());
        return Some(v[..end].to_string());
    }
    None
}

fn find_snippet(blk: &str) -> Option<String> {
    let mut rest = blk;
    while let Some(i) = rest.find("<p class=") {
        let tag = &rest[i..];
        let gt = tag.find('>')?;
        if tag[..gt].contains("content") {
            let after = &tag[gt + 1..];
            let end = after.find("</p>").unwrap_or(after.len());
            return Some(after[..end].to_string());
        }
        rest = &tag[gt + 1..];
    }
    None
}

/// The connection-failure sentence. It names both variables that can point at
/// a SearXNG instance and says that installing rustxng gives rdsh a local
/// engine it can start itself.
fn unreachable_engine_message(base: &str, locale: crate::locale::Locale) -> String {
    match locale {
        crate::locale::Locale::English => format!(
            "cannot reach SearXNG at {base}; is it running? Set SEARXNG_URL or RUSTXNG_URL, or install the rustxng binary (RUSTXNG_BIN) so rdsh can start the local engine"
        ),
        crate::locale::Locale::Chinese => format!(
            "无法连接 {base} 的 SearXNG；它是否正在运行？请设置 SEARXNG_URL 或 RUSTXNG_URL，或安装 rustxng（RUSTXNG_BIN）以便 rdsh 启动本地引擎"
        ),
        crate::locale::Locale::Japanese => format!(
            "{base} の SearXNG に接続できません。起動していますか？SEARXNG_URL か RUSTXNG_URL を設定するか、rustxng（RUSTXNG_BIN）を導入すると rdsh がローカルエンジンを起動できます"
        ),
    }
}

fn fetch_with(
    base: &str,
    query: &str,
    locale: crate::locale::Locale,
    format: Format,
) -> anyhow::Result<Vec<Hit>> {
    use std::io::{Read, Write};
    use std::net::ToSocketAddrs;
    let (host, port, prefix) = split_base(base, locale)?;
    if !is_loopback_host(&host) {
        // Plain-http to a non-loopback host is observable on the network.
        // Advisory only: remote instances stay usable via an SSH tunnel.
        eprintln!("[rdsh] warning: SearXNG host {host} is not loopback; prefer an SSH tunnel to localhost");
    }
    let mut target = format!("{prefix}/search?q={}", encode_query(query));
    if format == Format::Json {
        target.push_str("&format=json");
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let mut stream = None;
    for address in format!("{host}:{port}").to_socket_addrs()? {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        if let Ok(connected) = std::net::TcpStream::connect_timeout(&address, remaining) {
            stream = Some(connected);
            break;
        }
    }
    let mut s =
        stream.ok_or_else(|| anyhow::anyhow!("{}", unreachable_engine_message(base, locale)))?;
    let ua = format!("rdsh/{}", env!("CARGO_PKG_VERSION"));
    // Virtual-hosted instances need the port to route; the default port is
    // omitted per convention. Bracketed IPv6 literals pass through as-is.
    let host_header = if port == 80 {
        host.clone()
    } else {
        format!("{host}:{port}")
    };
    let accept = if format == Format::Json {
        "application/json"
    } else {
        "text/html"
    };
    let request = format!("GET {target} HTTP/1.0\r\nHost: {host_header}\r\nUser-Agent: {ua}\r\nAccept: {accept}\r\nConnection: close\r\n\r\n");
    let mut pending = request.as_bytes();
    while !pending.is_empty() {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        anyhow::ensure!(
            !remaining.is_zero(),
            "{}",
            crate::locale::native_message(
                locale,
                crate::locale::NativeMessage::SearxRequestTimedOut
            )
        );
        s.set_write_timeout(Some(remaining))?;
        let n = s.write(pending)?;
        anyhow::ensure!(
            n != 0,
            "{}",
            crate::locale::native_message(locale, crate::locale::NativeMessage::SearxRequestClosed)
        );
        pending = &pending[n..];
    }
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            anyhow::bail!(
                "{}",
                crate::locale::native_message(
                    locale,
                    crate::locale::NativeMessage::SearxResponseTimedOut
                )
            );
        }
        s.set_read_timeout(Some(remaining))?;
        let n = s.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        if raw.len().saturating_add(n) > 2 * 1024 * 1024 {
            anyhow::bail!(
                "{}",
                crate::locale::native_message(
                    locale,
                    crate::locale::NativeMessage::SearxResponseTooLarge
                )
            );
        }
        raw.extend_from_slice(&chunk[..n]);
    }
    let text = String::from_utf8_lossy(&raw);
    let status = text
        .lines()
        .next()
        .and_then(|line| {
            let mut parts = line.split_whitespace();
            let protocol = parts.next()?;
            if !matches!(protocol, "HTTP/1.0" | "HTTP/1.1") {
                return None;
            }
            parts.next()?.parse::<u16>().ok()
        })
        .ok_or_else(|| {
            anyhow::anyhow!(
                "{} {base}",
                crate::locale::native_message(
                    locale,
                    crate::locale::NativeMessage::BadSearxResponse
                )
            )
        })?;
    if !(200..300).contains(&status) {
        anyhow::bail!(
            "{} {status} {} {base}",
            crate::locale::native_message(locale, crate::locale::NativeMessage::SearxReturnedHttp),
            match locale {
                crate::locale::Locale::English => "from",
                crate::locale::Locale::Chinese => "，来源",
                crate::locale::Locale::Japanese => "、送信元",
            }
        );
    }
    let body = match text.find("\r\n\r\n") {
        Some(i) => &text[i + 4..],
        None => anyhow::bail!(
            "{} {base}",
            crate::locale::native_message(locale, crate::locale::NativeMessage::BadSearxResponse)
        ),
    };
    if format == Format::Json {
        return parse_json(body, 50);
    }
    ensure_results_page(body, base, locale)?;
    Ok(parse_html(body, 50))
}

/// HTML search client used by the stub tests.
#[cfg(test)]
fn fetch(base: &str, query: &str, locale: crate::locale::Locale) -> anyhow::Result<Vec<Hit>> {
    fetch_with(base, query, locale, Format::Html)
}

/// Accept recognizable empty SearXNG pages; preserve locale on invalid pages.
fn ensure_results_page(
    body: &str,
    base: &str,
    locale: crate::locale::Locale,
) -> anyhow::Result<()> {
    if body.contains("<article") || looks_like_searxng(body) {
        return Ok(());
    }
    anyhow::bail!(
        "{} {base}{}",
        crate::locale::native_message(locale, crate::locale::NativeMessage::NoSearxResultsPage),
        match locale {
            crate::locale::Locale::English => " (is SEARXNG_URL right?)",
            crate::locale::Locale::Chinese => "（SEARXNG_URL 是否正确？）",
            crate::locale::Locale::Japanese => "（SEARXNG_URL は正しいですか？）",
        }
    );
}

/// The real HTML search client against one base URL. Shared with the rustxng
/// unit test, which points it at its own TCP stub.
#[cfg(test)]
pub(crate) fn fetch_via_stub(
    base: &str,
    query: &str,
    locale: crate::locale::Locale,
) -> anyhow::Result<Vec<Hit>> {
    fetch(base, query, locale)
}

fn looks_like_searxng(body: &str) -> bool {
    body.contains("id=\"results\"") || body.contains("content=\"searxng")
}

pub fn cmd_search_web(
    query: &str,
    limit: usize,
    json: bool,
    provider: Provider,
    engine: Engine,
    auto_start: bool,
    locale: crate::locale::Locale,
) -> anyhow::Result<()> {
    let (base, hits) = match provider {
        Provider::Searxng => {
            let base = resolve_base(engine)?;
            // Opt-in only: the search still runs (and reports its own
            // connection error) when a container cannot be started, except for
            // the explicit --auto-start failures below, which say why. A
            // rustxng base keeps --auto-start out of the compose path.
            if auto_start && engine != Engine::Rustxng {
                let outcome = crate::searxng::ensure_running(&base, true, locale);
                if let Some(notice) = outcome.notice(&base, locale) {
                    eprintln!("{notice}");
                }
                if let Some(failure) = outcome.start_failure(&base, locale) {
                    anyhow::bail!("{failure}");
                }
            }
            let format = format_for(engine);
            let hits = match fetch_with(&base, query, locale, format) {
                Ok(hits) => hits,
                Err(error) => {
                    // An auto-detected rustxng base also serves JSON rather
                    // than the SearXNG result markup, so one JSON retry is
                    // worth it unless the operator pinned SearXNG.
                    if format == Format::Html && engine != Engine::Searxng {
                        match fetch_with(&base, query, locale, Format::Json) {
                            Ok(hits) => hits,
                            Err(_) => return Err(error),
                        }
                    } else {
                        return Err(error);
                    }
                }
            };
            (base, hits)
        }
        Provider::Ollama => (
            ollama::ENDPOINT.to_string(),
            ollama::search(query, limit, locale)?,
        ),
    };
    let shown: Vec<&Hit> = hits.iter().take(limit.max(1)).collect();
    if json {
        println!(
            "{}",
            serde_json::json!({
                "query": query,
                "engine": base,
                "results": shown
                    .iter()
                    .map(|r| {
                        serde_json::json!({
                            "title": r.title,
                            "url": r.url,
                            "content": r.content,
                        })
                    })
                    .collect::<Vec<_>>(),
            })
        );
        return Ok(());
    }
    use std::io::Write as _;
    let out = std::io::stdout();
    let mut out = std::io::BufWriter::new(out.lock());
    for r in &shown {
        let _ = writeln!(out, "- {}\n  {}", r.title, r.url);
        if !r.content.is_empty() {
            let snippet: String = r.content.chars().take(240).collect();
            let _ = writeln!(out, "  {snippet}");
        }
    }
    let _ = out.flush();
    match locale {
        crate::locale::Locale::English => eprintln!("[rdsh] {} web hit(s) via {base}", shown.len()),
        crate::locale::Locale::Chinese => {
            eprintln!("[rdsh] {} 个网页匹配，来源 {base}", shown.len())
        }
        crate::locale::Locale::Japanese => {
            eprintln!("[rdsh] {} 件のWeb一致、経由 {base}", shown.len())
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 0 件でも正しい SearXNG インスタンスなら成功扱いにする（設定ミスと誤診しない）。
    #[test]
    fn empty_searxng_page_is_not_a_configuration_error() {
        let page =
            "<html><body><div id=\"results\"><p>No results were found.</p></div></body></html>";
        assert!(ensure_results_page(
            page,
            "http://127.0.0.1:8888",
            crate::locale::Locale::English
        )
        .is_ok());
        assert!(parse_html(page, 50).is_empty());
    }

    #[test]
    fn searxng_generator_meta_is_accepted() {
        let page = "<html><head><meta name=\"generator\" content=\"searxng/2026\"></head></html>";
        assert!(ensure_results_page(
            page,
            "http://127.0.0.1:8888",
            crate::locale::Locale::English
        )
        .is_ok());
    }

    #[test]
    fn a_plain_page_is_still_reported_as_a_wrong_url() {
        let page = "<html><body><h1>hello</h1></body></html>";
        assert!(ensure_results_page(
            page,
            "http://127.0.0.1:8888",
            crate::locale::Locale::English
        )
        .is_err());
    }

    #[test]
    fn empty_results_and_invalid_pages_retain_the_requested_language() {
        use crate::locale::Locale;
        for (locale, expected) in [
            (Locale::English, "no SearXNG results page"),
            (Locale::Chinese, "以下地址没有 SearXNG 结果页"),
            (Locale::Japanese, "SearXNG の結果ページがありません"),
        ] {
            assert!(ensure_results_page(
                "<div id=\"results\"></div>",
                "http://127.0.0.1:8888",
                locale
            )
            .is_ok());
            let error = ensure_results_page(
                "<html>wrong service</html>",
                "http://127.0.0.1:8888",
                locale,
            )
            .unwrap_err()
            .to_string();
            assert!(error.contains(expected), "{error}");
            assert!(error.contains("http://127.0.0.1:8888"));
        }
    }

    // Engine selection: auto falls back to the historical default when neither
    // variable is set and no local rustxng answers.
    #[test]
    fn auto_engine_falls_back_to_the_default() {
        let _lock = engine_env_lock();
        let dir = std::env::temp_dir().join(format!(
            "rdsh-websearch-auto-{}-{}",
            std::process::id(),
            nondet_nonce()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let _env = EngineEnvGuard::apply(&[
            ("SEARXNG_URL", None),
            ("RUSTXNG_URL", None),
            ("RUSTXNG_PORT", None),
            ("DSH_HOME", Some(dir.to_string_lossy().as_ref())),
            ("HOME", Some(dir.to_string_lossy().as_ref())),
            // No PATH entry, so the lookup cannot reach a real install.
            ("PATH", Some(dir.to_string_lossy().as_ref())),
        ]);
        // With nothing configured and no local engine the historical default
        // is the answer, and the health probe is never consulted.
        assert_eq!(
            resolve_base_with(Engine::Auto, |_| panic!("no probe without a local engine")).unwrap(),
            "http://127.0.0.1:8888"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A unique tag for temp directories shared by the resolution tests.
    fn nondet_nonce() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    }

    // SEARXNG_URL is consulted before RUSTXNG_URL, and both before the local
    // sidecar (the health probe must never be reached).
    #[test]
    fn auto_engine_prefers_searxng_url_then_rustxng_url() {
        let _lock = engine_env_lock();
        let _env = EngineEnvGuard::apply(&[
            ("SEARXNG_URL", Some("http://127.0.0.1:9999/")),
            ("RUSTXNG_URL", Some("http://127.0.0.1:7777")),
        ]);
        assert_eq!(
            resolve_base_with(Engine::Auto, |_| panic!("no probe when an env URL is set")).unwrap(),
            "http://127.0.0.1:9999"
        );
        std::env::remove_var("SEARXNG_URL");
        assert_eq!(
            resolve_base_with(Engine::Auto, |_| panic!("no probe when RUSTXNG_URL is set"))
                .unwrap(),
            "http://127.0.0.1:7777"
        );
    }

    // --engine searxng keeps today's behaviour and never starts rustxng, even
    // when RUSTXNG_URL points somewhere.
    #[test]
    fn explicit_searxng_never_spawns_rustxng() {
        let _lock = engine_env_lock();
        let _env = EngineEnvGuard::apply(&[
            ("RUSTXNG_URL", Some("http://127.0.0.1:7777")),
            ("SEARXNG_URL", Some("http://127.0.0.1:9999")),
        ]);
        assert_eq!(
            resolve_base_with(Engine::Searxng, |_| panic!(
                "searxng must not probe rustxng"
            ))
            .unwrap(),
            "http://127.0.0.1:9999"
        );
        std::env::remove_var("SEARXNG_URL");
        let base = resolve_base_with(Engine::Searxng, |_| {
            panic!("searxng must not probe rustxng")
        })
        .unwrap();
        assert!(!base.contains("7777"), "{base}");
    }

    // --engine rustxng uses RUSTXNG_URL and never another engine.
    #[test]
    fn explicit_rustxng_uses_only_the_configured_or_local_engine() {
        let _lock = engine_env_lock();
        let _env = EngineEnvGuard::apply(&[
            ("RUSTXNG_URL", Some("http://127.0.0.1:7777")),
            ("SEARXNG_URL", Some("http://127.0.0.1:9999")),
        ]);
        assert_eq!(
            resolve_base_with(Engine::Rustxng, |_| panic!(
                "a configured URL needs no probe"
            ))
            .unwrap(),
            "http://127.0.0.1:7777"
        );
        // With nothing configured the local engine decides; a missing binary is
        // an explicit error rather than a silent fallback.
        std::env::remove_var("RUSTXNG_URL");
        let dir = std::env::temp_dir().join(format!(
            "rdsh-websearch-resolve-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("DSH_HOME", &dir);
        // The host may really have the sidecar installed (that is now the
        // default path); pin HOME to the temp dir so the lookup stays empty.
        let saved = [
            std::env::var("HOME").ok().map(|v| ("HOME", Some(v))),
            std::env::var("USERPROFILE")
                .ok()
                .map(|v| ("USERPROFILE", Some(v))),
            std::env::var("RUSTXNG_BIN")
                .ok()
                .map(|v| ("RUSTXNG_BIN", Some(v))),
        ];
        std::env::set_var("HOME", &dir);
        std::env::set_var("USERPROFILE", &dir);
        std::env::remove_var("RUSTXNG_PORT");
        let result = resolve_base_with(Engine::Rustxng, |_| false);
        std::env::remove_var("RUSTXNG_BIN");
        for item in saved.into_iter().flatten() {
            match item.1 {
                Some(value) => std::env::set_var(item.0, value),
                None => std::env::remove_var(item.0),
            }
        }
        assert!(result.is_err(), "rustxng must not fall back to searxng");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Serialises the environment-touching resolution tests in this module.
    fn engine_env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Sets variables for one test and restores them on drop.
    struct EngineEnvGuard {
        saved: Vec<(String, Option<String>)>,
    }

    impl EngineEnvGuard {
        fn apply(pairs: &[(&str, Option<&str>)]) -> Self {
            let mut saved = Vec::new();
            for (name, value) in pairs {
                saved.push(((*name).to_string(), std::env::var(name).ok()));
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
            Self { saved }
        }
    }

    impl Drop for EngineEnvGuard {
        fn drop(&mut self) {
            for (name, value) in &self.saved {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }

    #[test]
    fn query_encoding() {
        assert_eq!(encode_query("a b+c"), "a+b%2Bc");
        assert_eq!(encode_query("日本語"), "%E6%97%A5%E6%9C%AC%E8%AA%9E");
    }

    #[test]
    fn base_splitting() {
        assert_eq!(
            split_base("http://127.0.0.1:8888", crate::locale::Locale::English).unwrap(),
            ("127.0.0.1".to_string(), 8888, String::new())
        );
        assert_eq!(
            split_base("http://h/searx", crate::locale::Locale::English).unwrap(),
            ("h".to_string(), 80, "/searx".to_string())
        );
        assert!(split_base("https://h/", crate::locale::Locale::English).is_err());
        assert_eq!(
            split_base("http://[::1]/searx", crate::locale::Locale::English).unwrap(),
            ("[::1]".to_string(), 80, "/searx".to_string())
        );
        assert_eq!(
            split_base(
                "http://searx.example:8888/prefix",
                crate::locale::Locale::English
            )
            .unwrap(),
            ("searx.example".to_string(), 8888, "/prefix".to_string())
        );
    }

    #[test]
    fn base_rejects_http_request_injection_and_malformed_authorities() {
        for base in [
            "http://127.0.0.1:8888/prefix\r\nInjected: yes",
            "http://127.0.0.1:8888/path HTTP/1.0",
            "http://localhost\t:8888",
            "http://user@localhost:8888",
            "http://localhost:8888/path?other=query",
            "http://localhost:8888/#fragment",
            "http://[::1]extra:8888",
            "http://[bad]:8888",
            "http://::1",
            "http://localhost:0",
            "http://localhost:65536",
            "http://localhost:",
            "http:///path",
        ] {
            assert!(
                split_base(base, crate::locale::Locale::English).is_err(),
                "{base:?}"
            );
        }
        // The query is encoded separately and cannot create a second request.
        assert_eq!(encode_query("\r\nInjected: yes"), "%0D%0AInjected%3A+yes");
    }

    #[test]
    fn rustxng_uses_the_json_format() {
        assert_eq!(format_for(Engine::Rustxng), Format::Json);
        assert_eq!(format_for(Engine::Searxng), Format::Html);
        assert_eq!(format_for(Engine::Auto), Format::Html);
    }

    #[test]
    fn json_results_are_parsed_and_limited() {
        let body = r#"{"results":[{"url":"https://a.example/1","title":"A","content":"one"},{"url":"https://b.example/2","title":"B"},{"title":"no url"},{"url":"https://c.example/3","title":"C","content":"three"}]}"#;
        let hits = parse_json(body, 2).expect("json body");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "A");
        assert_eq!(hits[0].url, "https://a.example/1");
        assert_eq!(hits[1].content, "");
    }

    #[test]
    fn json_without_results_is_an_error() {
        assert!(parse_json("<html>not json</html>", 5).is_err());
        assert!(parse_json("{\"nope\":1}", 5).is_err());
    }

    #[test]
    fn fetch_encodes_query_and_preserves_configured_prefix() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "no fixture connection"
                        );
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(e) => panic!("fixture accept: {e}"),
                }
            };
            // Accepted sockets inherit O_NONBLOCK from the listener on BSD.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                assert_eq!(stream.read(&mut byte).unwrap(), 1);
                request.push(byte[0]);
                assert!(request.len() < 8192);
            }
            let body = "<article class=\"result\"><a href=\"https://example.invalid/\">DUMMY_RESULT</a></article>";
            write!(
                stream,
                "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            String::from_utf8(request).unwrap()
        });
        let hits = fetch(
            &format!("http://{address}/prefix"),
            "hello\r\nInjected: yes",
            crate::locale::Locale::English,
        );
        let request = server.join().unwrap();
        assert_eq!(hits.unwrap()[0].title, "DUMMY_RESULT");
        assert!(request.starts_with("GET /prefix/search?q=hello%0D%0AInjected%3A+yes HTTP/1.0\r\n"));
        assert!(!request.contains("\r\nInjected:"));
        // Ephemeral port: the Host header must carry it for vhost routing.
        assert!(request.contains(&format!("\r\nHost: {address}\r\n")));
    }

    #[test]
    fn loopback_classification() {
        for good in ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"] {
            assert!(is_loopback_host(good), "{good:?}");
        }
        for bad in [
            "192.168.1.1",
            "10.0.0.1",
            "example.com",
            "",
            "127.0.0.1:8888",
        ] {
            assert!(!is_loopback_host(bad), "{bad:?}");
        }
    }

    #[test]
    fn html_parsing() {
        let h = "<article class=\"result\"><h3><a href=\"https://e.com/x?a=1&amp;b=2\">A <b>B</b></a></h3><p class=\"content\">one &lt;two&gt;</p></article><article class=\"result result-correction\"><a href=\"https://e.com/y\">no</a></article>";
        let hits = parse_html(h, 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "A B");
        assert_eq!(hits[0].url, "https://e.com/x?a=1&b=2");
        assert_eq!(hits[0].content, "one <two>");
    }

    #[test]
    fn html_parsing_keeps_correction_words_in_title_url_snippet() {
        // Regression test for #382: the word "correction" in body text must
        // not exclude a normal result; only the start tag's class tokens decide.
        let h = concat!(
            "<article class=\"result\"><h3><a href=\"https://example.invalid/a\">",
            "Quantum error correction</a></h3><p class=\"content\">Useful paper</p></article>",
            "<article class=\"result\"><h3><a href=\"https://example.invalid/correction-notes\">",
            "Quantum paper</a></h3><p class=\"content\">Useful paper</p></article>",
            "<article class=\"result\"><h3><a href=\"https://example.invalid/b\">",
            "Quantum paper</a></h3><p class=\"content\">About error correction</p></article>",
            "<article class=\"result result-correction\"><h3><a href=\"https://example.invalid/d\">",
            "Did you mean?</a></h3></article>",
        );
        let hits = parse_html(h, 10);
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].title, "Quantum error correction");
        assert_eq!(hits[0].url, "https://example.invalid/a");
        assert_eq!(hits[1].url, "https://example.invalid/correction-notes");
        assert_eq!(hits[2].content, "About error correction");
    }

    #[test]
    fn html_parsing_skips_utf8_attribute_name_candidates() {
        for character in ["é", "→", "🦀"] {
            let url = format!("https://example.invalid/{character}");
            let title = format!("結果 {character}");
            let html = format!(
                "<article class=\"result\"><a title=\"href{character}\" href=\"{url}\">{title}</a></article>"
            );

            assert_eq!(
                parse_html(&html, 1),
                vec![Hit {
                    title,
                    url,
                    content: String::new(),
                }],
                "failed to skip a {character:?} candidate"
            );
        }
    }

    #[test]
    fn attribute_name_at_end_does_not_panic() {
        assert_eq!(attr("href", "href"), None);
    }

    #[test]
    fn malformed_numeric_entity_does_not_panic_or_hide_later_entities() {
        assert_eq!(decode_entities("A&#65"), "A&#65");
        assert_eq!(decode_entities("A&#65;B"), "AAB");
        assert_eq!(decode_entities("bad &#xZ; then &#65;"), "bad &#xZ; then A");
    }
}
