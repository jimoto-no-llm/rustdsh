use crate::{
    auth, compaction_cli, compaction_policy, desktop, distro, dsh_env, executable, locale,
    passthrough, plugins, rdsh_config, rustxng, searxng, slim, tmp_guard, websearch, zdr,
};

fn profile_count(home: &str) -> std::io::Result<usize> {
    Ok(
        std::fs::read_dir(std::path::Path::new(home).join("profiles"))?
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .count(),
    )
}

pub(crate) fn doctor_json() -> anyhow::Result<()> {
    use std::io::Write;
    let original = passthrough::find_original_dsh();
    let node = match original.as_deref() {
        Some(original) => passthrough::selected_node(original),
        None => passthrough::find_node_bin(),
    };
    let node_required = original
        .as_deref()
        .is_some_and(|path| path.ends_with(".js"));
    let original_found = original.as_deref().is_some_and(|path| {
        let path = std::path::Path::new(path);
        if node_required {
            path.is_file()
        } else {
            executable::is_executable(path)
        }
    });
    let ok = original_found && (!node_required || node.is_some());
    let home = crate::inspect::dsh_home();
    let profiles = profile_count(&home);
    let env = desktop::OsEnv::from_process();
    let profile = desktop::read_profile(&env.profile_dir());
    let enabled: Vec<&str> = desktop::BUNDLED_PLUGINS
        .iter()
        .copied()
        .filter(|name| profile.enabled(name))
        .collect();
    let shadowed = crate::wrapper_diag::shadowing_original();
    let mut warnings = crate::wrapper_diag::wrapper_warnings(shadowed, locale::Locale::English);
    if profiles.is_err() {
        warnings.push("local profiles directory is unreadable or absent".to_string());
    }
    warnings.extend(tmp_guard::doctor_lines(locale::Locale::English));
    let compaction = compaction_policy::report();
    warnings.extend(compaction_policy::doctor_warnings(&compaction));
    let report = serde_json::json!({
        "schema": 1,
        "ok": ok,
        "rdsh_version": env!("CARGO_PKG_VERSION"),
        "dsh_home": home,
        "original": { "found": original_found, "path": original, "probed": false },
        "node": { "required": node_required, "found": node.is_some(), "path": node },
        "profiles": { "readable": profiles.is_ok(), "count": profiles.ok() },
        "desktop": {
            "app": desktop::find_app(&env),
            "profile_initialized": profile.initialized,
            "enabled_bundled_plugins": enabled,
        },
        "path_shadowed": shadowed,
        "warnings": warnings,
        "environment": dsh_env::json(&dsh_env::diagnose()),
        "compaction_policy": compaction_policy::doctor_json(&compaction),
        "compaction_capabilities": compaction_cli::capabilities(),
    });
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    serde_json::to_writer(&mut out, &report)?;
    writeln!(out)?;
    if !ok {
        anyhow::bail!("local DSH prerequisites are missing; see the JSON report");
    }
    Ok(())
}

