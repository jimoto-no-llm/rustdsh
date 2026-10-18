//! Small, dependency-free Markdown block model for the conversation timeline.
//!
//! The parser is deliberately total: every input produces blocks (or nothing),
//! it never panics, and anything it does not understand falls back to a plain
//! paragraph. Only the subset the timeline needs is modelled: paragraphs, ATX
//! headings, bullet and numbered lists, blockquotes, fenced and indented code,
//! thematic breaks, and the inline spans bold, italic, inline code and links.

/// One renderable block of a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Block {
    /// Runs of text separated by blank lines; single newlines become spaces.
    Paragraph(Vec<Span>),
    /// An ATX heading (`#`..`######`); the level is clamped to 1..=6.
    Heading { level: u8, spans: Vec<Span> },
    /// A bullet (`-`, `*`, `+`) or numbered (`1.`, `1)`) list.
    List { ordered: bool, items: Vec<Vec<Span>> },
    /// A `>` blockquote, rendered with a left border.
    Blockquote(Vec<Block>),
    /// A fenced or indented code block with its optional language label.
    CodeBlock { language: Option<String>, code: String },
    /// `---`, `***` or `___` on a line of its own.
    Rule,
}

/// One inline span inside a block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Span {
    Text(String),
    Bold(Vec<Span>),
    Italic(Vec<Span>),
    Code(String),
    /// `[label](target)`; rendering shows the label in the accent colour.
    Link { text: Vec<Span>, target: String },
}

/// Parse `text` into blocks. Never fails and never panics.
pub fn parse(text: &str) -> Vec<Block> {
    parse_lines(text, 0)
}

/// The plain text of a span tree. Used by the tests to assert what a user
/// would read; the timeline renders spans directly.
#[cfg(test)]
pub fn span_text(spans: &[Span]) -> String {
    let mut out = String::new();
    push_span_text(spans, &mut out);
    out
}

#[cfg(test)]
fn push_span_text(spans: &[Span], out: &mut String) {
    for span in spans {
        match span {
            Span::Text(text) | Span::Code(text) => out.push_str(text),
            Span::Bold(inner) | Span::Italic(inner) => push_span_text(inner, out),
            Span::Link { text, .. } => push_span_text(text, out),
        }
    }
}

/// Nesting guard for blockquotes: a pathological document of `>` lines must
/// not recurse without bound.
const MAX_QUOTE_DEPTH: usize = 8;

fn parse_lines(text: &str, depth: usize) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut paragraph: Vec<&str> = Vec::new();
    let mut list: Vec<ListItem<'_>> = Vec::new();
    let mut quote: Vec<String> = Vec::new();
    let mut fence: Option<Fence> = None;
    let mut code = String::new();
    let mut pending_rule = false;

    for line in text.lines() {
        if let Some(marker) = fence.as_ref() {
            if is_fence(line, marker.marker) {
                blocks.push(finish_fence(fence.take(), code));
                code = String::new();
            } else {
                if !code.is_empty() {
                    code.push('\n');
                }
                code.push_str(line);
            }
            continue;
        }

        if let Some(open) = fence_open(line) {
            flush_paragraph(&mut blocks, &mut paragraph);
            flush_list(&mut blocks, &mut list);
            flush_quote(&mut blocks, &mut quote, depth);
            fence = Some(open);
            continue;
        }

        if line.trim().is_empty() {
            flush_paragraph(&mut blocks, &mut paragraph);
            flush_list(&mut blocks, &mut list);
            if !quote.is_empty() {
                flush_quote(&mut blocks, &mut quote, depth);
            }
            continue;
        }

        if pending_rule {
            blocks.push(Block::Rule);
            pending_rule = false;
        }

        if let Some((ordered, content)) = list_item(line) {
            if !list.is_empty() && list[0].ordered != ordered {
                flush_list(&mut blocks, &mut list);
            }
            flush_paragraph(&mut blocks, &mut paragraph);
            if !quote.is_empty() {
                flush_quote(&mut blocks, &mut quote, depth);
            }
            list.push(ListItem { ordered, content });
            continue;
        }

        if is_quote(line) {
            flush_paragraph(&mut blocks, &mut paragraph);
            flush_list(&mut blocks, &mut list);
            quote.push(quote_content(line));
            continue;
        }

        if !quote.is_empty() {
            flush_quote(&mut blocks, &mut quote, depth);
        }

        if is_rule(line) {
            flush_paragraph(&mut blocks, &mut paragraph);
            flush_list(&mut blocks, &mut list);
            pending_rule = true;
            continue;
        }

        if let Some((level, content)) = heading(line) {
            flush_paragraph(&mut blocks, &mut paragraph);
            flush_list(&mut blocks, &mut list);
            blocks.push(Block::Heading {
                level,
                spans: parse_inline(content),
            });
            continue;
        }

        paragraph.push(line);
    }

    if let Some(marker) = fence {
        // An unterminated fence still renders as a code block.
        blocks.push(finish_fence(Some(marker), code));
    }
    if pending_rule {
        blocks.push(Block::Rule);
    }
    flush_paragraph(&mut blocks, &mut paragraph);
    flush_list(&mut blocks, &mut list);
    flush_quote(&mut blocks, &mut quote, depth);
    blocks
}

