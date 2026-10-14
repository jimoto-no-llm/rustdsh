use crate::tokens::{estimate_tokens, prune_to_budget};
use std::collections::BTreeSet;
use std::io::Write;

/// Split `text` exactly like `str::lines` while counting per-line tokens
/// in the same byte pass. One scan replaces the old split pass plus one
/// `estimate_tokens` scan per line (each with its own `is_ascii` setup).
/// Returns (lines, per-line tokens, total tokens).
fn split_lines_with_tokens(text: &str) -> (Vec<&str>, Vec<usize>, usize) {
    let b = text.as_bytes();
    if text.is_ascii() {
        // Fast path: one SIMD scan above, then line lengths are tokens/4
        // with no per-line estimator call. Identical to estimate_tokens
        // on ASCII lines (len.div_ceil(4)).
        let guess = (b.len() / 128).clamp(16, 1 << 20);
        let mut lines: Vec<&str> = Vec::with_capacity(guess);
        let mut toks: Vec<usize> = Vec::with_capacity(guess);
        let mut total = 0usize;
        for l in text.lines() {
            let t = l.len().div_ceil(4);
            lines.push(l);
            toks.push(t);
            total += t;
        }
        return (lines, toks, total);
    }
    // Transcripts average well above 100 bytes/line; under-reserving a
    // little is cheaper than a second counting pass.
    let guess = (b.len() / 128).clamp(16, 1 << 20);
    let mut lines: Vec<&str> = Vec::with_capacity(guess);
    let mut toks: Vec<usize> = Vec::with_capacity(guess);
    let mut total = 0usize;
    let mut line_start = 0usize;
    let mut ascii_run = 0usize;
    let mut line_tokens = 0usize;
    let mut i = 0usize;
    while i < b.len() {
        let c = b[i];
        if c == b'\n' {
            // str::lines strips a single trailing '\r' (CRLF).
            let mut end = i;
            if end > line_start && b[end - 1] == b'\r' {
                end -= 1;
                // That '\r' was skipped below, so it never fed ascii_run.
            }
            line_tokens += ascii_run.div_ceil(4);
            total += line_tokens;
            // Both ends sit on ASCII bytes, hence on char boundaries.
            lines.push(&text[line_start..end]);
            toks.push(line_tokens);
            i += 1;
            line_start = i;
            ascii_run = 0;
            line_tokens = 0;
            continue;
        }
        if c < 0x80 {
            // Skip a '\r' that lines() would strip; a lone '\r' counts.
            if c == b'\r' && i + 1 < b.len() && b[i + 1] == b'\n' {
                i += 1;
                continue;
            }
            ascii_run += 1;
            if ascii_run == 4 {
                line_tokens += 1;
                ascii_run = 0;
            }
        } else if c & 0xC0 != 0x80 {
            // UTF-8 lead byte: one non-ASCII char == 1 token.
            if ascii_run > 0 {
                line_tokens += ascii_run.div_ceil(4);
                ascii_run = 0;
            }
            line_tokens += 1;
        }
        // Continuation bytes carry no additional tokens.
        i += 1;
    }
    // Trailing text without a final newline is the last line; a trailing
    // newline adds nothing (same as str::lines).
    if line_start < b.len() {
        line_tokens += ascii_run.div_ceil(4);
        total += line_tokens;
        lines.push(&text[line_start..]);
        toks.push(line_tokens);
    }
    (lines, toks, total)
}

/// Bit weights keep constraints ahead of any combination of lower categories.
/// The category order is also the fixed order used in the digest.
fn importance(line: &str) -> u8 {
    let lower = line.to_ascii_lowercase();
    let constraint = [
        "必ず",
        "方針",
        "決定",
        "制約",
        "してはいけない",
        "decided",
        "constraint",
        "must",
        "never",
    ]
    .iter()
    .any(|marker| lower.contains(marker));
    let error = ["error", "failed", "panic", "fail"]
        .iter()
        .any(|marker| lower.contains(marker));
    let diff = ["+++ b/", "--- a/", "@@", "src/"]
        .iter()
        .any(|marker| lower.contains(marker));
    let command = ["$ ", "cargo ", "npm ", "git "]
        .iter()
        .any(|marker| lower.contains(marker));
    u8::from(constraint) * 8 + u8::from(error) * 4 + u8::from(diff) * 2 + u8::from(command)
}

