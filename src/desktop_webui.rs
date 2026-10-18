//! Opt-in autostart of the native client's local Web UI.
//!
//! `rdsh-desktop --serve-web --port 8790` serves the harness session on
//! 127.0.0.1, prints a URL carrying a page token and writes that URL to
//! `~/.cache/rdsh-desktop/webui.url`. Keeping it available after login is a
//! user choice, so this module owns one switch with two sides:
//!
//! * `rdsh desktop web-ui status` — is the unit installed, enabled, running,
//!   and what URL does the client publish?
//! * `rdsh desktop web-ui on` — write `~/.config/rdsh-desktop/webui.env`
//!   (mode 0600) so the page token survives restarts, write the user unit
//!   `rdsh-webui.service`, `daemon-reload`, then `enable --now`.
//! * `rdsh desktop web-ui off` — `disable --now` and remove the unit file,
//!   which drops the `default.target.wants` autostart link with it.
//!
//! The default is OFF: only `apply(true)` writes or enables anything. The
//! unit is a user file written under `$XDG_CONFIG_HOME/systemd/user`; nothing
//! touches a system-wide directory. The client binds 127.0.0.1 only, and the
//! unit never enables itself (no `systemctl` inside the unit text; the
//! autostart link comes from the explicit `systemctl --user enable`).
//!
//! `RDSH_SYSTEMD_NO_RELOAD=1` skips every systemctl call (used by tests and
//! by hosts without a user session), and `RDSH_SYSTEMD_DIR` redirects the unit
//! directory. `RDSH_DESKTOP_CLIENT` overrides the client binary path.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde_json::json;

/// User unit that keeps the local Web UI alive across logins.
pub const SERVICE: &str = "rdsh-webui.service";
/// Port the client serves the Web UI on (loopback only).
pub const PORT: u16 = 8790;
/// Environment variable the client reads the pinned page token from.
pub const TOKEN_ENV: &str = "RDSH_DESKTOP_WEB_TOKEN";
/// Length of a generated or accepted page token, in hex characters.
pub const TOKEN_HEX_LEN: usize = 32;

/// Embedded user unit. `unit_text` fills in the machine-specific paths; the
/// literal text keeps the loopback guarantee and the port visible to tests.
pub const UNIT_TEMPLATE: &str = "\
[Unit]
Description=rdsh desktop local Web UI (127.0.0.1 only)
# The client binds 127.0.0.1 and rejects requests without the page token in
# the EnvironmentFile below; this unit must never be exposed on a public
# interface. It does not enable itself: only an explicit
# 'systemctl --user enable' creates the default.target autostart link.
After=default.target

[Service]
Type=simple
Environment=XDG_CACHE_HOME={cache}
Environment=DSH_HOME={dsh_home}
EnvironmentFile={env_file}
ExecStart={exec} --serve-web --port {port}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
";

/// The state the CLI and the setup page render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebUiStatus {
    /// The user unit file exists.
    pub unit_present: bool,
    /// `systemctl --user is-enabled` reports enabled.
    pub enabled: bool,
    /// `systemctl --user is-active` reports active.
    pub active: bool,
    /// The client binary the unit would run is present.
    pub client_present: bool,
    /// The URL published by the running client, when readable.
    pub url: Option<String>,
    /// Human hint, set when the client binary is missing.
    pub hint: Option<String>,
}

impl WebUiStatus {
    /// The wire shape shared by `--json` and `GET /api/webui`.
    pub fn to_json(&self) -> serde_json::Value {
        json!({
            "unit_present": self.unit_present,
            "enabled": self.enabled,
            "active": self.active,
            "client_present": self.client_present,
            "url": self.url,
            "hint": self.hint,
        })
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// `$XDG_CONFIG_HOME` when absolute, else `~/.config`.
fn config_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home_dir().join(".config"))
}

/// `$XDG_CACHE_HOME` when absolute, else `~/.cache`.
fn cache_dir() -> PathBuf {
    std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home_dir().join(".cache"))
}

/// Where the user units live; `RDSH_SYSTEMD_DIR` redirects them for tests.
fn unit_directory() -> PathBuf {
    if let Some(dir) = std::env::var_os("RDSH_SYSTEMD_DIR") {
        return PathBuf::from(dir);
    }
    config_dir().join("systemd/user")
}

