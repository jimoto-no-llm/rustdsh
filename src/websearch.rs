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
fn split_base(base: &str) -> anyhow::Result<(String, u16, String)> {
    // The configured endpoint is a human-selected capability, not a URL from
    // search results. Preserve remote instances, but never interpolate request
    // separators, userinfo, queries, or fragments into the HTTP request.
    anyhow::ensure!(
        !base.chars().any(|c| c.is_control() || c.is_whitespace())
            && !base.contains(['@', '?', '#']),
        "invalid SearXNG URL"
    );
    let rest = base
        .strip_prefix("http://")
        .ok_or_else(|| anyhow::anyhow!("only http:// SearXNG URLs are supported (for a remote instance use an SSH tunnel to localhost): {base}"))?;
    let (hostport, prefix) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, String::new()),
    };
    let (host, port_text) = if hostport.starts_with('[') {
        let end = hostport
            .find(']')
            .ok_or_else(|| anyhow::anyhow!("invalid IPv6 SearXNG host"))?;
        hostport[1..end]
            .parse::<std::net::Ipv6Addr>()
            .map_err(|_| anyhow::anyhow!("invalid IPv6 SearXNG host"))?;
        (&hostport[..=end], &hostport[end + 1..])
    } else {
        let end = hostport.find(':').unwrap_or(hostport.len());
        let host = &hostport[..end];
        anyhow::ensure!(
            !host.is_empty()
                && host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b)),
            "invalid SearXNG host"
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
            .ok_or_else(|| anyhow::anyhow!("invalid SearXNG port"))?
    };
    Ok((host.to_string(), port, prefix))
}

/// Loopback check for the SearXNG warning: 127/8, ::1 and localhost names.
/// Bracketed IPv6 literals (as kept by split_base) are unwrapped first.
fn is_loopback_host(host: &str) -> bool {
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
    use std::net::ToSocketAddrs;
    let (host, port, prefix) = split_base(base)?;
    if !is_loopback_host(&host) {
        // Plain-http to a non-loopback host is observable on the network.
        // Advisory only: remote instances stay usable via an SSH tunnel.
        eprintln!("[rdsh] warning: SearXNG host {host} is not loopback; prefer an SSH tunnel to localhost");
    }
    let target = format!("{prefix}/search?q={}", encode_query(query));
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
    let mut s = stream.ok_or_else(|| {
        anyhow::anyhow!("cannot reach SearXNG at {base}; is it running? SEARXNG_URL overrides")
    })?;
    let ua = format!("rdsh/{}", env!("CARGO_PKG_VERSION"));
    // Virtual-hosted instances need the port to route; the default port is
    // omitted per convention. Bracketed IPv6 literals pass through as-is.
    let host_header = if port == 80 {
        host.clone()
    } else {
        format!("{host}:{port}")
    };
    let request = format!("GET {target} HTTP/1.0\r\nHost: {host_header}\r\nUser-Agent: {ua}\r\nAccept: text/html\r\nConnection: close\r\n\r\n");
    let mut pending = request.as_bytes();
    while !pending.is_empty() {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        anyhow::ensure!(!remaining.is_zero(), "SearXNG request timed out");
        s.set_write_timeout(Some(remaining))?;
        let n = s.write(pending)?;
        anyhow::ensure!(n != 0, "SearXNG request connection closed");
        pending = &pending[n..];
    }
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
        .ok_or_else(|| anyhow::anyhow!("bad HTTP response from {base}"))?;
    if !(200..300).contains(&status) {
        anyhow::bail!("SearXNG returned HTTP {status} from {base}");
    }
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
        assert_eq!(
            split_base("http://[::1]/searx").unwrap(),
            ("[::1]".to_string(), 80, "/searx".to_string())
        );
        assert_eq!(
            split_base("http://searx.example:8888/prefix").unwrap(),
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
            assert!(split_base(base).is_err(), "{base:?}");
        }
        // The query is encoded separately and cannot create a second request.
        assert_eq!(encode_query("\r\nInjected: yes"), "%0D%0AInjected%3A+yes");
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
    fn malformed_numeric_entity_does_not_panic_or_hide_later_entities() {
        assert_eq!(decode_entities("A&#65"), "A&#65");
        assert_eq!(decode_entities("A&#65;B"), "AAB");
        assert_eq!(decode_entities("bad &#xZ; then &#65;"), "bad &#xZ; then A");
    }
}
