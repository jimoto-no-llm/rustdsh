//! Decide which key events remain owned by the input method.
use gpui::Keystroke;

pub fn ime_owns_key(keystroke: &Keystroke, has_marked_text: bool) -> bool {
    // GPUI 0.2.2 also reports plain Enter with no key_char as an unfinished
    // IME keystroke on Wayland. It is a composer command when no preedit exists.
    if keystroke.key == "enter" {
        has_marked_text
    } else {
        keystroke.is_ime_in_progress()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::Modifiers;

    #[test]
    fn wayland_enter_without_key_char_is_a_command_only_outside_preedit() {
        for modifiers in [
            Modifiers::default(),
            Modifiers {
                shift: true,
                ..Default::default()
            },
            Modifiers {
                control: true,
                ..Default::default()
            },
            Modifiers {
                alt: true,
                ..Default::default()
            },
        ] {
            let key = Keystroke {
                key: "enter".into(),
                key_char: None,
                modifiers,
            };
            assert!(!ime_owns_key(&key, false));
            assert!(ime_owns_key(&key, true));
        }
    }

    #[test]
    fn incomplete_dead_key_is_owned_even_before_marked_text_is_available() {
        let mut key = Keystroke {
            key: "e".into(),
            key_char: None,
            modifiers: Modifiers::default(),
        };
        assert!(ime_owns_key(&key, false));
        key.key_char = Some("é".into());
        assert!(!ime_owns_key(&key, true));
    }
}