/// The pinned-token file the unit reads; mode 0600, never world readable.
fn env_file_path() -> PathBuf {
    config_dir().join("rdsh-desktop/webui.env")
}

/// The URL the running client publishes.
fn url_file_path() -> PathBuf {
    cache_dir().join("rdsh-desktop/webui.url")
}

/// The native client binary the unit runs.
fn client_path() -> PathBuf {
    std::env::var_os("RDSH_DESKTOP_CLIENT")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| home_dir().join(".local/bin/rdsh-desktop"))
}

/// True when systemctl must not be called (tests, containers, other init
/// systems). The files are still written, so the operator keeps the plan.
fn systemctl_skipped() -> bool {
    std::env::var_os("RDSH_SYSTEMD_NO_RELOAD").is_some_and(|value| value == "1")
}

/// The session variables `systemctl --user` needs, taken from `lookup` so the
/// handoff is testable without touching the process environment.
///
/// Both are optional on their own, but a login session without either cannot
/// reach the user manager, so that case fails with one clear message.
fn session_environment(
    locale: crate::locale::Locale,
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<Vec<(String, String)>> {
    let mut values = Vec::new();
    for key in ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] {
        if let Some(value) = lookup(key).filter(|value| !value.trim().is_empty()) {
            values.push((key.to_string(), value));
        }
    }
    if values.is_empty() {
        bail!(
            "{}",
            localized_format!(
                locale,
                "the user session bus is unavailable (set XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS by running this from your desktop login session)",
                "用户会话总线不可用（请在桌面登录会话中运行，以设置 XDG_RUNTIME_DIR 和 DBUS_SESSION_BUS_ADDRESS）",
                "ユーザーのセッションバスに接続できません。デスクトップのログインセッションで実行し、XDG_RUNTIME_DIR と DBUS_SESSION_BUS_ADDRESS を設定してください"
            )
        );
    }
    Ok(values)
}

fn systemctl(
    args: &[&str],
    session: &[(String, String)],
    locale: crate::locale::Locale,
) -> Result<String> {
    if systemctl_skipped() {
        return Ok(String::new());
    }
    let output = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .envs(session.iter().map(|(key, value)| (key, value)))
        .output()
        .with_context(|| {
            localized_format!(
                locale,
                "running systemctl --user {}",
                "运行 systemctl --user {}",
                "systemctl --user {} を実行",
                args.join(" ")
            )
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "{}",
            localized_format!(
                locale,
                "systemctl --user {} failed: {}",
                "systemctl --user {} 失败：{}",
                "systemctl --user {} が失敗しました: {}",
                args.join(" "),
                stderr.trim()
            )
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// A read-only systemctl query: any failure is unknown, never an error, so the
/// caller still reports the file-level facts.
fn systemctl_read(args: &[&str]) -> Option<String> {
    if systemctl_skipped() {
        return None;
    }
    let session = session_environment(crate::locale::Locale::English, |key| {
        std::env::var(key).ok()
    })
    .unwrap_or_default();
    let output = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .envs(session.iter().map(|(key, value)| (key, value)))
        .output()
        .ok()?;
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn missing_client_hint(locale: crate::locale::Locale, client: &Path) -> String {
    localized_format!(
        locale,
        "rdsh-desktop was not found at {}; install the native client there or set RDSH_DESKTOP_CLIENT",
        "在 {} 未找到 rdsh-desktop；请在那里安装原生客户端或设置 RDSH_DESKTOP_CLIENT",
        "rdsh-desktop が {} に見つかりません。そこにネイティブクライアントを置くか RDSH_DESKTOP_CLIENT を設定してください",
        client.display()
    )
}

/// Read the current switch state. Never fails: a missing unit or an
/// unreachable user bus degrades to false, which is the OFF default.
pub fn status(locale: crate::locale::Locale) -> WebUiStatus {
    let unit = unit_directory().join(SERVICE);
    let unit_present = unit.is_file();
    let enabled =
        unit_present && systemctl_read(&["is-enabled", SERVICE]).as_deref() == Some("enabled");
    let active =
        unit_present && systemctl_read(&["is-active", SERVICE]).as_deref() == Some("active");
    let url = fs::read_to_string(url_file_path())
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    let client = client_path();
    let client_present = client.is_file();
    WebUiStatus {
        unit_present,
        enabled,
        active,
        client_present,
        url,
        hint: (!client_present).then(|| missing_client_hint(locale, &client)),
    }
}

/// Quote one path for a systemd setting: a percent sign is a specifier and is
/// always doubled; quotes, backslashes and whitespace force a quoted form.
fn systemd_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    let quote = text
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '\\'));
    let mut out = String::new();
    if quote {
        out.push('"');
    }
    for character in text.chars() {
        match character {
            '%' => out.push_str("%%"),
            '"' if quote => out.push_str("\\\""),
            '\\' if quote => out.push_str("\\\\"),
            _ => out.push(character),
        }
    }
    if quote {
        out.push('"');
    }
    out
}

/// Render the embedded unit for this machine.
pub fn unit_text(exec: &Path, env_file: &Path, cache: &Path, dsh_home: &Path) -> String {
    UNIT_TEMPLATE
        .replace("{cache}", &systemd_path(cache))
        .replace("{dsh_home}", &systemd_path(dsh_home))
        .replace("{env_file}", &systemd_path(env_file))
        .replace("{exec}", &systemd_path(exec))
        .replace("{port}", &PORT.to_string())
}

/// A page token is exactly 32 hex characters.
fn is_token(value: &str) -> bool {
    value.len() == TOKEN_HEX_LEN && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Pull the token out of an env file body, if it is usable.
fn token_in(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let line = line.trim();
        let value = line.strip_prefix(TOKEN_ENV)?.strip_prefix('=')?.trim();
        is_token(value).then(|| value.to_string())
    })
}

