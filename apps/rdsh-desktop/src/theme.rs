//! Design tokens taken from the upstream theme source
//! (packages/client/ui-theme/src/styles/*.css at the pinned revision), so the
//! native window matches the web product: white page, near-white sidebar,
//! near-black label text, a single blue accent and half-pixel hairline borders.
//!
//! Every colour role also exists for dark mode. `LIGHT` and `DARK` hold the raw
//! values; the `page()`, `sidebar()`, ... accessors read the process-wide mode
//! that `init_from_env_and_args` picks once at startup.

use std::sync::atomic::{AtomicU8, Ordering};

use gpui::{px, Pixels, Rgba};

/// One palette: every colour the shell renders, as `0xRRGGBB` or `0xRRGGBBAA`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Theme {
    pub page: u32,
    pub sidebar: u32,
    pub composer: u32,
    pub user_bubble: u32,
    pub code_block: u32,
    pub label: u32,
    pub secondary: u32,
    pub tertiary: u32,
    pub accent: u32,
    pub brand: u32,
    pub danger: u32,
    /// border-l1: rgba(0, 0, 0, 0.04) in light, rgba(255, 255, 255, 0.06) in dark.
    pub hairline: u32,
    /// border-l2: rgba(0, 0, 0, 0.1) in light, rgba(255, 255, 255, 0.12) in dark.
    pub border: u32,
    /// border-l3: rgba(0, 0, 0, 0.12) in light, rgba(255, 255, 255, 0.18) in dark.
    pub border_strong: u32,
}

/// `app.rs` reads the failure tone as a constant, so it stays one: the light
/// red is the value the light palette carries and the value the icon uses.
pub const DANGER: u32 = 0xd93a3a;

/// The upstream light values, byte for byte (design parity with the web UI).
pub const LIGHT: Theme = Theme {
    page: 0xffffff,
    sidebar: 0xf9fafb,
    composer: 0xffffff,
    user_bubble: 0xedf3fe,
    code_block: 0xf9fafb,
    label: 0x0f1115,
    secondary: 0x61666b,
    tertiary: 0x81858c,
    accent: 0x4176e6,
    brand: 0x5686fe,
    danger: DANGER,
    hairline: 0x0000000a,
    border: 0x0000001a,
    border_strong: 0x0000001f,
};

/// The dark values: the same roles on a near-black scale, with the hairlines
/// flipped to translucent white and a lighter accent so labels stay readable.
pub const DARK: Theme = Theme {
    page: 0x1b1c1f,
    sidebar: 0x17181b,
    composer: 0x202125,
    user_bubble: 0x24304a,
    code_block: 0x26282d,
    label: 0xf2f3f5,
    secondary: 0xb6b9c0,
    tertiary: 0x8b8f96,
    accent: 0x6f9bff,
    brand: 0x7ba2ff,
    danger: 0xff6b6b,
    hairline: 0xffffff0f,
    border: 0xffffff1f,
    border_strong: 0xffffff2e,
};

/// The resolved mode the accessors render.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Light,
    Dark,
}

impl Mode {
    pub fn is_dark(self) -> bool {
        matches!(self, Mode::Dark)
    }

    fn tag(self) -> u8 {
        match self {
            Mode::Light => 0,
            Mode::Dark => 1,
        }
    }

    fn from_tag(tag: u8) -> Mode {
        if tag == 1 {
            Mode::Dark
        } else {
            Mode::Light
        }
    }
}

/// One setting value before `system` is resolved against the desktop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    Light,
    Dark,
    System,
}

impl Choice {
    /// `light`, `dark` or `system`, case-insensitively; `None` for anything else.
    pub fn parse(value: &str) -> Option<Choice> {
        match value.trim().to_ascii_lowercase().as_str() {
            "light" => Some(Choice::Light),
            "dark" => Some(Choice::Dark),
            "system" => Some(Choice::System),
            _ => None,
        }
    }

