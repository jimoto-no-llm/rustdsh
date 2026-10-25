//! Pure editing model for the composer text field.
//!
//! The composer is not a plain string append: it owns a caret, a selection and
//! the editing operations a text field must provide (insert, delete, caret
//! movement, select-all, cut/paste extraction). Everything here is host-free so
//! the behaviour is unit tested without a window or a GPU.
//!
//! State is the pair (caret, anchor): the selection is everything between them,
//! the caret is the end that moves and the anchor is the end that stays put
//! while a selection is extended. Byte offsets are always kept on char
//! boundaries, so a multi-byte character is never split.

use std::ops::Range;

/// Caret, anchor and text of one text field.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Editor {
    text: String,
    /// Byte offset the caret is drawn at.
    caret: usize,
    /// Byte offset the current selection is anchored at. Equal to the caret
    /// whenever nothing is selected.
    anchor: usize,
}

impl Editor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.text.len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    /// The byte offset the caret is drawn at.
    pub fn caret(&self) -> usize {
        self.caret
    }

    /// The end that stays put while shift-selection extends the other one.
    pub fn anchor(&self) -> usize {
        self.anchor
    }

    /// The selected byte range, always ascending; empty for a plain caret.
    pub fn selection(&self) -> Range<usize> {
        self.caret.min(self.anchor)..self.caret.max(self.anchor)
    }

    /// True while a non-empty selection is active.
    pub fn has_selection(&self) -> bool {
        self.caret != self.anchor
    }

    /// The selected text, or an empty string for a plain caret.
    pub fn selected_text(&self) -> &str {
        self.text.get(self.selection()).unwrap_or("")
    }

    /// The text before the caret and the text after it, split at a character
    /// boundary, for inspecting caret movement in tests.
    #[cfg(test)]
    pub fn split_at_caret(&self) -> (&str, &str) {
        (
            self.text.get(..self.caret).unwrap_or(&self.text),
            self.text.get(self.caret..).unwrap_or(""),
        )
    }

    /// Move the caret to an offset, dropping any selection.
    pub fn move_to(&mut self, offset: usize) {
        let caret = self.clamp(offset);
        self.caret = caret;
        self.anchor = caret;
    }

    /// Extend the selection to an offset, keeping the current anchor: selecting
    /// left from a caret at 4 down to 0 selects 0..4 and leaves the caret at 0.
    pub fn select_to(&mut self, offset: usize) {
        let caret = self.clamp(offset);
        if caret < self.anchor {
            // Extending towards the start: the old caret stays put as the new
            // anchor, so the selection grows instead of shrinking.
            self.anchor = self.caret;
        }
        self.caret = caret;
    }

    /// Select the whole text; the caret lands at the end.
    pub fn select_all(&mut self) {
        self.anchor = 0;
        self.caret = self.text.len();
    }

    /// Drop the selection, keeping the caret where it is.
    #[cfg(test)]
    pub fn collapse_selection(&mut self) {
        self.anchor = self.caret;
    }

    /// Clear the text, the caret and the selection.
    pub fn clear(&mut self) {
        self.text.clear();
        self.caret = 0;
        self.anchor = 0;
    }

    /// Replace the selection (or insert at the caret) with a value and place
    /// the caret after the inserted text.
    pub fn insert(&mut self, value: &str) {
        let range = self.selection();
        self.text.replace_range(range.clone(), value);
        let caret = range.start + value.len();
        self.caret = caret;
        self.anchor = caret;
    }

    /// Shift+Enter: insert a hard line break at the caret.
    pub fn insert_newline(&mut self) {
        self.insert("\n");
    }

    /// Backspace: delete the selection, or the character before the caret.
    pub fn delete_backward(&mut self) {
        if self.has_selection() {
            self.insert("");
            return;
        }
        let start = previous_boundary(&self.text, self.caret);
        if start == self.caret {
            return;
        }
        self.text.replace_range(start..self.caret, "");
        self.move_to(start);
    }

    /// Delete: delete the selection, or the character after the caret.
    pub fn delete_forward(&mut self) {
        if self.has_selection() {
            self.insert("");
            return;
        }
        let end = next_boundary(&self.text, self.caret);
        if end == self.caret {
            return;
        }
        self.text.replace_range(self.caret..end, "");
        self.move_to(self.caret);
    }

    /// Delete the selection, or the character after the caret, and return the
    /// deleted text (the cut half of Ctrl+X).
    pub fn cut_forward(&mut self) -> String {
        if self.has_selection() {
            let removed = self.selected_text().to_string();
            self.insert("");
            return removed;
        }
        let end = next_boundary(&self.text, self.caret);
        let removed = self.text.get(self.caret..end).unwrap_or("").to_string();
        if !removed.is_empty() {
            self.text.replace_range(self.caret..end, "");
            self.move_to(self.caret);
        }
        removed
    }

    /// Move the caret to a boundary and drop the selection.
    pub fn moved(&mut self, motion: Motion) {
        let caret = self.caret;
        let target = match motion {
            Motion::Left => previous_boundary(&self.text, caret),
            Motion::Right => next_boundary(&self.text, caret),
            Motion::WordLeft => previous_word_boundary(&self.text, caret),
            Motion::WordRight => next_word_boundary(&self.text, caret),
            Motion::Home => line_start(&self.text, caret),
            Motion::End => line_end(&self.text, caret),
        };
        self.move_to(target);
    }

    fn clamp(&self, offset: usize) -> usize {
        clamp_boundary(&self.text, offset)
    }
}

