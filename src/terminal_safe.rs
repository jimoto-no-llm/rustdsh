/// Terminal-safe text.
///
/// Search trees and remote result pages are attacker-controlled, so a raw C0/C1
/// control character reaching stdout can move the cursor, erase earlier lines,
/// or (OSC 52) rewrite the clipboard. Everything printed for a human goes
/// through here; machine-readable output keeps the original bytes.
pub(crate) fn strip_control(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() && !matches!(c, '\u{2028}' | '\u{2029}' | '\u{202e}'))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::strip_control;

    #[test]
    fn plain_text_is_returned_unchanged() {
        assert_eq!(
            strip_control("src/main.rs:12: fn main()"),
            "src/main.rs:12: fn main()"
        );
        // 日本語やアクセント記号は制御文字ではないので残る。
        assert_eq!(strip_control("検索結果: café"), "検索結果: café");
    }

    #[test]
    fn c0_escapes_cannot_drive_the_terminal() {
        assert_eq!(strip_control("a\u{1b}[2Kb"), "a[2Kb");
        assert_eq!(strip_control("a\r\nb"), "ab");
        assert_eq!(strip_control("a\u{07}b"), "ab");
    }

    #[test]
    fn osc_52_cannot_rewrite_the_clipboard() {
        let attack = "x\u{1b}]52;c;cGF3bmVk\u{07}y";
        assert_eq!(strip_control(attack), "x]52;c;cGF3bmVk y".replace(' ', ""));
    }

    #[test]
    fn line_and_direction_separators_are_dropped() {
        assert_eq!(strip_control("a\u{2028}b\u{2029}c"), "abc");
        assert_eq!(strip_control("a\u{202e}b"), "ab");
    }
}