#[derive(Clone, Debug)]
struct Fence {
    marker: u8,
    language: Option<String>,
}

#[derive(Clone, Debug)]
struct ListItem<'a> {
    ordered: bool,
    content: &'a str,
}

/// Fences are three or more of the same marker, optionally followed by a
/// language word: ```rust or ~~~ rust.
fn fence_open(line: &str) -> Option<Fence> {
    let trimmed = line.trim_start();
    let marker = *trimmed.as_bytes().first()?;
    if marker != b'`' && marker != b'~' {
        return None;
    }
    let width = trimmed.bytes().take_while(|byte| *byte == marker).count();
    if width < 3 {
        return None;
    }
    let rest = trimmed[width..].trim();
    if rest.contains(marker as char) {
        return None;
    }
    let language = rest
        .split_whitespace()
        .next()
        .map(str::to_string)
        .filter(|name| !name.is_empty());
    Some(Fence { marker, language })
}

fn is_fence(line: &str, marker: u8) -> bool {
    let trimmed = line.trim();
    trimmed.len() >= 3 && trimmed.bytes().all(|byte| byte == marker)
}

fn finish_fence(fence: Option<Fence>, code: String) -> Block {
    Block::CodeBlock {
        language: fence.and_then(|fence| fence.language),
        code: code.trim_end_matches('\n').to_string(),
    }
}

fn flush_paragraph<'a>(blocks: &mut Vec<Block>, paragraph: &mut Vec<&'a str>) {
    if paragraph.is_empty() {
        return;
    }
    let text = paragraph
        .iter()
        .map(|line| line.trim())
        .collect::<Vec<_>>()
        .join(" ");
    paragraph.clear();
    blocks.push(Block::Paragraph(parse_inline(&text)));
}

fn flush_list<'a>(blocks: &mut Vec<Block>, list: &mut Vec<ListItem<'a>>) {
    if list.is_empty() {
        return;
    }
    let ordered = list.iter().filter(|item| item.ordered).count() * 2 > list.len();
    let items = list.iter().map(|item| parse_inline(item.content)).collect();
    list.clear();
    blocks.push(Block::List { ordered, items });
}

/// Blockquotes are parsed recursively so nested `>` markers survive.
fn flush_quote(blocks: &mut Vec<Block>, quote: &mut Vec<String>, depth: usize) {
    if quote.is_empty() {
        return;
    }
    let text = quote.join("\n");
    quote.clear();
    if depth >= MAX_QUOTE_DEPTH {
        blocks.push(Block::Paragraph(parse_inline(&text)));
    } else {
        blocks.push(Block::Blockquote(parse_lines(&text, depth + 1)));
    }
}