    fn resolve(self, system_dark: impl FnOnce() -> bool) -> Mode {
        match self {
            Choice::Light => Mode::Light,
            Choice::Dark => Mode::Dark,
            Choice::System if system_dark() => Mode::Dark,
            Choice::System => Mode::Light,
        }
    }
}

/// The active mode; 0 = light, so an untouched process starts on the web palette.
static ACTIVE: AtomicU8 = AtomicU8::new(0);

/// Resolve one setting: the environment value first, then the `--theme` flag,
/// then light. Pure, and `system_dark` only runs for `system`, so the desktop
/// probe stays lazy.
pub fn resolve(env: Option<&str>, flag: Option<&str>, system_dark: impl FnOnce() -> bool) -> Mode {
    env.and_then(Choice::parse)
        .or_else(|| flag.and_then(Choice::parse))
        .unwrap_or(Choice::Light)
        .resolve(system_dark)
}

/// Pick the mode once at startup from `RDSH_DESKTOP_THEME` and `--theme`.
pub fn init_from_env_and_args(flag: Option<&str>) -> Mode {
    let env = std::env::var("RDSH_DESKTOP_THEME").ok();
    let mode = resolve(env.as_deref(), flag, system_prefers_dark);
    set_mode(mode);
    mode
}

/// The active mode.
pub fn mode() -> Mode {
    Mode::from_tag(ACTIVE.load(Ordering::Relaxed))
}

/// Set the active mode (tests and, later, a settings UI).
pub fn set_mode(mode: Mode) {
    ACTIVE.store(mode.tag(), Ordering::Relaxed);
}

/// The active palette.
pub fn palette() -> Theme {
    if mode().is_dark() {
        DARK
    } else {
        LIGHT
    }
}

pub fn page() -> Rgba {
    rgb(palette().page)
}

pub fn sidebar() -> Rgba {
    rgb(palette().sidebar)
}

pub fn composer() -> Rgba {
    rgb(palette().composer)
}

pub fn user_bubble() -> Rgba {
    rgb(palette().user_bubble)
}

pub fn code_block() -> Rgba {
    rgb(palette().code_block)
}

pub fn label() -> Rgba {
    rgb(palette().label)
}

pub fn secondary() -> Rgba {
    rgb(palette().secondary)
}

pub fn tertiary() -> Rgba {
    rgb(palette().tertiary)
}

pub fn accent() -> Rgba {
    rgb(palette().accent)
}

pub fn hairline() -> Rgba {
    rgba(palette().hairline)
}

pub fn border() -> Rgba {
    rgba(palette().border)
}

pub fn border_strong() -> Rgba {
    rgba(palette().border_strong)
}

fn rgba(value: u32) -> Rgba {
    gpui::rgba(value)
}

fn rgb(value: u32) -> Rgba {
    gpui::rgb(value)
}

/// Ask the desktop whether it prefers dark, once, and cheaply: GNOME's
/// `color-scheme`, then KDE's `ColorScheme`. Anything unreadable means light.
fn system_prefers_dark() -> bool {
    if let Some(dark) = gnome_prefers_dark() {
        return dark;
    }
    kde_prefers_dark().unwrap_or(false)
}

fn gnome_prefers_dark() -> Option<bool> {
    let output = std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "color-scheme"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let value = text.trim().trim_matches(['\'', '"']);
    if value.is_empty() || value == "default" {
        return None;
    }
    Some(value.contains("dark"))
}

fn kde_prefers_dark() -> Option<bool> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".config"))
        })?;
    let text = std::fs::read_to_string(config.join("kdeglobals")).ok()?;
    text.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        if key.trim() != "ColorScheme" {
            return None;
        }
        let value = value.trim();
        if value.is_empty() {
            return None;
        }
        Some(value.to_ascii_lowercase().contains("dark"))
    })
}

// Typography scale: 24/32, 20/28, 16/24, 14/22, 13/20, 12/18, 11/14.
// Body content defaults to 14px with a 24px line box.
pub fn body_size() -> Pixels {
    px(14.)
}

pub fn body_line_height() -> Pixels {
    px(24.)
}

