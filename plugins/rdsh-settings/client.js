window.__ModuleLoader__.load({
  id: "rdsh-settings",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useCallback = React.useCallback;
    // 単一設定源: rdsh.json のみ。旧 rdsh-context.json はサーバ側の
    // 読み替え専用で、UIからは触らない。
    const GET_ALL = "/api/rdsh-settings";
    const SAVE_ALL = "/api/rdsh-settings/save";
    const card = {
      border: "0.5px solid var(--dsw-alias-settings-card-stroke)",
      background: "var(--dsw-alias-settings-card-fill)",
      borderRadius: "12px",
      padding: "12px 14px",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      color: "var(--dsw-alias-label-primary)",
    };
    const title = {
      margin: "0",
      fontSize: "16px",
      fontWeight: 500,
      color: "var(--dsw-alias-label-primary)",
    };
    const desc = {
      margin: "0",
      fontSize: "13px",
      color: "var(--dsw-alias-label-tertiary)",
    };
    const label = {
      fontSize: "12px",
      fontWeight: 600,
      color: "var(--dsw-alias-label-secondary)",
    };
    const input = {
      font: "inherit",
      fontSize: "13px",
      padding: "6px 8px",
      borderRadius: "8px",
      width: "100%",
      boxSizing: "border-box",
    };
    const row = {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      fontSize: "13px",
      color: "var(--dsw-alias-label-primary)",
    };
    const warn = {
      margin: "0",
      fontSize: "12px",
      color: "var(--dsw-alias-label-warning, #b7791f)",
    };
    const cssText =
      ".rdsh-settings input,.rdsh-settings textarea,.rdsh-settings select{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l3);outline:none}.rdsh-settings input:focus,.rdsh-settings textarea:focus,.rdsh-settings select:focus{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));border-color:transparent}.rdsh-settings input::placeholder,.rdsh-settings textarea::placeholder{color:var(--dsw-alias-label-dimmed)}.rdsh-settings input[type=checkbox]{accent-color:var(--dsw-alias-button-primary-fill);width:15px;height:15px;background:none;border:none;padding:0}.rdsh-settings button{font:inherit}.rdsh-btn-pri{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:none}.rdsh-btn-pri:hover{background:var(--dsw-alias-button-primary-hover)}.rdsh-btn-pri:disabled{opacity:.4;cursor:default}.rdsh-btn-sec{background:transparent;color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l3)}.rdsh-btn-sec:hover{background:var(--dsw-alias-interactive-bg-hover)}.rdsh-btn-sec:disabled{opacity:.4;cursor:default}.rdsh-msg{font-size:12px;color:var(--dsw-alias-label-secondary)}";
    const grid2 = {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "10px",
    };
    const discordDesc = {
      ...desc,
      color: "var(--dsw-alias-label-secondary)",
      lineHeight: 1.6,
    };
    const defaultDiscordId = "1557873849280888903";
    const defaultDiscordImage =
      "https://cdn.discordapp.com/app-icons/1557873849280888903/3abd404070c831dcaa59310cc29982df.png?size=256";
    const settingsCopy = {
      invalidSettings: [
        "設定ファイルを読み込めません。元の設定を確認してから再読み込みしてください。",
        "Cannot read the settings file. Check the original settings, then reload.",
        "无法读取设置文件。请检查原始设置后重新加载。",
      ],
      loadFailed: [
        "読み込みに失敗しました。接続と権限を確認してから再読み込みしてください。",
        "Loading failed. Check your connection and permissions, then reload.",
        "加载失败。请检查连接和权限后重新加载。",
      ],
      savedDiscord: [
        "保存しました。Discordへの反映を待っています。",
        "Saved. Waiting for Discord to update.",
        "已保存。正在等待 Discord 更新。",
      ],
      savedAll: [
        "保存しました (rdsh.json)",
        "Saved (rdsh.json)",
        "已保存（rdsh.json）",
      ],
      saveFailed: [
        "保存できませんでした。接続を確認して、もう一度保存してください。",
        "Could not save. Check your connection and try again.",
        "无法保存。请检查连接后重试。",
      ],
      defaultDetails: ["dshで作業中", "Working in dsh", "正在使用 dsh 工作"],
      idle: ["待機中", "Idle", "待机中"],
      customApp: [
        "独自のアプリ名",
        "Custom application name",
        "自定义应用名称",
      ],
      connectionDisabled: ["接続状態: OFF", "Connection: OFF", "连接：关闭"],
      checkApplication: [
        "Application IDを確認してください",
        "Check the Application ID",
        "请检查应用 ID",
      ],
      connecting: [
        "Discordに接続中…",
        "Connecting to Discord…",
        "正在连接 Discord…",
      ],
      connected: [
        "Discordに接続済み",
        "Connected to Discord",
        "已连接 Discord",
      ],
      disconnected: [
        "Discordに接続できません",
        "Cannot connect to Discord",
        "无法连接 Discord",
      ],
      invalidFile: [
        "設定ファイルを読み込めません",
        "Cannot read the settings file",
        "无法读取设置文件",
      ],
      checkingConnection: [
        "接続状態を確認中…",
        "Checking connection…",
        "正在检查连接…",
      ],
      unreflected: [
        "変更はまだ反映されていません",
        "Changes have not been applied yet",
        "更改尚未生效",
      ],
      savedOff: [
        "保存済み。表示はOFFです。",
        "Saved. Presence is OFF.",
        "已保存。状态显示已关闭。",
      ],
      reflected: [
        "Discordに反映しました",
        "Applied to Discord",
        "已在 Discord 生效",
      ],
      saved: ["保存済み", "Saved", "已保存"],
      unknownVersion: [
        "rdsh バージョン不明",
        "rdsh version unknown",
        "rdsh 版本未知",
      ],
      version: ["バージョン", "Version", "版本"],
      discordTitle: [
        "Discordの作業状態",
        "Discord Rich Presence",
        "Discord 丰富状态",
      ],
      unsaved: ["未保存", "Unsaved", "未保存"],
      presenceOn: ["表示 ON", "Presence ON", "状态显示开启"],
      presenceOff: ["表示 OFF", "Presence OFF", "状态显示关闭"],
      discordIntro: [
        "Discordで、dshの作業状態を共有します。変更は保存すると反映されます。",
        "Share your dsh activity on Discord. Save changes to apply them.",
        "在 Discord 分享 dsh 工作状态。保存后更改生效。",
      ],
      enableDiscord: [
        "Discordに作業状態を表示する",
        "Show work activity on Discord",
        "在 Discord 显示工作状态",
      ],
      details: ["表示文", "Display text", "显示文本"],
      truncated: [
        "Discordの文字数制限に合わせ、プレビューの長さで送信します。",
        "The preview is shortened to fit Discord’s text limit and sent at that length.",
        "预览已按 Discord 文本长度限制截短，将按此长度发送。",
      ],
      showAgents: [
        "agentの稼働状態・稼働数を表示する",
        "Show agent activity and running count",
        "显示代理运行状态和数量",
      ],
      showElapsed: ["経過時間を表示する", "Show elapsed time", "显示已用时间"],
      discordPreview: [
        "Discord表示プレビュー",
        "Discord presence preview",
        "Discord 状态预览",
      ],
      preview: ["表示プレビュー", "Presence preview", "状态预览"],
      unsavedSuffix: ["（未保存）", " (unsaved)", "（未保存）"],
      members: ["メンバー一覧: ", "Member list: ", "成员列表："],
      previewNote: [
        "現在のagent数を使った表示例です。Discord側の見た目は環境によって異なります。",
        "Example using the current agent count. Discord’s appearance varies by environment.",
        "此示例使用当前代理数量。Discord 中的外观因环境而异。",
      ],
      offNote: [
        "OFFのため公開されません。ONにして保存すると、この内容を表示します。",
        "Presence is OFF and will not be published. Turn it ON and save to show this activity.",
        "状态显示已关闭，不会公开。开启并保存后将显示此内容。",
      ],
      imageNote: [
        "画像はDiscord上で確認できます。",
        "View the image in Discord.",
        "可在 Discord 查看图片。",
      ],
      advanced: [
        "詳細設定（一覧の表示・画像・リンク）",
        "Advanced settings (member list, image and link)",
        "高级设置（成员列表、图片和链接）",
      ],
      memberDisplay: [
        "メンバー一覧に表示する内容",
        "Content shown in the member list",
        "成员列表中显示的内容",
      ],
      agentState: ["agentの状態", "Agent status", "代理状态"],
      appName: ["アプリ名", "Application name", "应用名称"],
      stateFallback: [
        "agentの表示がOFFの間は、一覧に表示文を使います。",
        "The member list uses the display text while agent status is OFF.",
        "代理状态显示关闭时，成员列表将使用显示文本。",
      ],
      showImage: [
        "アプリの画像を表示する",
        "Show application image",
        "显示应用图片",
      ],
      imageAsset: [
        "画像キー / 画像URL",
        "Image key / image URL",
        "图片键 / 图片 URL",
      ],
      imagePlaceholder: [
        "例: dsh_logo または https://…/logo.png",
        "Example: dsh_logo or https://…/logo.png",
        "例如：dsh_logo 或 https://…/logo.png",
      ],
      imageHelp: [
        "Art Assetsの画像キー、または公開画像のURLを使います。空欄では共通アプリのアイコンを表示します。独自アプリなら画像なし。",
        "Use an Art Assets image key or a public image URL. A blank value shows the shared application icon; custom applications have no image.",
        "使用 Art Assets 图片键或公开图片 URL。留空时显示共享应用图标；自定义应用不显示图片。",
      ],
      imageInvalid: [
        "画像キーは半角英小文字・数字・_・-、画像URLはhttp / httpsを使ってください。",
        "Use lowercase ASCII letters, digits, _ or - for image keys, or an http / https image URL.",
        "图片键请使用小写英文字母、数字、_ 或 -；图片 URL 请使用 http / https。",
      ],
      imageTooltip: [
        "画像にカーソルを合わせたときの説明",
        "Image hover text",
        "图片悬停说明",
      ],
      buttonName: ["リンクボタンの名前", "Link button label", "链接按钮名称"],
      buttonPlaceholder: [
        "例: dshについて",
        "Example: About dsh",
        "例如：关于 dsh",
      ],
      link: ["リンク先", "Link URL", "链接地址"],
      buttonInvalid: [
        "名前とhttp / httpsのURLを両方入力するか、両方を空欄にしてください。",
        "Enter both a label and an http / https URL, or leave both blank.",
        "请同时填写名称和 http / https URL，或将两者留空。",
      ],
      buttonNote: [
        "リンクボタンは他の人に表示されます。自分のプロフィールには表示されません。",
        "Link buttons are visible to others, but not on your own profile.",
        "链接按钮对其他人可见，不会显示在自己的个人资料中。",
      ],
      customDiscord: [
        "独自のDiscordアプリを使う",
        "Use a custom Discord application",
        "使用自定义 Discord 应用",
      ],
      customHelp: [
        "通常は変更不要です。共通アプリ（rdsh）を使います。アプリ名はDeveloper PortalのGeneral Informationで設定します。",
        "Usually no change is needed; the shared rdsh application is used. Set a custom application name in Developer Portal’s General Information.",
        "通常无需更改，默认使用共享 rdsh 应用。自定义应用名称可在 Developer Portal 的 General Information 中设置。",
      ],
      applicationId: ["アプリケーションID", "Application ID", "应用 ID"],
      applicationPlaceholder: [
        "Discord アプリケーションID",
        "Discord Application ID",
        "Discord 应用 ID",
      ],
      applicationInvalid: [
        "Application IDは17〜20桁の数字です。空欄で共通アプリに戻せます。",
        "The Application ID must contain 17–20 digits. Leave it blank to use the shared application.",
        "应用 ID 必须为 17–20 位数字。留空可恢复共享应用。",
      ],
      customNote: [
        "空欄で保存すると共通アプリに戻ります。Bot tokenやClient secretは不要です。",
        "Save a blank value to return to the shared application. No bot token or client secret is needed.",
        "留空保存可恢复共享应用。无需机器人令牌或客户端密钥。",
      ],
      saveDiscord: [
        "Discord設定を保存",
        "Save Discord settings",
        "保存 Discord 设置",
      ],
      openDiscord: [
        "Discordデスクトップアプリを起動してください。WSLからWindows側にも接続します。5秒ごとに自動再接続します。",
        "Open the Discord desktop application. WSL can also connect to Windows. Reconnection is attempted every 5 seconds.",
        "请启动 Discord 桌面应用。WSL 也可连接 Windows。每 5 秒自动尝试重新连接。",
      ],
      discordPrivacy: [
        "表示が見えない場合は、Discordの「アクティビティのプライバシー」で共有設定を確認してください。",
        "If your presence is not visible, check sharing in Discord’s Activity Privacy settings.",
        "若看不到状态，请检查 Discord 的活动隐私共享设置。",
      ],
      privacy: [
        "プロンプト、ファイル名、プロジェクトのパスは送信しません。",
        "Prompts, file names and project paths are not sent.",
        "不会发送提示词、文件名和项目路径。",
      ],
      contextTitle: [
        "rdsh context engine（実験的、既定OFF）",
        "rdsh context engine (experimental, OFF by default)",
        "rdsh 上下文引擎（实验性，默认关闭）",
      ],
      contextHelp: [
        "毎ターン必要な文脈だけ再構成します。全文履歴は渡しません。使うときだけONにします。設定は rdsh.json に保存され、`rdsh context` コマンドと共有されます。",
        "Rebuild only the context needed each turn, without passing the full history. Enable it when needed. Settings are saved in rdsh.json and shared with the `rdsh context` command.",
        "每轮仅重建所需上下文，不传递完整历史。仅在需要时开启。设置保存在 rdsh.json，并与 `rdsh context` 命令共享。",
      ],
      enableContext: [
        "context engine を有効化する",
        "Enable the context engine",
        "启用上下文引擎",
      ],
      legacy: [
        "旧 rdsh-context.json があります。削除する前に、この画面で設定を保存し、rdsh.json に文脈が保存されたことを確認してください。",
        "A legacy rdsh-context.json exists. Before deleting it, save these settings and verify that rdsh.json contains the context.",
        "检测到旧 rdsh-context.json。删除前请在此保存设置，并确认上下文已保存到 rdsh.json。",
      ],
      workingMemory: ["作業記憶", "Working Memory", "工作记忆"],
      workingHelp: [
        "今のゴールと作業中だけを保持します。",
        "Keep only the current goal and work in progress.",
        "仅保留当前目标和正在进行的工作。",
      ],
      tokenBudget: ["トークン予算", "Token budget", "令牌预算"],
      retriever: ["Retriever（検索）", "Retriever (search)", "检索器（搜索）"],
      packer: ["Packer（圧縮）", "Packer (compression)", "打包器（压缩）"],
      verifier: [
        "Verifier（確認）",
        "Verifier (verification)",
        "验证器（确认）",
      ],
      gitDiff: ["git差分を含める", "Include Git diff", "包含 Git 差异"],
      codeLimit: ["コード取得上限", "Code retrieval limit", "代码检索上限"],
      historyLimit: [
        "旧履歴参照数（自動取り込みは無効）",
        "Previous history count (automatic import disabled)",
        "旧历史引用数（自动导入已禁用）",
      ],
      goal: ["ゴール", "Goal", "目标"],
      goalPlaceholder: [
        "例: dsh互換性を維持する",
        "Example: Preserve dsh compatibility",
        "例如：保持 dsh 兼容性",
      ],
      workingFiles: [
        "作業中ファイル (1行1件)",
        "Working files (one per line)",
        "工作文件（每行一项）",
      ],
      openTasks: [
        "未解決タスク (1行1件)",
        "Open tasks (one per line)",
        "未完成任务（每行一项）",
      ],
      longMemory: ["長期記憶", "Long-term Memory", "长期记忆"],
      longHelp: [
        "全文ではなく決定・制約だけ残します。",
        "Keep decisions and constraints instead of the full text.",
        "仅保留决策和约束，不保留全文。",
      ],
      decisions: [
        "決定事項 (1行1件)",
        "Decisions (one per line)",
        "决策（每行一项）",
      ],
      constraints: [
        "制約 (1行1件)",
        "Constraints (one per line)",
        "约束（每行一项）",
      ],
      allSettings: [
        "全体設定 (rdsh.json)",
        "Global settings (rdsh.json)",
        "全局设置（rdsh.json）",
      ],
      allHelp: [
        "rdsh 全体の動作を切り替えます。context engine 以外もここで変えられます。",
        "Change global rdsh behavior, including settings beyond the context engine.",
        "更改 rdsh 全局行为，包括上下文引擎之外的设置。",
      ],
      slim: ["スリム出力", "Slim output", "精简输出"],
      passthrough: ["パススルー", "Passthrough", "直通"],
      dryRun: ["ドライラン", "Dry run", "试运行"],
      tokens: ["トークン (tokens)", "Tokens", "令牌"],
      defaultBudget: ["既定予算", "Default budget", "默认预算"],
      search: ["検索 (search)", "Search", "搜索"],
      directory: ["対象ディレクトリ", "Target directory", "目标目录"],
      maxResults: ["最大件数", "Maximum results", "最大结果数"],
      webLimit: ["Web上限", "Web result limit", "网页结果上限"],
      searxng: ["SearxNG URL", "SearxNG URL", "SearxNG URL"],
      unset: ["未設定", "Not configured", "未配置"],
      compact: ["圧縮 (compact)", "Compaction", "压缩"],
      maxTokens: ["上限トークン", "Maximum tokens", "最大令牌数"],
      sessions: ["セッション (sessions)", "Sessions", "会话"],
      retention: ["保持数", "Retention count", "保留数量"],
      withTokens: ["トークン付き", "Include tokens", "包含令牌"],
      logs: ["ログ (logs)", "Logs", "日志"],
      tail: ["末尾行数", "Tail lines", "末尾行数"],
      server: ["サーバ (serve)", "Server", "服务器"],
      port: ["ポート", "Port", "端口"],
      guard: ["ガード (guard)", "Guard", "防护"],
      denyPaths: [
        "拒否パス (1行1件)",
        "Denied paths (one per line)",
        "拒绝的路径（每行一项）",
      ],
      reason: ["理由", "Reason", "原因"],
      benchmark: ["ベンチ (bench)", "Benchmark", "基准测试"],
      iterations: ["回数", "Iterations", "次数"],
      setup: ["セットアップ (setup)", "Setup", "设置"],
      webPort: [
        "Webポート (0=ランダム)",
        "Web port (0 = random)",
        "网页端口（0 = 随机）",
      ],
      running: [
        "agent稼働中 ({count})",
        "Agents running ({count})",
        "代理运行中（{count}）",
      ],
      elapsed: ["{time} 経過", "{time} elapsed", "已用 {time}"],
      lastUpdated: [
        " / 最終反映 {time}",
        " / Last applied {time}",
        " / 最后生效 {time}",
      ],

      language: ["表示言語", "Display language", "显示语言"],
      auto: [
        "自動（ブラウザーの言語）",
        "Automatic (browser language)",
        "自动（浏览器语言）",
      ],
      save: ["保存する", "Save", "保存"],
      saving: ["保存中…", "Saving…", "正在保存…"],
      reload: ["再読み込み", "Reload", "重新加载"],
      loading: ["読み込み中…", "Loading…", "正在加载…"],
      general: ["全般 (general)", "General", "常规"],
      defaultProfile: ["既定プロファイル", "Default profile", "默认配置文件"],
      unspecified: ["未指定", "Not set", "未设置"],
    };
    function settingsLocale(language) {
      if (language === "en" || language === "zh-CN" || language === "ja")
        return language;
      const browser = globalThis.navigator?.language || "en";
      return browser.toLowerCase().startsWith("zh")
        ? "zh-CN"
        : browser.toLowerCase().startsWith("ja")
          ? "ja"
          : "en";
    }
    function settingText(language, key, values = {}) {
      const index = { ja: 0, en: 1, "zh-CN": 2 }[settingsLocale(language)];
      return (settingsCopy[key]?.[index] ?? key).replace(
        /\{(\w+)\}/g,
        (_, name) => String(values[name] ?? `{${name}}`),
      );
    }
    // Scope the host layout adjustment to this mounted section; use semantic anchors, not generated CSS names.
    const narrowCss =
      "@media(max-width:640px){[data-shortcut-modal=settings]:has(.rdsh-settings){flex-direction:column}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav{width:100%;padding:16px 12px 0;gap:8px}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav>div:last-child{flex-direction:row;overflow-x:auto;overflow-y:hidden}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav button{flex:none}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav+div{min-height:0}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav+div>div:first-child{height:48px;padding:8px 12px}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav+div>div:last-child{padding:0 12px 16px}}";
    const discordCss =
      ".rdsh-discord{min-width:0;overflow-wrap:anywhere}.rdsh-discord fieldset{border:0;padding:0;margin:0;min-width:0;display:flex;flex-direction:column;gap:12px}.rdsh-discord label{line-height:1.6}.rdsh-discord summary{cursor:pointer;padding:8px 0;min-height:32px;box-sizing:border-box}.rdsh-discord summary:focus-visible,.rdsh-settings button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:3px}.rdsh-discord-fields{display:flex;flex-direction:column;gap:12px;padding:8px 0}.rdsh-discord-preview{margin:0;padding:12px 0;border-block:1px solid var(--dsw-alias-border-l3);display:flex;flex-direction:column;gap:6px;font-size:13px}.rdsh-discord-preview p{margin:0}.rdsh-discord-preview strong{font-size:15px}.rdsh-discord-meta{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}.rdsh-discord-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.rdsh-discord-actions button{padding:9px 12px;min-height:36px;border-radius:8px;cursor:pointer;font-size:13px}.rdsh-discord-pill{font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l3);border-radius:12px;padding:3px 9px}.rdsh-discord-link{align-self:flex-start;font-size:12px;padding:6px 12px;background:var(--dsw-alias-interactive-bg-hover);border-radius:8px}.rdsh-discord input,.rdsh-discord select{min-height:34px}.rdsh-discord input[type=checkbox]{min-height:15px;flex-shrink:0}.rdsh-discord select{width:100%}.rdsh-discord ::selection{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}";
    function wireText(value) {
      let result = "";
      for (const char of value) {
        if (new TextEncoder().encode(result + char).length > 128) break;
        result += char;
      }
      return result;
    }
    function validUrl(value) {
      try {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    }
    function toLines(v) {
      return Array.isArray(v) ? v.join("\n") : "";
    }
    function fromLines(s) {
      return String(s || "")
        .split("\n")
        .map((x) => x.trim())
        .filter((x) => x !== "");
    }
    function RdshSection() {
      const al = useState(null);
      const all = al[0];
      const setAll = al[1];
      const lg = useState(false);
      const legacy = lg[0];
      const setLegacy = lg[1];
      const ld = useState(true);
      const loading = ld[0];
      const setLoading = ld[1];
      const sv = useState(false);
      const saving = sv[0];
      const setSaving = sv[1];
      const ds = useState(null);
      const discordStatus = ds[0];
      const setDiscordStatus = ds[1];
      const sd = useState(null);
      const savedDiscord = sd[0];
      const setSavedDiscord = sd[1];
      const dm = useState("");
      const discordMsg = dm[0];
      const setDiscordMsg = dm[1];
      const ms = useState("");
      const msg = ms[0];
      const setMsg = ms[1];
      const languageState = useState("auto");
      const displayLanguage = languageState[0];
      const setDisplayLanguage = languageState[1];
      const copy = (key, values) => settingText(displayLanguage, key, values);
      const vr = useState({});
      const versions = vr[0];
      const setVersions = vr[1];
      const load = useCallback(async () => {
        setLoading(true);
        setMsg("");
        setAll(null);
        try {
          const r2 = await fetch(GET_ALL, { cache: "no-store" });
          const j2 = await r2.json();
          if (
            r2.ok &&
            j2 &&
            j2.config &&
            (!Object.hasOwn(j2.config.general || {}, "language") ||
              ["auto", "en", "zh-CN", "ja"].includes(
                j2.config.general.language,
              ))
          ) {
            setDisplayLanguage(j2.config.general?.language || "auto");
            setAll(j2.config);
            setSavedDiscord(j2.config.discord || {});
            setDiscordMsg("");
            setLegacy(!!j2.legacy_present);
            setVersions(
              j2.versions && typeof j2.versions === "object" ? j2.versions : {},
            );
          } else {
            setMsg(
              j2?.error === "invalid-settings" || j2?.config
                ? "invalidSettings"
                : "loadFailed",
            );
          }
        } catch (e) {
          setMsg("loadFailed");
        }
        setLoading(false);
      }, []);
      useEffect(() => {
        load();
      }, [load]);
      useEffect(() => {
        let active = true;
        const poll = async () => {
          try {
            const response = await fetch("/api/rdsh-discord", {
              cache: "no-store",
            });
            const value = await response.json();
            if (active)
              setDiscordStatus(response.ok && value.ok ? value : null);
          } catch {
            if (active) setDiscordStatus(null);
          }
        };
        poll();
        const timer = setInterval(poll, 5000);
        return () => {
          active = false;
          clearInterval(timer);
        };
      }, []);
      const setPath = (sec, k, v) => {
        if (sec === "general" && k === "language") setDisplayLanguage(v);
        setAll((c) => ({ ...c, [sec]: { ...(c ? c[sec] : {}), [k]: v } }));
      };
      const sec = (name) => (all && all[name]) || {};
      const saveAll = async (discordOnly = false) => {
        if (!all || saving) return;
        const showMsg = discordOnly ? setDiscordMsg : setMsg;
        setSaving(true);
        showMsg("saving");
        try {
          const r = await fetch(SAVE_ALL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              config: discordOnly ? { discord: all.discord } : all,
            }),
          });
          const j = await r.json();
          if (r.ok && j && j.ok) {
            setAll((c) =>
              discordOnly ? { ...c, discord: j.config.discord } : j.config,
            );
            setSavedDiscord(j.config.discord || {});
            if ("legacy_present" in j) setLegacy(!!j.legacy_present);
            showMsg(discordOnly ? "savedDiscord" : "savedAll");
          } else showMsg("saveFailed");
        } catch (e) {
          showMsg("saveFailed");
        }
        setSaving(false);
      };
      const num = (secName, key, v, fb) => {
        const n = String(v).trim() === "" ? NaN : Number(v);
        setPath(secName, key, Number.isFinite(n) ? n : fb);
      };
      if (loading)
        return h(
          "div",
          {
            style: {
              maxWidth: 720,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            },
          },
          h("p", { style: desc }, copy("loading")),
        );
      if (!all)
        return h(
          "div",
          {
            style: {
              maxWidth: 720,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            },
          },
          h("p", { role: "alert", style: warn }, copy(msg || "loadFailed")),
          h(
            "button",
            {
              className: "rdsh-btn-sec",
              onClick: load,
              style: {
                padding: "8px 12px",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: 13,
                alignSelf: "flex-start",
              },
            },
            copy("reload"),
          ),
        );
      const g = sec("general");
      const tk = sec("tokens");
      const se = sec("search");

      const co = sec("compact");
      const ss = sec("sessions");
      const lg2 = sec("logs");
      const svv = sec("serve");
      const gu = sec("guard");
      const be = sec("bench");
      const dc = sec("discord");
      const discordDirty = JSON.stringify(dc) !== JSON.stringify(savedDiscord);
      const presenceCopy = (key, values) =>
        settingText(discordStatus?.language || displayLanguage, key, values);
      const detailsText = wireText(
        dc.details?.trim() ? dc.details : presenceCopy("defaultDetails"),
      );
      const agentText =
        discordStatus?.running_agents > 0
          ? presenceCopy("running", { count: discordStatus.running_agents })
          : presenceCopy("idle");
      const commonApp =
        !dc.application_id?.trim() ||
        dc.application_id.trim() === defaultDiscordId;
      const appName = commonApp ? "rdsh" : copy("customApp");
      const previewImage =
        dc.show_image === false
          ? ""
          : dc.large_image?.trim()
            ? validUrl(dc.large_image.trim())
              ? dc.large_image.trim()
              : ""
            : commonApp
              ? "/api/rdsh-discord/icon"
              : "";
      const memberText =
        dc.status_display === "name"
          ? appName
          : dc.status_display === "state" && dc.show_agent_status !== false
            ? agentText
            : detailsText;
      const assetValid =
        !dc.large_image ||
        /^[a-z0-9_-]+$/.test(dc.large_image.trim()) ||
        validUrl(dc.large_image.trim());
      const idValid =
        !dc.application_id?.trim() ||
        /^[1-9][0-9]{16,19}$/.test(dc.application_id.trim());
      const buttonValid =
        !dc.button_url?.trim() || validUrl(dc.button_url.trim());
      const buttonComplete =
        !!dc.button_url?.trim() === !!dc.button_label?.trim();
      const discordValid =
        assetValid && idValid && buttonValid && buttonComplete;
      const connectionText =
        {
          disabled: copy("connectionDisabled"),
          needs_application_id: copy("checkApplication"),
          connecting: copy("connecting"),
          connected: copy("connected"),
          disconnected: copy("disconnected"),
          invalid_settings: copy("invalidFile"),
        }[discordStatus?.state] || copy("checkingConnection");
      const elapsed = Math.max(
        0,
        Math.floor(Date.now() / 1000) -
          (discordStatus?.started_at || Math.floor(Date.now() / 1000)),
      );
      const elapsedText = copy("elapsed", {
        time: `${Math.floor(elapsed / 3600)
          .toString()
          .padStart(2, "0")}:${Math.floor((elapsed / 60) % 60)
          .toString()
          .padStart(2, "0")}:${(elapsed % 60).toString().padStart(2, "0")}`,
      });
      const published = discordStatus?.published_activity;
      const expectedDisplay =
        dc.status_display === "name"
          ? 0
          : dc.status_display === "state" && dc.show_agent_status !== false
            ? 1
            : 2;
      const reflected =
        discordStatus?.state === "connected" &&
        published?.details === detailsText &&
        published?.status_display_type === expectedDisplay &&
        published?.state ===
          (dc.show_agent_status === false ? undefined : agentText) &&
        !!published?.timestamps === (dc.show_elapsed !== false) &&
        (published?.assets?.large_image || "") ===
          (dc.show_image === false
            ? ""
            : dc.large_image?.trim() ||
              (commonApp
                ? discordStatus?.default_image || defaultDiscordImage
                : "")) &&
        (published?.assets?.large_text || "") ===
          (dc.show_image !== false && (dc.large_image?.trim() || commonApp)
            ? wireText(dc.large_text || "dsh")
            : "") &&
        (published?.buttons?.[0]?.label || "") ===
          (dc.button_label?.trim() || "") &&
        (published?.buttons?.[0]?.url || "") === (dc.button_url?.trim() || "");
      const discordFeedback =
        discordMsg === "saveFailed"
          ? copy(discordMsg)
          : discordDirty
            ? copy("unreflected")
            : !dc.enabled && discordStatus?.state === "disabled"
              ? copy("savedOff")
              : reflected
                ? copy("reflected")
                : discordMsg
                  ? copy(discordMsg)
                  : copy("saved");
      const su = sec("setup");
      const bt = sec("beta");
      const cx = sec("context");
      const cxActive = Object.keys(cx).some((k) => {
        const v = cx[k];
        return Array.isArray(v)
          ? v.length > 0
          : typeof v === "string"
            ? v !== ""
            : false;
      });
      const versionText = [
        versions.rdsh ? `rdsh ${versions.rdsh}` : copy("unknownVersion"),
        versions.dsh ? `dsh ${versions.dsh}` : "",
      ]
        .filter(Boolean)
        .join(" ・ ");
      return h(
        "div",
        {
          className: "rdsh-settings",
          style: {
            maxWidth: 720,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          },
        },
        h("style", null, cssText + discordCss + narrowCss),
        h(
          "p",
          {
            className: "rdsh-version",
            style: { ...desc, fontSize: "12px" },
            "aria-label": copy("version"),
          },
          versionText,
        ),
        h(
          "section",
          {
            className: "rdsh-discord",
            style: card,
            "aria-label": copy("discordTitle"),
          },
          h(
            "div",
            {
              style: {
                ...row,
                justifyContent: "space-between",
                flexWrap: "wrap",
              },
            },
            h("h3", { style: title }, copy("discordTitle")),
            h(
              "span",
              { className: "rdsh-discord-pill" },
              discordDirty
                ? copy("unsaved")
                : dc.enabled
                  ? copy("presenceOn")
                  : copy("presenceOff"),
            ),
          ),
          h("p", { style: discordDesc }, copy("discordIntro")),
          h(
            "fieldset",
            { disabled: saving },
            h(
              "label",
              { style: row },
              h("input", {
                type: "checkbox",
                checked: !!dc.enabled,
                onChange: (e) =>
                  setPath("discord", "enabled", e.target.checked),
              }),
              copy("enableDiscord"),
            ),
            h(
              "label",
              { style: label },
              copy("details"),
              h("input", {
                style: input,
                value: dc.details ?? "",
                maxLength: 128,
                placeholder: copy("defaultDetails"),
                onChange: (e) => setPath("discord", "details", e.target.value),
              }),
            ),
            detailsText !==
              (dc.details?.trim() ? dc.details : copy("defaultDetails"))
              ? h("p", { style: warn }, copy("truncated"))
              : null,
            h(
              "label",
              { style: row },
              h("input", {
                type: "checkbox",
                checked: dc.show_agent_status !== false,
                onChange: (e) =>
                  setPath("discord", "show_agent_status", e.target.checked),
              }),
              copy("showAgents"),
            ),
            h(
              "label",
              { style: row },
              h("input", {
                type: "checkbox",
                checked: dc.show_elapsed !== false,
                onChange: (e) =>
                  setPath("discord", "show_elapsed", e.target.checked),
              }),
              copy("showElapsed"),
            ),
            h(
              "figure",
              {
                className: "rdsh-discord-preview",
                "aria-label": copy("discordPreview"),
              },
              h(
                "figcaption",
                { className: "rdsh-discord-meta" },
                copy("preview"),
                discordDirty ? copy("unsavedSuffix") : "",
              ),
              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 12 } },
                previewImage
                  ? h("img", {
                      src: previewImage,
                      width: 48,
                      height: 48,
                      alt: "",
                      referrerPolicy: "no-referrer",
                      style: {
                        borderRadius: 8,
                        objectFit: "cover",
                        flexShrink: 0,
                      },
                      onError: (e) => {
                        e.currentTarget.hidden = true;
                      },
                    })
                  : null,
                h(
                  "div",
                  null,
                  h("strong", null, appName),
                  h("p", null, detailsText),
                ),
              ),
              dc.show_agent_status !== false ? h("p", null, agentText) : null,
              dc.show_elapsed !== false
                ? h("p", { className: "rdsh-discord-meta" }, elapsedText)
                : null,
              dc.button_label?.trim() && dc.button_url?.trim() && buttonValid
                ? h(
                    "span",
                    { className: "rdsh-discord-link" },
                    dc.button_label.trim(),
                  )
                : null,
              h(
                "p",
                { className: "rdsh-discord-meta" },
                copy("members"),
                memberText,
              ),
              h(
                "p",
                { className: "rdsh-discord-meta" },
                dc.enabled ? copy("previewNote") : copy("offNote"),
              ),
              dc.show_image !== false && dc.large_image
                ? h("p", { className: "rdsh-discord-meta" }, copy("imageNote"))
                : null,
            ),
            h(
              "details",
              null,
              h("summary", { style: label }, copy("advanced")),
              h(
                "div",
                { className: "rdsh-discord-fields" },
                h(
                  "label",
                  { style: label },
                  copy("memberDisplay"),
                  h(
                    "select",
                    {
                      style: input,
                      value: dc.status_display || "details",
                      onChange: (e) =>
                        setPath("discord", "status_display", e.target.value),
                    },
                    h("option", { value: "details" }, copy("details")),
                    h(
                      "option",
                      {
                        value: "state",
                        disabled: dc.show_agent_status === false,
                      },
                      copy("agentState"),
                    ),
                    h("option", { value: "name" }, copy("appName")),
                  ),
                ),
                dc.status_display === "state" && dc.show_agent_status === false
                  ? h("p", { style: discordDesc }, copy("stateFallback"))
                  : null,
                h(
                  "label",
                  { style: row },
                  h("input", {
                    type: "checkbox",
                    checked: dc.show_image !== false,
                    onChange: (e) =>
                      setPath("discord", "show_image", e.target.checked),
                  }),
                  copy("showImage"),
                ),
                h(
                  "label",
                  { style: label },
                  copy("imageAsset"),
                  h("input", {
                    style: input,
                    value: dc.large_image || "",
                    maxLength: 512,
                    placeholder: copy("imagePlaceholder"),
                    onChange: (e) =>
                      setPath("discord", "large_image", e.target.value),
                    "aria-invalid": !assetValid,
                  }),
                ),
                h("p", { style: discordDesc }, copy("imageHelp")),
                !assetValid
                  ? h("p", { role: "alert", style: warn }, copy("imageInvalid"))
                  : null,
                h(
                  "label",
                  { style: label },
                  copy("imageTooltip"),
                  h("input", {
                    style: input,
                    value: dc.large_text || "",
                    maxLength: 128,
                    placeholder: "dsh",
                    onChange: (e) =>
                      setPath("discord", "large_text", e.target.value),
                  }),
                ),
                h(
                  "label",
                  { style: label },
                  copy("buttonName"),
                  h("input", {
                    style: input,
                    value: dc.button_label || "",
                    maxLength: 32,
                    placeholder: copy("buttonPlaceholder"),
                    onChange: (e) =>
                      setPath("discord", "button_label", e.target.value),
                  }),
                ),
                h(
                  "label",
                  { style: label },
                  copy("link"),
                  h("input", {
                    style: input,
                    type: "url",
                    value: dc.button_url || "",
                    maxLength: 512,
                    placeholder: "https://…",
                    onChange: (e) =>
                      setPath("discord", "button_url", e.target.value),
                    "aria-invalid": !buttonValid,
                  }),
                ),
                !buttonValid || !buttonComplete
                  ? h(
                      "p",
                      { role: "alert", style: warn },
                      copy("buttonInvalid"),
                    )
                  : null,
                h("p", { style: discordDesc }, copy("buttonNote")),
              ),
            ),
            h(
              "details",
              null,
              h("summary", { style: label }, copy("customDiscord")),
              h(
                "div",
                { className: "rdsh-discord-fields" },
                h("p", { style: discordDesc }, copy("customHelp")),
                h(
                  "label",
                  { style: label },
                  copy("applicationId"),
                  h("input", {
                    style: input,
                    value: dc.application_id || "",
                    inputMode: "numeric",
                    maxLength: 20,
                    placeholder: copy("applicationPlaceholder"),
                    onChange: (e) =>
                      setPath("discord", "application_id", e.target.value),
                    "aria-invalid": !idValid,
                  }),
                ),
                !idValid
                  ? h(
                      "p",
                      { role: "alert", style: warn },
                      copy("applicationInvalid"),
                    )
                  : null,
                h("p", { style: discordDesc }, copy("customNote")),
              ),
            ),
          ),
          h(
            "div",
            { className: "rdsh-discord-actions" },
            h(
              "button",
              {
                className: "rdsh-btn-pri",
                disabled: saving || !discordDirty || !discordValid,
                onClick: () => saveAll(true),
              },
              saving ? copy("saving") : copy("saveDiscord"),
            ),
            h(
              "span",
              {
                role: discordMsg === "saveFailed" ? "alert" : "status",
                className: "rdsh-discord-meta",
              },
              discordFeedback,
            ),
          ),
          h(
            "p",
            { role: "status", className: "rdsh-discord-meta" },
            connectionText,
            discordStatus?.state === "connected" && discordStatus.updated_at
              ? copy("lastUpdated", {
                  time: new Date(discordStatus.updated_at).toLocaleTimeString(
                    settingsLocale(displayLanguage),
                  ),
                })
              : "",
          ),
          discordStatus?.state === "disconnected" ||
            discordStatus?.state === "connecting"
            ? h("p", { style: discordDesc }, copy("openDiscord"))
            : null,
          discordStatus?.state === "connected"
            ? h("p", { style: discordDesc }, copy("discordPrivacy"))
            : null,
          h("p", { style: discordDesc }, copy("privacy")),
        ),
        h(
          "div",
          { style: card },
          h("p", { style: title }, copy("contextTitle")),
          h("p", { style: desc }, copy("contextHelp")),
          h(
            "div",
            { style: row },
            h(
              "label",
              { style: row },
              h("input", {
                type: "checkbox",
                checked: !!bt.context_engine,
                onChange: (e) =>
                  setPath("beta", "context_engine", e.target.checked),
              }),
              copy("enableContext"),
            ),
          ),
          legacy && cxActive ? h("p", { style: warn }, copy("legacy")) : null,
        ),
        h(
          "div",
          { style: card },
          h("p", { style: title }, copy("workingMemory")),
          h("p", { style: desc }, copy("workingHelp")),
          h(
            "div",
            { style: row },
            h("span", { style: label }, copy("tokenBudget")),
            h("input", {
              type: "number",
              min: 500,
              max: 200000,
              step: 100,
              value: cx.token_budget,
              onChange: (e) =>
                num("context", "token_budget", e.target.value, 4000),
              style: { ...input, maxWidth: 140 },
            }),
          ),
          h(
            "div",
            { style: grid2 },
            h(
              "label",
              { style: row },
              h("input", {
                type: "checkbox",
                checked: !!cx.enable_retriever,
                onChange: (e) =>
                  setPath("context", "enable_retriever", e.target.checked),
              }),
              copy("retriever"),
            ),
            h(
              "label",
              { style: row },
              h("input", {
                type: "checkbox",
                checked: !!cx.enable_packer,
                onChange: (e) =>
                  setPath("context", "enable_packer", e.target.checked),
              }),
              copy("packer"),
            ),
            h(
              "label",
              { style: row },
              h("input", {
                type: "checkbox",
                checked: !!cx.enable_verifier,
                onChange: (e) =>
                  setPath("context", "enable_verifier", e.target.checked),
              }),
              copy("verifier"),
            ),
            h(
              "label",
              { style: row },
              h("input", {
                type: "checkbox",
                checked: !!cx.include_git_diff,
                onChange: (e) =>
                  setPath("context", "include_git_diff", e.target.checked),
              }),
              copy("gitDiff"),
            ),
          ),
          h(
            "div",
            { style: grid2 },
            h(
              "div",
              { style: row },
              h("span", { style: label }, copy("codeLimit")),
              h("input", {
                type: "number",
                min: 1,
                max: 100,
                value: cx.max_code_hits,
                onChange: (e) =>
                  num("context", "max_code_hits", e.target.value, 20),
                style: { ...input, maxWidth: 110 },
              }),
            ),
            h(
              "div",
              { style: row },
              h("span", { style: label }, copy("historyLimit")),
              h("input", {
                type: "number",
                min: 0,
                max: 100,
                value: cx.max_sessions,
                onChange: (e) =>
                  num("context", "max_sessions", e.target.value, 0),
                style: { ...input, maxWidth: 110 },
              }),
            ),
          ),
          h(
            "div",
            null,
            h("div", { style: label }, copy("goal")),
            h("input", {
              value: cx.goal || "",
              placeholder: copy("goalPlaceholder"),
              onChange: (e) => setPath("context", "goal", e.target.value),
              style: input,
            }),
          ),
          h(
            "div",
            null,
            h("div", { style: label }, copy("workingFiles")),
            h("textarea", {
              value: toLines(cx.working_files),
              rows: 3,
              onChange: (e) =>
                setPath("context", "working_files", fromLines(e.target.value)),
              style: { ...input, minHeight: 56 },
            }),
          ),
          h(
            "div",
            null,
            h("div", { style: label }, copy("openTasks")),
            h("textarea", {
              value: toLines(cx.open_tasks),
              rows: 3,
              onChange: (e) => setPath("context", "open_tasks", e.target.value),
              style: { ...input, minHeight: 56 },
            }),
          ),
        ),
        h(
          "div",
          { style: card },
          h("p", { style: title }, copy("longMemory")),
          h("p", { style: desc }, copy("longHelp")),
          h(
            "div",
            null,
            h("div", { style: label }, copy("decisions")),
            h("textarea", {
              value: toLines(cx.decisions),
              rows: 3,
              onChange: (e) =>
                setPath("context", "decisions", fromLines(e.target.value)),
              style: { ...input, minHeight: 56 },
            }),
          ),
          h(
            "div",
            null,
            h("div", { style: label }, copy("constraints")),
            h("textarea", {
              value: toLines(cx.constraints),
              rows: 3,
              onChange: (e) =>
                setPath("context", "constraints", fromLines(e.target.value)),
              style: { ...input, minHeight: 56 },
            }),
          ),
        ),
        h(
          "div",
          { style: card },
          h("p", { style: title }, copy("allSettings")),
          h("p", { style: desc }, copy("allHelp")),
          h("div", { style: label }, copy("general")),
          h(
            "div",
            { style: grid2 },
            h(
              "label",
              { style: row },
              h("input", {
                type: "checkbox",
                checked: !!g.slim,
                onChange: (e) => setPath("general", "slim", e.target.checked),
              }),
              copy("slim"),
            ),
            h(
              "label",
              { style: row },
              h("input", {
                type: "checkbox",
                checked: !!g.passthrough,
                onChange: (e) =>
                  setPath("general", "passthrough", e.target.checked),
              }),
              copy("passthrough"),
            ),
            h(
              "label",
              { style: row },
              h("input", {
                type: "checkbox",
                checked: !!g.dry_run,
                onChange: (e) =>
                  setPath("general", "dry_run", e.target.checked),
              }),
              copy("dryRun"),
            ),
          ),
          h(
            "div",
            null,
            h("div", { style: label }, copy("defaultProfile")),
            h("input", {
              value: g.default_profile || "",
              placeholder: copy("unspecified"),
              onChange: (e) =>
                setPath("general", "default_profile", e.target.value),
              style: input,
            }),
          ),
          h(
            "label",
            { style: label },
            copy("language"),
            h(
              "select",
              {
                value: displayLanguage,
                disabled: saving,
                onChange: (e) => setPath("general", "language", e.target.value),
                style: input,
              },
              h("option", { value: "auto" }, copy("auto")),
              h("option", { value: "en" }, "English"),
              h("option", { value: "zh-CN" }, "简体中文"),
              h("option", { value: "ja" }, "日本語"),
            ),
          ),
          h("div", { style: label }, copy("tokens")),
          h(
            "div",
            { style: row },
            h("span", { style: label }, copy("defaultBudget")),
            h("input", {
              type: "number",
              min: 500,
              max: 200000,
              step: 100,
              value: tk.default_budget,
              onChange: (e) =>
                num("tokens", "default_budget", e.target.value, 4000),
              style: { ...input, maxWidth: 140 },
            }),
          ),
          h("div", { style: label }, copy("search")),
          h(
            "div",
            null,
            h("div", { style: label }, copy("directory")),
            h("input", {
              value: se.dir || "",
              onChange: (e) => setPath("search", "dir", e.target.value),
              style: input,
            }),
          ),
          h(
            "div",
            { style: grid2 },
            h(
              "div",
              { style: row },
              h("span", { style: label }, copy("maxResults")),
              h("input", {
                type: "number",
                min: 1,
                max: 100,
                value: se.max,
                onChange: (e) => num("search", "max", e.target.value, 100),
                style: { ...input, maxWidth: 110 },
              }),
            ),
            h(
              "div",
              { style: row },
              h("span", { style: label }, copy("webLimit")),
              h("input", {
                type: "number",
                min: 1,
                max: 100,
                value: se.web_limit,
                onChange: (e) => num("search", "web_limit", e.target.value, 10),
                style: { ...input, maxWidth: 110 },
              }),
            ),
          ),
          h(
            "div",
            null,
            h("div", { style: label }, copy("searxng")),
            h("input", {
              value: se.searxng_url || "",
              placeholder: copy("unset"),
              onChange: (e) => setPath("search", "searxng_url", e.target.value),
              style: input,
            }),
          ),
          h("div", { style: label }, copy("compact")),
          h(
            "div",
            { style: row },
            h("span", { style: label }, copy("maxTokens")),
            h("input", {
              type: "number",
              min: 500,
              max: 200000,
              step: 100,
              value: co.max_tokens,
              onChange: (e) =>
                num("compact", "max_tokens", e.target.value, 8000),
              style: { ...input, maxWidth: 140 },
            }),
          ),
          h("div", { style: label }, copy("sessions")),
          h(
            "div",
            { style: grid2 },
            h(
              "div",
              { style: row },
              h("span", { style: label }, copy("retention")),
              h("input", {
                type: "number",
                min: 1,
                max: 100,
                value: ss.limit,
                onChange: (e) => num("sessions", "limit", e.target.value, 20),
                style: { ...input, maxWidth: 110 },
              }),
            ),
            h(
              "label",
              { style: row },
              h("input", {
                type: "checkbox",
                checked: !!ss.with_tokens,
                onChange: (e) =>
                  setPath("sessions", "with_tokens", e.target.checked),
              }),
              copy("withTokens"),
            ),
          ),
          h("div", { style: label }, copy("logs")),
          h(
            "div",
            { style: row },
            h("span", { style: label }, copy("tail")),
            h("input", {
              type: "number",
              min: 1,
              max: 500,
              value: lg2.tail,
              onChange: (e) => num("logs", "tail", e.target.value, 50),
              style: { ...input, maxWidth: 110 },
            }),
          ),
          h("div", { style: label }, copy("server")),
          h(
            "div",
            { style: row },
            h("span", { style: label }, copy("port")),
            h("input", {
              type: "number",
              min: 1,
              max: 65535,
              value: svv.port,
              onChange: (e) => num("serve", "port", e.target.value, 38080),
              style: { ...input, maxWidth: 110 },
            }),
          ),
          h("div", { style: label }, copy("guard")),
          h(
            "div",
            null,
            h("div", { style: label }, copy("denyPaths")),
            h("textarea", {
              value: toLines(gu.deny),
              rows: 2,
              onChange: (e) =>
                setPath("guard", "deny", fromLines(e.target.value)),
              style: { ...input, minHeight: 44 },
            }),
          ),
          h(
            "div",
            null,
            h("div", { style: label }, copy("reason")),
            h("input", {
              value: gu.reason || "",
              onChange: (e) => setPath("guard", "reason", e.target.value),
              style: input,
            }),
          ),
          h("div", { style: label }, copy("benchmark")),
          h(
            "div",
            { style: row },
            h("span", { style: label }, copy("iterations")),
            h("input", {
              type: "number",
              min: 1,
              max: 20,
              value: be.n,
              onChange: (e) => num("bench", "n", e.target.value, 5),
              style: { ...input, maxWidth: 110 },
            }),
          ),
          h("div", { style: label }, copy("setup")),
          h(
            "div",
            { style: row },
            h("span", { style: label }, copy("webPort")),
            h("input", {
              type: "number",
              min: 0,
              max: 65535,
              value: su.web_port,
              onChange: (e) => num("setup", "web_port", e.target.value, 0),
              style: { ...input, maxWidth: 110 },
            }),
          ),
        ),
        h(
          "div",
          { style: { display: "flex", gap: 8, alignItems: "center" } },
          h(
            "button",
            {
              className: "rdsh-btn-pri",
              onClick: () => saveAll(),
              disabled: saving || !discordValid,
              style: {
                padding: "8px 16px",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: 14,
              },
            },
            saving ? copy("saving") : copy("save"),
          ),
          h(
            "button",
            {
              className: "rdsh-btn-sec",
              onClick: load,
              disabled: saving,
              style: {
                padding: "8px 12px",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: 13,
              },
            },
            copy("reload"),
          ),
          h(
            "span",
            {
              className: "rdsh-msg",
              role: msg === "saveFailed" ? "alert" : "status",
            },
            msg ? copy(msg) : "",
          ),
        ),
      );
    }
    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "rdsh",
              order: 20,
              label: () => "rdsh",
              inject: () => ({}),
            },
            RdshSection,
          ),
        );
      },
    };
  },
});
