//! Grapheme-aware editor. Cursor indices are UTF-8 boundaries, never screen cells.
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub const INPUT_LIMIT: usize = 16 * 1024;
#[derive(Default)]
pub(super) struct Editor {
    pub text: String,
    pub cursor: usize,
}
impl Editor {
    pub fn insert(&mut self, value: &str) -> bool {
        let value = clean(&value.replace("\r\n", "\n").replace('\r', "\n"));
        if self.text.len() + value.len() > INPUT_LIMIT {
            return false;
        }
        self.text.insert_str(self.cursor, &value);
        self.cursor += value.len();
        // A combining sequence may merge with text after the insertion point.
        self.cursor = self
            .text
            .grapheme_indices(true)
            .map(|(i, _)| i)
            .find(|i| *i >= self.cursor)
            .unwrap_or(self.text.len());
        true
    }
    pub fn left(&mut self) {
        self.cursor = self.text[..self.cursor]
            .grapheme_indices(true)
            .next_back()
            .map(|(i, _)| i)
            .unwrap_or(0);
    }
    pub fn right(&mut self) {
        self.cursor += self.text[self.cursor..]
            .graphemes(true)
            .next()
            .map(str::len)
            .unwrap_or(0);
    }
    pub fn backspace(&mut self) {
        let end = self.cursor;
        self.left();
        self.text.replace_range(self.cursor..end, "");
    }
    pub fn delete(&mut self) {
        let start = self.cursor;
        self.right();
        let end = self.cursor;
        self.cursor = start;
        self.text.replace_range(start..end, "");
    }
    pub fn home(&mut self) {
        self.cursor = self.text[..self.cursor]
            .rfind('\n')
            .map(|n| n + 1)
            .unwrap_or(0);
    }
    pub fn end(&mut self) {
        self.cursor += self.text[self.cursor..]
            .find('\n')
            .unwrap_or(self.text.len() - self.cursor);
    }
    pub fn vertical(&mut self, down: bool) {
        let start = self.text[..self.cursor]
            .rfind('\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        let column = UnicodeWidthStr::width(&self.text[start..self.cursor]);
        let (next_start, next_end) = if down {
            let Some(end) = self.text[self.cursor..].find('\n').map(|i| i + self.cursor) else {
                return;
            };
            let next = end + 1;
            (
                next,
                self.text[next..]
                    .find('\n')
                    .map(|i| i + next)
                    .unwrap_or(self.text.len()),
            )
        } else {
            if start == 0 {
                return;
            }
            (
                self.text[..start - 1]
                    .rfind('\n')
                    .map(|i| i + 1)
                    .unwrap_or(0),
                start - 1,
            )
        };
        self.cursor = next_start;
        let mut width = 0;
        for g in self.text[next_start..next_end].graphemes(true) {
            width += UnicodeWidthStr::width(g);
            if width > column {
                break;
            }
            self.cursor += g.len();
        }
    }
    pub fn clear(&mut self) {
        self.text.clear();
        self.cursor = 0;
    }
}
// Strip terminal escape introducers and C0/C1 controls, retain explicit newlines.
pub(super) fn clean(text: &str) -> String {
    text.replace('\t', "    ")
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .collect()
}

/// Wrap by terminal cells, shared by transcript, editor and cursor placement.
pub(super) fn wrap(text: &str, width: u16, cursor: usize) -> (Vec<String>, (u16, u16)) {
    let width = usize::from(width.max(2));
    let mut lines = vec![String::new()];
    let (mut x, mut point) = (0, (0, 0));
    for (i, g) in text.grapheme_indices(true) {
        let cells = UnicodeWidthStr::width(g);
        if g != "\n" && x + cells > width {
            lines.push(String::new());
            x = 0;
        }
        if i == cursor {
            point = (x as u16, (lines.len() - 1).min(u16::MAX as usize) as u16);
        }
        if g == "\n" {
            lines.push(String::new());
            x = 0;
        } else {
            lines.last_mut().unwrap().push_str(g);
            x += cells;
        }
    }
    if cursor == text.len() {
        if x >= width {
            lines.push(String::new());
            x = 0;
        }
        point = (x as u16, (lines.len() - 1).min(u16::MAX as usize) as u16);
    }
    (lines, point)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn japanese_combining_emoji_edit_as_graphemes() {
        let mut e = Editor::default();
        e.insert("日本e\u{301}👨‍👩‍👧‍👦");
        e.backspace();
        assert_eq!(e.text, "日本e\u{301}");
        e.left();
        e.delete();
        assert_eq!(e.text, "日本");
        e.left();
        e.insert("語");
        assert_eq!(e.text, "日語本");
        e.insert("\n二行目");
        e.home();
        assert_eq!(&e.text[e.cursor..], "二行目本");
        e.vertical(false);
        assert_eq!(e.cursor, 0);
    }
    #[test]
    fn paste_limit_and_control_filter() {
        let mut e = Editor::default();
        assert!(!e.insert(&"x".repeat(INPUT_LIMIT + 1)));
        assert!(e.text.is_empty());
        e.insert("一\r\n二\x1b\x07");
        assert_eq!(e.text, "一\n二");
        assert_eq!(clean("\u{9b}x\x1b]52;c;data\x07"), "x]52;c;data");
    }
    #[test]
    fn wrapping_uses_cells_and_has_valid_cursor_at_right_edge() {
        let (lines, point) = wrap("日本ab", 4, "日本ab".len());
        assert_eq!(lines, vec!["日本", "ab"]);
        assert_eq!(point, (2, 1));
        assert_eq!(wrap("日本", 4, 6).1, (0, 1));
        assert_eq!(wrap("a\nb", 4, 2).1, (0, 1));
    }
}