pub fn title_size() -> Pixels {
    px(20.)
}

pub fn heading_size() -> Pixels {
    px(16.)
}

pub fn meta_size() -> Pixels {
    px(13.)
}

pub fn micro_size() -> Pixels {
    px(11.)
}

// Radii: xs 4 / sm 8 / md 12 / lg 16 / xl 20 / panel 28.
pub fn radius_xs() -> Pixels {
    px(4.)
}

pub fn radius_sm() -> Pixels {
    px(8.)
}

pub fn radius_md() -> Pixels {
    px(12.)
}

pub fn radius_lg() -> Pixels {
    px(16.)
}

pub fn radius_xl() -> Pixels {
    px(20.)
}

pub fn radius_panel() -> Pixels {
    px(28.)
}

// Layout constants from the layout modules.
pub const SIDEBAR_DEFAULT: f32 = 280.;
pub const SIDEBAR_MIN: f32 = 264.;
pub const SIDEBAR_MAX: f32 = 420.;
pub const SIDEBAR_COLLAPSED: f32 = 56.;
pub const CENTER_MIN: f32 = 400.;
pub const TOP_STRIP_HEIGHT: f32 = 52.;
pub const LOGO_ROW_HEIGHT: f32 = 60.;
pub const NEW_SESSION_HEIGHT: f32 = 38.;
pub const LIST_ROW_HEIGHT: f32 = 36.;
pub const PROJECT_ROW_HEIGHT: f32 = 34.;
pub const SESSION_ROW_HEIGHT: f32 = 32.;
pub const HEADER_MIN_HEIGHT: f32 = 76.;
pub const CHAT_COLUMN_MIN: f32 = 680.;
pub const CHAT_COLUMN_MAX: f32 = 920.;
pub const CHAT_COLUMN_RATIO: f32 = 0.64;
pub const COMPOSER_MIN_HEIGHT: f32 = 36.;

// The window must stay wide enough for a full sidebar plus a usable center
// column, and tall enough for the header and composer stack.
pub const WINDOW_MIN_WIDTH: f32 = 900.;
pub const WINDOW_MIN_HEIGHT: f32 = 600.;

#[cfg(test)]
mod tests {
    use super::*;

    /// The roles in the order the palette tests walk them.
    fn roles(theme: Theme) -> Vec<(&'static str, u32)> {
        vec![
            ("page", theme.page),
            ("sidebar", theme.sidebar),
            ("composer", theme.composer),
            ("user_bubble", theme.user_bubble),
            ("code_block", theme.code_block),
            ("label", theme.label),
            ("secondary", theme.secondary),
            ("tertiary", theme.tertiary),
            ("accent", theme.accent),
            ("brand", theme.brand),
            ("danger", theme.danger),
            ("hairline", theme.hairline),
            ("border", theme.border),
            ("border_strong", theme.border_strong),
        ]
    }

    #[test]
    fn light_keeps_the_web_ui_values() {
        assert_eq!(LIGHT.page, 0xffffff);
        assert_eq!(LIGHT.sidebar, 0xf9fafb);
        assert_eq!(LIGHT.composer, 0xffffff);
        assert_eq!(LIGHT.user_bubble, 0xedf3fe);
        assert_eq!(LIGHT.code_block, 0xf9fafb);
        assert_eq!(LIGHT.label, 0x0f1115);
        assert_eq!(LIGHT.secondary, 0x61666b);
        assert_eq!(LIGHT.tertiary, 0x81858c);
        assert_eq!(LIGHT.accent, 0x4176e6);
        assert_eq!(LIGHT.brand, 0x5686fe);
        assert_eq!(LIGHT.danger, DANGER);
        // 0.04, 0.1 and 0.12 alpha on black.
        assert_eq!(LIGHT.hairline, 0x0000000a);
        assert_eq!(LIGHT.border, 0x0000001a);
        assert_eq!(LIGHT.border_strong, 0x0000001f);
    }

