//! Resident pure-compute worker for Web acceleration PoC (stage 2).
//!
//! Protocol `rdsh-compute/1` over stdio NDJSON (one JSON object per line).
//! Only pure string computation is exposed; no filesystem, no secrets,
//! no session/auth/model access. DSH stays the owner of sessions and agent
//! loop. The Node caller keeps the original path and falls back on any error.
//!
//! Request:
//!   {"v":1,"id":"<1..128 chars>","op":"tokens.estimate"|"tokens.prune",
//!    "text":"...","max_tokens":4000}
//!   {"v":1,"id":"...","op":"tokens.estimate_batch","texts":["...", ...]}
//!
//! Response (success):
//!   {"v":1,"id":"...","ok":true,"op":"...","tokens":n,"chars":n,
//!    "pruned":"...","before":n,"after":n,"budget":n,"elapsed_us":n}
//! Response (failure, fail-closed — caller must use the original path):
//!   {"v":1,"id":"...","ok":false,"error":"...","code":"..."}
//!
//! Limits: text <= 1 MiB, id 1..=128 chars, max_tokens 1..=200_000.
//! Unknown op / version / oversize / invalid UTF-8 are rejected, never
//! executed. Large histories must be chunked by the caller; one giant JSON
//! round-trip is intentionally not supported.

use std::io::{BufRead, Write};
use std::time::Instant;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_TEXT_BYTES: usize = 1_048_576;
pub const MAX_ID_LEN: usize = 128;
pub const MAX_TOKENS: usize = 200_000;
pub const MIN_TOKENS: usize = 1;
pub const MAX_BATCH_ITEMS: usize = 64;
pub const MAX_BATCH_ITEM_BYTES: usize = 262_144;

/// Single-shot helper used by tests: parse one request line, run it.
pub fn handle_line(line: &str) -> String {
    let started = Instant::now();
    match run_request(line) {
        Ok(mut v) => {
            v["elapsed_us"] = serde_json::json!(started.elapsed().as_micros() as u64);
            v.to_string()
        }
        Err((id, code, error)) => serde_json::json!({
            "v": PROTOCOL_VERSION,
            "id": id,
            "ok": false,
            "code": code,
            "error": error,
        })
        .to_string(),
    }
}

fn run_request(line: &str) -> Result<serde_json::Value, (String, &'static str, String)> {
    let v: serde_json::Value = serde_json::from_str(line)
        .map_err(|e| ("".to_string(), "bad_json", format!("invalid JSON: {e}")))?;
    let id = v
        .get("id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let fail = |code: &'static str, msg: String| -> (String, &'static str, String) {
        (id.clone(), code, msg)
    };
    if v.get("v").and_then(|x| x.as_u64()) != Some(PROTOCOL_VERSION as u64) {
        return Err(fail(
            "bad_version",
            format!("unsupported protocol, want v{}", PROTOCOL_VERSION),
        ));
    }
    if id.is_empty() || id.len() > MAX_ID_LEN {
        return Err(fail("bad_id", "id must be 1..=128 chars".to_string()));
    }
    let op = v.get("op").and_then(|x| x.as_str()).unwrap_or("");
    let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("");
    if text.len() > MAX_TEXT_BYTES {
        return Err(fail(
            "too_large",
            format!("text exceeds {MAX_TEXT_BYTES} bytes"),
        ));
    }
    match op {
        "tokens.estimate" => {
            let tokens = crate::tokens::estimate_tokens(text);
            Ok(serde_json::json!({
                "v": PROTOCOL_VERSION,
                "id": id,
                "ok": true,
                "op": op,
                "tokens": tokens,
                "chars": text.chars().count(),
            }))
        }
        "tokens.prune" => {
            let max = v.get("max_tokens").and_then(|x| x.as_u64()).unwrap_or(4000) as usize;
            if !(MIN_TOKENS..=MAX_TOKENS).contains(&max) {
                return Err(fail(
                    "bad_budget",
                    format!("max_tokens must be {MIN_TOKENS}..={MAX_TOKENS}"),
                ));
            }
            let before = crate::tokens::estimate_tokens(text);
            let pruned = crate::tokens::prune_to_budget(text, max);
            let after = crate::tokens::estimate_tokens(&pruned);
            Ok(serde_json::json!({
                "v": PROTOCOL_VERSION,
                "id": id,
                "ok": true,
                "op": op,
                "pruned": pruned,
                "before": before,
                "after": after,
                "budget": max,
            }))
        }
        "tokens.estimate_batch" => {
            let arr = v
                .get("texts")
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default();
            if arr.is_empty() || arr.len() > MAX_BATCH_ITEMS {
                return Err(fail(
                    "bad_batch",
                    format!("texts must hold 1..={MAX_BATCH_ITEMS} items"),
                ));
            }
            let mut texts: Vec<&str> = Vec::with_capacity(arr.len());
            let mut total = 0usize;
            for item in &arr {
                let s = item
                    .as_str()
                    .ok_or_else(|| fail("bad_batch", "every item must be a string".to_string()))?;
                if s.len() > MAX_BATCH_ITEM_BYTES {
                    return Err(fail(
                        "too_large",
                        format!("one item exceeds {MAX_BATCH_ITEM_BYTES} bytes"),
                    ));
                }
                total += s.len();
                if total > MAX_TEXT_BYTES {
                    return Err(fail(
                        "too_large",
                        format!("batch total exceeds {MAX_TEXT_BYTES} bytes"),
                    ));
                }
                texts.push(s);
            }
            // One pass over all items: a single IPC round-trip replaces N.
            let tokens: Vec<usize> = texts
                .iter()
                .map(|s| crate::tokens::estimate_tokens(s))
                .collect();
            let chars: Vec<usize> = texts.iter().map(|s| s.chars().count()).collect();
            let total_tokens: usize = tokens.iter().sum();
            Ok(serde_json::json!({
                "v": PROTOCOL_VERSION,
                "id": id,
                "ok": true,
                "op": op,
                "tokens": tokens,
                "chars": chars,
                "total": total_tokens,
            }))
        }
        _ => Err(fail("bad_op", format!("unknown op: {op}"))),
    }
}