fn compact_digest(
    dropped: usize,
    before: usize,
    after: usize,
    preserved: usize,
    counts: [usize; 4],
) -> String {
    let [constraint, error, diff, command] = counts;
    format!(
        "...[rdsh compact: dropped {dropped} turn(s), {before}->{after} tokens]...\n\
         ...[rdsh compact: preserved {preserved} important line(s) from the dropped middle; \
         constraint={constraint}, error={error}, diff/path={diff}, command={command}]...\n"
    )
}

/// Keep system, ranked middle lines and recent turns without a final prune
/// that could remove an already selected important line.
fn compact_output(text: &str, max_tokens: usize) -> String {
    let full = estimate_tokens(text);
    if full <= max_tokens {
        return text.to_string();
    }
    let (lines, toks, _total) = split_lines_with_tokens(text);
    let first = lines.first().copied().unwrap_or_default();
    // Per-line estimates plus one token for a newline are an upper bound
    // on the joined output, including mixed ASCII/CJK boundaries.
    let costs: Vec<usize> = toks.iter().map(|tokens| tokens + 1).collect();
    let head_cost = costs.first().copied().unwrap_or_default();
    if head_cost > max_tokens {
        // A complete system line (and sometimes just its newline) cannot
        // fit. The strict budget wins; never cut at a UTF-8 byte boundary.
        return prune_to_budget(first, max_tokens);
    }
    let scores: Vec<u8> = lines.iter().map(|line| importance(line)).collect();
    let middle_reserve = max_tokens / 4;
    let smallest_important = (1..lines.len())
        .filter(|&i| scores[i] > 0 && lines[i] != first && costs[i] <= middle_reserve)
        .map(|i| costs[i])
        .min()
        .unwrap_or(0);
    // Maximum digit widths bound the digest before any lines are selected.
    // On very small budgets omit the digest rather than crowding out a
    // fitting important line or returning a partially pruned transcript.
    let digest_bound = compact_digest(lines.len(), full, max_tokens, lines.len(), [lines.len(); 4]);
    let digest_cost = estimate_tokens(&digest_bound);
    let available = max_tokens - head_cost;
    let with_digest = digest_cost <= available.saturating_sub(smallest_important);
    let content_budget = available - if with_digest { digest_cost } else { 0 };
    let reserve = if smallest_important > 0 {
        middle_reserve.min(content_budget)
    } else {
        0
    };
    let mut remaining = content_budget - reserve;
    let mut seen = BTreeSet::from([first]);
    let mut tail = Vec::new();
    let mut tail_start = lines.len();
    for i in (1..lines.len()).rev() {
        if seen.contains(lines[i]) {
            continue;
        }
        if costs[i] > remaining {
            break;
        }
        remaining -= costs[i];
        seen.insert(lines[i]);
        tail.push(i);
        tail_start = i;
    }
    let mut ranked: Vec<usize> = (1..tail_start)
        .filter(|&i| scores[i] > 0 && !seen.contains(lines[i]))
        .collect();
    ranked.sort_unstable_by_key(|&i| (std::cmp::Reverse(scores[i]), i));
    let mut middle = Vec::new();
    let mut middle_remaining = reserve;
    let mut counts = [0; 4];
    for i in ranked {
        if costs[i] > middle_remaining || seen.contains(lines[i]) {
            continue;
        }
        middle_remaining -= costs[i];
        seen.insert(lines[i]);
        middle.push(i);
        for (category, count) in counts.iter_mut().enumerate() {
            *count += usize::from(scores[i] & (8 >> category) != 0);
        }
    }
    middle.sort_unstable();
    // Lines kept from the dropped middle, including the ones the giveback loop
    // below rescues; the digest counts both.
    let mut preserved_important = middle.len();
    // Give unused middle capacity back to the tail, stopping before the
    // newest preserved middle line to keep all source lines in order.
    remaining += middle_remaining;
    let middle_end = middle.last().copied().unwrap_or(0);
    for i in ((middle_end + 1)..tail_start).rev() {
        if seen.contains(lines[i]) {
            continue;
        }
        if costs[i] > remaining {
            break;
        }
        remaining -= costs[i];
        seen.insert(lines[i]);
        tail.push(i);
        if scores[i] > 0 {
            preserved_important += 1;
            for (category, count) in counts.iter_mut().enumerate() {
                *count += usize::from(scores[i] & (8 >> category) != 0);
            }
        }
    }
    tail.reverse();
    let dropped = lines.len().saturating_sub(1 + middle.len() + tail.len());
    let mut after = max_tokens;
    loop {
        let mut body = String::new();
        body.push_str(first);
        body.push('\n');
        if with_digest {
            body.push_str(&compact_digest(
                dropped,
                full,
                after,
                preserved_important,
                counts,
            ));
        }
        for &i in middle.iter().chain(tail.iter()) {
            body.push_str(lines[i]);
            body.push('\n');
        }
        let actual = estimate_tokens(&body);
        debug_assert!(actual <= max_tokens);
        if !with_digest || actual == after {
            return body;
        }
        // Only the decimal width of `after` affects the estimate. Starting
        // at the budget makes widths decrease until the digest is exact.
        after = actual;
    }
}