pub(crate) fn doctor(mode: DoctorMode, locale: locale::Locale) -> anyhow::Result<()> {
    use std::io::Write;
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    // `let _` on purpose: piping to `grep -q` / `head` closes early (EPIPE),
    // which must not abort doctor with a panic.
    let mut say = |s: String| {
        let _ = writeln!(out, "{s}");
    };
    let text = |english: &'static str, chinese: &'static str, japanese: &'static str| match locale {
        locale::Locale::English => english,
        locale::Locale::Chinese => chinese,
        locale::Locale::Japanese => japanese,
    };
    let orig = passthrough::find_original_dsh();
    say(format!(
        "[rdsh] {}: {}",
        match locale {
            locale::Locale::English => "original dsh",
            locale::Locale::Chinese => "原始 dsh",
            locale::Locale::Japanese => "元の dsh",
        },
        orig.as_deref().unwrap_or("<not found in PATH>")
    ));
    let home = crate::inspect::dsh_home();
    say(format!("[rdsh] DSH_HOME: {home}"));
    // Node.js / npm / pnpm as this host resolves them, plus the pnpm
    // build-script policy (ERR_PNPM_IGNORED_BUILDS). Advisory only: doctor's
    // exit status is decided by the original dsh check at the end.
    for line in dsh_env::doctor_lines(&dsh_env::diagnose(), locale) {
        say(line);
    }
    match profile_count(&home) {
        Ok(count) => say(format!(
            "[rdsh] {}: {} {}",
            text("profiles", "配置文件", "プロファイル"),
            count,
            text(
                "local profile(s)",
                "个本地配置文件",
                "件のローカルプロファイル"
            )
        )),
        Err(e) => say(format!(
            "[rdsh] {}: ({}: {e})",
            text("profiles", "配置文件", "プロファイル"),
            text("unreadable", "无法读取", "読み取れません")
        )),
    }
    // Desktop (Electron) shares $DSH_HOME but keeps its own reserved profile;
    // report both so a missing plugin attachment is visible in doctor.
    let desktop_env = desktop::OsEnv::from_process();
    let desktop_app = desktop::find_app(&desktop_env);
    let desktop_profile = desktop::read_profile(&desktop_env.profile_dir());
    say(format!(
        "[rdsh] {}: {} {} | {} {}",
        text("desktop", "桌面", "デスクトップ"),
        text("app", "应用", "アプリ"),
        desktop_app
            .as_deref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| format!("<{}>", text("not found", "未找到", "見つかりません"))),
        text("profile", "配置文件", "プロファイル"),
        if desktop_profile.initialized {
            text("initialized", "已初始化", "初期化済み")
        } else {
            text("not initialized", "未初始化", "未初期化")
        }
    ));
    if desktop_profile.initialized {
        let enabled: Vec<&str> = desktop::BUNDLED_PLUGINS
            .iter()
            .copied()
            .filter(|name| desktop_profile.enabled(name))
            .collect();
        say(format!(
            "[rdsh] {} {}: {}",
            text("desktop", "桌面", "デスクトップ"),
            text("plugins", "插件", "プラグイン"),
            if enabled.is_empty() {
                text(
                    "none enabled (run: rdsh desktop install --plugins-dir <checkout>)",
                    "没有已启用项（运行：rdsh desktop install --plugins-dir <checkout>）",
                    "有効なものはありません（rdsh desktop install --plugins-dir <checkout> を実行）",
                )
                .to_string()
            } else {
                enabled.join(", ")
            }
        ));
    }
    // Every initialized profile, not just the Desktop one: an upgraded binary
    // never rewrites a profile manifest, so an essential plugin can stay
    // missing with no other signal.
    for line in plugins::doctor_lines(&desktop_env, locale) {
        say(line);
    }
    // Host-specific optional dependencies (rpm-based hosts only).
    for line in distro::doctor_notes() {
        say(line);
    }
    // Local web search. Advisory only: doctor reports what it finds and never
    // starts a container (that stays behind search-web --auto-start).
    let searxng_base = websearch::default_base();
    say(format!(
        "[rdsh] {}: {} ({searxng_base})",
        text("SearXNG", "SearXNG", "SearXNG"),
        if searxng::reachable(&searxng_base, locale) {
            text("reachable", "可连接", "接続OK")
        } else {
            text("not reachable", "无法连接", "未接続")
        }
    ));
    if let Some(line) = rustxng::update::doctor_line(locale) {
        say(format!("[rdsh] {line}"));
    }
    let runtimes = searxng::runtime_names();
    say(format!(
        "[rdsh] {}: {}",
        text("container runtime", "容器运行时", "コンテナランタイム"),
        if runtimes.is_empty() {
            text("none found", "未找到", "見つかりません").to_string()
        } else {
            runtimes.join(", ")
        }
    ));
    say(format!(
        "[rdsh] {}: {}",
        text(
            "SearXNG compose file",
            "SearXNG compose 文件",
            "SearXNG compose ファイル"
        ),
        searxng::compose_source().label(locale)
    ));
    say(format!(
        "[rdsh] {}: {}",
        text("slim env", "精简环境", "slim 環境"),
        slim::describe()
    ));
    say(format!(
        "[rdsh] {}: {}",
        text("auth", "认证", "認証"),
        auth::summary_line(locale)
    ));
    if let Some(v) = original_version(orig.as_deref().unwrap_or_default()) {
        say(format!(
            "[rdsh] dsh {}: {v}",
            text("version", "版本", "バージョン")
        ));
    }
    say(format!(
        "[rdsh] smart-dsh: {}",
        smart_dsh_status(&home, locale)
    ));
    let shadowed = crate::wrapper_diag::shadowing_original();
    if shadowed {
        say(format!(
            "[rdsh] {}: {}",
            text("note", "提示", "注記"),
            text(
                "'dsh' currently resolves to rdsh; Smart-DSH scripts that locate",
                "'dsh' 当前解析为 rdsh；查找 DSH 的 Smart-DSH 脚本",
                "'dsh' は現在 rdsh に解決されます。DSH を探す Smart-DSH スクリプトは"
            )
        ));
        say(format!("[rdsh] {}: {}", text("note", "提示", "注記"), text("DSH via PATH need the original: use `dsh-orig` or set DSH_PACKAGE_DIR", "若要通过 PATH 使用 DSH，需要原始版本：请使用 `dsh-orig` 或设置 DSH_PACKAGE_DIR", "PATH 経由で DSH を使うには元の実行ファイルが必要です。`dsh-orig` を使うか DSH_PACKAGE_DIR を設定してください")));
    }
    for w in crate::wrapper_diag::shadow_warnings(shadowed, orig.as_deref(), locale) {
        say(w);
    }
    for w in crate::wrapper_diag::wrapper_warnings(shadowed, locale) {
        say(w);
    }
    // dsh-workspace-changes snapshot hygiene: big untracked paths and
    // leftover orphan directories. Read-only; doctor never deletes.
    for w in tmp_guard::doctor_lines(locale) {
        say(w);
    }
    // Compaction policy layer: the feature switch and the policy file as a
    // boot would read them. Read-only; no profile is composed here.
    for line in compaction_policy::doctor_lines(&compaction_policy::report(), locale) {
        say(line);
    }
    for line in zdr::doctor_lines(zdr::mode_on(
        &rdsh_config::load(),
        std::env::var("RDSH_ZDR").ok().as_deref(),
    )) {
        say(line);
    }
    say(format!(
        "[rdsh] {}: {}",
        text("note", "提示", "注記"),
        text(
            "dsh web GUI defaults to 3080; `rdsh serve` defaults to 38080",
            "dsh Web GUI 默认使用 3080；`rdsh serve` 默认使用 38080",
            "dsh Web GUI の既定は 3080、`rdsh serve` の既定は 38080 です"
        )
    ));
    say(format!(
        "[rdsh] {}: {}",
        text("note", "提示", "注記"),
        text(
            "enable the serve extra first; `rdsh serve --port 0` picks a free port",
            "请先启用 serve 附加功能；`rdsh serve --port 0` 会选择空闲端口",
            "先に serve 追加機能を有効にしてください。`rdsh serve --port 0` は空きポートを選びます"
        )
    ));
    if orig.is_none() {
        anyhow::bail!(match locale {
            locale::Locale::English => {
                "original 'dsh' not found; set DSH_ORIG_BIN or install @deepseek-ai/dsh"
            }
            locale::Locale::Chinese => {
                "未找到原始 'dsh'；请设置 DSH_ORIG_BIN 或安装 @deepseek-ai/dsh"
            }
            locale::Locale::Japanese => {
                "元の 'dsh' が見つかりません。DSH_ORIG_BIN を設定するか @deepseek-ai/dsh をインストールしてください"
            }
        });
    }
    doctor_mode_choice(mode, locale)?;
    Ok(())
}

