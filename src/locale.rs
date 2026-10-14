//! User-interface language selection for rdsh-owned output.
//!
//! This module deliberately does not affect delegated commands, wire values,
//! model output, files supplied by a user, or machine-readable JSON fields.

/// The three product languages supported by rdsh-owned user interfaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    English,
    Chinese,
    Japanese,
}

/// Resolve a supported language without modifying the process environment.
///
/// The caller supplies the CLI choice and persisted setting. The environment
/// iterator makes the precedence testable and keeps lookup side-effect free.
pub fn resolve(
    explicit: Option<&str>,
    setting: &str,
    env: &[(impl AsRef<str>, impl AsRef<str>)],
) -> Locale {
    explicit
        .and_then(parse)
        .or_else(|| {
            env_value(env, "RDSH_LANG").map(|value| parse(value).unwrap_or(Locale::English))
        })
        .or_else(|| parse(setting))
        .or_else(|| {
            ["LC_ALL", "LC_MESSAGES", "LANG"].iter().find_map(|name| {
                env_value(env, name).map(|value| parse(value).unwrap_or(Locale::English))
            })
        })
        .unwrap_or(Locale::English)
}

/// Resolve from the current process only at the product boundary.
pub fn current(explicit: Option<&str>, setting: &str) -> Locale {
    let env = ["RDSH_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok().map(|value| (name, value)))
        .collect::<Vec<_>>();
    resolve(explicit, setting, &env)
}

/// Parse canonical values and common operating-system locale spellings.
pub fn parse(value: &str) -> Option<Locale> {
    let normalized = value
        .trim()
        .split(['.', '@'])
        .next()
        .unwrap_or_default()
        .replace('_', "-")
        .to_ascii_lowercase();
    match normalized.as_str() {
        "en" | "en-us" | "en-gb" => Some(Locale::English),
        "zh" | "zh-cn" | "zh-sg" | "chinese-simplified" | "chinese-china" => Some(Locale::Chinese),
        "ja" | "ja-jp" | "japanese" | "japanese-japan" => Some(Locale::Japanese),
        _ => None,
    }
}

fn env_value<'a>(env: &'a [(impl AsRef<str>, impl AsRef<str>)], name: &str) -> Option<&'a str> {
    env.iter()
        .find(|(key, _)| key.as_ref() == name)
        .map(|(_, value)| value.as_ref().trim())
        .filter(|value| !value.is_empty())
}

/// Return a localized rdsh-owned short message.
pub fn message(locale: Locale, key: Message) -> &'static str {
    match (locale, key) {
        (Locale::English, Message::SettingsExists) => "settings already exist at",
        (Locale::Chinese, Message::SettingsExists) => "设置已存在于",
        (Locale::Japanese, Message::SettingsExists) => "設定はすでに存在します:",
        (Locale::English, Message::UnknownSetting) => "unknown settings key",
        (Locale::Chinese, Message::UnknownSetting) => "未知的设置键",
        (Locale::Japanese, Message::UnknownSetting) => "不明な設定キー",
        (Locale::English, Message::Reset) => "reset",
        (Locale::Chinese, Message::Reset) => "已重置",
        (Locale::Japanese, Message::Reset) => "リセットしました",
        (Locale::English, Message::Error) => "error",
        (Locale::Chinese, Message::Error) => "错误",
        (Locale::Japanese, Message::Error) => "エラー",
        (Locale::English, Message::SettingsRead) => "cannot read settings",
        (Locale::Chinese, Message::SettingsRead) => "无法读取设置",
        (Locale::Japanese, Message::SettingsRead) => "設定を読み込めません",
        (Locale::English, Message::InvalidArguments) => "invalid command arguments",
        (Locale::Chinese, Message::InvalidArguments) => "命令参数无效",
        (Locale::Japanese, Message::InvalidArguments) => "コマンド引数が無効です",
        (Locale::English, Message::ExternalDiagnostic) => "Clap diagnostic",
        (Locale::Chinese, Message::ExternalDiagnostic) => "Clap 诊断",
        (Locale::Japanese, Message::ExternalDiagnostic) => "Clap 診断",
    }
}

/// Localized diagnostic messages which retain keys and paths supplied by users.
#[derive(Debug, Clone, Copy)]
pub enum Message {
    SettingsExists,
    UnknownSetting,
    Reset,
    Error,
    SettingsRead,
    InvalidArguments,
    ExternalDiagnostic,
}