/// Caret movement kinds the key handler maps keys onto.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Motion {
    Left,
    Right,
    WordLeft,
    WordRight,
    Home,
    End,
}

/// Round an offset down to a char boundary and up to the text length at most.
pub fn clamp_boundary(text: &str, offset: usize) -> usize {
    let mut offset = offset.min(text.len());
    while offset > 0 && !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

/// Start of the character before an offset; the offset itself at the start.
pub fn previous_boundary(text: &str, offset: usize) -> usize {
    let offset = clamp_boundary(text, offset);
    if offset == 0 {
        return 0;
    }
    let mut previous = offset - 1;
    while previous > 0 && !text.is_char_boundary(previous) {
        previous -= 1;
    }
    previous
}

/// End of the character after an offset; the text length at the end.
pub fn next_boundary(text: &str, offset: usize) -> usize {
    let offset = clamp_boundary(text, offset);
    if offset >= text.len() {
        return text.len();
    }
    let mut next = offset + 1;
    while next < text.len() && !text.is_char_boundary(next) {
        next += 1;
    }
    next
}

/// Start of the line containing an offset (the byte after the previous newline).
pub fn line_start(text: &str, offset: usize) -> usize {
    let offset = clamp_boundary(text, offset);
    text[..offset]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0)
}

/// End of the line containing an offset (the next newline, or the text end).
pub fn line_end(text: &str, offset: usize) -> usize {
    let offset = clamp_boundary(text, offset);
    text[offset..]
        .find('\n')
        .map(|index| offset + index)
        .unwrap_or(text.len())
}