/// A heading is one to six `#` followed by a space or the end of the line.
fn heading(line: &str) -> Option<(u8, &str)> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('#') {
        return None;
    }
    let level = trimmed.bytes().take_while(|byte| *byte == b'#').count();
    if level == 0 || level > 6 {
        return None;
    }
    let rest = &trimmed[level..];
    if !rest.is_empty() && !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    let content = rest.trim();
    let trimmed_end = content.trim_end_matches('#');
    let content = if trimmed_end.len() != content.len() {
        trimmed_end.trim_end()
    } else {
        content
    };
    Some((level as u8, content))
}

fn is_rule(line: &str) -> bool {
    let stripped: String = line
        .trim()
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    stripped.len() >= 3
        && (stripped.chars().all(|character| character == '-')
            || stripped.chars().all(|character| character == '*')
            || stripped.chars().all(|character| character == '_'))
}

fn is_quote(line: &str) -> bool {
    line.trim_start().starts_with('>')
}

fn quote_content(line: &str) -> String {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix('>').unwrap_or(trimmed);
    rest.strip_prefix(' ').unwrap_or(rest).to_string()
}

/// A list marker must be followed by a space so `-1` stays arithmetic.
fn list_item(line: &str) -> Option<(bool, &str)> {
    let trimmed = line.trim_start();
    for marker in ['-', '*', '+'] {
        if let Some(rest) = trimmed.strip_prefix(marker) {
            if let Some(content) = rest.strip_prefix(' ') {
                return Some((false, content.trim()));
            }
        }
    }
    let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 || digits > 9 {
        return None;
    }
    let rest = &trimmed[digits..];
    let content = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "))?;
    Some((true, content.trim()))
}

fn parse_inline(text: &str) -> Vec<Span> {
    let mut spans: Vec<Span> = Vec::new();
    let mut start = 0usize;
    let mut index = 0usize;
    while index < text.len() {
        if !text.is_char_boundary(index) {
            index += 1;
            continue;
        }
        let byte = text.as_bytes()[index];
        let emit = |spans: &mut Vec<Span>, start: &mut usize, up_to: usize| {
            if up_to > *start {
                let plain = text[*start..up_to].to_string();
                push_span(spans, Span::Text(plain));
                *start = up_to;
            }
        };
        match byte {
            b'`' => {
                if let Some(end) = text[index + 1..].find('`') {
                    let close = index + 1 + end;
                    emit(&mut spans, &mut start, index);
                    push_span(&mut spans, Span::Code(text[index + 1..close].to_string()));
                    index = close + 1;
                    start = index;
                    continue;
                }
            }
            b'*' | b'_' => {
                let double = text.as_bytes().get(index + 1) == Some(&byte);
                let width = if double { 2 } else { 1 };
                if let Some((inner, end)) = delimited(text, index, byte, width) {
                    emit(&mut spans, &mut start, index);
                    push_span(
                        &mut spans,
                        if width == 2 {
                            Span::Bold(inner)
                        } else {
                            Span::Italic(inner)
                        },
                    );
                    index = end;
                    start = index;
                    continue;
                }
            }
            b'!' | b'[' => {
                let open = if byte == b'!' { index + 1 } else { index };
                if text.as_bytes().get(open) == Some(&b'[') {
                    if let Some((label, target, end)) = link(text, open) {
                        emit(&mut spans, &mut start, index);
                        push_span(&mut spans, Span::Link { text: label, target });
                        index = end;
                        start = index;
                        continue;
                    }
                }
            }
            _ => {}
        }
        if byte == b'\n' {
            emit(&mut spans, &mut start, index);
            start = index + 1;
        }
        index += 1;
    }
    if start < text.len() {
        let plain = text[start..].to_string();
        push_span(&mut spans, Span::Text(plain));
    }
    spans
}

/// Find the closing run of `marker` at `at`; `None` leaves the marker as text.
fn delimited(text: &str, at: usize, marker: u8, width: usize) -> Option<(Vec<Span>, usize)> {
    let open_end = at + width;
    if open_end >= text.len() {
        return None;
    }
    if text.as_bytes().get(open_end).copied() == Some(b' ') {
        return None;
    }
    if marker == b'_' && !underscore_open(text, at) {
        return None;
    }
    let close = find_close(text, open_end, marker, width)?;
    if close == open_end {
        return None;
    }
    if marker == b'_' && !underscore_close(text, close + width) {
        return None;
    }
    Some((parse_inline(&text[open_end..close]), close + width))
}