    #[test]
    fn dark_keeps_the_documented_values() {
        assert_eq!(DARK.page, 0x1b1c1f);
        assert_eq!(DARK.sidebar, 0x17181b);
        assert_eq!(DARK.composer, 0x202125);
        assert_eq!(DARK.user_bubble, 0x24304a);
        assert_eq!(DARK.code_block, 0x26282d);
        assert_eq!(DARK.label, 0xf2f3f5);
        assert_eq!(DARK.secondary, 0xb6b9c0);
        assert_eq!(DARK.tertiary, 0x8b8f96);
        assert_eq!(DARK.accent, 0x6f9bff);
        // 0.06, 0.12 and 0.18 alpha on white.
        assert_eq!(DARK.hairline, 0xffffff0f);
        assert_eq!(DARK.border, 0xffffff1f);
        assert_eq!(DARK.border_strong, 0xffffff2e);
    }

    #[test]
    fn every_role_differs_between_light_and_dark() {
        let light = roles(LIGHT);
        let dark = roles(DARK);
        assert_eq!(light.len(), dark.len());
        assert_eq!(light.len(), 14, "the palette covers every role");
        for ((role, light), (_, dark)) in light.into_iter().zip(dark) {
            assert_ne!(light, dark, "{role} must differ between light and dark");
        }
    }

    #[test]
    fn the_parser_takes_light_dark_and_system_only() {
        assert_eq!(Choice::parse("light"), Some(Choice::Light));
        assert_eq!(Choice::parse("dark"), Some(Choice::Dark));
        assert_eq!(Choice::parse("system"), Some(Choice::System));
        assert_eq!(Choice::parse(" Dark "), Some(Choice::Dark));
        for junk in ["", "blue", "light-", "darkk", "auto", "0", "system2", "--"] {
            assert_eq!(Choice::parse(junk), None, "{junk:?} is not a mode");
        }
    }

    #[test]
    fn the_environment_wins_over_the_flag_and_light_is_the_default() {
        assert_eq!(resolve(Some("dark"), Some("light"), || false), Mode::Dark);
        assert_eq!(resolve(None, Some("dark"), || false), Mode::Dark);
        assert_eq!(resolve(None, None, || false), Mode::Light);
        // Junk falls through to the next source instead of failing the start.
        assert_eq!(resolve(Some("blue"), Some("dark"), || false), Mode::Dark);
        assert_eq!(resolve(Some("blue"), None, || false), Mode::Light);
    }

    #[test]
    fn system_follows_the_desktop_and_the_probe_stays_lazy() {
        assert_eq!(resolve(Some("system"), None, || true), Mode::Dark);
        assert_eq!(resolve(Some("system"), None, || false), Mode::Light);
        let mut probed = false;
        let mode = resolve(Some("dark"), None, || {
            probed = true;
            true
        });
        assert_eq!(mode, Mode::Dark);
        assert!(!probed, "only system reads the desktop setting");
    }

    #[test]
    fn set_mode_switches_the_accessors_and_can_be_restored() {
        let previous = mode();
        set_mode(Mode::Dark);
        assert_eq!(mode(), Mode::Dark);
        assert_eq!(palette(), DARK);
        assert!(mode().is_dark());
        assert_eq!(page(), rgb(DARK.page));
        assert_eq!(hairline(), rgba(DARK.hairline));
        set_mode(Mode::Light);
        assert_eq!(palette(), LIGHT);
        assert_eq!(page(), rgb(LIGHT.page));
        set_mode(previous);
    }

    #[test]
    fn the_minimum_window_keeps_the_sidebar_and_center_usable() {
        assert!(WINDOW_MIN_WIDTH >= SIDEBAR_DEFAULT + CENTER_MIN);
        assert!(WINDOW_MIN_HEIGHT >= TOP_STRIP_HEIGHT + HEADER_MIN_HEIGHT + COMPOSER_MIN_HEIGHT);
        // The minimum must never exceed the default bounds the window opens at.
        assert!(WINDOW_MIN_WIDTH <= 1280.);
        assert!(WINDOW_MIN_HEIGHT <= 860.);
    }
}