fn is_word_char(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

/// Start of the word before an offset, skipping separators first.
pub fn previous_word_boundary(text: &str, offset: usize) -> usize {
    let offset = clamp_boundary(text, offset);
    if offset == 0 {
        return 0;
    }
    let mut index = offset;
    for character in text[..offset].chars().rev() {
        if is_word_char(character) {
            break;
        }
        index -= character.len_utf8();
    }
    for character in text[..index].chars().rev() {
        if !is_word_char(character) {
            break;
        }
        index -= character.len_utf8();
    }
    index
}

/// End of the word after an offset, skipping separators first.
pub fn next_word_boundary(text: &str, offset: usize) -> usize {
    let offset = clamp_boundary(text, offset);
    if offset >= text.len() {
        return text.len();
    }
    let mut index = offset;
    for character in text[offset..].chars() {
        if is_word_char(character) {
            break;
        }
        index += character.len_utf8();
    }
    for character in text[index..].chars() {
        if !is_word_char(character) {
            break;
        }
        index += character.len_utf8();
    }
    index
}

#[cfg(test)]
mod tests {
    use super::{Editor, Motion};

    /// Editor holding some text with the caret at an offset.
    fn caret_at(text: &str, caret: usize) -> Editor {
        let mut editor = Editor::new();
        editor.insert(text);
        editor.move_to(caret);
        editor
    }

    #[test]
    fn insert_places_text_at_the_caret() {
        let mut editor = caret_at("hello", 5);
        editor.move_to(0);
        editor.insert("say ");
        assert_eq!(editor.text(), "say hello");
        assert_eq!(editor.caret(), 4);

        // "say " occupies 0..4, so the caret at 4 is before the space.
        editor.move_to(4);
        editor.insert("-");
        assert_eq!(editor.text(), "say -hello");
        assert_eq!(editor.caret(), 5);
    }

    #[test]
    fn insert_keeps_multi_byte_characters_intact() {
        let mut editor = caret_at("日本語", 9);
        editor.move_to(3);
        editor.insert("の");
        assert_eq!(editor.text(), "日の本語");
        assert_eq!(editor.caret(), 6);
    }

    #[test]
    fn newline_is_inserted_at_the_caret() {
        let mut editor = caret_at("ab", 1);
        editor.insert_newline();
        assert_eq!(editor.text(), "a\nb");
        assert_eq!(editor.caret(), 2);

        let mut empty = Editor::new();
        empty.insert_newline();
        assert_eq!(empty.text(), "\n");
        assert_eq!(empty.caret(), 1);
    }

    #[test]
    fn backspace_deletes_one_character_before_the_caret() {
        let mut editor = caret_at("ab", 2);
        editor.delete_backward();
        assert_eq!(editor.text(), "a");
        assert_eq!(editor.caret(), 1);

        editor.delete_backward();
        editor.delete_backward();
        assert_eq!(editor.text(), "");
        assert_eq!(editor.caret(), 0);
    }

    #[test]
    fn backspace_deletes_a_whole_character_not_a_byte() {
        let mut editor = caret_at("é!", 3);
        editor.delete_backward();
        assert_eq!(editor.text(), "é");
        editor.delete_backward();
        assert_eq!(editor.text(), "");

        let mut mixed = caret_at("aあ", 4);
        mixed.delete_backward();
        assert_eq!(mixed.text(), "a");
    }

    #[test]
    fn delete_removes_the_character_after_the_caret() {
        let mut editor = caret_at("abc", 0);
        editor.delete_forward();
        assert_eq!(editor.text(), "bc");
        assert_eq!(editor.caret(), 0);

        editor.move_to(2);
        editor.delete_forward();
        assert_eq!(editor.text(), "bc");
    }

    #[test]
    fn deleting_over_a_selection_removes_the_whole_selection() {
        let mut backspace = caret_at("abc", 3);
        backspace.move_to(0);
        backspace.select_to(2);
        backspace.delete_backward();
        assert_eq!(backspace.text(), "c");

        let mut delete = caret_at("abc", 1);
        delete.select_to(3);
        delete.delete_forward();
        assert_eq!(delete.text(), "a");
    }

    #[test]
    fn caret_movement_stops_at_both_ends() {
        let mut editor = caret_at("ab", 1);
        editor.move_to(0);
        editor.moved(Motion::Left);
        assert_eq!(editor.caret(), 0);
        editor.moved(Motion::WordLeft);
        assert_eq!(editor.caret(), 0);

        editor.move_to(2);
        editor.moved(Motion::Right);
        assert_eq!(editor.caret(), 2);
        editor.moved(Motion::WordRight);
        assert_eq!(editor.caret(), 2);
    }

    #[test]
    fn caret_movement_steps_over_multi_byte_characters() {
        let mut editor = caret_at("aあb", 0);
        editor.moved(Motion::Right);
        assert_eq!(editor.caret(), 1);
        editor.moved(Motion::Right);
        assert_eq!(editor.caret(), 4);
        editor.moved(Motion::Left);
        assert_eq!(editor.caret(), 1);
    }

    #[test]
    fn caret_movement_never_lands_inside_a_character() {
        let text = "aé😀z";
        let mut editor = caret_at(text, 0);
        while editor.caret() < text.len() {
            editor.moved(Motion::Right);
            assert!(
                text.is_char_boundary(editor.caret()),
                "caret left on a byte boundary: {}",
                editor.caret()
            );
        }
        assert_eq!(editor.caret(), text.len());
        while editor.caret() > 0 {
            editor.moved(Motion::Left);
            assert!(text.is_char_boundary(editor.caret()));
        }
        assert_eq!(editor.caret(), 0);
    }

    #[test]
    fn home_and_end_move_within_the_current_line() {
        let mut editor = caret_at("one\ntwo\nthree", 0);
        editor.move_to(6);
        editor.moved(Motion::Home);
        assert_eq!(editor.caret(), 4);
        editor.moved(Motion::End);
        assert_eq!(editor.caret(), 7);
        editor.moved(Motion::End);
        assert_eq!(editor.caret(), 7);

        editor.move_to(9);
        editor.moved(Motion::Home);
        assert_eq!(editor.caret(), 8);
        editor.moved(Motion::End);
        assert_eq!(editor.caret(), 13);
    }

    #[test]
    fn word_movement_skips_separators() {
        let mut editor = caret_at("hello world  again", 0);
        editor.moved(Motion::WordRight);
        assert_eq!(editor.caret(), 5);
        editor.moved(Motion::WordRight);
        assert_eq!(editor.caret(), 11);
        editor.moved(Motion::WordLeft);
        assert_eq!(editor.caret(), 6);
        editor.moved(Motion::WordLeft);
        assert_eq!(editor.caret(), 0);
    }

    #[test]
    fn select_all_covers_the_whole_text_and_extracts_it() {
        let mut editor = caret_at("first line\nsecond", 3);
        editor.select_all();
        assert!(editor.has_selection());
        assert_eq!(editor.selected_text(), "first line\nsecond");
        assert_eq!(editor.selection(), 0..editor.len());
        assert_eq!(editor.caret(), editor.len());

        let mut empty = Editor::new();
        empty.select_all();
        assert_eq!(empty.selected_text(), "");
    }

    #[test]
    fn selection_keeps_its_anchor_and_reports_the_moving_caret() {
        let mut editor = caret_at("abcdef", 1);
        editor.select_to(4);
        assert_eq!(editor.selection(), 1..4);
        assert_eq!(editor.anchor(), 1);
        assert_eq!(editor.caret(), 4);
        assert_eq!(editor.selected_text(), "bcd");

        // Extending backwards from there anchors on 4: the range grows to
        // 0..4 and the caret follows the moving end to 0.
        editor.select_to(0);
        assert_eq!(editor.selection(), 0..4);
        assert_eq!(editor.anchor(), 4);
        assert_eq!(editor.caret(), 0);
        assert_eq!(editor.selected_text(), "abcd");
        assert_eq!(editor.split_at_caret(), ("", "abcdef"));

        // Collapsing keeps the caret and drops the selection.
        editor.collapse_selection();
        assert_eq!(editor.selection(), 0..0);
        assert_eq!(editor.caret(), 0);
        assert!(!editor.has_selection());
    }

    #[test]
    fn out_of_range_offsets_are_clamped() {
        let mut editor = caret_at("abc", 0);
        editor.move_to(999);
        assert_eq!(editor.caret(), 3);
        editor.move_to(usize::MAX);
        assert_eq!(editor.caret(), 3);
    }

    #[test]
    fn cut_forward_returns_the_removed_text() {
        let mut editor = caret_at("hello", 1);
        editor.select_to(4);
        assert_eq!(editor.cut_forward(), "ell");
        assert_eq!(editor.text(), "ho");
        assert_eq!(editor.caret(), 1);

        let mut plain = caret_at("hello", 0);
        assert_eq!(plain.cut_forward(), "h");
        assert_eq!(plain.text(), "ello");

        let mut empty = Editor::new();
        assert_eq!(empty.cut_forward(), "");
    }

    #[test]
    fn clear_resets_text_and_caret() {
        let mut editor = caret_at("abc", 2);
        editor.select_to(3);
        editor.clear();
        assert!(editor.is_empty());
        assert_eq!(editor.caret(), 0);
        assert!(!editor.has_selection());
    }
}