/// Labels used by native commands whose data output must remain unchanged.
#[derive(Debug, Clone, Copy)]
pub enum NativeMessage {
    Preview,
    Total,
    SearchUnavailable,
    CannotReadFile,
    CannotAccessSearchDirectory,
    InvalidSearxUrl,
    OnlyHttpSearxUrl,
    InvalidIpv6SearxHost,
    InvalidSearxHost,
    InvalidSearxPort,
    SearxRequestTimedOut,
    SearxRequestClosed,
    SearxResponseTimedOut,
    SearxResponseTooLarge,
    BadSearxResponse,
    SearxReturnedHttp,
    NoSearxResultsPage,
}

/// Return a native command's localized human-readable label.
pub fn native_message(locale: Locale, key: NativeMessage) -> &'static str {
    match (locale, key) {
        (Locale::English, NativeMessage::Preview) => "preview",
        (Locale::Chinese, NativeMessage::Preview) => "预览",
        (Locale::Japanese, NativeMessage::Preview) => "プレビュー",
        (Locale::English, NativeMessage::Total) => "total",
        (Locale::Chinese, NativeMessage::Total) => "总计",
        (Locale::Japanese, NativeMessage::Total) => "合計",
        (Locale::English, NativeMessage::SearchUnavailable) => {
            "RDSH_SECURITY: secure native search is unavailable on this platform"
        }
        (Locale::Chinese, NativeMessage::SearchUnavailable) => "RDSH_SECURITY：此平台无法使用安全原生搜索",
        (Locale::Japanese, NativeMessage::SearchUnavailable) => {
            "RDSH_SECURITY: このプラットフォームでは安全なネイティブ検索を利用できません"
        }
        (Locale::English, NativeMessage::CannotReadFile) => "cannot read file",
        (Locale::Chinese, NativeMessage::CannotReadFile) => "无法读取文件",
        (Locale::Japanese, NativeMessage::CannotReadFile) => "ファイルを読み込めません",
        (Locale::English, NativeMessage::CannotAccessSearchDirectory) => {
            "cannot access search directory"
        }
        (Locale::Chinese, NativeMessage::CannotAccessSearchDirectory) => "无法访问搜索目录",
        (Locale::Japanese, NativeMessage::CannotAccessSearchDirectory) => {
            "検索ディレクトリにアクセスできません"
        }
        (Locale::English, NativeMessage::InvalidSearxUrl) => "invalid SearXNG URL",
        (Locale::Chinese, NativeMessage::InvalidSearxUrl) => "无效的 SearXNG URL",
        (Locale::Japanese, NativeMessage::InvalidSearxUrl) => "無効な SearXNG URL",
        (Locale::English, NativeMessage::OnlyHttpSearxUrl) => {
            "only http:// SearXNG URLs are supported (for a remote instance use an SSH tunnel to localhost)"
        }
        (Locale::Chinese, NativeMessage::OnlyHttpSearxUrl) => {
            "仅支持 http:// SearXNG URL（远程实例请通过 SSH 隧道连接 localhost）"
        }
        (Locale::Japanese, NativeMessage::OnlyHttpSearxUrl) => {
            "http:// の SearXNG URL のみ対応です（リモートインスタンスには localhost への SSH トンネルを使用してください）"
        }
        (Locale::English, NativeMessage::InvalidIpv6SearxHost) => "invalid IPv6 SearXNG host",
        (Locale::Chinese, NativeMessage::InvalidIpv6SearxHost) => "无效的 IPv6 SearXNG 主机",
        (Locale::Japanese, NativeMessage::InvalidIpv6SearxHost) => "無効な IPv6 SearXNG ホスト",
        (Locale::English, NativeMessage::InvalidSearxHost) => "invalid SearXNG host",
        (Locale::Chinese, NativeMessage::InvalidSearxHost) => "无效的 SearXNG 主机",
        (Locale::Japanese, NativeMessage::InvalidSearxHost) => "無効な SearXNG ホスト",
        (Locale::English, NativeMessage::InvalidSearxPort) => "invalid SearXNG port",
        (Locale::Chinese, NativeMessage::InvalidSearxPort) => "无效的 SearXNG 端口",
        (Locale::Japanese, NativeMessage::InvalidSearxPort) => "無効な SearXNG ポート",
        (Locale::English, NativeMessage::SearxRequestTimedOut) => "SearXNG request timed out",
        (Locale::Chinese, NativeMessage::SearxRequestTimedOut) => "SearXNG 请求超时",
        (Locale::Japanese, NativeMessage::SearxRequestTimedOut) => "SearXNG リクエストがタイムアウトしました",
        (Locale::English, NativeMessage::SearxRequestClosed) => "SearXNG request connection closed",
        (Locale::Chinese, NativeMessage::SearxRequestClosed) => "SearXNG 请求连接已关闭",
        (Locale::Japanese, NativeMessage::SearxRequestClosed) => "SearXNG リクエスト接続が閉じられました",
        (Locale::English, NativeMessage::SearxResponseTimedOut) => "SearXNG response timed out",
        (Locale::Chinese, NativeMessage::SearxResponseTimedOut) => "SearXNG 响应超时",
        (Locale::Japanese, NativeMessage::SearxResponseTimedOut) => "SearXNG 応答がタイムアウトしました",
        (Locale::English, NativeMessage::SearxResponseTooLarge) => "SearXNG response too large",
        (Locale::Chinese, NativeMessage::SearxResponseTooLarge) => "SearXNG 响应过大",
        (Locale::Japanese, NativeMessage::SearxResponseTooLarge) => "SearXNG 応答が大きすぎます",
        (Locale::English, NativeMessage::BadSearxResponse) => "bad HTTP response from",
        (Locale::Chinese, NativeMessage::BadSearxResponse) => "来自以下地址的 HTTP 响应无效：",
        (Locale::Japanese, NativeMessage::BadSearxResponse) => "HTTP 応答が不正です：",
        (Locale::English, NativeMessage::SearxReturnedHttp) => "SearXNG returned HTTP",
        (Locale::Chinese, NativeMessage::SearxReturnedHttp) => "SearXNG 返回 HTTP",
        (Locale::Japanese, NativeMessage::SearxReturnedHttp) => "SearXNG が HTTP を返しました",
        (Locale::English, NativeMessage::NoSearxResultsPage) => "no SearXNG results page from",
        (Locale::Chinese, NativeMessage::NoSearxResultsPage) => "以下地址没有 SearXNG 结果页：",
        (Locale::Japanese, NativeMessage::NoSearxResultsPage) => "SearXNG の結果ページがありません：",
    }
}