/// What `rdsh doctor` does after the diagnosis: print the next step only, or
/// offer the two ways to start a conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DoctorMode {
    /// Print the summary and the next step; start nothing (`--json`).
    Diagnose,
    /// On a terminal, ask for the Web UI or the terminal; otherwise answer
    /// with the default for this host (Web UI with a desktop session, the
    /// terminal everywhere else).
    Choose,
}

impl DoctorMode {
    /// `doctor` with no explicit mode: a terminal gets the question, anything
    /// else (a pipe, an agent) gets the non-blocking summary.
    pub(crate) fn from_terminal(locale: locale::Locale) -> Self {
        use std::io::IsTerminal as _;
        if std::io::stdin().is_terminal() && std::io::stderr().is_terminal() {
            let _ = locale;
            DoctorMode::Choose
        } else {
            DoctorMode::Diagnose
        }
    }
}

/// The last lines of `rdsh doctor`: what to do next, and - on a terminal - the
/// one question a first-time user can answer without knowing any command.
/// Read the answer to the doctor question. `1`/`w`/`web` means the Web UI,
/// `2`/`t`/`tui`/`terminal` the terminal, and anything else (an empty line, a
/// closed stdin) the default for this host: the Web UI where a desktop session
/// exists, the terminal everywhere else.
fn mode_choice(answer: Option<&str>, desktop_session: bool) -> bool {
    match answer {
        Some("1") | Some("w") | Some("web") => true,
        Some("2") | Some("t") | Some("tui") | Some("terminal") => false,
        _ => desktop_session,
    }
}