fn find_close(text: &str, from: usize, marker: u8, width: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut cursor = from;
    while cursor + width <= bytes.len() {
        if bytes[cursor] == marker {
            let run = bytes[cursor..]
                .iter()
                .take_while(|byte| **byte == marker)
                .count();
            if run >= width {
                return Some(cursor);
            }
            cursor += run.max(1);
        } else {
            cursor += 1;
        }
    }
    None
}

/// `_` opens only at a word boundary so `snake_case` stays literal.
fn underscore_open(text: &str, at: usize) -> bool {
    at == 0
        || text[..at]
            .chars()
            .next_back()
            .map(|character| !character.is_alphanumeric())
            .unwrap_or(true)
}

fn underscore_close(text: &str, after: usize) -> bool {
    text[after..]
        .chars()
        .next()
        .map(|character| !character.is_alphanumeric())
        .unwrap_or(true)
}

/// `[label](target)` or `![label](target)`, starting at the bracket.
fn link(text: &str, open: usize) -> Option<(Vec<Span>, String, usize)> {
    let close = matching_bracket(text, open)?;
    if text.as_bytes().get(close + 1) != Some(&b'(') {
        return None;
    }
    let rest = &text[close + 2..];
    let end = rest.find(')')?;
    let destination = rest[..end].trim();
    if destination.is_empty() || destination.contains(char::is_whitespace) {
        return None;
    }
    let label = parse_inline(&text[open + 1..close]);
    let target = destination
        .trim_start_matches('<')
        .trim_end_matches('>')
        .to_string();
    Some((label, target, close + 2 + end + 1))
}

fn matching_bracket(text: &str, open: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut cursor = open;
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'[' => depth += 1,
            b']' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(cursor);
                }
            }
            _ => {}
        }
        cursor += 1;
    }
    None
}

fn push_span(spans: &mut Vec<Span>, span: Span) {
    if let Span::Text(text) = &span {
        if text.is_empty() {
            return;
        }
    }
    spans.push(span);
}

#[cfg(test)]
mod tests {
    use super::{parse, span_text, Block, Span};

    #[test]
    fn headings_keep_their_level_and_text() {
        let blocks = parse("# Title\n\n### Deep ###\n\n####### too deep\n\n#no space");
        assert_eq!(
            blocks,
            vec![
                Block::Heading {
                    level: 1,
                    spans: vec![Span::Text("Title".to_string())],
                },
                Block::Heading {
                    level: 3,
                    spans: vec![Span::Text("Deep".to_string())],
                },
                Block::Paragraph(vec![Span::Text("####### too deep".to_string())]),
                Block::Paragraph(vec![Span::Text("#no space".to_string())]),
            ]
        );
    }

    #[test]
    fn bullet_and_numbered_lists_are_split_by_kind() {
        let blocks = parse("- one\n- two\n\n1. first\n2. second");
        assert_eq!(
            blocks,
            vec![
                Block::List {
                    ordered: false,
                    items: vec![
                        vec![Span::Text("one".to_string())],
                        vec![Span::Text("two".to_string())],
                    ],
                },
                Block::List {
                    ordered: true,
                    items: vec![
                        vec![Span::Text("first".to_string())],
                        vec![Span::Text("second".to_string())],
                    ],
                },
            ]
        );
    }

    #[test]
    fn a_minus_without_a_space_is_not_a_list() {
        let blocks = parse("-1 degree");
        assert_eq!(
            blocks,
            vec![Block::Paragraph(vec![Span::Text("-1 degree".to_string())])]
        );
    }

    #[test]
    fn fenced_code_keeps_its_language_and_body() {
        let blocks = parse("before\n\n```rust\nfn main() {}\n```\n\nafter");
        assert_eq!(
            blocks,
            vec![
                Block::Paragraph(vec![Span::Text("before".to_string())]),
                Block::CodeBlock {
                    language: Some("rust".to_string()),
                    code: "fn main() {}".to_string(),
                },
                Block::Paragraph(vec![Span::Text("after".to_string())]),
            ]
        );
    }

