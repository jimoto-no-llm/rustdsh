use std::io::{Read, Write};

/// Heuristic token estimator: ASCII runs count `ceil(len / 4)` tokens,
/// non-ASCII scalars (e.g. CJK) count 1 token each. O(n), std-only.
///
/// Budget context (estimation only, no enforcement here):
/// - #80 inline type-declaration budgets compare against this estimate.
/// - #81 small-state snapshots use it to check size limits.
/// - #82 classifier fan-out sums per-call estimates via this function.
///
/// Formula is frozen; keep doc/test-only changes in this area.
pub fn estimate_tokens(s: &str) -> usize {
    if s.is_ascii() {
        return s.len().div_ceil(4);
    }
    estimate_bytes(s.as_bytes())
}

/// Byte-level twin of the char rule above: ASCII bytes accumulate in runs
/// of 4 -> 1 token, each non-ASCII scalar (exactly one UTF-8 lead byte)
/// counts 1 token, continuation bytes count nothing. Same result as
/// iterating `chars()`, without UTF-8 decoding overhead.
fn estimate_bytes(b: &[u8]) -> usize {
    let mut tokens = 0usize;
    let mut ascii_run = 0usize;
    for &c in b {
        if c < 0x80 {
            ascii_run += 1;
            if ascii_run == 4 {
                tokens += 1;
                ascii_run = 0;
            }
        } else if c & 0xC0 != 0x80 {
            // UTF-8 lead byte: one non-ASCII char.
            if ascii_run > 0 {
                tokens += ascii_run.div_ceil(4);
                ascii_run = 0;
            }
            tokens += 1;
        }
    }
    tokens + ascii_run.div_ceil(4)
}

/// Byte offset just past the first `n` chars (`s.len()` when shorter).
/// Pure byte-class scan, no per-char allocation.
fn head_byte_end(s: &str, n: usize) -> usize {
    let mut chars = 0usize;
    for (i, &b) in s.as_bytes().iter().enumerate() {
        if b & 0xC0 != 0x80 {
            chars += 1;
            if chars > n {
                return i;
            }
        }
    }
    s.len()
}

/// Byte offset where the last `n` chars start (0 when longer).
fn tail_byte_start(s: &str, n: usize) -> usize {
    let mut chars = 0usize;
    for (i, &b) in s.as_bytes().iter().enumerate().rev() {
        if b & 0xC0 != 0x80 {
            chars += 1;
            if chars > n {
                return i + utf8_len(b);
            }
        }
    }
    0
}

/// Length in bytes of the scalar starting with lead byte `b`.
fn utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b & 0xE0 == 0xC0 {
        2
    } else if b & 0xF0 == 0xE0 {
        3
    } else {
        4
    }
}

/// Keep head+tail within `max_tokens`; middle replaced with a marker.
/// Budget guarantee: `estimate_tokens(result) <= max_tokens` always holds.
/// Split is head-heavy (2/3 head, 1/3 tail); tiny budgets that cannot fit
/// the marker degrade to a head-only prefix instead of going over budget.
/// Callers (#80 tool catalogs, #81 state snapshots, #82 classifier batches)
/// use this to size payloads before sending; formula unchanged.
pub fn prune_to_budget(s: &str, max_tokens: usize) -> String {
    prune_with_total(s, max_tokens, estimate_tokens(s))
}

/// Fast char count for valid UTF-8: lead bytes only (same as chars().count()).
#[inline]
fn char_count(s: &str) -> usize {
    s.as_bytes().iter().filter(|&&b| b & 0xC0 != 0x80).count()
}

