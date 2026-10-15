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

/// Translate a known rdsh diagnostic or state value; external text is preserved.
pub fn diagnostic(locale: Locale, text: &str) -> &str {
    let pair = match text {
        "unexpected or missing fields" => ("字段多余或缺失", "余分なフィールドがあるか、必要なフィールドがありません"),
        "invalid identifier" => ("标识无效", "識別子が無効です"),
        "invalid source text" => ("来源文本无效", "参照元のテキストが無効です"),
        "UTC timestamp required" => ("需要 UTC 时间戳", "UTCのタイムスタンプが必要です"),
        "invalid UTC timestamp" => ("UTC 时间戳无效", "UTCのタイムスタンプが無効です"),
        "amount must be a nonnegative decimal string with at most 9 fractional digits" => ("amount 必须为非负十进制字符串，且小数位不超过 9 位", "amountは小数点以下9桁以内の非負の10進文字列で指定してください"),
        "scope belongs to another project" => ("scope 属于其他项目", "scopeは別のプロジェクトに属しています"),
        "period must have a positive duration" => ("统计周期的时长必须大于零", "期間の長さは正の値である必要があります"),
        "membership_complete must be explicit" => ("必须明确指定 membership_complete", "membership_completeを明示してください"),
        "declare 1 to 100 expected targets" => ("请声明 1 到 100 个预期目标", "予定する対象を1～100件宣言してください"),
        "duplicate target identity" => ("目标标识重复", "対象の識別情報が重複しています"),
        "unknown source kind" => ("未知的来源类型", "不明な参照元の種類です"),
        "unknown scope" => ("未知的 scope", "不明なscopeです"),
        "unknown target; only an unallocated invoice may use null" => ("目标未知；只有未分配的账单可以使用 null", "不明な対象です。nullは未割り当ての請求書にのみ使用できます"),
        "invalid report mode" => ("报告模式无效", "レポートのモードが無効です"),
        "positive stable sequence required" => ("需要稳定的正序列号", "固定の正のシーケンス番号が必要です"),
        "currency must be an explicit three-letter code" => ("currency 必须明确指定为三字母代码", "currencyは3文字の通貨コードで明示してください"),
        "certainty must match the amount and source" => ("certainty 必须与金额及来源一致", "certaintyは金額と参照元に一致する必要があります"),
        "invalid reported token counter" => ("报告的令牌计数无效", "報告されたトークン数が無効です"),
        "cached input exceeds input" => ("缓存输入量超过总输入量", "キャッシュ済み入力数が入力数を超えています"),
        "observation precedes its period" => ("观测时间早于统计周期", "観測時刻が対象期間より前です"),
        "do not mix event/cumulative modes or currencies in one source stream" => ("同一来源流中不能混用 event/cumulative 模式或币种", "同じ参照元のストリームでevent/cumulativeモードや通貨を混在させないでください"),
        "sequence already refers to a different observation" => ("该序列号已对应其他观测", "シーケンス番号はすでに別の観測を参照しています"),
        "cumulative observation time moved backwards" => ("累计观测时间倒退", "累積観測の時刻が逆行しています"),
        "cumulative counter decreased; declare a new period for a meter reset" => ("累计计数下降；计量器重置时请声明新周期", "累積値が減少しています。計器をリセットした場合は新しい期間を宣言してください"),
        "invalid ledger identity" => ("台账标识无效", "台帳の識別情報が無効です"),
        "scope identity is immutable" => ("scope 标识不可更改", "scopeの識別情報は変更できません"),
        "scope retention limit reached" => ("已达到 scope 保留数量上限", "scopeの保存件数が上限に達しました"),
        "declare the exact scope before reporting" => ("报告前请声明准确的 scope", "報告する前に正確なscopeを宣言してください"),
        "event ID already refers to different data" => ("事件 ID 已对应其他数据", "イベントIDはすでに別のデータを参照しています"),
        "report retention limit reached" => ("已达到报告保留数量上限", "レポートの保存件数が上限に達しました"),
        "retention limit exceeded" => ("超过保留数量上限", "保存件数の上限を超えています"),
        "invalid stored scope" => ("已存储的 scope 无效", "保存済みのscopeが無効です"),
        "stored report scope missing" => ("已存储报告缺少对应的 scope", "保存済みレポートのscopeがありません"),
        "invalid stored report" => ("已存储的报告无效", "保存済みのレポートが無効です"),
        "serialize cost ledger" => ("序列化费用台账", "費用台帳をシリアライズ"),

        "Milestone contract must match the task milestone" => ("里程碑约定必须与任务里程碑匹配", "マイルストーンの条件はタスクのマイルストーンと一致する必要があります"),
        "Milestone criteria are fixed; declare changed criteria with a new milestone ID" => ("里程碑标准已固定；更改标准请使用新的里程碑 ID", "マイルストーンの基準は固定です。変更する基準は新しいマイルストーンIDで宣言してください"),

        "Outcome task limit reached" => ("已达到结果任务数量上限", "結果タスクの件数が上限に達しました"),
        "Milestone limit reached" => ("已达到里程碑数量上限", "マイルストーンの件数が上限に達しました"),
        "Invalid outcome task" => ("结果任务无效", "結果タスクが無効です"),
        "Duplicate milestone" => ("里程碑重复", "マイルストーンが重複しています"),

        "Invalid outcome report fields" => ("结果报告字段无效", "結果レポートのフィールドが無効です"),
        "Invalid milestone contract" => ("里程碑约定无效", "マイルストーンの条件が無効です"),
        "Invalid milestone criteria" => ("里程碑标准无效", "マイルストーンの基準が無効です"),
        "Invalid milestone criterion" => ("里程碑标准项无效", "マイルストーンの基準項目が無効です"),
        "Duplicate milestone criterion" => ("里程碑标准项重复", "マイルストーンの基準項目が重複しています"),
        "Invalid task outcomes" => ("任务结果无效", "タスク結果が無効です"),
        "serialize task outcomes result" => ("序列化任务结果", "タスク結果をシリアライズ"),
        "serialize subagent plan" => ("序列化子代理计划", "サブエージェント計画をシリアライズ"),
        "credential sharing is locked; retry after other rdsh auth/setup writers finish; after a crash, verify no writer is active before removing .rdsh-auth-sharing.lock" => ("凭据共享已锁定；请等待其他 rdsh auth/setup 写入完成后重试；崩溃后请先确认没有活动写入，再移除 .rdsh-auth-sharing.lock", "認証情報の共有がロックされています。他のrdsh auth/setupの書き込み終了後に再試行してください。異常終了後は書き込み中の処理がないことを確認してから .rdsh-auth-sharing.lock を削除してください"),
        "a double-quoted scalar continues on the next line" => ("双引号标量延续到下一行", "二重引用符の値が次の行まで続いています"),
        "a double-quoted scalar is not closed cleanly" => ("双引号标量未正确结束", "二重引用符の値が正しく閉じられていません"),
        "a single-quoted scalar is not closed cleanly" => ("单引号标量未正确结束", "単一引用符の値が正しく閉じられていません"),
        "a patch entry does not start with `- key:` on one line" => ("补丁条目未在同一行以 `- key:` 开头", "パッチのエントリが1行の `- key:` で始まっていません"),
        "a patch entry is written in flow style or without a first key" => ("补丁条目采用流式格式或缺少首个键", "パッチのエントリがフロー形式か、最初のキーがありません"),
        "the llm-pi-ai entry starts with its config key" => ("llm-pi-ai 条目以 config 键开头", "llm-pi-aiエントリがconfigキーで始まっています"),
        "llm-pi-ai is declared by more than one patch entry" => ("多个补丁条目声明了 llm-pi-ai", "複数のパッチエントリがllm-pi-aiを宣言しています"),
        "a quoted scalar continues on the next line" => ("带引号的标量延续到下一行", "引用符付きの値が次の行まで続いています"),
        "the file uses YAML anchors, aliases or tags" => ("文件使用了 YAML 锚点、别名或标签", "ファイルにYAMLのアンカー・エイリアス・タグが使われています"),
        "the file uses a flow mapping" => ("文件使用了流式映射", "ファイルにフロー形式のマッピングが使われています"),
        "the file uses a flow sequence that may hold keys" => ("文件使用了可能包含键的流式序列", "ファイルにキーを含む可能性のあるフロー形式の配列が使われています"),
        "llm-pi-ai is also mentioned elsewhere in the file (a nested or second definition)" => ("文件其他位置也出现 llm-pi-ai（嵌套或重复定义）", "ファイルの別の場所にもllm-pi-aiがあります（入れ子または重複定義）"),
        "the llm-pi-ai entry is not found after the edit" => ("编辑后找不到 llm-pi-ai 条目", "編集後にllm-pi-aiエントリが見つかりません"),
        "the providers block is not found after the edit" => ("编辑后找不到 providers 区块", "編集後にprovidersブロックが見つかりません"),
        "the written route is not found exactly once on read-back" => ("重新读取时路由不是恰好出现一次", "再読み取り時の経路が1件ではありません"),
        "the written route differs from the requested one on read-back" => ("重新读取的路由与请求内容不同", "再読み取りした経路が要求内容と異なります"),
        "the written route is not at the providers child column" => ("写入的路由未对齐 providers 子级列", "書き込んだ経路がprovidersの子要素の列にありません"),
        "an unexpected key sits at the route's column" => ("路由所在列出现了意外的键", "経路の列に予期しないキーがあります"),
        "the written route has no models key" => ("写入的路由缺少 models 键", "書き込んだ経路にmodelsキーがありません"),
        "model items are at different columns" => ("模型条目位于不同列", "モデルのエントリが異なる列にあります"),
        "a model key is not aligned with its `- id`" => ("模型键未与其 `- id` 对齐", "モデルのキーが対応する `- id` と同じ列にありません"),
        "the written models do not match the requested count" => ("写入的模型数量与请求不符", "書き込んだモデルの件数が要求と異なります"),
        "the file is not a plain sequence of patch entries" => ("文件不是普通的补丁条目序列", "ファイルが通常のパッチエントリ配列ではありません"),
        "could not read the API key from stdin" => ("无法从标准输入读取 API 密钥", "標準入力からAPIキーを読み取れません"),
        "--key-stdin: no key on stdin" => ("--key-stdin：标准输入中没有密钥", "--key-stdin: 標準入力にキーがありません"),
        "--key-stdin: the key is empty, oversized or contains whitespace" => ("--key-stdin：密钥为空、过大或包含空白", "--key-stdin: キーが空・大きすぎる・空白を含む、のいずれかです"),
        "the temporary file does not hold what was written" => ("临时文件内容与写入内容不同", "一時ファイルの内容が書き込んだ内容と異なります"),
        "base URL is empty" => ("基础 URL 为空", "ベースURLが空です"),
        "base URL contains whitespace or a control character" => ("基础 URL 包含空白或控制字符", "ベースURLに空白または制御文字が含まれています"),
        "base URL must start with http:// or https://" => ("基础 URL 必须以 http:// 或 https:// 开头", "ベースURLは http:// または https:// で始めてください"),
        "base URL must not carry a query or fragment" => ("基础 URL 不能包含查询或片段", "ベースURLにクエリやフラグメントは指定できません"),
        "base URL must not contain credentials (user:pass@); use --key-stdin or {ID}_API_KEY" => ("基础 URL 不能包含凭据（user:pass@）；请使用 --key-stdin 或 {ID}_API_KEY", "ベースURLに認証情報（user:pass@）は指定できません。--key-stdin または {ID}_API_KEY を使用してください"),
        "invalid IPv6 host in base URL" => ("基础 URL 中的 IPv6 主机无效", "ベースURLのIPv6ホストが無効です"),
        "invalid host in base URL" => ("基础 URL 中的主机无效", "ベースURLのホストが無効です"),
        "invalid port in base URL" => ("基础 URL 中的端口无效", "ベースURLのポートが無効です"),
        "base URL path contains an unsupported character" => ("基础 URL 路径包含不支持的字符", "ベースURLのパスに未対応の文字が含まれています"),
        "--key-stdin is empty" => ("--key-stdin 为空", "--key-stdin が空です"),
        "could not run curl; install it, or pass --model instead of --discover" => ("无法运行 curl；请安装 curl，或改用 --model 而不是 --discover", "curlを実行できません。インストールするか、--discover の代わりに --model を指定してください"),
        "could not send the request to curl" => ("无法向 curl 发送请求", "curlへ要求を送信できません"),
        "could not read curl's output" => ("无法读取 curl 输出", "curlの出力を読み取れません"),
        "could not wait for curl" => ("无法等待 curl", "curlの終了を待機できません"),
        "cannot read API key from stdin" => ("无法从标准输入读取 API 密钥", "標準入力からAPIキーを読み取れません"),
        "the API key contains whitespace or a control character" => ("API 密钥包含空白或控制字符", "APIキーに空白または制御文字が含まれています"),
        "the model listing is not JSON" => ("模型清单不是 JSON", "モデル一覧がJSONではありません"),
        "the model listing has neither data[] nor models[]" => ("模型清单中没有 data[] 或 models[]", "モデル一覧にdata[]もmodels[]もありません"),
        "opencode baseURL" => ("OpenCode 基础 URL", "OpenCodeのベースURL"),
        "the llm-pi-ai config is written inline on one line" => ("llm-pi-ai 配置采用单行内联形式", "llm-pi-ai設定が1行のインライン形式です"),
        "providers is written inline (for example `providers: {}`)" => ("providers 采用内联形式（例如 `providers: {}`）", "providersがインライン形式です（例: `providers: {}`）"),
        "credential ok" => ("凭据已存在", "認証情報あり"),
        "credential importable: run `rdsh auth --import --provider <id>`" => ("凭据可导入：运行 `rdsh auth --import --provider <id>`", "認証情報をインポート可能: `rdsh auth --import --provider <id>` を実行"),
        "credential missing: run `rdsh setup`" => ("缺少凭据：运行 `rdsh setup`", "認証情報なし: `rdsh setup` を実行"),
        "opencode login skipped: invalid provider id" => ("已跳过 OpenCode 登录：提供方标识无效", "OpenCodeのログインをスキップ: プロバイダーIDが無効です"),

        "is not executable" => ("不可执行", "実行できません"), "does not exist" => ("不存在", "存在しません"),
        "invalid --max" => ("无效的 --max", "--max が無効です"),
        "invalid --queue-timeout" => ("无效的 --queue-timeout", "--queue-timeout が無効です"),
        "invalid --max-body-bytes" => ("无效的 --max-body-bytes", "--max-body-bytes が無効です"),
        "invalid --rpm" => ("无效的 --rpm", "--rpm が無効です"),
        "invalid --tool-choice-default (none, auto or required)" => ("--tool-choice-default 无效（none、auto 或 required）", "--tool-choice-default が無効です（none・auto・required）"),
        "invalid --upstream" => ("无效的 --upstream", "--upstream が無効です"),
        "--upstream must be http(s)" => ("--upstream 必须使用 http(s)", "--upstream は http(s) が必要です"),
        "refusing non-loopback --host without --allow-remote" => ("未设置 --allow-remote，拒绝非环回 --host", "--allow-remote がないためループバック以外の --host を拒否しました"),
        "invalid --host or host name did not resolve" => ("--host 无效或无法解析主机名", "--host が無効か、ホスト名を解決できません"),
        "Input JSON must be a regular file of at most 256 KiB" => ("输入 JSON 必须是最多 256 KiB 的常规文件", "入力JSONは256 KiB以下の通常ファイルである必要があります"),
        "Input JSON exceeds 256 KiB" => ("输入 JSON 超过 256 KiB", "入力JSONが256 KiBを超えています"),
        "Input JSON is invalid" => ("输入 JSON 无效", "入力JSONが無効です"),
        "Input JSON operation does not match the requested action" => ("输入 JSON 的 operation 与请求的操作不匹配", "入力JSONのoperationが要求した操作と一致しません"),
        "yes" => ("是", "はい"), "no" => ("否", "いいえ"),
        "present" => ("已存在", "設定済み"), "missing" => ("缺失", "未設定"),
        "active" => ("运行中", "実行中"), "inactive" => ("未运行", "停止中"),
        "enabled" => ("已启用", "有効"), "disabled" => ("已禁用", "無効"),
        "unknown" => ("未知", "不明"), "not-installed" => ("未安装", "未インストール"),
        "(not found; set RDSH_SYNC_SCRIPT)" => ("（未找到；请设置 RDSH_SYNC_SCRIPT）", "（見つかりません。RDSH_SYNC_SCRIPT を設定してください）"),
        "credential sharing policy is unreadable; imports are disabled" => ("无法读取凭据共享策略；已禁用导入", "認証情報の共有ポリシーを読み取れません。インポートは無効です"),
        "credential sharing policy is oversized; imports are disabled" => ("凭据共享策略过大；已禁用导入", "認証情報の共有ポリシーが大きすぎます。インポートは無効です"),
        "invalid credential sharing policy; imports are disabled" => ("凭据共享策略无效；已禁用导入", "認証情報の共有ポリシーが無効です。インポートは無効です"),
        "unsupported credential sharing policy; imports are disabled" => ("凭据共享策略不受支持；已禁用导入", "認証情報の共有ポリシーは未対応です。インポートは無効です"),
        "invalid credential sharing selection; imports are disabled" => ("凭据共享选择无效；已禁用导入", "認証情報の共有選択が無効です。インポートは無効です"),
        "credential sharing selection is oversized; imports are disabled" => ("凭据共享选择过多；已禁用导入", "認証情報の共有選択が多すぎます。インポートは無効です"),
        "invalid credential sharing selector; imports are disabled" => ("凭据共享选择器无效；已禁用导入", "認証情報の共有セレクターが無効です。インポートは無効です"),
        "duplicate credential sharing selector; imports are disabled" => ("凭据共享选择器重复；已禁用导入", "認証情報の共有セレクターが重複しています。インポートは無効です"),
        "expected a supported SOURCE:CREDENTIAL selector; run rdsh auth for the inventory" => ("需要受支持的 SOURCE:CREDENTIAL 选择器；运行 rdsh auth 查看清单", "対応する SOURCE:CREDENTIAL セレクターが必要です。rdsh auth で一覧を確認してください"),
        "cannot select and unselect the same credential in one command" => ("同一命令不能同时选择和取消选择同一凭据", "1つのコマンドで同じ認証情報の選択と選択解除はできません"),
        "too many selected credentials" => ("选择的凭据过多", "選択した認証情報が多すぎます"),
        "credential sharing policy path is not valid Unicode" => ("凭据共享策略路径不是有效的 Unicode", "認証情報の共有ポリシーのパスが有効なUnicodeではありません"),
        "credential import requires --provider <id> or --ref <name>" => ("凭据导入需要 --provider <id> 或 --ref <name>", "認証情報のインポートには --provider <id> または --ref <name> が必要です"),
        "one-time import filters cannot be combined with persistent --select/--unselect" => ("一次性导入筛选不能与持久 --select/--unselect 同时使用", "1回限りのインポート条件と継続的な --select/--unselect は併用できません"),
        "unknown credential source" => ("未知的凭据来源", "不明な認証情報ソース"),
        "no credential sharing selected; credential import requires --provider <id>, --ref <name>, or --select SOURCE:CREDENTIAL with an available source" => ("未选择凭据共享；请使用 --provider <id>、--ref <name>，或选择可用来源 --select SOURCE:CREDENTIAL", "共有する認証情報が選択されていません。--provider <id>、--ref <name>、または利用可能なソースの --select SOURCE:CREDENTIAL が必要です"),
        "conflicting selected sources provide different values for the same credential ref; no credentials were copied" => ("所选来源为同一凭据引用提供了不同值；未复制任何凭据", "選択したソースが同じ認証情報参照に異なる値を提供しています。認証情報はコピーされていません"),
        "credential store is unreadable; no credentials were copied" => ("无法读取凭据存储；未复制任何凭据", "認証情報ストアを読み取れません。認証情報はコピーされていません"),
        "sharing has not been selected" => ("尚未选择共享", "共有が選択されていません"),
        "Imported entries are available to every DSH profile using this DSH_HOME" => ("导入的条目适用于使用此 DSH_HOME 的所有 DSH 配置文件", "インポートしたエントリは、このDSH_HOMEを使う全DSHプロファイルで利用できます"),
        "rdsh auth --unselect SOURCE:CREDENTIAL prevents all future rdsh imports of that selection" => ("rdsh auth --unselect SOURCE:CREDENTIAL 会停止今后对此选择的所有 rdsh 导入", "rdsh auth --unselect SOURCE:CREDENTIAL は、その選択の今後のrdshインポートをすべて停止します"),
        "Unselect retains existing DSH copies. Stop DSH, then remove the named record/ref from the credential store to stop using the copy" => ("取消选择会保留现有 DSH 副本。要停止使用副本，请停止 DSH 并从凭据存储中删除对应 record/ref", "選択解除後も既存のDSHコピーは残ります。コピーの利用を止めるにはDSHを停止し、認証情報ストアから該当record/refを削除してください"),
        "Unselect does not revoke provider credentials. Revoke the OAuth grant or rotate the API key at its provider; source CLI logins may also stop working" => ("取消选择不会撤销提供方凭据。请在提供方撤销 OAuth 授权或轮换 API 密钥；来源 CLI 登录也可能失效", "選択解除は発行元の認証情報を失効させません。発行元でOAuth認可の取消やAPIキーの更新を行ってください。ソースCLIのログインも使えなくなる場合があります"),
        "invalid sharing policy; imports disabled; authentication not verified" => ("共享策略无效；导入已禁用；身份验证尚未确认", "共有ポリシーが無効です。インポートは無効です。認証の成功は未確認です"),
        "no external logins found (codex/opencode)" => ("未找到外部登录（codex/opencode）", "外部ログインが見つかりません（codex/opencode）"),
        "stored" => ("已保存", "保存済み"),
        "source-changed" => ("来源已更改", "ソース変更済み"),
        "pending-import" => ("等待导入", "インポート待ち"),
        "not-selected" => ("未选择", "未選択"),
        "not_selected" => ("未选择", "未選択"),
        "import" => ("导入", "インポート"),
        "refresh" => ("更新", "更新"),
        "ok" => ("已识别", "認識済み"),
        "api_key" => ("API 密钥", "APIキー"),
        _ => return text,
    };
    match locale {
        Locale::English => text,
        Locale::Chinese => pair.0,
        Locale::Japanese => pair.1,
    }
}