    #[test]
    fn an_unterminated_fence_still_renders_as_code() {
        let blocks = parse("text\n\n```\nlet x = 1;");
        assert_eq!(
            blocks,
            vec![
                Block::Paragraph(vec![Span::Text("text".to_string())]),
                Block::CodeBlock {
                    language: None,
                    code: "let x = 1;".to_string(),
                },
            ]
        );
    }

    #[test]
    fn one_line_fence_carries_no_language() {
        let blocks = parse("```   \nplain\n```");
        assert_eq!(
            blocks,
            vec![Block::CodeBlock {
                language: None,
                code: "plain".to_string(),
            }]
        );
    }

    #[test]
    fn blockquotes_keep_their_inner_blocks() {
        let blocks = parse("> quoted\n>\n> - item");
        assert_eq!(
            blocks,
            vec![Block::Blockquote(vec![
                Block::Paragraph(vec![Span::Text("quoted".to_string())]),
                Block::List {
                    ordered: false,
                    items: vec![vec![Span::Text("item".to_string())]],
                },
            ])]
        );
    }

    #[test]
    fn rules_need_three_markers_and_no_other_text() {
        let blocks = parse("---\n\ntext\n\n***\n\n- item");
        assert_eq!(
            blocks,
            vec![
                Block::Rule,
                Block::Paragraph(vec![Span::Text("text".to_string())]),
                Block::Rule,
                Block::List {
                    ordered: false,
                    items: vec![vec![Span::Text("item".to_string())]],
                },
            ]
        );
    }

    #[test]
    fn inline_code_bold_italic_and_links_are_recognised() {
        let source = "use `cargo test`, then **bold**, _em_ and [docs](https://example.com/a).";
        let blocks = parse(source);
        assert_eq!(blocks.len(), 1, "one paragraph: {blocks:?}");
        let Block::Paragraph(spans) = &blocks[0] else {
            panic!("expected a paragraph, got {blocks:?}");
        };
        assert_eq!(
            span_text(spans),
            "use cargo test, then bold, em and docs."
        );
        assert!(spans
            .iter()
            .any(|span| matches!(span, Span::Code(code) if code == "cargo test")));
        assert!(spans
            .iter()
            .any(|span| matches!(span, Span::Bold(inner) if span_text(inner) == "bold")));
        assert!(spans
            .iter()
            .any(|span| matches!(span, Span::Italic(inner) if span_text(inner) == "em")));
        assert!(spans.iter().any(|span| matches!(
            span,
            Span::Link { text, target }
                if span_text(text) == "docs" && target == "https://example.com/a"
        )));
    }

    #[test]
    fn snake_case_underscores_stay_literal() {
        let blocks = parse("a snake_case_name stays");
        assert_eq!(
            blocks,
            vec![Block::Paragraph(vec![Span::Text(
                "a snake_case_name stays".to_string()
            )])]
        );
    }

    #[test]
    fn plain_text_without_markdown_is_one_paragraph() {
        let blocks = parse("ただの文章です。改行も\nあります。");
        assert_eq!(
            blocks,
            vec![Block::Paragraph(vec![Span::Text(
                "ただの文章です。改行も あります。".to_string()
            )])]
        );
    }

    #[test]
    fn empty_input_has_no_blocks() {
        assert!(parse("").is_empty());
        assert!(parse("   \n\n\t").is_empty());
    }

    #[test]
    fn pathological_input_does_not_panic() {
        let deep = ">".repeat(64);
        let wide = "*".repeat(4000);
        let brackets = "[".repeat(512) + &"]".repeat(512);
        let inputs = [
            deep.as_str(),
            wide.as_str(),
            brackets.as_str(),
            "```",
            "`",
            "*",
            "**",
            "[a](",
            "| a | b |",
        ];
        for input in inputs {
            let blocks = parse(input);
            let _ = format!("{blocks:?}");
        }
    }
}