/// Return the existing body with exactly one token line, so other settings in
/// the file (for example RDSH_DESKTOP_UPDATE_CHECK=0) survive.
fn with_token_line(existing: &str, token: &str) -> String {
    let line = format!("{TOKEN_ENV}={token}");
    let mut replaced = false;
    let mut out = String::new();
    for raw in existing.lines() {
        let trimmed = raw.trim();
        let is_token_line = trimmed
            .strip_prefix(TOKEN_ENV)
            .is_some_and(|rest| rest.starts_with('='));
        if is_token_line && !replaced {
            out.push_str(&line);
            replaced = true;
        } else {
            out.push_str(raw);
        }
        out.push('\n');
    }
    if !replaced {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// 32 hex characters from the OS random source.
fn generate_token() -> Result<String> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut bytes = [0u8; TOKEN_HEX_LEN / 2];
    getrandom::fill(&mut bytes)
        .map_err(|error| anyhow::anyhow!("OS random source failed: {error}"))?;
    let mut out = String::with_capacity(TOKEN_HEX_LEN);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(out)
}

/// Write contents at path with mode 0600 on Unix.
fn write_private(path: &Path, contents: &str) -> Result<()> {
    use std::io::Write as _;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("writing {}", path.display()))?;
    file.write_all(contents.as_bytes())
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

/// Ensure the token file exists with a usable pinned token: reuse the existing
/// one, otherwise generate 32 hex characters. An existing token is never
/// rotated, so a bookmarked URL keeps working. Returns the token.
pub fn ensure_env_file(path: &Path) -> Result<String> {
    let existing = fs::read_to_string(path).unwrap_or_default();
    if let Some(token) = token_in(&existing) {
        // The token is fine; only the file mode may have drifted.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        return Ok(token);
    }
    let token = generate_token()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
    write_private(path, &with_token_line(&existing, &token))?;
    Ok(token)
}

/// Turn the autostart on or off, then report the resulting state.
///
/// Enabling is the only path that writes or enables the unit. Disabling stops
/// the service, removes the unit file and the autostart link, and leaves the
/// token file in place so a later enable keeps the same URL.
pub fn apply(enable: bool, locale: crate::locale::Locale) -> Result<WebUiStatus> {
    let client = client_path();
    if enable && !client.is_file() {
        bail!("{}", missing_client_hint(locale, &client));
    }
    let session = if systemctl_skipped() {
        Vec::new()
    } else {
        session_environment(locale, |key| std::env::var(key).ok())?
    };
    let unit = unit_directory().join(SERVICE);
    if enable {
        let env_file = env_file_path();
        ensure_env_file(&env_file)?;
        let directory = unit_directory();
        fs::create_dir_all(&directory)
            .with_context(|| format!("creating {}", directory.display()))?;
        let text = unit_text(
            &client,
            &env_file,
            &cache_dir(),
            &PathBuf::from(crate::inspect::dsh_home()),
        );
        fs::write(&unit, text).with_context(|| format!("writing {}", unit.display()))?;
        systemctl(&["daemon-reload"], &session, locale)?;
        systemctl(&["enable", "--now", SERVICE], &session, locale)?;
    } else {
        // An interrupted or hand-made install may not be loaded; disabling an
        // unknown unit is not an error, so the file can still be cleaned up.
        let _ = systemctl(&["disable", "--now", SERVICE], &session, locale);
        if unit.is_file() {
            fs::remove_file(&unit).with_context(|| format!("removing {}", unit.display()))?;
        }
        systemctl(&["daemon-reload"], &session, locale)?;
    }
    Ok(status(locale))
}

fn print_status(locale: crate::locale::Locale) {
    let state = status(locale);
    println!(
        "{}",
        localized_format!(
            locale,
            "unit:   {} ({})",
            "单元文件：{} ({})",
            "ユニット: {} ({})",
            unit_directory().join(SERVICE).display(),
            if state.unit_present {
                localized_format!(locale, "present", "存在", "あり")
            } else {
                localized_format!(locale, "not installed", "未安装", "未インストール")
            }
        )
    );
    println!(
        "{}",
        localized_format!(
            locale,
            "enabled: {}",
            "已启用：{}",
            "自動起動: {}",
            if state.enabled {
                localized_format!(locale, "yes", "是", "オン")
            } else {
                localized_format!(locale, "no", "否", "オフ")
            }
        )
    );
    println!(
        "{}",
        localized_format!(
            locale,
            "active: {}",
            "运行中：{}",
            "稼働: {}",
            if state.active {
                localized_format!(locale, "running", "运行中", "稼働中")
            } else {
                localized_format!(locale, "stopped", "已停止", "停止")
            }
        )
    );
    match &state.url {
        Some(url) => println!(
            "{}",
            localized_format!(locale, "url:    {url}", "URL：{url}", "URL:    {url}")
        ),
        None => println!(
            "{}",
            localized_format!(
                locale,
                "url:    (not written yet)",
                "URL：（尚未写入）",
                "URL:    （まだありません）"
            )
        ),
    }
    if let Some(hint) = &state.hint {
        println!(
            "{}",
            localized_format!(locale, "note:   {hint}", "注意：{hint}", "注意:   {hint}")
        );
    }
}

fn print_applied(enable: bool, state: &WebUiStatus, locale: crate::locale::Locale) {
    if enable {
        println!(
            "{}",
            localized_format!(
                locale,
                "local Web UI autostart enabled ({} at login)",
                "本地 Web UI 常时启动已开启（登录时 {}）",
                "ローカルWeb UIの常時起動を有効にしました（ログイン時に {}）",
                SERVICE
            )
        );
    } else {
        println!(
            "{}",
            localized_format!(
                locale,
                "local Web UI autostart disabled and stopped",
                "本地 Web UI 常时启动已关闭并停止",
                "ローカルWeb UIの常時起動を無効にし、停止しました"
            )
        );
    }
    print_status(locale);
    if enable && state.active {
        if let Some(url) = &state.url {
            println!(
                "{}",
                localized_format!(locale, "open: {url}", "打开：{url}", "開く: {url}")
            );
        }
    }
}

/// Entry point behind `rdsh desktop web-ui status|on|off`.
pub fn cmd_web_ui(action: &str, json: bool, locale: crate::locale::Locale) -> Result<()> {
    match action {
        "status" => {
            let state = status(locale);
            if json {
                println!("{}", serde_json::to_string_pretty(&state.to_json())?);
            } else {
                print_status(locale);
            }
            Ok(())
        }
        "on" => {
            let state = apply(true, locale)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&state.to_json())?);
            } else {
                print_applied(true, &state, locale);
            }
            Ok(())
        }
        "off" => {
            let state = apply(false, locale)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&state.to_json())?);
            } else {
                print_applied(false, &state, locale);
            }
            Ok(())
        }
        other => bail!(
            "{}",
            localized_format!(
                locale,
                "unknown action {other:?}: use status, on or off",
                "未知操作 {other:?}：请使用 status、on 或 off",
                "不明な操作 {other:?}: status、on、off を指定してください"
            )
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("rdsh-desktop-webui-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn with_vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect();
        move |key: &str| {
            pairs
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.clone())
        }
    }

    #[test]
    fn unit_binds_loopback_on_the_web_ui_port_and_starts_the_client() {
        let text = unit_text(
            Path::new("/home/u/.local/bin/rdsh-desktop"),
            Path::new("/home/u/.config/rdsh-desktop/webui.env"),
            Path::new("/home/u/.cache"),
            Path::new("/home/u/.dsh"),
        );
        assert!(text.contains("127.0.0.1"), "{text}");
        assert!(text.contains("--serve-web --port 8790"), "{text}");
        assert!(
            text.contains("ExecStart=/home/u/.local/bin/rdsh-desktop --serve-web --port 8790"),
            "{text}"
        );
        assert!(
            text.contains("EnvironmentFile=/home/u/.config/rdsh-desktop/webui.env"),
            "{text}"
        );
        assert!(text.contains("WantedBy=default.target"), "{text}");
        assert!(!text.contains("{exec}"), "{text}");
    }

    #[test]
    fn unit_never_enables_itself() {
        let text = unit_text(
            Path::new("/bin/rdsh-desktop"),
            Path::new("/tmp/webui.env"),
            Path::new("/tmp/cache"),
            Path::new("/tmp/dsh"),
        );
        assert!(!text.contains("ExecStartPre"), "{text}");
        let starts: Vec<&str> = text
            .lines()
            .filter(|line| line.starts_with("ExecStart="))
            .collect();
        assert_eq!(starts.len(), 1, "{text}");
        assert!(starts[0].contains("rdsh-desktop --serve-web"), "{text}");
        assert!(!starts[0].contains("systemctl"), "{text}");
        assert_eq!(text.matches("WantedBy=").count(), 1, "{text}");
        assert_eq!(text.matches("[Install]").count(), 1, "{text}");
    }

    #[test]
    fn unit_escapes_percent_specifiers() {
        let text = unit_text(
            Path::new("/home/100%/rdsh-desktop"),
            Path::new("/tmp/webui.env"),
            Path::new("/tmp/cache"),
            Path::new("/tmp/dsh"),
        );
        assert!(text.contains("/home/100%%/rdsh-desktop"), "{text}");
        assert!(text.contains("--serve-web --port 8790"), "{text}");
    }

    #[test]
    fn env_file_generates_a_private_32_hex_token_and_reuses_it() {
        let dir = temp_dir("token");
        let path = dir.join("nested/webui.env");
        let token = ensure_env_file(&path).unwrap();
        assert_eq!(token.len(), 32);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.contains(&format!("RDSH_DESKTOP_WEB_TOKEN={token}")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "token file must stay private");
        }
        assert_eq!(
            ensure_env_file(&path).unwrap(),
            token,
            "the pinned token is reused"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn env_file_keeps_other_settings_and_repairs_a_bad_token() {
        let dir = temp_dir("merge");
        let path = dir.join("webui.env");
        fs::write(
            &path,
            "RDSH_DESKTOP_UPDATE_CHECK=0
RDSH_DESKTOP_WEB_TOKEN=short
",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        }
        let token = ensure_env_file(&path).unwrap();
        assert_eq!(token.len(), 32);
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.contains("RDSH_DESKTOP_UPDATE_CHECK=0"));
        assert!(body.contains(&format!("RDSH_DESKTOP_WEB_TOKEN={token}")));
        assert!(!body.contains("TOKEN=short"));
        assert_eq!(body.matches("RDSH_DESKTOP_WEB_TOKEN=").count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_environment_passes_the_user_bus_and_fails_without_it() {
        let both = session_environment(
            crate::locale::Locale::English,
            with_vars(&[
                ("XDG_RUNTIME_DIR", "/run/user/1000"),
                ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
            ]),
        )
        .unwrap();
        assert_eq!(both.len(), 2);
        assert!(both.contains(&("XDG_RUNTIME_DIR".to_string(), "/run/user/1000".to_string())));

        let only_runtime = session_environment(
            crate::locale::Locale::English,
            with_vars(&[("XDG_RUNTIME_DIR", "/run/user/1000")]),
        )
        .unwrap();
        assert_eq!(only_runtime.len(), 1);

        let error = session_environment(crate::locale::Locale::Japanese, |_| None).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("XDG_RUNTIME_DIR"), "{message}");
        assert!(message.contains("ユーザー"), "{message}");
    }
}
