use crate::tokens::{estimate_tokens, prune_to_budget};
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

/// Compact a JSONL session transcript: keep first (system) + last turns
/// within budget. Never deletes source; prints to stdout.
pub fn cmd_compact(file: &str, max_tokens: usize) -> anyhow::Result<()> {
    let text = std::fs::read_to_string(file)?;
    let (lines, toks, total) = split_lines_with_tokens(&text);
    // One lock + big buffer: the old println! flushed at every newline
    // inside large outputs (stdout is line-buffered). Same bytes, far
    // fewer syscalls.
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::with_capacity(256 * 1024, stdout.lock());
    if total <= max_tokens {
        out.write_all(text.as_bytes())?;
        out.write_all(b"\n")?;
        out.flush()?;
        eprintln!("[rdsh] no compaction needed ({total} <= {max_tokens} tokens)");
        return Ok(());
    }
    let first = lines.first().copied().unwrap_or("");
    let mut kept: Vec<&str> = vec![];
    let mut used = toks.first().copied().unwrap_or(0) + 200;
    for (l, t) in lines.iter().zip(toks.iter()).rev() {
        if used + *t > max_tokens {
            break;
        }
        used += *t;
        kept.push(l);
    }
    kept.reverse();
    let dropped = lines.len().saturating_sub(kept.len());
    let summary =
        format!("...[rdsh compact: dropped ~{dropped} turn(s), {total}-><={max_tokens} tokens]...");
    let mut body = String::new();
    body.reserve(first.len() + summary.len() + kept.iter().map(|l| l.len() + 1).sum::<usize>() + 2);
    body.push_str(first);
    body.push('\n');
    body.push_str(&summary);
    body.push('\n');
    for l in &kept {
        // Skip only the head line itself (already emitted above). A content
        // match (`*l == first`) would also drop a body line that happens to
        // repeat the first line verbatim, e.g. a re-sent system prompt.
        if std::ptr::eq(*l, first) {
            continue;
        }
        body.push_str(l);
        body.push('\n');
    }
    let body = prune_to_budget(&body, max_tokens);
    out.write_all(body.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()?;
    eprintln!(
        "[rdsh] compacted {total} -> ~{} tokens ({} lines kept of {})",
        estimate_tokens(&body),
        kept.len(),
        lines.len()
    );
    Ok(())
}