/// Compact a JSONL session transcript without changing the source file.
pub fn cmd_compact(file: &str, max_tokens: usize) -> anyhow::Result<()> {
    let text = std::fs::read_to_string(file)?;
    let body = compact_output(&text, max_tokens);
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::with_capacity(256 * 1024, stdout.lock());
    out.write_all(body.as_bytes())?;
    out.flush()?;
    let full = estimate_tokens(&text);
    if full <= max_tokens {
        eprintln!("[rdsh] no compaction needed ({full} <= {max_tokens} tokens)");
    } else {
        eprintln!(
            "[rdsh] compacted {full} -> ~{} tokens ({} lines kept of {})",
            estimate_tokens(&body),
            body.lines()
                .filter(|line| !line.starts_with("...[rdsh compact:"))
                .count(),
            text.lines().count()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn newlines_count_toward_noop_budget() {
        let line = r#"{"a":10}"#;
        let mut text = String::new();
        for _ in 0..4000 {
            text.push_str(line);
            text.push('\n');
        }
        let (_lines, _toks, split_total) = split_lines_with_tokens(&text);
        assert_eq!(split_total, 8000);
        let full = estimate_tokens(&text);
        assert_eq!(full, 9000);
        assert!(full > 8000);
        let out = compact_output(&text, 8000);
        assert!(estimate_tokens(&out) <= 8000);
    }
    #[test]
    fn tiny_budgets_never_exceed_budget() {
        let mut source = String::new();
        for _ in 0..100 {
            source.push_str(r"1234567890");
        }
        for budget in [0, 1] {
            let out = compact_output(&source, budget);
            assert!(estimate_tokens(&out) <= budget);
        }
        assert_eq!(estimate_tokens(&compact_output(&source, 0)), 0);
    }
    #[test]
    fn noop_returns_source_verbatim_within_budget() {
        let text = r"hello".to_string();
        let out = compact_output(&text, 8000);
        assert_eq!(out, text);
        assert!(estimate_tokens(&out) <= 8000);
    }

    fn transcript_with_middle(middle: &[&str]) -> String {
        let mut text = String::from("SYSTEM\n");
        for i in 0..24 {
            text.push_str(&format!("old {i:02} {}\n", "x".repeat(80)));
        }
        for line in middle {
            text.push_str(line);
            text.push('\n');
        }
        for i in 0..24 {
            text.push_str(&format!("recent {i:02} {}\n", "y".repeat(80)));
        }
        text.push_str("LATEST\n");
        text
    }

    #[test]
    fn middle_constraint_survives_one_third_and_small_budgets() {
        let important = "必ず検証する";
        let text = transcript_with_middle(&[important]);
        for budget in [estimate_tokens(&text) / 3, 100, 64] {
            let out = compact_output(&text, budget);
            assert!(out.lines().any(|line| line == important), "budget {budget}");
            assert!(out.starts_with("SYSTEM\n"));
            assert!(out.ends_with("LATEST\n"));
            assert!(estimate_tokens(&out) <= budget);
        }
    }

    #[test]
    fn cjk_and_ascii_markers_have_ranked_categories() {
        for marker in [
            "必ず",
            "方針",
            "決定",
            "制約",
            "してはいけない",
            "DECIDED",
            "Constraint",
            "MUST",
            "never",
        ] {
            assert_eq!(importance(marker), 8, "{marker}");
        }
        for marker in ["error", "FAILED", "panic", "fail"] {
            assert_eq!(importance(marker), 4, "{marker}");
        }
        for marker in ["+++ b/file", "--- a/file", "@@", "src/file"] {
            assert_eq!(importance(marker), 2, "{marker}");
        }
        for marker in ["$ run", "cargo test", "npm test", "git diff"] {
            assert_eq!(importance(marker), 1, "{marker}");
        }
        assert_eq!(importance("ordinary text"), 0);
        assert!(importance("必ず") > importance("$ cargo test src/a.rs FAILED"));
    }

    #[test]
    fn important_middle_is_in_source_order_with_exact_digest() {
        let important = [
            "error: earlier failure",
            "必ず確認する",
            "+++ b/src/lib.rs",
            "$ cargo test",
            "$ git diff",
        ];
        let text = transcript_with_middle(&important);
        let budget = estimate_tokens(&text) / 3;
        let out = compact_output(&text, budget);
        let positions: Vec<_> = important
            .iter()
            .map(|line| out.find(line).expect("important line retained"))
            .collect();
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(out.contains("preserved 5 important line(s) from the dropped middle"));
        assert!(out.contains("constraint=1, error=1, diff/path=1, command=2"));
        assert!(out.contains(&format!(
            "{}->{} tokens",
            estimate_tokens(&text),
            estimate_tokens(&out)
        )));
        let retained: Vec<_> = out
            .lines()
            .filter(|line| !line.starts_with("...[rdsh compact:"))
            .collect();
        let dropped = text.lines().count() - retained.len();
        assert!(out.contains(&format!("dropped {dropped} turn(s)")));
        assert!(estimate_tokens(&out) <= budget);
    }

    #[test]
    fn highest_scoring_middle_wins_the_quarter_budget() {
        let important = ["$ cargo test", "error: a", "必ず確認する"];
        let text = transcript_with_middle(&important);
        let budget = 32;
        let out = compact_output(&text, budget);
        assert!(out.lines().any(|line| line == important[2]));
        assert!(!out.lines().any(|line| line == important[0]));
        assert!(!out.lines().any(|line| line == important[1]));
        let middle_cost: usize = important
            .iter()
            .filter(|line| out.lines().any(|kept| kept == **line))
            .map(|line| estimate_tokens(line) + 1)
            .sum();
        assert!(middle_cost <= budget / 4);
        assert!(estimate_tokens(&out) <= budget);
    }

    #[test]
    fn repeated_source_lines_are_emitted_once_and_deterministically() {
        let text = transcript_with_middle(&["SYSTEM", "必ず確認する", "必ず確認する", "LATEST"]);
        let budget = estimate_tokens(&text) / 3;
        let out = compact_output(&text, budget);
        assert_eq!(out, compact_output(&text, budget));
        let emitted: Vec<_> = out.lines().collect();
        let unique: BTreeSet<_> = emitted.iter().copied().collect();
        assert_eq!(emitted.len(), unique.len());
        for line in ["SYSTEM", "必ず確認する", "LATEST"] {
            assert_eq!(emitted.iter().filter(|&&kept| kept == line).count(), 1);
        }
    }

    #[test]
    fn noop_preserves_crlf_blanks_duplicates_and_final_newline() {
        for text in ["", "\n", "a\r\na\r\n\r\n", "方針\r\n必ず\n\n", "hello\r"] {
            for budget in [estimate_tokens(text), usize::MAX] {
                assert_eq!(compact_output(text, budget).as_bytes(), text.as_bytes());
            }
        }
    }

    #[test]
    fn every_small_budget_is_safe_for_unicode_and_oversized_lines() {
        let sources = [
            "必ず日本語abc\n".repeat(100),
            format!("SYSTEM\n{}\nLATEST\n", "panic 日本語".repeat(100)),
            format!("{}\n必ず確認する\n", "巨大な先頭abc".repeat(100)),
            "\r\n".repeat(400),
            transcript_with_middle(&["必ず確認する", "error: 日本語"]),
        ];
        for source in sources {
            for budget in 0..=256 {
                let out = compact_output(&source, budget);
                assert!(estimate_tokens(&out) <= budget, "budget {budget}");
            }
        }
    }
}
