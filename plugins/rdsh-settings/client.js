window.__ModuleLoader__.load({
  id: "rdsh-settings",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useCallback = React.useCallback;
    // DSH language packs contribute to the existing selector and preference store.
    // Keys outside this settings pack use the locale service's English fallback.
    const japaneseDictionaries = {
      common: {
        'ok': 'OK', 'cancel': 'キャンセル', 'close': '閉じる',
        'copy': 'コピー', 'copied': 'コピーしました',
        'codeBlock.title': 'コードブロック', 'codeBlock.wrap': '行を折り返す',
        'codeBlock.unwrap': '行を折り返さない', 'copy.failed': 'コピーに失敗しました',
        'copy.value': '値をコピー', 'copy.json': 'JSONをコピー',
        'copy.path': 'プロパティのパスをコピー', 'copy.prettyJson': '整形したJSONをコピー',
        'copy.compactJson': '圧縮したJSONをコピー',
        'copy.optionsHint': '{action}（右クリックでコピー方法を選択）',
        'retry': '再試行', 'loading': '読み込み中…', 'load.failed': '読み込みに失敗しました',
        'submit': '送信', 'submitting': '送信中…', 'next': '次へ',
        'previous': '前へ', 'skip': 'スキップ', 'delete': '削除', 'edit': '編集',
        'save': '保存', 'search': '検索', 'more': 'その他', 'collapse': '折りたたむ',
        'expand': '展開', 'back': '戻る', 'brand.localBuild': 'DSH ローカルビルド',
        'workspace.defaultName': '既定のワークスペース', 'unknown': '不明',
        'none': 'なし', 'truncated': '省略あり', 'json.label': 'JSON',
        'markdown.footnotes': '脚注', 'markdown.truncatedCharacters': '… {total}文字で省略',
        'number.thousand': '{value}K', 'number.million': '{value}M',
      },
      'settings.locale': { 'language.title': '言語' },
      settings: {
        'trigger': '設定', 'shortcut.open': '設定を開く', 'title': '設定', 'close': '閉じる',
        'openDocument': '設定ファイルを開く', 'openDocument.error': '設定ファイルを開けませんでした',
        'general.nav': '一般', 'general.currentVersion': '現在のバージョン: {version}',
        'developerTools.title': 'コーディング表示',
        'developerTools.error': '保存できませんでした。再試行してください',
        'developerTools.description': '作業の履歴、コード差分、すべてのエージェントプリセットを表示します',
        'connection.error': '接続が切れました', 'connection.connecting': '再接続中',
        'connection.connected': '接続しました', 'connection.reconnect': '接続が切れました。クリックで再接続',
        'connection.restart': '再接続中です。クリックですぐに再接続',
        'desktop.update.available': '更新', 'desktop.update.checking': '更新を確認中…',
        'desktop.update.progress': '{percent}%', 'desktop.update.verifying': '更新ファイルを検証中…',
        'desktop.update.installing': '再起動の準備中…', 'desktop.update.ready': 'インストールして再起動',
        'desktop.update.retry': '更新を再試行', 'desktop.update.versionDetail': '{label}: {version}',
        'desktop.update.downloadDetail': '更新をダウンロード中: {percent}%\n対象バージョン: {version}',
        'desktop.update.checkFailed': '更新を確認できませんでした。しばらくしてから再試行してください。',
        'desktop.update.downloadFailed': '更新をダウンロードできませんでした。再試行してください。',
        'desktop.update.installFailed': '更新をインストールできませんでした。しばらくしてから再試行してください。',
        'desktop.update.checkNetworkFailed': '更新を確認できませんでした。ネットワーク接続を確認して再試行してください。',
        'desktop.update.downloadNetworkFailed': '更新をダウンロードできませんでした。ネットワーク接続を確認して再試行してください。',
        'desktop.update.installNetworkFailed': '更新をインストールできませんでした。ネットワーク接続を確認して再試行してください。',
        'desktop.update.stopFailed': 'タスクを安全に停止できなかったため、更新していません。しばらくしてから再試行してください。',
        'desktop.update.tasksChanged': '新しいタスクが始まりました。停止して更新するか、もう一度確認してください。',
        'desktop.update.tasksUnavailable': 'タスクの状態を確認できません。ワークスペースの準備ができてから再試行してください。',
      },
      'settings.theme': {
        'appearance.title': '外観', 'appearance.light': 'ライト',
        'appearance.dark': 'ダーク', 'appearance.system': 'システム',
        // Font-size keys used by DSH 0.2.1-alpha.1 before per-role fonts.
        'fontSize.title': '文字サイズ', 'fontSize.description': '会話の内容にのみ適用されます',
        'fontSize.increase': '文字を大きくする', 'fontSize.decrease': '文字を小さくする',
        'fontSize.text.title': '文字サイズ', 'fontSize.text.description': '会話の内容にのみ適用されます',
        'fontSize.text.increase': '文字を大きくする', 'fontSize.text.decrease': '文字を小さくする',
        'fontSize.code.title': 'コードの文字サイズ',
        'fontSize.code.description': 'コードブロック、インラインコード、ツール出力に適用されます',
        'fontSize.code.increase': 'コードの文字を大きくする', 'fontSize.code.decrease': 'コードの文字を小さくする',
        'fontSize.terminal.title': 'ターミナルの文字サイズ',
        'fontSize.terminal.description': 'サイドバーのターミナルに適用されます',
        'fontSize.terminal.increase': 'ターミナルの文字を大きくする',
        'fontSize.terminal.decrease': 'ターミナルの文字を小さくする', 'fontSize.unit': 'px',
        'fontFamily.text.title': 'テキストのフォント',
        'fontFamily.text.description': '画面と会話の文章に適用されます。複数のフォントはカンマで区切り、既定に戻すには空欄にします',
        'fontFamily.code.title': 'コードのフォント',
        'fontFamily.code.description': 'コードブロック、インラインコード、ツール出力に適用されます。複数のフォントはカンマで区切り、既定に戻すには空欄にします',
        'fontFamily.terminal.title': 'ターミナルのフォント',
        'fontFamily.terminal.description': 'サイドバーのターミナルに適用されます。複数のフォントはカンマで区切り、既定に戻すには空欄にします',
        'fontFamily.placeholder': '既定', 'fontSize.more': 'その他のフォント設定',
      },
      'settings.permission': {
        'title': '権限', 'description': '新しいセッションの既定の権限を選びます',
        'loading': '読み込み中', 'unavailable': '利用できません',
        'preset.readOnly': '読み取りのみ', 'preset.workspaceWrite': 'ワークスペース内の書き込み',
        'preset.fullAccess': '完全なアクセス', 'confirm.title': '完全なアクセスを有効にしますか？',
        'confirm.description': '完全なアクセスでは、新しいセッションの確認手順が減り、機密性の高い操作、ファイル変更、外部コマンドなどを直接実行できます。これから行うタスクを信頼できる場合にのみ使用してください。',
        'confirm.acknowledge': 'リスクを理解したうえで続けます',
        'confirm.cancel': 'キャンセル', 'confirm.enable': '完全なアクセスを有効にする',
      },
      chat: {
        'settings.transcript.title': '作業の詳細',
        'settings.transcript.description': 'ツール呼び出しの詳細をどこまで表示するか選びます',
        'settings.transcript.compact': '簡潔', 'settings.transcript.standard': '標準',
        'settings.transcript.detailed': '詳細', 'settings.transcript.verbose': 'すべて表示',
      },
      conversation: {
        'settings.enter.title': '実行中の送信方法',
        'settings.enter.description': 'エージェントの実行中にEnterキーと送信ボタンが行う操作です。Cmd/Ctrl+Enterではもう一方の操作になります',
        'settings.enter.queue': '順番待ちに追加', 'settings.enter.steer': '実行中の作業に指示',
      },
      shortcuts: {
        'title': 'キーボードショートカット', 'open': 'キーボードショートカットを開く',
        'settings': 'キーボードショートカット', 'view': 'ショートカットを編集',
        'description': 'ショートカットと入力操作の確認・編集ができます',
        'search': 'ショートカットを検索', 'close': 'キーボードショートカットを閉じる',
      },
    };
    function registerJapaneseLocale(ctx) {
      // Older DSH clients still have locale, but predate language-pack registration.
      if (typeof ctx.locale.addLanguage !== 'function') return;
      // Another Japanese pack owns its dictionaries and language definition.
      if (ctx.locale.getSnapshot().locales.some(({ id }) => id.toLowerCase() === 'ja')) return;
      for (const [namespace, dictionary] of Object.entries(japaneseDictionaries)) {
        ctx.effect(() => ctx.locale.register(namespace, 'ja', dictionary), `rdsh-settings: Japanese ${namespace}`);
      }
      ctx.effect(() => ctx.locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' }), 'rdsh-settings: Japanese language');
    }
    // 単一設定源: rdsh.json のみ。旧 rdsh-context.json はサーバ側の
    // 読み替え専用で、UIからは触らない。
    const GET_ALL = "/api/rdsh-settings";
    const SAVE_ALL = "/api/rdsh-settings/save";
    const card = {
      border: "1px solid var(--dsw-alias-settings-card-stroke)",
      background: "var(--dsw-alias-settings-card-fill)",
      borderRadius: "12px",
      color: "var(--dsw-alias-label-primary)",
      minWidth: 0,
    };
    const cardHead = {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      margin: "0",
      padding: "0",
    };
    const groupToggle = {
      display: "grid",
      gridTemplateColumns: "auto minmax(0, 1fr) auto",
      alignItems: "center",
      columnGap: "10px",
      width: "100%",
      margin: "0",
      padding: "12px 14px",
      background: "transparent",
      border: "0",
      borderRadius: "12px",
      color: "inherit",
      textAlign: "left",
      cursor: "pointer",
    };
    const caretStyle = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "20px",
      height: "20px",
      color: "var(--dsw-alias-label-tertiary)",
      transition: "transform 150ms ease",
    };
    const headText = {
      display: "flex",
      flexDirection: "column",
      gap: "2px",
      minWidth: 0,
    };
    const summaryText = {
      fontSize: "12px",
      color: "var(--dsw-alias-label-tertiary)",
      overflowWrap: "anywhere",
    };
    const groupBody = {
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      padding: "12px 14px 14px",
      borderTop: "1px solid var(--dsw-alias-border-l3)",
      minWidth: 0,
    };
    const title = {
      margin: "0",
      fontSize: "15px",
      fontWeight: 600,
      lineHeight: 1.4,
      color: "var(--dsw-alias-label-primary)",
    };
    const desc = {
      margin: "0",
      fontSize: "12.5px",
      lineHeight: 1.6,
      color: "var(--dsw-alias-label-tertiary)",
    };
    const label = {
      fontSize: "12px",
      fontWeight: 600,
      color: "var(--dsw-alias-label-secondary)",
      lineHeight: 1.6,
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
    const checkboxRow = {
      ...row,
      minHeight: "32px",
      margin: "0",
    };
    const warn = {
      margin: "0",
      fontSize: "12px",
      lineHeight: 1.6,
      color: "var(--dsw-alias-label-warning, #b7791f)",
    };
    const hint = {
      margin: "0",
      fontSize: "12px",
      lineHeight: 1.6,
      color: "var(--dsw-alias-label-tertiary)",
    };
    const cssText = [
      ".rdsh-settings{color:var(--dsw-alias-label-primary)}",
      ".rdsh-settings *{box-sizing:border-box}",
      ".rdsh-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;align-items:start}",
      ".rdsh-grid-2>.rdsh-grid-field{flex:1 1 240px;min-width:0}",
      ".rdsh-card{min-width:0}",
      ".rdsh-group-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".rdsh-group-toggle:hover .rdsh-caret{color:var(--dsw-alias-label-secondary)}",
      ".rdsh-card[data-open=true] .rdsh-caret{transform:rotate(90deg)}",
      ".rdsh-card-body[hidden]{display:none!important}",
      ".rdsh-settings input:not([type=checkbox]),.rdsh-settings textarea,.rdsh-settings select{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l3);outline:none}",
      ".rdsh-settings input:not([type=checkbox]):focus,.rdsh-settings textarea:focus,.rdsh-settings select:focus{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));border-color:transparent}",
      ".rdsh-settings input::placeholder,.rdsh-settings textarea::placeholder{color:var(--dsw-alias-label-dimmed)}",
      ".rdsh-settings input[type=checkbox]{accent-color:var(--dsw-alias-button-primary-fill);width:15px;height:15px;flex:none;margin:0}",
      ".rdsh-settings fieldset{border:0;padding:0;margin:0;min-width:0}",
      ".rdsh-settings button{font:inherit;cursor:pointer}",
      ".rdsh-settings button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}",
      ".rdsh-settings textarea{resize:vertical}",
      ".rdsh-btn-pri{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:1px solid transparent}",
      ".rdsh-btn-pri:hover{background:var(--dsw-alias-button-primary-hover)}",
      ".rdsh-btn-pri:disabled{opacity:.4;cursor:default}",
      ".rdsh-btn-sec{background:transparent;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l3)}",
      ".rdsh-btn-sec:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".rdsh-btn-sec:disabled{opacity:.4;cursor:default}",
      ".rdsh-btn-sm{padding:5px 10px;border-radius:8px;font-size:12px}",
      ".rdsh-msg{font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".rdsh-settings [aria-invalid=true]{border-color:var(--dsw-alias-state-error)}",
    ].join("");
    // 2列のフォーム。入力欄が0幅に潰れないよう、幅が足りないカードでは
    // 1列へ折り返す (折り返し判定は .rdsh-grid-2 側のCSSで行う)。
    const grid2 = {
      display: "flex",
      flexWrap: "wrap",
      gap: "10px 12px",
    };
    // 読みやすさを優先する2列のフォーム (ラベル + 入力)。
    const gridField = {
      display: "grid",
      gridTemplateColumns: "minmax(84px, 140px) minmax(0, 1fr)",
      alignItems: "center",
      gap: "4px 10px",
      minWidth: 0,
      fontSize: "12px",
      fontWeight: 600,
      color: "var(--dsw-alias-label-secondary)",
    };
    // 参加/離脱が一度きりのチェックボックス群。
    const checkGrid = {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
      gap: "4px 16px",
    };
    // ラベルと入力が縦に並ぶ通常のフィールド。
    const field = {
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      minWidth: 0,
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
      groupConnection: [
        "接続とプロバイダの共有",
        "Connection and provider sharing",
        "连接与提供商共享",
      ],
      groupConnectionDesc: [
        "dsh 本体に渡す検索プロバイダと、ローカル状態画面の待ち受けポートを決めます。",
        "Choose the search provider handed to dsh and the port for the local status page.",
        "设置交给 dsh 的搜索提供商，以及本地状态页面的监听端口。",
      ],
      providerDelegation: [
        "dsh 本体の検索プロバイダ",
        "Search provider for dsh",
        "dsh 的搜索提供商",
      ],
      providerPlaceholder: [
        "例: searxng（空欄で自動）",
        "Example: searxng (blank = automatic)",
        "例如：searxng（留空为自动）",
      ],
      providerHelp: [
        "登録済みのプロバイダ ID を指定したときだけ、委譲先の dsh へ DSH_WEB_SEARCH_PROVIDER を渡します。",
        "Only when a registered provider ID is set, DSH_WEB_SEARCH_PROVIDER is passed to the delegated dsh process.",
        "仅当设置了已注册的提供商 ID 时，才向委派的 dsh 传递 DSH_WEB_SEARCH_PROVIDER。",
      ],
      statusPort: [
        "ローカル状態画面のポート",
        "Port for the local status page",
        "本地状态页面的端口",
      ],
      statusPortHelp: [
        "rdsh serve の待ち受けポートです。既定は 38080 です。",
        "The listening port used by rdsh serve. The default is 38080.",
        "rdsh serve 的监听端口，默认 38080。",
      ],
      groupModel: [
        "モデル",
        "Model",
        "模型",
      ],
      groupModelDesc: [
        "トークン予算と記憶の取り込み量を決めます。ここが会話の長さとコストに直結します。",
        "Set the token budget and how much memory is pulled in; this drives conversation length and cost.",
        "设置令牌预算与记忆引入量，直接影响对话长度和成本。",
      ],
      modelBudgetHelp: [
        "会話とコンテキストに使う上限です。既定のトークン予算は 4000、上限トークンは 8000 です。",
        "Upper bounds for the conversation and context. Defaults are a 4000 token budget and 8000 maximum tokens.",
        "对话与上下文的上限。默认令牌预算 4000，最大令牌 8000。",
      ],
      modelBudgetSummary: [
        "予算 {budget} / 上限 {max}",
        "Budget {budget} / max {max}",
        "预算 {budget} / 上限 {max}",
      ],
      groupFeatures: [
        "追加機能",
        "Extra features",
        "附加功能",
      ],
      groupFeaturesDesc: [
        "context engine、全体設定、保存したくない項目の4つのカードをまとめています。",
        "Holds the context engine, global settings and long-term memory cards.",
        "汇总上下文引擎、全局设置与长期记忆的卡片。",
      ],
      groupDetails: [
        "詳細",
        "Details",
        "详细",
      ],
      groupDetailsDesc: [
        "検索、セッション、ログ、サーバー、guard、bench、setup の各設定です。",
        "Search, sessions, logs, server, guard, bench and setup settings.",
        "搜索、会话、日志、服务器、防护、基准测试与安装设置。",
      ],
      groupsShowAll: ["すべて開く", "Expand all", "全部展开"],
      groupsHideAll: ["すべて閉じる", "Collapse all", "全部折叠"],
      groupSummaryUnset: ["未設定", "Not set", "未配置"],
      groupSummaryBudget: [
        "予算 {budget} / 上限 {max}",
        "Budget {budget} / max {max}",
        "预算 {budget} / 上限 {max}",
      ],
      groupSummaryContext: [
        "context engine {state}",
        "Context engine {state}",
        "上下文引擎 {state}",
      ],
      groupSummaryDetails: [
        "検索 {max} 件 ・ ログ {tail} 行",
        "Search {max} results · logs {tail} lines",
        "搜索 {max} 条 · 日志 {tail} 行",
      ],
    };
    // 5つのグループ。id は aria-controls と localStorage のキーに使います。
    const RDSH_GROUPS = [
      { id: "connection", title: "groupConnection" },
      { id: "model", title: "groupModel" },
      { id: "discord", title: "discordTitle" },
      { id: "features", title: "groupFeatures" },
      { id: "details", title: "groupDetails" },
    ];
    const RDSH_GROUP_IDS = RDSH_GROUPS.map((item) => item.id);
    const OPEN_STORAGE_KEY = "rdsh-settings-open:v1";
    // 開閉状態の既定値。最初のカードだけ開きます。
    const openThemes = (active) => {
      const next = {};
      for (const item of RDSH_GROUPS) next[item.id] = item.id === active;
      return next;
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
      "@media(max-width:640px){.rdsh-settings .rdsh-cards,.rdsh-settings .rdsh-grid-2,.rdsh-settings .rdsh-grid-field{grid-template-columns:1fr}[data-shortcut-modal=settings]:has(.rdsh-settings){flex-direction:column}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav{width:100%;padding:16px 12px 0;gap:8px}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav>div:last-child{flex-direction:row;overflow-x:auto;overflow-y:hidden}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav button{flex:none}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav+div{min-height:0}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav+div>div:first-child{height:48px;padding:8px 12px}[data-shortcut-modal=settings]:has(.rdsh-settings)>nav+div>div:last-child{padding:0 12px 16px}}";
    const discordCss =
      ".rdsh-discord{min-width:0;overflow-wrap:anywhere}.rdsh-discord fieldset{border:0;padding:0;margin:0;min-width:0;display:flex;flex-direction:column;gap:12px}.rdsh-discord label{line-height:1.6}.rdsh-discord summary{cursor:pointer;padding:8px 0;min-height:32px;box-sizing:border-box}.rdsh-discord summary:focus-visible,.rdsh-settings button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:3px}.rdsh-discord-fields{display:flex;flex-direction:column;gap:12px;padding:8px 0}.rdsh-discord-preview{margin:0;padding:12px 0;border-block:1px solid var(--dsw-alias-border-l3);display:flex;flex-direction:column;gap:6px;font-size:13px}.rdsh-discord-preview p{margin:0}.rdsh-discord-preview strong{font-size:15px}.rdsh-discord-meta{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}.rdsh-discord-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.rdsh-discord-actions button{padding:9px 12px;min-height:36px;border-radius:8px;cursor:pointer;font-size:13px}.rdsh-discord-link{align-self:flex-start;font-size:12px;padding:6px 12px;background:var(--dsw-alias-interactive-bg-hover);border-radius:8px}.rdsh-discord input,.rdsh-discord select{min-height:34px}.rdsh-discord input[type=checkbox]{min-height:15px;flex-shrink:0}.rdsh-discord select{width:100%}.rdsh-discord ::selection{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}";
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
      const readOpenGroups = () => {
        const fallback = openThemes(RDSH_GROUP_IDS[0]);
        try {
          const raw = globalThis.localStorage?.getItem(OPEN_STORAGE_KEY);
          if (raw === null || raw === undefined) return fallback;
          const stored = JSON.parse(raw);
          if (!stored || typeof stored !== "object") return fallback;
          const next = {};
          for (const id of RDSH_GROUP_IDS) next[id] = stored[id] === true;
          return next;
        } catch (e) {
          return fallback;
        }
      };
      const og = useState(readOpenGroups);
      const openGroups = og[0];
      const setOpenGroups = og[1];
      useEffect(() => {
        try {
          globalThis.localStorage?.setItem(
            OPEN_STORAGE_KEY,
            JSON.stringify(openGroups),
          );
        } catch (e) {
          /* 保存できない環境では既定の開閉状態のままにします */
        }
      }, [openGroups]);
      const toggleOpen = (id) =>
        setOpenGroups((current) => ({ ...current, [id]: !current[id] }));
      const setAllOpen = (value) => {
        const next = {};
        for (const id of RDSH_GROUP_IDS) next[id] = value;
        setOpenGroups(next);
      };
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

      const summaryValue = (value, fallback) =>
        value === undefined || value === null || value === ""
          ? fallback
          : String(value);
      const presenceSummary = [
        connectionText,
        dc.enabled && dc.details?.trim() ? dc.details.trim() : "",
      ]
        .filter(Boolean)
        .join(" ・ ");
      const modelSummary = copy("modelBudgetSummary", {
        budget: summaryValue(tk.default_budget, 4000),
        max: summaryValue(co.max_tokens, 8000),
      });
      const featuresSummary = copy("groupSummaryContext", {
        state: bt.context_engine ? "ON" : "OFF",
      });
      const detailsSummary = copy("groupSummaryDetails", {
        max: summaryValue(se.max, 100),
        tail: summaryValue(lg2.tail, 50),
      });
      const pad = (...children) =>
        h(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 16,
              minWidth: 0,
            },
          },
          children,
        );
      const caret = () =>
        h(
          "span",
          {
            className: "rdsh-caret",
            "aria-hidden": "true",
            style: caretStyle,
          },
          h(
            "svg",
            {
              viewBox: "0 0 16 16",
              width: 16,
              height: 16,
              focusable: "false",
            },
            h("path", {
              d: "M6 3.5 10.5 8 6 12.5",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 1.75,
              strokeLinecap: "round",
              strokeLinejoin: "round",
            }),
          ),
        );
      // 各カードの見出しはボタンで、本体だけを開閉します。
      const card = (id, cardTitle, cardDesc, open, onToggle, summary, ...body) =>
        h(
          "section",
          {
            key: id,
            className: "rdsh-card",
            "data-open": open ? "true" : "false",
          },
          h(
            "h3",
            { style: cardHead },
            h(
              "button",
              {
                type: "button",
                className: "rdsh-group-toggle",
                style: groupToggle,
                "aria-expanded": open,
                "aria-controls": "rdsh-group-" + id,
                onClick: onToggle,
              },
              caret(),
              h(
                "span",
                { style: headText },
                h("span", { style: title }, cardTitle),
                h("span", { style: hint }, cardDesc),
                summary
                  ? h(
                      "span",
                      { className: "rdsh-group-summary", style: summaryText },
                      summary,
                    )
                  : null,
              ),
            ),
          ),
          h(
            "div",
            {
              className: "rdsh-card-body",
              id: "rdsh-group-" + id,
              hidden: !open,
              style: groupBody,
            },
            body,
          ),
        );
      return h(
        "div",
        {
          className: "rdsh-settings",
          "aria-label": copy("advanced"),
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minWidth: 0,
          },
        },
        h("style", null, cssText + discordCss + narrowCss),
        h(
          "div",
          {
            className: "rdsh-version",
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
            },
          },
          h(
            "span",
            { className: "rdsh-group-summary", style: summaryText },
            versionText,
          ),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8 } },
            h(
              "button",
              {
                type: "button",
                className: "rdsh-btn-sec rdsh-btn-sm",
                onClick: () => setAllOpen(true),
              },
              copy("groupsShowAll"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "rdsh-btn-sec rdsh-btn-sm",
                onClick: () => setAllOpen(false),
              },
              copy("groupsHideAll"),
            ),
          ),
        ),
        h(
          "div",
          { className: "rdsh-cards rdsh-grid" },
          card(
            "connection",
            copy("groupConnection"),
            copy("groupConnectionDesc"),
            openGroups.connection,
            () => toggleOpen("connection"),
            null,
            h(
              "div",
              { className: "rdsh-grid-2", style: grid2 },
              h(
                "label",
                { className: "rdsh-grid-field", style: gridField },
                copy("providerDelegation"),
                h("input", {
                  style: input,
                  value: se.dsh_search_provider || "",
                  placeholder: copy("providerPlaceholder"),
                  onChange: (e) =>
                    setPath("search", "dsh_search_provider", e.target.value),
                }),
              ),
              h(
                "label",
                { className: "rdsh-grid-field", style: gridField },
                copy("statusPort"),
                h("input", {
                  type: "number",
                  min: 1,
                  max: 65535,
                  value: svv.port,
                  onChange: (e) => num("serve", "port", e.target.value, 38080),
                  style: { ...input, maxWidth: 120 },
                }),
              ),
            ),
            h("p", { style: hint }, copy("providerHelp")),
            h("p", { style: hint }, copy("statusPortHelp")),
          ),
          card(
            "model",
            copy("groupModel"),
            copy("groupModelDesc"),
            openGroups.model,
            () => toggleOpen("model"),
            modelSummary,
            h("p", { style: title }, copy("tokens")),
            h(
              "div",
              { className: "rdsh-grid-2", style: grid2 },
              h(
                "label",
                { className: "rdsh-grid-field", style: gridField },
                copy("defaultBudget"),
                h("input", {
                  type: "number",
                  min: 500,
                  max: 200000,
                  step: 100,
                  value: tk.default_budget,
                  onChange: (e) =>
                    num("tokens", "default_budget", e.target.value, 4000),
                  style: input,
                }),
              ),
              h(
                "label",
                { className: "rdsh-grid-field", style: gridField },
                copy("maxTokens"),
                h("input", {
                  type: "number",
                  min: 500,
                  max: 200000,
                  step: 100,
                  value: co.max_tokens,
                  onChange: (e) =>
                    num("compact", "max_tokens", e.target.value, 8000),
                  style: input,
                }),
              ),
            ),
            h("p", { style: hint }, copy("modelBudgetHelp")),
          ),
          card(
            "discord",
            copy("discordTitle"),
            copy("discordIntro"),
            openGroups.discord,
            () => toggleOpen("discord"),
            presenceSummary,
            h(
              "fieldset",
              { disabled: saving },
              h(
                "label",
                { style: checkboxRow },
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
                { style: field },
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
                (dc.details?.trim()
                  ? dc.details
                  : presenceCopy("defaultDetails"))
                ? h("p", { style: warn }, copy("truncated"))
                : null,
              h(
                "label",
                { style: checkboxRow },
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
                { style: checkboxRow },
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
                  {
                    style: { display: "flex", alignItems: "center", gap: 12 },
                  },
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
                    { style: { minWidth: 0 } },
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
                  ? h(
                      "p",
                      { className: "rdsh-discord-meta" },
                      copy("imageNote"),
                    )
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
                    { style: field },
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
                  dc.status_display === "state" &&
                  dc.show_agent_status === false
                    ? h("p", { style: hint }, copy("stateFallback"))
                    : null,
                  h(
                    "label",
                    { style: checkboxRow },
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
                    { style: field },
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
                  h("p", { style: hint }, copy("imageHelp")),
                  !assetValid
                    ? h(
                        "p",
                        { role: "alert", style: warn },
                        copy("imageInvalid"),
                      )
                    : null,
                  h(
                    "label",
                    { style: field },
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
                    { style: field },
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
                    { style: field },
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
                  h("p", { style: hint }, copy("buttonNote")),
                ),
              ),
              h(
                "details",
                null,
                h("summary", { style: label }, copy("customDiscord")),
                h(
                  "div",
                  { className: "rdsh-discord-fields" },
                  h("p", { style: hint }, copy("customHelp")),
                  h(
                    "label",
                    { style: field },
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
                  h("p", { style: hint }, copy("customNote")),
                ),
              ),
            ),
            h(
              "div",
              { className: "rdsh-discord-actions" },
              h(
                "button",
                {
                  type: "button",
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
              ? h("p", { style: hint }, copy("openDiscord"))
              : null,
            discordStatus?.state === "connected"
              ? h("p", { style: hint }, copy("discordPrivacy"))
              : null,
            h("p", { style: hint }, copy("privacy")),
          ),
          card(
            "features",
            copy("groupFeatures"),
            copy("groupFeaturesDesc"),
            openGroups.features,
            () => toggleOpen("features"),
            featuresSummary,
            pad(
              h(
                "div",
                { style: field },
                h("p", { style: title }, copy("contextTitle")),
                h("p", { style: hint }, copy("contextHelp")),
                h(
                  "label",
                  { style: checkboxRow },
                  h("input", {
                    type: "checkbox",
                    checked: !!bt.context_engine,
                    onChange: (e) =>
                      setPath("beta", "context_engine", e.target.checked),
                  }),
                  copy("enableContext"),
                ),
                legacy && cxActive
                  ? h("p", { style: warn }, copy("legacy"))
                  : null,
              ),
              h(
                "div",
                { style: field },
                h("p", { style: title }, copy("workingMemory")),
                h("p", { style: hint }, copy("workingHelp")),
                h(
                  "label",
                  { className: "rdsh-grid-field", style: gridField },
                  copy("tokenBudget"),
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
                  { style: checkGrid },
                  h(
                    "label",
                    { style: checkboxRow },
                    h("input", {
                      type: "checkbox",
                      checked: !!cx.enable_retriever,
                      onChange: (e) =>
                        setPath(
                          "context",
                          "enable_retriever",
                          e.target.checked,
                        ),
                    }),
                    copy("retriever"),
                  ),
                  h(
                    "label",
                    { style: checkboxRow },
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
                    { style: checkboxRow },
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
                    { style: checkboxRow },
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
                  { className: "rdsh-grid-2", style: grid2 },
                  h(
                    "label",
                    { className: "rdsh-grid-field", style: gridField },
                    copy("codeLimit"),
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
                    "label",
                    { className: "rdsh-grid-field", style: gridField },
                    copy("historyLimit"),
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
                  "label",
                  { style: field },
                  copy("goal"),
                  h("input", {
                    value: cx.goal || "",
                    placeholder: copy("goalPlaceholder"),
                    onChange: (e) => setPath("context", "goal", e.target.value),
                    style: input,
                  }),
                ),
                h(
                  "label",
                  { style: field },
                  copy("workingFiles"),
                  h("textarea", {
                    value: toLines(cx.working_files),
                    rows: 3,
                    onChange: (e) =>
                      setPath(
                        "context",
                        "working_files",
                        fromLines(e.target.value),
                      ),
                    style: { ...input, minHeight: 56 },
                  }),
                ),
                h(
                  "label",
                  { style: field },
                  copy("openTasks"),
                  h("textarea", {
                    value: toLines(cx.open_tasks),
                    rows: 3,
                    onChange: (e) =>
                      setPath("context", "open_tasks", e.target.value),
                    style: { ...input, minHeight: 56 },
                  }),
                ),
              ),
              h(
                "div",
                { style: field },
                h("p", { style: title }, copy("longMemory")),
                h("p", { style: hint }, copy("longHelp")),
                h(
                  "label",
                  { style: field },
                  copy("decisions"),
                  h("textarea", {
                    value: toLines(cx.decisions),
                    rows: 3,
                    onChange: (e) =>
                      setPath("context", "decisions", fromLines(e.target.value)),
                    style: { ...input, minHeight: 56 },
                  }),
                ),
                h(
                  "label",
                  { style: field },
                  copy("constraints"),
                  h("textarea", {
                    value: toLines(cx.constraints),
                    rows: 3,
                    onChange: (e) =>
                      setPath(
                        "context",
                        "constraints",
                        fromLines(e.target.value),
                      ),
                    style: { ...input, minHeight: 56 },
                  }),
                ),
              ),
            ),
            h("p", { style: hint }, copy("allHelp")),
          ),
          card(
            "details",
            copy("groupDetails"),
            copy("groupDetailsDesc"),
            openGroups.details,
            () => toggleOpen("details"),
            detailsSummary,
            pad(
              h(
                "div",
                { style: field },
                h("p", { style: title }, copy("allSettings")),
                h("p", { style: hint }, copy("general")),
                h(
                  "div",
                  { style: checkGrid },
                  h(
                    "label",
                    { style: checkboxRow },
                    h("input", {
                      type: "checkbox",
                      checked: !!g.slim,
                      onChange: (e) =>
                        setPath("general", "slim", e.target.checked),
                    }),
                    copy("slim"),
                  ),
                  h(
                    "label",
                    { style: checkboxRow },
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
                    { style: checkboxRow },
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
                  "label",
                  { style: field },
                  copy("defaultProfile"),
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
                  { style: field },
                  copy("language"),
                  h(
                    "select",
                    {
                      value: displayLanguage,
                      disabled: saving,
                      onChange: (e) =>
                        setPath("general", "language", e.target.value),
                      style: input,
                    },
                    h("option", { value: "auto" }, copy("auto")),
                    h("option", { value: "en" }, "English"),
                    h("option", { value: "zh-CN" }, "简体中文"),
                    h("option", { value: "ja" }, "日本語"),
                  ),
                ),
                h(
                  "label",
                  { className: "rdsh-grid-field", style: gridField },
                  copy("defaultBudget"),
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
              ),
              h(
                "div",
                { style: field },
                h("p", { style: title }, copy("search")),
                h(
                  "label",
                  { style: field },
                  copy("directory"),
                  h("input", {
                    value: se.dir || "",
                    onChange: (e) => setPath("search", "dir", e.target.value),
                    style: input,
                  }),
                ),
                h(
                  "div",
                  { className: "rdsh-grid-2", style: grid2 },
                  h(
                    "label",
                    { className: "rdsh-grid-field", style: gridField },
                    copy("maxResults"),
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
                    "label",
                    { className: "rdsh-grid-field", style: gridField },
                    copy("webLimit"),
                    h("input", {
                      type: "number",
                      min: 1,
                      max: 100,
                      value: se.web_limit,
                      onChange: (e) =>
                        num("search", "web_limit", e.target.value, 10),
                      style: { ...input, maxWidth: 110 },
                    }),
                  ),
                ),
                h(
                  "label",
                  { style: field },
                  copy("searxng"),
                  h("input", {
                    value: se.searxng_url || "",
                    placeholder: copy("unset"),
                    onChange: (e) =>
                      setPath("search", "searxng_url", e.target.value),
                    style: input,
                  }),
                ),
              ),
              h(
                "div",
                { style: field },
                h("p", { style: title }, copy("compact")),
                h(
                  "label",
                  { className: "rdsh-grid-field", style: gridField },
                  copy("maxTokens"),
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
                h("p", { style: title }, copy("sessions")),
                h(
                  "div",
                  { className: "rdsh-grid-2", style: grid2 },
                  h(
                    "label",
                    { className: "rdsh-grid-field", style: gridField },
                    copy("retention"),
                    h("input", {
                      type: "number",
                      min: 1,
                      max: 100,
                      value: ss.limit,
                      onChange: (e) =>
                        num("sessions", "limit", e.target.value, 20),
                      style: { ...input, maxWidth: 110 },
                    }),
                  ),
                  h(
                    "label",
                    { style: checkboxRow },
                    h("input", {
                      type: "checkbox",
                      checked: !!ss.with_tokens,
                      onChange: (e) =>
                        setPath("sessions", "with_tokens", e.target.checked),
                    }),
                    copy("withTokens"),
                  ),
                ),
                h("p", { style: title }, copy("logs")),
                h(
                  "label",
                  { className: "rdsh-grid-field", style: gridField },
                  copy("tail"),
                  h("input", {
                    type: "number",
                    min: 1,
                    max: 500,
                    value: lg2.tail,
                    onChange: (e) => num("logs", "tail", e.target.value, 50),
                    style: { ...input, maxWidth: 110 },
                  }),
                ),
                h("p", { style: title }, copy("server")),
                h(
                  "label",
                  { className: "rdsh-grid-field", style: gridField },
                  copy("port"),
                  h("input", {
                    type: "number",
                    min: 1,
                    max: 65535,
                    value: svv.port,
                    onChange: (e) => num("serve", "port", e.target.value, 38080),
                    style: { ...input, maxWidth: 110 },
                  }),
                ),
                h("p", { style: title }, copy("guard")),
                h(
                  "label",
                  { style: field },
                  copy("denyPaths"),
                  h("textarea", {
                    value: toLines(gu.deny),
                    rows: 2,
                    onChange: (e) =>
                      setPath("guard", "deny", fromLines(e.target.value)),
                    style: { ...input, minHeight: 44 },
                  }),
                ),
                h(
                  "label",
                  { style: field },
                  copy("reason"),
                  h("input", {
                    value: gu.reason || "",
                    onChange: (e) => setPath("guard", "reason", e.target.value),
                    style: input,
                  }),
                ),
                h("p", { style: title }, copy("benchmark")),
                h(
                  "label",
                  { className: "rdsh-grid-field", style: gridField },
                  copy("iterations"),
                  h("input", {
                    type: "number",
                    min: 1,
                    max: 20,
                    value: be.n,
                    onChange: (e) => num("bench", "n", e.target.value, 5),
                    style: { ...input, maxWidth: 110 },
                  }),
                ),
                h("p", { style: title }, copy("setup")),
                h(
                  "label",
                  { className: "rdsh-grid-field", style: gridField },
                  copy("webPort"),
                  h("input", {
                    type: "number",
                    min: 0,
                    max: 65535,
                    value: su.web_port,
                    onChange: (e) =>
                      num("setup", "web_port", e.target.value, 0),
                    style: { ...input, maxWidth: 110 },
                  }),
                ),
              ),
            ),
          ),
        ),
        h(
          "div",
          {
            style: {
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            },
          },
          h(
            "button",
            {
              type: "button",
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
              type: "button",
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
      inject: ['slots', 'locale'],
      apply(ctx) {
        registerJapaneseLocale(ctx);
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'rdsh',
          order: 20,
          label: () => 'rdsh',
          inject: () => ({}),
        }, RdshSection));
      },
    };
  },
});

;
// rdsh-ui-controls: DSH Web側には /rdsh-ui-controls.css ルートが無いため、共有コントロールCSSをこの場で注入する
if (typeof document !== 'undefined' && !document.getElementById('rdsh-ui-controls')) {
  const style = document.createElement('style');
  style.id = 'rdsh-ui-controls';
  style.textContent = `/* Shared browser controls: DSH, native serve/setup and the project dashboard. */
:root {
  --rdsh-control-accent: var(--dsw-alias-button-primary-fill, var(--acc, var(--blue, #386ed6)));
  --rdsh-control-thumb: var(--dsw-alias-label-tertiary, var(--mut, #8b949e));
  --rdsh-control-track: var(--dsw-alias-border-l3, var(--line, #30363d));
  --rdsh-control-surface: var(--dsw-alias-bg-module-platform, var(--card, #161b22));
}
* {
  scrollbar-width: thin;
  scrollbar-color: var(--rdsh-control-thumb) transparent;
}
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-track, *::-webkit-scrollbar-corner { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: var(--rdsh-control-thumb);
  background-clip: content-box;
  border: 3px solid transparent;
  border-radius: 10px;
}
*::-webkit-scrollbar-thumb:hover { background-color: var(--rdsh-control-accent); }
input[type="range"] {
  appearance: none;
  -webkit-appearance: none;
  min-width: 0;
  height: 32px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  accent-color: var(--rdsh-control-accent);
}
input[type="range"]::-webkit-slider-runnable-track {
  height: 4px; border-radius: 4px; background: var(--rdsh-control-track);
}
input[type="range"]::-moz-range-track {
  height: 4px; border-radius: 4px; background: var(--rdsh-control-track);
}
input[type="range"]::-moz-range-progress {
  height: 4px; border-radius: 4px; background: var(--rdsh-control-accent);
}
input[type="range"]::-webkit-slider-thumb {
  appearance: none; -webkit-appearance: none;
  width: 18px; height: 18px; margin-top: -7px;
  border: 2px solid var(--rdsh-control-surface); border-radius: 50%;
  background: var(--rdsh-control-accent);
}
input[type="range"]::-moz-range-thumb {
  box-sizing: border-box; width: 18px; height: 18px;
  border: 2px solid var(--rdsh-control-surface); border-radius: 50%;
  background: var(--rdsh-control-accent);
}
input[type="range"]:focus-visible {
  outline: 2px solid var(--rdsh-control-accent); outline-offset: 3px;
}
input[type="range"]:disabled { opacity: .45; cursor: not-allowed; }
@media (forced-colors: active) {
  * { scrollbar-color: auto; }
  input[type="range"] { appearance: auto; -webkit-appearance: auto; }
}
`;
  document.head.append(style);
}