/// Fixed labels used by native CLI presentations. JSON fields and user-supplied
/// values are deliberately not represented here.
#[derive(Debug, Clone, Copy)]
pub enum UiMessage {
    NoDirectory,
    Items,
    Sessions,
    ShowingUpTo,
    Reading,
    Lines,
    Matching,
    ZstdUnavailable,
    CannotOpenLogFile,
    CannotReadLogFile,
    LogFileMustStayInside,
    NoLogs,
    ContextDisabled,
    ContextStatus,
    ContextBuild,
    ContextSearch,
    ContextExplain,
    NoHits,
    MissingFiles,
    GoalUnset,
    DesktopApp,
    DesktopCommand,
    DesktopProfile,
    DesktopPlugin,
    NotFound,
    Initialized,
    NotInitialized,
    Installed,
    Failed,
    DryRun,
    Guard,
    PatternHit,
    InvalidJsonInput,
    UnreadableOrOversizedInput,
    DesktopPluginMissing,
    DesktopProfileNotInitialized,
    DesktopNothingToInstall,
    DesktopInstallFailed,
}

/// Return localized native CLI presentation text while keeping the English
/// strings byte-compatible with the original commands.
pub fn ui_message(locale: Locale, key: UiMessage) -> &'static str {
    let index = match locale {
        Locale::English => 0,
        Locale::Chinese => 1,
        Locale::Japanese => 2,
    };
    let text = match key {
        UiMessage::NoDirectory => ["no {kind} dir at", "没有 {kind} 目录：", "{kind} ディレクトリがありません:"],
        UiMessage::Items => ["{kind}(s)", "个{kind}", "件の{kind}"],
        UiMessage::Sessions => ["session(s)", "个会话", "件のセッション"],
        UiMessage::ShowingUpTo => ["showing up to", "最多显示", "最大表示数:"],
        UiMessage::Reading => ["reading", "正在读取", "読み込み中"],
        UiMessage::Lines => ["line(s)", "行", "行"],
        UiMessage::Matching => ["matching", "匹配", "一致"],
        UiMessage::ZstdUnavailable => ["note: zstd CLI not found; `?` rows show stored-bytes/4 estimate", "提示：未找到 zstd CLI；`?` 行显示 stored-bytes/4 估算值", "注: zstd CLI が見つかりません。`?` 行は stored-bytes/4 の推定値です"],
        UiMessage::CannotOpenLogFile => ["cannot open log file", "无法打开日志文件", "ログファイルを開けません"],
        UiMessage::CannotReadLogFile => ["cannot read log file", "无法读取日志文件", "ログファイルを読み込めません"],
        UiMessage::LogFileMustStayInside => ["log file must be inside", "日志文件必须位于以下目录内：", "ログファイルは次の配下である必要があります:"],
        UiMessage::NoLogs => ["no logs at", "没有日志目录：", "ログディレクトリがありません:"],
        UiMessage::ContextDisabled => ["context engine is OFF by default (experimental) — enable with: rdsh features on context_engine", "上下文引擎默认关闭（实验性）— 使用以下命令启用：rdsh features on context_engine", "コンテキストエンジンは既定でOFFです（実験的）。有効化: rdsh features on context_engine"],
        UiMessage::ContextStatus => ["context", "上下文", "コンテキスト"],
        UiMessage::ContextBuild => ["context build", "上下文构建", "コンテキスト構築"],
        UiMessage::ContextSearch => ["context search", "上下文搜索", "コンテキスト検索"],
        UiMessage::ContextExplain => ["context explain", "上下文说明", "コンテキスト説明"],
        UiMessage::NoHits => ["no hits", "没有结果", "一致なし"],
        UiMessage::MissingFiles => ["missing files", "缺失文件", "見つからないファイル"],
        UiMessage::GoalUnset => ["unset — rdsh settings set context.goal \"...\"", "未设置 — rdsh settings set context.goal \"...\"", "未設定 — rdsh settings set context.goal \"...\""],
        UiMessage::DesktopApp => ["desktop app", "桌面应用", "デスクトップアプリ"],
        UiMessage::DesktopCommand => ["desktop command", "桌面命令", "デスクトップコマンド"],
        UiMessage::DesktopProfile => ["desktop profile", "桌面配置文件", "デスクトッププロファイル"],
        UiMessage::DesktopPlugin => ["desktop plugin", "桌面插件", "デスクトッププラグイン"],
        UiMessage::NotFound => ["not found", "未找到", "見つかりません"],
        UiMessage::Initialized => ["initialized", "已初始化", "初期化済み"],
        UiMessage::NotInitialized => ["not initialized", "未初始化", "未初期化"],
        UiMessage::Installed => ["installed", "已安装", "インストール済み"],
        UiMessage::Failed => ["failed", "失败", "失敗"],
        UiMessage::DryRun => ["dry-run", "试运行", "ドライラン"],
        UiMessage::Guard => ["rdsh guard", "rdsh 防护", "rdsh ガード"],
        UiMessage::PatternHit => ["pattern hit", "命中模式", "パターン一致"],
        UiMessage::InvalidJsonInput => ["invalid JSON input", "无效的 JSON 输入", "無効な JSON 入力"],
        UiMessage::UnreadableOrOversizedInput => ["unreadable or oversized input", "无法读取或过大的输入", "読み取れないか大きすぎる入力"],
        UiMessage::DesktopPluginMissing => ["desktop profile has no enabled rdsh plugin", "桌面配置文件没有启用的 rdsh 插件", "デスクトッププロファイルに有効な rdsh プラグインがありません"],
        UiMessage::DesktopProfileNotInitialized => ["Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before attaching rdsh plugins", "请先打开一次 DeepSeek Harness Desktop 以初始化配置文件，然后完全退出后再添加 rdsh 插件", "DeepSeek Harness Desktop を一度起動してプロファイルを初期化し、完全に終了してから rdsh プラグインを追加してください"],
        UiMessage::DesktopNothingToInstall => ["nothing to install: pass --package <spec> or drop --no-bundled", "没有可安装项：请传入 --package <spec> 或移除 --no-bundled", "インストール対象がありません: --package <spec> を指定するか --no-bundled を外してください"],
        UiMessage::DesktopInstallFailed => ["desktop plugin install failed", "桌面插件安装失败", "デスクトッププラグインのインストールに失敗しました"],
    };
    text[index]
}