fn doctor_mode_choice(mode: DoctorMode, locale: locale::Locale) -> anyhow::Result<()> {
    use std::io::Write as _;
    let text = |english: &'static str, chinese: &'static str, japanese: &'static str| match locale {
        locale::Locale::English => english,
        locale::Locale::Chinese => chinese,
        locale::Locale::Japanese => japanese,
    };
    let connected = !crate::auth::setup_needed();
    let plugins = crate::plugins::doctor_lines(&desktop::OsEnv::from_process(), locale);
    let mut next: Vec<String> = Vec::new();
    if !connected {
        next.push(
            text(
                "connect a model: rdsh setup --web (opens a browser page)",
                "连接模型：rdsh setup --web（打开浏览器页面）",
                "モデルをつなぐ: rdsh setup --web（ブラウザの画面が開きます）",
            )
            .to_string(),
        );
    }
    if !plugins.is_empty() {
        next.push(
            text(
                "add the bundled plugins: rdsh plugins install",
                "补齐必需插件：rdsh plugins install",
                "同梱プラグインを補う: rdsh plugins install",
            )
            .to_string(),
        );
    }
    if next.is_empty() {
        next.push(
            text(
                "ready: nothing else to set up",
                "已就绪：无需其他设置",
                "準備完了: ほかに設定はありません",
            )
            .to_string(),
        );
    }
    let _ = writeln!(
        std::io::stdout(),
        "[rdsh] {}",
        text("next", "下一步", "次の一手")
    );
    for line in &next {
        let _ = writeln!(std::io::stdout(), "[rdsh]   {line}");
    }
    match mode {
        DoctorMode::Diagnose => return Ok(()),
        DoctorMode::Choose => {}
    }
    let desktop_session = crate::setup_web::a_desktop_session_is_available();
    let web = text(
        "Web UI (browser, opens automatically)",
        "Web UI（浏览器，自动打开）",
        "Web UI（ブラウザ。自動で開きます）",
    );
    let terminal = text(
        "Terminal (stays in this window)",
        "终端（留在此窗口）",
        "ターミナル（この画面のまま）",
    );
    let mut answer = None;
    if crate::setup_web::interactive_terminal() {
        let _ = writeln!(std::io::stdout());
        let _ = writeln!(
            std::io::stdout(),
            "[rdsh] {}",
            text(
                "where do you want to work?",
                "想在哪里使用？",
                "どこで使いますか？",
            )
        );
        let _ = writeln!(std::io::stdout(), "[rdsh]   1) {web}");
        let _ = writeln!(std::io::stdout(), "[rdsh]   2) {terminal}");
        let _ = write!(
            std::io::stdout(),
            "[rdsh] {} [{}] ",
            text("choose", "选择", "選択"),
            if desktop_session { "1" } else { "2" }
        );
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        if std::io::stdin().read_line(&mut line).is_ok() {
            answer = Some(line.trim().to_string());
        }
    }
    let start_web = mode_choice(answer.as_deref(), desktop_session);
    if start_web {
        let _ = writeln!(
            std::io::stdout(),
            "[rdsh] {} {web}",
            text("starting", "启动", "起動")
        );
        passthrough::exec_boot("web", None, &[], &[], false, true, locale)
    } else {
        let _ = writeln!(
            std::io::stdout(),
            "[rdsh] {} {terminal}",
            text("starting", "启动", "起動")
        );
        let _ = std::io::stdout().flush();
        // The terminal replaces this process, exactly as `rdsh tui` does.
        let exe = std::env::current_exe()?;
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt as _;
            let error = std::process::Command::new(exe).arg("tui").exec();
            Err(anyhow::anyhow!(error))
        }
        #[cfg(not(unix))]
        {
            let status = std::process::Command::new(exe).arg("tui").status()?;
            std::process::exit(status.code().unwrap_or(1));
        }
    }
}