/// Shared impl for callers that already estimated `s` (saves a scan).
fn prune_with_total(s: &str, max_tokens: usize, total: usize) -> String {
    if total <= max_tokens {
        return s.to_string();
    }
    if max_tokens == 0 {
        return String::new();
    }
    let marker = format!("\n\n...[rdsh pruned {total}->{max_tokens} tokens]...\n\n");
    // For ASCII, char and byte offsets coincide, and the joined result is
    // exactly ceil((kept bytes + marker bytes) / 4). Solve the same search
    // directly, retaining its head/tail split and tiny-budget behavior.
    if s.is_ascii() {
        let capacity = max_tokens.saturating_mul(4);
        if estimate_tokens(&marker) >= max_tokens {
            return s[..s.len().min(capacity)].to_string();
        }
        let keep = s.len().saturating_sub(1).min(capacity - marker.len());
        let head = keep * 2 / 3;
        let tail = keep - head;
        return format!("{}{}{}", &s[..head], marker, &s[s.len() - tail..]);
    }
    let chars = char_count(s);
    if estimate_tokens(&marker) >= max_tokens {
        // A tiny budget cannot fit the marker. Preserve as much of the head
        // as the estimator permits instead of returning an over-budget label.
        let mut low = 0;
        let mut high = chars.min(max_tokens.saturating_mul(4));
        while low < high {
            let mid = low + (high - low).div_ceil(2);
            if estimate_tokens(&s[..head_byte_end(s, mid)]) <= max_tokens {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return s[..head_byte_end(s, low)].to_string();
    }
    let candidate = |keep: usize| {
        let head_chars = keep * 2 / 3;
        let tail_chars = keep - head_chars;
        let head = &s[..head_byte_end(s, head_chars)];
        let tail = if tail_chars == 0 {
            ""
        } else {
            &s[tail_byte_start(s, tail_chars)..]
        };
        format!("{head}{marker}{tail}")
    };
    let mut low = 0;
    let mut high = chars.saturating_sub(1).min(max_tokens.saturating_mul(4));
    while low < high {
        let mid = low + (high - low).div_ceil(2);
        if estimate_tokens(&candidate(mid)) <= max_tokens {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    candidate(low)
}

fn read_stdin() -> anyhow::Result<String> {
    let mut buf = String::with_capacity(1 << 16);
    std::io::stdin().read_to_string(&mut buf)?;
    Ok(buf)
}

fn stdout_writer() -> std::io::BufWriter<std::io::StdoutLock<'static>> {
    std::io::BufWriter::with_capacity(256 * 1024, std::io::stdout().lock())
}

pub fn cmd_tokens(files: Vec<String>, preview: usize) -> anyhow::Result<()> {
    let mut out = stdout_writer();
    if files.is_empty() {
        let text = read_stdin()?;
        writeln!(
            out,
            "{{\"tokens\": {}, \"chars\": {}}}",
            estimate_tokens(&text),
            text.len()
        )?;
        out.flush()?;
        return Ok(());
    }
    let mut total = 0usize;
    for f in &files {
        let text = std::fs::read_to_string(f)?;
        let t = estimate_tokens(&text);
        total += t;
        writeln!(out, "{t:>8}  {f}")?;
        if preview > 0 {
            let pv = text[..head_byte_end(&text, preview)].replace('\n', "\\n");
            writeln!(out, "  preview: {pv}")?;
        }
    }
    if files.len() > 1 {
        writeln!(out, "{total:>8}  (total)")?;
    }
    out.flush()?;
    Ok(())
}

pub fn cmd_prune(max_tokens: usize, file: Option<String>) -> anyhow::Result<()> {
    let text = match file {
        Some(f) => std::fs::read_to_string(&f)?,
        None => read_stdin()?,
    };
    // Borrow the content field when present; otherwise the raw text.
    // The old code cloned the whole input here on the common path.
    // Fast path: plain text never parses; skip failed parse (same fallback).
    let parsed: Option<serde_json::Value> = match text.trim_start().as_bytes().first() {
        Some(b'{') | Some(b'[') | Some(b'"') => serde_json::from_str(&text).ok(),
        _ => None,
    };
    let raw: &str = parsed
        .as_ref()
        .and_then(|v| v.get("content"))
        .and_then(|c| c.as_str())
        .filter(|c| !c.is_empty())
        .unwrap_or(&text);
    let before = estimate_tokens(raw);
    let pruned = prune_with_total(raw, max_tokens, before);
    let after = estimate_tokens(&pruned);
    eprintln!("[rdsh] tokens {before} -> {after} (budget {max_tokens})");
    let mut out = stdout_writer();
    write!(out, "{pruned}")?;
    out.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_counts() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("a"), 1);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
        assert_eq!(estimate_tokens("hello world, token test"), 6);
    }

    #[test]
    fn non_ascii_counts() {
        assert_eq!(estimate_tokens("a"), 1);
        assert!(estimate_tokens("hello") > 0);
        let mixed = "abcXdef";
        assert_eq!(estimate_tokens(mixed), 2);
    }

    #[test]
    fn prune_keeps_small() {
        let s = "short text";
        assert_eq!(prune_to_budget(s, 4000), s);
    }

    #[test]
    fn prune_marks_big() {
        let s: String = "x".repeat(20000);
        let p = prune_to_budget(&s, 100);
        assert!(p.contains("rdsh pruned"));
        assert!(estimate_tokens(&p) <= 100);
    }

    #[test]
    fn prune_respects_small_and_unicode_budgets() {
        for source in ["abcdef".repeat(1000), "日本語abc".repeat(1000)] {
            for budget in [0, 1, 2, 4, 8, 16, 32, 100] {
                let result = prune_to_budget(&source, budget);
                assert!(estimate_tokens(&result) <= budget, "budget {budget}");
            }
        }
    }

    #[test]
    fn ascii_prune_matches_exhaustive_budget_oracle() {
        // Enumerate possible outputs independently of the optimized path.
        // Distinct bytes expose head/tail off-by-one errors at marker and
        // four-byte token boundaries, including budgets too small for a marker.
        for length in (0usize..180).chain([999, 1000, 3999, 4000, 4001, 40000]) {
            let source: String = (0..length)
                .map(|i| (b'!' + (i % 90) as u8) as char)
                .collect();
            let total = length.div_ceil(4);
            for budget in 0..81 {
                let expected = if total <= budget {
                    source.clone()
                } else if budget == 0 {
                    String::new()
                } else {
                    let marker = format!("\n\n...[rdsh pruned {total}->{budget} tokens]...\n\n");
                    if marker.len().div_ceil(4) >= budget {
                        source[..length.min(budget * 4)].to_string()
                    } else {
                        (0..length.min(budget * 4))
                            .map(|keep| {
                                let head = keep * 2 / 3;
                                let tail = keep - head;
                                format!("{}{}{}", &source[..head], marker, &source[length - tail..])
                            })
                            .rfind(|candidate| candidate.len().div_ceil(4) <= budget)
                            .unwrap()
                    }
                };
                assert_eq!(
                    prune_to_budget(&source, budget),
                    expected,
                    "length={length}, budget={budget}"
                );
            }
        }
    }

    // #80: inline type-declaration budget — small catalog stays intact,
    // oversized catalog prunes within budget (estimate-only check).
    #[test]
    fn inline_type_budget_for_tool_catalog() {
        let small = r#"{"name":"search","input":{"q":"string"}}"#;
        assert_eq!(prune_to_budget(small, 4000), small);
        let big = r#"{"type":"object"}"#.repeat(2000);
        let pruned = prune_to_budget(&big, 64);
        assert!(estimate_tokens(&pruned) <= 64);
        assert!(pruned.contains("rdsh pruned"));
    }

    // #81: small-state snapshot — tiny JSON under budget is byte-identical.
    #[test]
    fn small_state_snapshot_kept_verbatim() {
        let state = r#"{"cursor":"abc123","hits":[1,2,3]}"#;
        let budget = estimate_tokens(state) + 10;
        assert_eq!(prune_to_budget(state, budget), state);
    }

    // #82: classifier fan-out — per-call estimates sum without overflow,
    // pruned batch head still fits the shared budget.
    #[test]
    fn classifier_batch_fits_shared_budget() {
        let choices = ["yes".to_string(), "no".to_string(), "はい".to_string()];
        let total: usize = choices.iter().map(|c| estimate_tokens(c)).sum();
        assert_eq!(total, 4); // 1 + 1 + 2 (CJK x2).
        let joined = choices.join("\n").repeat(500);
        let pruned = prune_to_budget(&joined, 48);
        assert!(estimate_tokens(&pruned) <= 48);
    }

    // CJK rule pin: each non-ASCII scalar counts 1 token.
    #[test]
    fn cjk_chars_count_one_each() {
        assert_eq!(estimate_tokens("あ"), 1);
        assert_eq!(estimate_tokens("日本語"), 3);
        // Mixed ASCII run + CJK: ceil(3/4)=1 plus 2 CJK = 3.
        assert_eq!(estimate_tokens("abc日本"), 3);
    }

    // Pruned output keeps head and tail order around the marker.
    #[test]
    fn prune_keeps_head_and_tail_order() {
        let s: String = (0..5000).map(|i| format!("L{i:04} ")).collect();
        let p = prune_to_budget(&s, 50);
        assert!(estimate_tokens(&p) <= 50);
        let marker = p.find("rdsh pruned").expect("marker");
        assert!(p[..marker].contains("L0000"));
        assert!(p[marker..].contains("L4999"));
    }
}