/// Resident loop: read NDJSON from stdin, write NDJSON to stdout.
/// EOF ends the loop (exit 0). A malformed line yields an error object,
/// never a crash. `--once` handles a single line (for IPC cost comparison).
pub fn cmd_compute(once: bool) -> anyhow::Result<()> {
    let stdin = std::io::stdin();
    let mut out = std::io::BufWriter::with_capacity(256 * 1024, std::io::stdout().lock());
    run_lines(stdin.lock(), &mut out, once)
}

// Streaming NDJSON loop: one request line in, one response line out.
// Invalid UTF-8 yields a bad_utf8 error object, never a worker crash.
fn run_lines<R: BufRead, W: Write>(mut input: R, output: &mut W, once: bool) -> anyhow::Result<()> {
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    loop {
        buf.clear();
        let n = input.read_until(b'\n', &mut buf)?;
        if n == 0 {
            break; // EOF
        }
        // Strip one trailing newline / CR for tolerance on Windows pipes.
        if buf.last() == Some(&b'\n') {
            buf.pop();
        }
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
        if buf.iter().all(|b| b.is_ascii_whitespace()) {
            if once {
                break;
            }
            continue;
        }
        let resp = match std::str::from_utf8(&buf) {
            Ok(s) => handle_line(s),
            Err(_) => serde_json::json!({
                "v": PROTOCOL_VERSION, "id": "",
                "ok": false, "code": "bad_utf8", "error": "request is not valid UTF-8",
            })
            .to_string(),
        };
        writeln!(output, "{resp}")?;
        output.flush()?;
        if once {
            break;
        }
    }
    output.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(id: &str, op: &str, text: &str, max: Option<usize>) -> String {
        let mut v = serde_json::json!({"v": 1, "id": id, "op": op, "text": text});
        if let Some(m) = max {
            v["max_tokens"] = serde_json::json!(m);
        }
        v.to_string()
    }

    #[test]
    fn estimate_matches_direct() {
        let text = "hello world, token test";
        let resp: serde_json::Value =
            serde_json::from_str(&handle_line(&req("a1", "tokens.estimate", text, None))).unwrap();
        assert_eq!(resp["ok"], true);
        assert_eq!(resp["tokens"], crate::tokens::estimate_tokens(text));
        assert_eq!(resp["chars"], text.chars().count());
        assert!(resp["elapsed_us"].as_u64().is_some());
    }

    // #389: chars は文字数（Unicode scalar 数）であってバイト数ではない。
    #[test]
    fn estimate_reports_char_count_not_byte_count() {
        for (text, want) in [("\u{65e5}\u{672c}\u{8a9e}", 3), ("\u{e9}", 1), ("abc", 3)] {
            let resp: serde_json::Value =
                serde_json::from_str(&handle_line(&req("c1", "tokens.estimate", text, None)))
                    .unwrap();
            assert_eq!(resp["chars"], want, "text {text:?}");
        }
        let line = serde_json::json!({"v": 1, "id": "c2", "op": "tokens.estimate_batch",
            "texts": ["\u{65e5}\u{672c}\u{8a9e}", "\u{e9}", "abc"]})
        .to_string();
        let resp: serde_json::Value = serde_json::from_str(&handle_line(&line)).unwrap();
        assert_eq!(resp["chars"], serde_json::json!([3, 1, 3]));
    }

    #[test]
    fn prune_matches_direct_and_respects_budget() {
        let text = "x".repeat(20000);
        let resp: serde_json::Value =
            serde_json::from_str(&handle_line(&req("p1", "tokens.prune", &text, Some(100))))
                .unwrap();
        assert_eq!(resp["ok"], true);
        let pruned = resp["pruned"].as_str().unwrap();
        assert_eq!(pruned, crate::tokens::prune_to_budget(&text, 100));
        assert!(resp["after"].as_u64().unwrap() <= 100);
    }

    #[test]
    fn batch_matches_sum_of_direct() {
        let texts = vec!["abcd1234", "hello", "あいう"];
        let line =
            serde_json::json!({"v": 1, "id": "m1", "op": "tokens.estimate_batch", "texts": texts})
                .to_string();
        let resp: serde_json::Value = serde_json::from_str(&handle_line(&line)).unwrap();
        assert_eq!(resp["ok"], true);
        let want: Vec<usize> = texts
            .iter()
            .map(|s| crate::tokens::estimate_tokens(s))
            .collect();
        let got: Vec<u64> = serde_json::from_value(resp["tokens"].clone()).unwrap();
        assert_eq!(got, want.iter().map(|&n| n as u64).collect::<Vec<_>>());
        assert_eq!(resp["total"], want.iter().sum::<usize>() as u64);

        let empty =
            serde_json::json!({"v": 1, "id": "m2", "op": "tokens.estimate_batch", "texts": []})
                .to_string();
        let r: serde_json::Value = serde_json::from_str(&handle_line(&empty)).unwrap();
        assert_eq!(r["code"], "bad_batch");
    }

    #[test]
    fn rejects_unknown_op_version_and_size() {
        let bad_op: serde_json::Value =
            serde_json::from_str(&handle_line(&req("x", "nope", "hi", None))).unwrap();
        assert_eq!(bad_op["ok"], false);
        assert_eq!(bad_op["code"], "bad_op");

        let bad_v = serde_json::json!({"v": 999, "id": "x", "op": "tokens.estimate", "text": "hi"})
            .to_string();
        let r: serde_json::Value = serde_json::from_str(&handle_line(&bad_v)).unwrap();
        assert_eq!(r["code"], "bad_version");

        let big = "y".repeat(MAX_TEXT_BYTES + 1);
        let r: serde_json::Value =
            serde_json::from_str(&handle_line(&req("big", "tokens.estimate", &big, None))).unwrap();
        assert_eq!(r["code"], "too_large");

        let bad_budget: serde_json::Value = serde_json::from_str(&handle_line(&req(
            "b",
            "tokens.prune",
            "hello",
            Some(MAX_TOKENS + 1),
        )))
        .unwrap();
        assert_eq!(bad_budget["code"], "bad_budget");
    }

    #[test]
    fn rejects_bad_json_and_id() {
        let r: serde_json::Value = serde_json::from_str(&handle_line("{oops")).unwrap();
        assert_eq!(r["ok"], false);
        let r: serde_json::Value =
            serde_json::from_str(&handle_line(&req("", "tokens.estimate", "hi", None))).unwrap();
        assert_eq!(r["code"], "bad_id");
    }
}