/// Best-effort, bounded `dsh --version` readout. Only the owned child is killed.
fn original_version(orig: &str) -> Option<String> {
    use std::process::Command;
    use std::time::Duration;
    if orig.is_empty() {
        return None;
    }
    let mut command = if orig.ends_with(".js") {
        let mut command = Command::new(passthrough::selected_node(orig)?);
        command.arg(orig);
        command
    } else {
        Command::new(orig)
    };
    command.arg("--version");
    // The deadline, the bounded read and the never-joined reader live in
    // dsh_env, shared with the Node/npm/pnpm probes.
    let bytes = dsh_env::run_bounded_capture(command, 4096, Duration::from_secs(2))?;
    String::from_utf8_lossy(&bytes)
        .lines()
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Smart-DSH (https://github.com/hikarioyama/Smart-DSH) is a DSH web-profile
/// plugin bundle, not a competing binary: report which of its bundles the web
/// profile currently wires in (read-only package.json scan).
fn smart_dsh_status(home: &str, locale: locale::Locale) -> String {
    const KNOWN: &[&str] = &["dsh-notify-push", "dsh-esc-stop", "dsh-btw", "dsh-tasks"];
    let pkg = format!("{home}/profiles/web/package.json");
    let text = std::fs::read_to_string(&pkg).unwrap_or_default();
    if text.is_empty() {
        return match locale {
            locale::Locale::English => "(not installed: no web profile package.json)",
            locale::Locale::Chinese => "（未安装：没有 Web 配置文件 package.json）",
            locale::Locale::Japanese => "（未導入: Web プロファイルの package.json がありません）",
        }
        .to_string();
    }
    let found: Vec<&str> = KNOWN.iter().copied().filter(|b| text.contains(b)).collect();
    if found.is_empty() {
        match locale {
            locale::Locale::English => "(not installed in web profile)",
            locale::Locale::Chinese => "（未安装在 Web 配置文件中）",
            locale::Locale::Japanese => "（Web プロファイルに導入されていません）",
        }
        .to_string()
    } else {
        format!(
            "{}: {}",
            match locale {
                locale::Locale::English => "bundles in web profile",
                locale::Locale::Chinese => "Web 配置文件中的捆绑包",
                locale::Locale::Japanese => "Web プロファイルのバンドル",
            },
            found.join(", ")
        )
    }
}

#[cfg(test)]
mod doctor_choice_test {
    use super::mode_choice;

    #[test]
    fn the_doctor_question_defaults_to_web_only_with_a_desktop_session() {
        assert!(mode_choice(None, true));
        assert!(!mode_choice(None, false));
        assert!(mode_choice(Some(""), true));
        assert!(!mode_choice(Some(""), false));
    }

    #[test]
    fn the_answer_wins_over_the_default() {
        for web in ["1", "w", "web"] {
            assert!(mode_choice(Some(web), false), "{web}");
        }
        for tui in ["2", "t", "tui", "terminal"] {
            assert!(!mode_choice(Some(tui), true), "{tui}");
        }
        // Unknown input falls back to the default rather than erroring.
        assert!(mode_choice(Some("x"), true));
        assert!(!mode_choice(Some("x"), false));
    }
}
