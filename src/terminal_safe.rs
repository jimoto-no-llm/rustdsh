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
