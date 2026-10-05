//! `rdsh search-web`: web search through SearXNG (self-hosted default).
//! No API key needed: talks to `$SEARXNG_URL` (default `http://127.0.0.1:8888`)
//! over plain HTTP with a hand-rolled client (no new dependencies). The HTML
//! results page is parsed because many instances (including a default
//! local one) only serve HTML, not the JSON API.

fn default_base() -> String {
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

fn encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else if b == b' ' {
            out.push('+');
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Split an `http://host[:port][/prefix]` base URL.
fn split_base(base: &str) -> anyhow::Result<(String, u16, String)> {
    let rest = base
        .strip_prefix("http://")
        .ok_or_else(|| anyhow::anyhow!("only http:// SearXNG URLs are supported: {base}"))?;
    let (hostport, prefix) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, String::new()),
    };
    let (host, port) = match hostport.rfind(':') {
        Some(i) => (
            hostport[..i].to_string(),
            hostport[i + 1..]
                .parse::<u16>()
                .map_err(|_| anyhow::anyhow!("bad port in {base}"))?,
        ),
        None => (hostport.to_string(), 80),
    };
    if host.is_empty() {
        anyhow::bail!("bad SearXNG URL: {base}");
    }
    Ok((host, port, prefix))
}

#[derive(Debug, Clone, PartialEq)]
struct Hit {
    title: String,
    url: String,
    content: String,
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
        } else if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
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

/// First `href` + link text inside an `<article class="...result...">` block.
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
        if !blk.contains("result") || blk.contains("correction") {
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
        if let Some(u) = attr(head, "href") {
            if !u.is_empty() && !u.starts_with('#') {
                return Some(decode_entities(&u));
            }
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
        let ok = match attr(head, "href") {
            Some(u) => !u.is_empty() && !u.starts_with('#'),
            None => false,
        };
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
    const SQ: u8 = 39;
    let mut rest = tag_head;
    while let Some(i) = rest.find(name) {
        let after = &rest[i + name.len()..];
        let b = after.as_bytes();
        if b.len() < 2 || b[0] != b'=' || (b[1] != b'"' && b[1] != SQ) {
            rest = &after[1.min(after.len())..];
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

fn fetch(base: &str, query: &str) -> anyhow::Result<Vec<Hit>> {
    use std::io::{Read, Write};
    let (host, port, prefix) = split_base(base)?;
    let target = format!("{prefix}/search?q={}", encode_query(query));
    let mut s = std::net::TcpStream::connect(format!("{host}:{port}")).map_err(|e| {
        anyhow::anyhow!(
            "cannot reach SearXNG at {base} ({e}); is it running? SEARXNG_URL overrides"
        )
    })?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let ua = format!("rdsh/{}", env!("CARGO_PKG_VERSION"));
    s.write_all(
        format!("GET {target} HTTP/1.0\r\nHost: {host}\r\nUser-Agent: {ua}\r\nAccept: text/html\r\nConnection: close\r\n\r\n").as_bytes(),
    )?;
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            anyhow::bail!("SearXNG response timed out");
        }
        s.set_read_timeout(Some(remaining))?;
        let n = s.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        if raw.len().saturating_add(n) > 2 * 1024 * 1024 {
            anyhow::bail!("SearXNG response too large");
        }
        raw.extend_from_slice(&chunk[..n]);
    }
    let text = String::from_utf8_lossy(&raw);
    let body = match text.find("\r\n\r\n") {
        Some(i) => &text[i + 4..],
        None => anyhow::bail!("bad HTTP response from {base}"),
    };
    if !body.contains("<article") {
        anyhow::bail!("no SearXNG results page from {base} (is SEARXNG_URL right?)");
    }
    Ok(parse_html(body, 50))
}

pub fn cmd_search_web(query: &str, limit: usize, json: bool) -> anyhow::Result<()> {
    let base = default_base();
    let hits = fetch(&base, query)?;
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
    eprintln!("[rdsh] {} web hit(s) via {base}", shown.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_encoding() {
        assert_eq!(encode_query("a b+c"), "a+b%2Bc");
        assert_eq!(encode_query("日本語"), "%E6%97%A5%E6%9C%AC%E8%AA%9E");
    }

    #[test]
    fn base_splitting() {
        assert_eq!(
            split_base("http://127.0.0.1:8888").unwrap(),
            ("127.0.0.1".to_string(), 8888, String::new())
        );
        assert_eq!(
            split_base("http://h/searx").unwrap(),
            ("h".to_string(), 80, "/searx".to_string())
        );
        assert!(split_base("https://h/").is_err());
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
    fn malformed_numeric_entity_does_not_panic_or_hide_later_entities() {
        assert_eq!(decode_entities("A&#65"), "A&#65");
        assert_eq!(decode_entities("A&#65;B"), "AAB");
        assert_eq!(decode_entities("bad &#xZ; then &#65;"), "bad &#xZ; then A");
    }
}
