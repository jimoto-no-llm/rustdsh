/**
 * dsh-mobile-maxxing — UI copy, in one place.
 *
 * The package used to ship Japanese literals in `client.js`, `sw.js` and
 * `notify/host.js` while the shell it decorates is served in `en`. This module
 * is the single source of those strings: the host half injects the table into
 * the page (`globalThis.__RDSH_PWA_COPY__`) and the service worker config, so
 * no UI copy lives in the code that renders it.
 *
 * `en` is complete and is the authoritative key list. `ja` carries every one
 * of those keys with the reference build's Japanese copy; a later key only has
 * to be assigned in both packs. Every lookup still falls back to `en` per key,
 * so a partially filled pack is safe.
 *
 * `PROBES` is different: those are *upstream* labels this plugin matches to
 * find controls, not text it renders. They stay bilingual on purpose so a
 * future `ja` shell keeps working. Do not translate them; add a locale.
 *
 * @module dsh-mobile-maxxing/copy
 */

/** Every string this package renders, keyed by namespace. */
export const COPY = {
	en: {
		// --- manifest -------------------------------------------------------
		"manifest.description": "Launch DeepSeek Harness as an app.",
		"manifest.screenshot.chat": "Chat",
		"manifest.screenshot.desktop": "Desktop view",

		// --- settings tabs --------------------------------------------------
		"tab.mobile": "Mobile",
		"tab.update": "Updates",
		"update.confirm": "Check for updates from this repository?",
		"update.no": "No",
		"update.yes": "Yes",
		"update.checking": "Checking for updates…",
		"update.latest": "You have the latest release",
		"update.ahead": "Your installed version is newer than the latest release",
		"update.available": "An update is available",
		"update.install": "Update",
		"update.cancel": "Cancel",
		"update.installing": "Updating…",
		"update.done": "Update complete",
		"update.restart": "Close and reopen the app. If the update does not appear, restart DSH.",
		"update.close": "Close",
		"update.failed": "Update check failed",
		"update.installFailed": "Update failed",
		"update.release": "Release {version}",
		"mobile.other": "Other settings",
		"mobile.notifications": "Notifications",
		"mobile.access": "Access mode",
		"mobile.accessScope": "Applies to new sessions on this device.",
		"mobile.enabled": "Push notifications: enabled",
		"mobile.disabled": "Push notifications: not enabled",
		"mobile.unsupported": "Push notifications are not supported here",
		"mobile.soundScope": "Plays while the app is open.",

		// --- local display -------------------------------------------------
		"localDisplay.title": "Display",
		"localDisplay.desc": "Text, code and terminal sizes, plus a terminal-only dark palette, for this device. These choices stay in this browser.",
		"localDisplay.resetFonts": "Reset font sizes to default",
		"localDisplay.text": "Body text",
		"localDisplay.code": "Code",
		"localDisplay.terminal": "Terminal",
		"localDisplay.subagent": "Subagent",
		"localDisplay.terminalDark": "Dark terminal only",
		"localDisplay.terminalDark.note": "Keeps the terminal dark while the surrounding UI and the shared theme stay unchanged. Saved in this browser only.",
		"localDisplay.language": "Display language",
		"localDisplay.language.system": "System",
		"localDisplay.language.note": "System follows this device's language when DSH has a pack for it, and the shared Host language otherwise. The choice stays on this device and never changes the shared Host setting.",
		"localDisplay.note": "Saved only in this browser. Other devices keep their own display choices.",
		"localDisplay.unavailable": "Not adjustable here ({reason})",
		"localDisplay.reason.themeMissing": "The theme service is not available.",
		"localDisplay.reason.themeShape": "The theme service does not expose mutable font sizes.",
		"localDisplay.reason.localeMissing": "The locale service is not available.",
		"localDisplay.reason.localeShape": "The locale service does not expose a mutable locale.",
		"localDisplay.reason.noLocales": "No display language is registered.",

		// --- activity popover (#82) -----------------------------------------
		"activityPanel.sort.running": "Running first",
		"activityPanel.sort.running.aria": "Sort running first",

		// --- terminal key row ----------------------------------------------
		"terminalKeys.label": "Terminal keys",
		"terminalKeys.esc": "Esc",
		"terminalKeys.escape": "Escape",
		"terminalKeys.tab": "Tab",
		"terminalKeys.up": "↑",
		"terminalKeys.down": "↓",
		"terminalKeys.left": "←",
		"terminalKeys.right": "→",
		"terminalKeys.arrowUp": "Arrow up",
		"terminalKeys.arrowDown": "Arrow down",
		"terminalKeys.arrowLeft": "Arrow left",
		"terminalKeys.arrowRight": "Arrow right",
		"terminalKeys.ctrl": "Ctrl",
		"terminalKeys.control": "Control",
		"terminalKeys.menu": "Menu",
		"terminalKeys.virtualWindow": "Virtual window",
		"terminalKeys.scale": "Scale",
		"mux.floatingWindows": "Floating windows",
		"mux.showWindow": "Show in window",

		// --- PWA section ----------------------------------------------------
		"pwa.install.promptable": "Install DSH as an app",
		"pwa.install.iosHint": "Add it to your Home Screen from Safari's Share menu",
		"pwa.install.button": "Install",
		"pwa.install.title": "Install as an app",
		"pwa.later": "Later",
		"pwa.update.available": "A new version is available",
		"pwa.update.reload": "Reload",
		"pwa.offline": "Offline — waiting to reconnect",
		"pwa.sw.activeUpdate": "Active (update pending)",
		"pwa.sw.active": "Active",
		"pwa.sw.unsupported": "Not supported in this browser",
		"pwa.sw.insecure": "Off (requires HTTPS or localhost)",
		"pwa.sw.shared": "Controlled by another service worker (cache off)",
		"pwa.sw.error": "Registration failed",
		"pwa.sw.pending": "Preparing",
		"pwa.install.state.standalone": "Installed (running as an app)",
		"pwa.install.state.installable": "Available",
		"pwa.install.state.ios": "Safari Share menu → Add to Home Screen",
		"pwa.install.state.insecure": "Open over HTTPS to install",
		"pwa.install.state.unsupported": "Not available in this browser",
		"pwa.install.accepted": "Installed.",
		"pwa.install.dismissed": "Cancelled.",
		"pwa.install.unavailable": "The install prompt is not available in this environment.",
		"pwa.check.noWorker": "No service worker is registered.",
		"pwa.check.available": "A new version is available.",
		"pwa.check.latest": "Up to date.",
		"pwa.check.failed": "Could not check (you may be offline).",
		"pwa.section.title": "App (PWA)",
		"pwa.section.desc": "Launches DSH in its own app window and keeps the screen available offline.",
		"pwa.row.displayMode": "Display mode",
		"pwa.row.displayMode.standalone": "App (standalone)",
		"pwa.row.displayMode.browser": "Browser",
		"pwa.row.install": "Install",
		"pwa.row.offline": "Offline launch",
		"pwa.row.build": "Build",
		"pwa.action.reloadUpdate": "Reload to update",
		"pwa.action.checking": "Checking…",
		"pwa.action.check": "Check for updates",
		"pwa.action.updatePlugins": "Update plugins",
		"pwa.action.updatingPlugins": "Updating plugins…",
		"pwa.note.pluginsUpdated": "Plugins updated. Reload to apply.",
		"pwa.note.pluginsLatest": "Plugins are up to date.",
		"pwa.note.pluginsUpdateFailed": "Plugin update failed: {error}",
		"pwa.note.ios": "iPhone / iPad: choose Add to Home Screen from Safari's Share button to launch it as an app.",
		"pwa.note.insecure": "Offline launch and installation work only over HTTPS or localhost.",
		"pwa.note.swError": "Service worker registration failed: {error}",
		"pwa.note.bootError": "Boot error: {error}",

		// --- mobile settings -------------------------------------------------
		"mux.nav.scrollLeft": "Scroll settings tabs left",
		"mux.nav.scrollRight": "Scroll settings tabs right",
		"mux.stats.turn": "{count} turn",
		"mux.stats.turns": "{count} turns",
		"mux.stats.tokPerSec": "{speed} tok/s",
		"mux.stats.cacheHit": "Cache hit {percent}%",
		"mux.settingsRow": "Settings",
		"mux.navMore": "More",
		"mux.navMore.menu": "More actions",
		"mux.fab.open": "Open session list",
		"mux.fab.openWithCount": "Open session list ({count} unread or waiting)",
		"mux.route.back": "Back",
		"mux.toast.noFileInput": "No file input is available for attachments",
		"mux.detail.todo": "Todo",
		"mux.detail.goal": "Goal",
		"mux.section.title": "Mobile UI",
		"mux.section.desc": "Adapts the layout and controls to phone width. Settings are stored in this browser.",
		"mux.section.desc.desktop": "The phone layout and its controls apply only on a phone or in the installed app. This desktop window keeps the stock layout.",
		"mux.section.plusNote": "+ opens image and file attachments only (commands start with /).",
		"mux.deviceTheme.title": "Theme (this device only)",
		"mux.deviceTheme.desc": "Pick a palette for this browser alone. The choice is saved here and does not affect your other devices.",
		"mux.deviceTheme.label": "Palette",
		"mux.deviceTheme.note": "The shared theme lives in Settings → General → Appearance. A choice here overrides it on this device only.",
		"mux.deviceTheme.custom": "A custom (registered) theme is active, so the per-device override is disabled.",
		"mux.deviceTheme.unsupported": "This DSH version could not apply a per-device palette, so the shared theme stays.",
		"mux.deviceTheme.follow": "Follow the shared theme",
		"mux.deviceTheme.light": "Light",
		"mux.deviceTheme.dark": "Dark",
		"mux.deviceTheme.system": "Match this device",
		"mux.action.enable": "Enable notifications",
		"mux.action.reRegister": "Re-register notifications",
		"mux.action.test": "Test notification",
		"mux.action.disable": "Turn off notifications",
		"mux.message.enabled": "Notifications enabled.",
		"mux.message.testSent": "Test notification sent (via push).",
		"mux.message.disabled": "Notifications turned off.",
		"mux.note.blocked": "Notifications are blocked. Set Notifications to Allow in this site's browser settings.",
		"mux.sound.title": "Notification sound",
		"mux.sound.desc": "Plays while the app is open. The browser synthesises the sound, so no audio files are needed.",
		"mux.sound.preview": "Preview",
		"mux.sound.volume": "Volume",
		"mux.sound.none": "None",
		"mux.sound.chime": "Chime",
		"mux.sound.pop": "Pop",
		"mux.sound.drop": "Drop",
		"mux.sound.tick": "Tick",
		"mux.note.notifyScope": "Notifies on turn end and questions. Only the main agent is covered. By default, only turns sent from this phone are notified.",

		// --- device-local chat policy (this phone only) ----------------------
		"localChat.title": "Chat view (this device)",
		"localChat.desc": "Applies to this device only. The Host configuration is not changed.",
		"localChat.note": "A row you have not changed follows the Host setting.",
		"localChat.followHost": "Follow Host setting",
		"localChat.unavailable": "Not adjustable here ({reason})",
		"localChat.workDetails": "Work details",
		"localChat.workDetails.compact": "Compact",
		"localChat.workDetails.standard": "Standard",
		"localChat.workDetails.detailed": "Detailed",
		"localChat.workDetails.verbose": "Verbose",
		"localChat.collapse": "Collapse completed turns",
		"localChat.collapse.completion": "On completion",
		"localChat.collapse.next-input": "On the next input",
		"localChat.busyEnter": "Enter while a turn runs",
		"localChat.busyEnter.queue": "Queue",
		"localChat.busyEnter.steer": "Steer",
		"localChat.performance": "Performance detail",
		"localChat.performance.compact": "Compact",
		"localChat.performance.detailed": "Detailed",
		"localPermission.title": "Default permission (this device only)",
		"localPermission.desc": "Applied to new sessions started on this device. The shared default and your other devices are untouched.",
		"localPermission.label": "Preset",
		"localPermission.follow": "Follow the shared default",
		"localPermission.shared": "Shared default: {preset}",
		"localPermission.hostNote": "The session records this preset in its own log; the host configuration is never written from here.",
		"localPermission.saved": "Saved for this browser. It applies to the next session you start here.",
		"localPermission.readOnly": "Read only",
		"localPermission.workspaceWrite": "Workspace write",
		"localPermission.fullAccess": "Full access",
		"localPermission.auto": "Auto review",
		"localPermission.unavailable": "This DSH build does not expose the permission catalog, so the per-device default is unavailable.",
		"localPermission.unavailableDetail": "Could not read the permission catalog: {error}",
		"localPermission.unsupported": "The host offers no /permission command",
		"localPermission.applyFailed": "The preset could not be applied to the new session: {error}",
		"localPermission.applying": "Applying this device's permission default…",
		"mux.preview.more": "More preview actions",
		"mux.preview.menu": "Preview actions",
		"mux.bootError": "Boot error: {error}",
		"mux.input.title": "Input",
		"mux.input.desc": "Choose what Enter does in the message composer.",
		"mux.input.enterToSend": "Enter sends (off means a newline)",
		"mux.input.current.enterSends": "Currently: Enter sends, Shift+Enter adds a newline.",
		"mux.input.current.enterNewline": "Currently: Enter adds a newline. Send with the send button (Shift+Enter also adds a newline).",
		"mux.liveSpeed.title": "Output speed (estimated from stream deltas)",
		"mux.liveSpeed.aria": "Estimated speed {speed} tok/s",

		// --- session frame palette ------------------------------------------
		"frame.menu": "Color frame",
		"frame.paletteAria": "Frame color",
		"frame.paletteTitle": "Frame color",
		"frame.color.blue": "Blue",
		"frame.color.green": "Green",
		"frame.color.amber": "Amber",
		"frame.color.red": "Red",
		"frame.color.purple": "Purple",
		"frame.color.pink": "Pink",
		"frame.applied": "Frame color set to {color}",
		"frame.clear": "Remove frame",
		"frame.cleared": "Frame removed",

		// --- image crop ------------------------------------------------------
		"crop.aria": "Crop image",
		"crop.title": "Crop image",
		"crop.rotateLeft": "Rotate left 90°",
		"crop.rotateRight": "Rotate right 90°",
		"crop.close": "Close cropping",
		"crop.cancel": "Cancel",
		"crop.save": "Add to query",
		"crop.addFailed": "Could not add the image to the query",
		"crop.updated": "Updated the image in the query",
		"crop.added": "Cropped image added to the query",

		// --- notifications ---------------------------------------------------
		"notify.unsupported": "This browser does not support notifications",
		"notify.permissionMissing": "Notification permission was not granted",
		"notify.unavailable": "Push notifications are unavailable right now",
		"notify.subscribeFailed": "Could not save the subscription ({status})",
		"notify.unknownError": "Unknown error",
		"notify.rejected": "Push was rejected ({detail})",
		"notify.testTitle": "DSH test notification",
		"notify.testBody": "This banner is how it arrives while the app is open.",
		"notify.testLocalBody": "Notifications are on. Agent questions will arrive here.",
		"notify.noWorker": "No service worker is registered",
		"notify.notSubscribed": "Notifications are not enabled on this device",
		"notify.open": "Open",
		"notify.permission.unsupported": "Not supported in this browser",
		"notify.permission.granted": "On (subscribed)",
		"notify.permission.allowed": "Allowed (not subscribed)",
		"notify.permission.blocked": "Blocked (allow notifications in browser settings)",
		"notify.permission.default": "Not allowed yet",
		"notify.turn.completed": "Work finished",
		"notify.turn.max-tokens": "Work finished (token limit)",
		"notify.turn.blocked": "Stopped (declined)",
		"notify.turn.error": "Stopped with an error",
		"notify.turn.aborted": "Stopped (interrupted)",
		"notify.turn.other": "Turn ended ({kind})",
		"notify.turn.detailCompleted": "The work finished.",
		"notify.turn.detailReason": "End reason: {kind}",
		"notify.questionHeader": "Confirm",
		"notify.questionMore": "(+{count} more)",
		"notify.previewQuestion": "Continue as is?",
		"notify.testPayloadBody": "Tap to open this session.",

		// --- agent question card ---------------------------------------------
		"question.selectRequired": "Select at least one option to continue.",

		// --- composer / session menu ----------------------------------------
		"add.label": "Add image or file",
		"add.stock": "Add files or run commands",

		// --- workspace picker / right-panel files ---------------------------
		"workspace.search.placeholder": "Search workspaces",
		"workspace.search.noMatches": "No matches",
		"files.search.placeholder": "Search this folder",
		"files.search.submit": "Search this folder",
		"files.search.clear": "Clear search",
		"files.search.noMatches": "No matches",
		"files.menu.root": "Folder path",
		"files.menu.entry": "File actions",
		"files.menu.copyPath": "Copy path",
		"files.menu.copyName": "Copy name",
		"files.copied": "Copied",

		// --- service worker --------------------------------------------------
		"sw.documentTitle": "Offline — DSH",
		"sw.offlineHeading": "You're offline",
		"sw.offlineBody1": "Could not reach the DSH server.",
		"sw.offlineBody2": "Check your network connection.",
		"sw.retry": "Retry",
		"sw.pushTitle": "DSH",
		"sw.pushBody": "You have a new notification",
		"sw.open": "Open",
	},

	/**
	 * Japanese pack: the reference build's copy, restored key for key.
	 * Every key of `COPY.en` is present; `copyFor("ja")` therefore never falls
	 * back to English. The English dictionary stays authoritative for the key
	 * list, so a new key is a visible test failure until both packs carry it.
	 */
	ja: {
		// --- manifest -------------------------------------------------------
		"manifest.description": "DeepSeek Harness をアプリのように起動します。",
		"manifest.screenshot.chat": "チャット画面",
		"manifest.screenshot.desktop": "デスクトップ表示",

		// --- settings tabs --------------------------------------------------
		"tab.mobile": "モバイル",
		"tab.update": "更新",
		"update.confirm": "以下のリポジトリから更新を確認しますか？",
		"update.no": "いいえ",
		"update.yes": "はい",
		"update.checking": "更新を確認しています…",
		"update.latest": "最新バージョンです",
		"update.ahead": "公開中の最新リリースより新しいバージョンです",
		"update.available": "更新があります",
		"update.install": "更新する",
		"update.cancel": "キャンセル",
		"update.installing": "更新しています…",
		"update.done": "更新完了",
		"update.restart": "アプリを終了し、開き直してください。反映されない場合はDSHを再起動してください。",
		"update.close": "閉じる",
		"update.failed": "更新を確認できませんでした",
		"update.installFailed": "更新できませんでした",
		"update.release": "リリース {version}",
		"mobile.other": "その他の設定",
		"mobile.notifications": "通知",
		"mobile.access": "アクセスモード",
		"mobile.accessScope": "この端末で新しく始めるセッションに適用します。",
		"mobile.enabled": "プッシュ通知：有効",
		"mobile.disabled": "プッシュ通知：無効",
		"mobile.unsupported": "この環境ではプッシュ通知を利用できません",
		"mobile.soundScope": "アプリを開いているときに鳴ります。",

		// --- local display -------------------------------------------------
		"localDisplay.title": "表示",
		"localDisplay.desc": "この端末の本文・コード・ターミナルの文字サイズと、ターミナルだけのダーク配色です。設定はこのブラウザだけに保存されます。",
		"localDisplay.resetFonts": "文字サイズをデフォルトに戻す",
		"localDisplay.text": "本文",
		"localDisplay.code": "コード",
		"localDisplay.terminal": "ターミナル",
		"localDisplay.subagent": "サブエージェント",
		"localDisplay.terminalDark": "ターミナルだけダーク",
		"localDisplay.terminalDark.note": "周囲の画面と共有テーマは変えず、ターミナルだけを暗い配色にします。このブラウザにだけ保存されます。",
		"localDisplay.language": "表示言語",
		"localDisplay.language.system": "システム",
		"localDisplay.language.note": "「システム」は、対応する言語パックがある場合はこの端末の言語に従います。無ければ共有のホスト言語に従います。設定はこの端末にだけ保存され、共有のホスト設定は変更しません。",
		"localDisplay.note": "このブラウザだけに保存されます。他の端末の表示設定は変わりません。",
		"localDisplay.unavailable": "ここでは変更できません（{reason}）",
		"localDisplay.reason.themeMissing": "テーマサービスがありません。",
		"localDisplay.reason.themeShape": "テーマサービスが文字サイズの変更に対応していません。",
		"localDisplay.reason.localeMissing": "ロケールサービスがありません。",
		"localDisplay.reason.localeShape": "ロケールサービスが表示言語の変更に対応していません。",
		"localDisplay.reason.noLocales": "表示言語が登録されていません。",

		// --- activity popover (#82) -----------------------------------------
		"activityPanel.sort.running": "実行中を上に",
		"activityPanel.sort.running.aria": "実行中を上に並べ替え",

		// --- terminal key row ----------------------------------------------
		"terminalKeys.label": "ターミナルキー",
		"terminalKeys.esc": "Esc",
		"terminalKeys.escape": "エスケープ",
		"terminalKeys.tab": "Tab",
		"terminalKeys.up": "↑",
		"terminalKeys.down": "↓",
		"terminalKeys.left": "←",
		"terminalKeys.right": "→",
		"terminalKeys.arrowUp": "上矢印",
		"terminalKeys.arrowDown": "下矢印",
		"terminalKeys.arrowLeft": "左矢印",
		"terminalKeys.arrowRight": "右矢印",
		"terminalKeys.ctrl": "Ctrl",
		"terminalKeys.control": "コントロール",
		"terminalKeys.menu": "メニュー",
		"terminalKeys.virtualWindow": "仮想ウィンドウ",
		"terminalKeys.scale": "縮尺",
		"mux.floatingWindows": "フロートウィンドウ",
		"mux.showWindow": "ウィンドウで表示",

		// --- PWA section ----------------------------------------------------
		"pwa.install.promptable": "DSH をアプリとしてインストールできます",
		"pwa.install.iosHint": "Safari の共有 → 「ホーム画面に追加」でアプリにできます",
		"pwa.install.button": "インストール",
		"pwa.install.title": "アプリとしてインストール",
		"pwa.later": "あとで",
		"pwa.update.available": "新しいバージョンがあります",
		"pwa.update.reload": "再読み込み",
		"pwa.offline": "オフライン — 再接続を待っています",
		"pwa.sw.activeUpdate": "有効（更新待ち）",
		"pwa.sw.active": "有効",
		"pwa.sw.unsupported": "このブラウザは非対応",
		"pwa.sw.insecure": "無効（HTTPS または localhost で有効）",
		"pwa.sw.shared": "他のサービスワーカーが制御中（キャッシュ無効）",
		"pwa.sw.error": "登録に失敗",
		"pwa.sw.pending": "準備中",
		"pwa.install.state.standalone": "インストール済み（アプリとして起動中）",
		"pwa.install.state.installable": "インストールできます",
		"pwa.install.state.ios": "Safari の共有メニュー →「ホーム画面に追加」",
		"pwa.install.state.insecure": "HTTPS で開くとインストールできます",
		"pwa.install.state.unsupported": "このブラウザでは未対応",
		"pwa.install.accepted": "インストールしました。",
		"pwa.install.dismissed": "キャンセルしました。",
		"pwa.install.unavailable": "この環境ではプロンプトを出せません。",
		"pwa.check.noWorker": "サービスワーカーが未登録です。",
		"pwa.check.available": "新しいバージョンがあります。",
		"pwa.check.latest": "最新です。",
		"pwa.check.failed": "確認できませんでした（オフラインの可能性があります）。",
		"pwa.section.title": "アプリ（PWA）",
		"pwa.section.desc": "DSH を独立したアプリウィンドウで起動し、オフライン時も画面を表示できるようにします。",
		"pwa.row.displayMode": "表示モード",
		"pwa.row.displayMode.standalone": "アプリ（スタンドアロン）",
		"pwa.row.displayMode.browser": "ブラウザ",
		"pwa.row.install": "インストール",
		"pwa.row.offline": "オフライン起動",
		"pwa.row.build": "ビルド",
		"pwa.action.reloadUpdate": "再読み込みして更新",
		"pwa.action.checking": "確認中…",
		"pwa.action.check": "更新を確認",
		"pwa.action.updatePlugins": "プラグインを更新",
		"pwa.action.updatingPlugins": "プラグインを更新中…",
		"pwa.note.pluginsUpdated": "プラグインを更新しました。再読み込みで反映されます。",
		"pwa.note.pluginsLatest": "プラグインは最新です。",
		"pwa.note.pluginsUpdateFailed": "プラグインの更新に失敗しました: {error}",
		"pwa.note.ios": "iPhone / iPad: Safari の共有ボタンから「ホーム画面に追加」を選ぶと、アプリとして起動できます。",
		"pwa.note.insecure": "オフライン起動とインストールは HTTPS または localhost でのみ有効になります。",
		"pwa.note.swError": "サービスワーカーの登録に失敗しました: {error}",
		"pwa.note.bootError": "起動時にエラーが発生しました: {error}",

		// --- mobile settings -------------------------------------------------
		"mux.nav.scrollLeft": "設定タブを左へスクロール",
		"mux.nav.scrollRight": "設定タブを右へスクロール",
		"mux.stats.turn": "{count} turn",
		"mux.stats.turns": "{count} turns",
		"mux.stats.tokPerSec": "{speed} tok/s",
		"mux.stats.cacheHit": "Cache hit {percent}%",
		"mux.settingsRow": "Settings",
		"mux.navMore": "その他",
		"mux.navMore.menu": "その他の操作",
		"mux.fab.open": "セッション一覧を開く",
		"mux.fab.openWithCount": "セッション一覧を開く（未読・質問待ち {count}件）",
		"mux.route.back": "戻る",
		"mux.toast.noFileInput": "添付できるファイル入力がありません",
		"mux.detail.todo": "Todo",
		"mux.detail.goal": "Goal",
		"mux.section.title": "モバイルUI",
		"mux.section.desc": "スマホ幅の表示と操作を整えます。設定はこのブラウザに保存されます。",
		"mux.section.desc.desktop": "スマホ用レイアウトとその操作はスマホまたはインストールしたアプリでのみ有効です。このデスクトップウィンドウは標準レイアウトのままです。",
		"mux.section.plusNote": "＋ は画像とファイルの添付だけを開きます（コマンドは / から）。",
		"mux.deviceTheme.title": "テーマ（この端末のみ）",
		"mux.deviceTheme.desc": "このブラウザだけで使う配色を選びます。選択はここに保存され、他の端末には影響しません。",
		"mux.deviceTheme.label": "配色",
		"mux.deviceTheme.note": "共有テーマは 設定 → 一般 → 外観 にあります。ここでの選択はこの端末だけ上書きします。",
		"mux.deviceTheme.custom": "カスタム（登録済み）テーマが有効なため、端末別の上書きは無効です。",
		"mux.deviceTheme.unsupported": "この DSH では端末別の配色を適用できなかったため、共有テーマのままです。",
		"mux.deviceTheme.follow": "共有テーマに合わせる",
		"mux.deviceTheme.light": "ライト",
		"mux.deviceTheme.dark": "ダーク",
		"mux.deviceTheme.system": "この端末に合わせる",
		"mux.action.enable": "通知を有効にする",
		"mux.action.reRegister": "通知を再登録",
		"mux.action.test": "テスト通知",
		"mux.action.disable": "通知を解除",
		"mux.message.enabled": "通知を有効にしました。",
		"mux.message.testSent": "テスト通知を送りました（プッシュ経由）。",
		"mux.message.disabled": "通知を解除しました。",
		"mux.note.blocked": "通知がブロックされています。ブラウザのサイト設定 → 通知 を「許可」に変更してください。",
		"mux.sound.title": "通知音",
		"mux.sound.desc": "アプリを開いているときに鳴ります。音はブラウザが合成するので、音声ファイルは不要です。",
		"mux.sound.preview": "試聴",
		"mux.sound.volume": "音量",
		"mux.sound.none": "なし",
		"mux.sound.chime": "チャイム",
		"mux.sound.pop": "ポップ",
		"mux.sound.drop": "ドロップ",
		"mux.sound.tick": "タップ",
		"mux.note.notifyScope": "回答終了時と質問時に通知します。メインエージェントのみ、このスマホから送ったターンだけが対象です。",

		// --- この端末だけのチャット表示 ------------------------------------
		"localChat.title": "チャット表示（この端末）",
		"localChat.desc": "この端末にだけ適用します。ホストの設定は変更しません。",
		"localChat.note": "変更していない項目はホストの設定に従います。",
		"localChat.followHost": "ホスト設定に従う",
		"localChat.unavailable": "この環境では変更できません（{reason}）",
		"localChat.workDetails": "作業の詳細",
		"localChat.workDetails.compact": "コンパクト",
		"localChat.workDetails.standard": "標準",
		"localChat.workDetails.detailed": "詳細",
		"localChat.workDetails.verbose": "冗長",
		"localChat.collapse": "完了ターンの折りたたみ",
		"localChat.collapse.completion": "完了時",
		"localChat.collapse.next-input": "次の入力時",
		"localChat.busyEnter": "実行中の Enter",
		"localChat.busyEnter.queue": "キューに追加",
		"localChat.busyEnter.steer": "割り込み送信",
		"localChat.performance": "性能表示",
		"localChat.performance.compact": "コンパクト",
		"localChat.performance.detailed": "詳細",
		"localPermission.title": "権限の既定（この端末のみ）",
		"localPermission.desc": "この端末で始める新しいセッションに適用します。共有の既定と他の端末は変わりません。",
		"localPermission.label": "プリセット",
		"localPermission.follow": "共有の既定に従う",
		"localPermission.shared": "共有の既定: {preset}",
		"localPermission.hostNote": "選んだプリセットはセッション自身のログに記録されます。ここからホストの設定は書き換えません。",
		"localPermission.saved": "このブラウザに保存しました。次にここで始めるセッションから適用されます。",
		"localPermission.readOnly": "読み取りのみ",
		"localPermission.workspaceWrite": "ワークスペース内の変更",
		"localPermission.fullAccess": "完全アクセス",
		"localPermission.auto": "自動レビュー",
		"localPermission.unavailable": "この DSH では権限カタログが公開されていないため、端末別の既定は使えません。",
		"localPermission.unavailableDetail": "権限カタログを読めませんでした: {error}",
		"localPermission.unsupported": "ホストに /permission コマンドがありません",
		"localPermission.applyFailed": "新しいセッションにプリセットを適用できませんでした: {error}",
		"localPermission.applying": "この端末の権限の既定を適用しています…",
		"mux.preview.more": "プレビューのその他の操作",
		"mux.preview.menu": "プレビューの操作",
		"mux.bootError": "起動時エラー: {error}",
		"mux.input.title": "入力",
		"mux.input.desc": "メッセージ入力欄で Enter を押したときの動作を選びます。",
		"mux.input.enterToSend": "Enterで送信する（OFFなら改行）",
		"mux.input.current.enterSends": "現在: Enter で送信、Shift+Enter で改行。",
		"mux.input.current.enterNewline": "現在: Enter で改行。送信は送信ボタンから（Shift+Enter も改行）。",
		"mux.liveSpeed.title": "出力速度（ストリーム差分からの概算）",
		"mux.liveSpeed.aria": "推定速度 {speed} tok/s",

		// --- session frame palette ------------------------------------------
		"frame.menu": "色枠",
		"frame.paletteAria": "枠の色",
		"frame.paletteTitle": "枠の色",
		"frame.color.blue": "ブルー",
		"frame.color.green": "グリーン",
		"frame.color.amber": "アンバー",
		"frame.color.red": "レッド",
		"frame.color.purple": "パープル",
		"frame.color.pink": "ピンク",
		"frame.applied": "枠の色を{color}にしました",
		"frame.clear": "枠を外す",
		"frame.cleared": "枠を外しました",

		// --- image crop ------------------------------------------------------
		"crop.aria": "画像をトリミング",
		"crop.title": "画像をトリミング",
		"crop.rotateLeft": "左に90度回転",
		"crop.rotateRight": "右に90度回転",
		"crop.close": "トリミングを閉じる",
		"crop.cancel": "キャンセル",
		"crop.save": "クエリに追加",
		"crop.addFailed": "クエリに画像を追加できませんでした",
		"crop.updated": "編集した画像をクエリに反映しました",
		"crop.added": "トリミングした画像をクエリに追加しました",

		// --- notifications ---------------------------------------------------
		"notify.unsupported": "このブラウザは通知に対応していません",
		"notify.permissionMissing": "通知の許可が得られませんでした",
		"notify.unavailable": "プッシュ通知を利用できません",
		"notify.subscribeFailed": "購読を保存できませんでした（{status}）",
		"notify.unknownError": "不明なエラー",
		"notify.rejected": "プッシュが拒否されました（{detail}）",
		"notify.testTitle": "DSH のテスト通知",
		"notify.testBody": "アプリを開いているときは、このバナーで届きます。",
		"notify.testLocalBody": "通知が有効です。エージェントが質問したときにここへ届きます。",
		"notify.noWorker": "サービスワーカーが未登録です",
		"notify.notSubscribed": "この端末では通知が有効になっていません",
		"notify.open": "開く",
		"notify.permission.unsupported": "このブラウザは非対応",
		"notify.permission.granted": "有効（購読済み）",
		"notify.permission.allowed": "許可済み（未購読）",
		"notify.permission.blocked": "ブロックされています（ブラウザ設定から許可）",
		"notify.permission.default": "未許可",
		"notify.turn.completed": "作業完了",
		"notify.turn.max-tokens": "作業完了 (トークン上限)",
		"notify.turn.blocked": "停止 (拒否されました)",
		"notify.turn.error": "エラーで停止",
		"notify.turn.aborted": "停止 (中断)",
		"notify.turn.other": "ターン終了 ({kind})",
		"notify.turn.detailCompleted": "作業が完了しました。",
		"notify.turn.detailReason": "終了理由: {kind}",
		"notify.questionHeader": "確認",
		"notify.questionMore": "（他 {count} 件）",
		"notify.previewQuestion": "このまま進めますか？",
		"notify.testPayloadBody": "タップするとこのセッションが開きます。",

		// --- agent question card ---------------------------------------------
		"question.selectRequired": "選択肢を1つ以上選んでください。",

		// --- composer / session menu ----------------------------------------
		"add.label": "画像やファイルを追加",
		"add.stock": "ファイルを追加またはコマンドを実行",

		// --- workspace picker / right-panel files ---------------------------
		"workspace.search.placeholder": "ワークスペースを検索",
		"workspace.search.noMatches": "該当なし",
		"files.search.placeholder": "このフォルダ内を検索",
		"files.search.submit": "このフォルダ内を検索",
		"files.search.clear": "検索をクリア",
		"files.search.noMatches": "該当なし",
		"files.menu.root": "フォルダのパス",
		"files.menu.entry": "ファイルの操作",
		"files.menu.copyPath": "パスをコピー",
		"files.menu.copyName": "名前をコピー",
		"files.copied": "コピーしました",

		// --- service worker --------------------------------------------------
		"sw.documentTitle": "オフライン — DSH",
		"sw.offlineHeading": "オフラインです",
		"sw.offlineBody1": "DSH のサーバーに接続できませんでした。",
		"sw.offlineBody2": "Tailscale などのネットワーク接続を確認してください。",
		"sw.retry": "再試行",
		"sw.pushTitle": "DSH",
		"sw.pushBody": "新しい通知があります",
		"sw.open": "開く",
	},
};

/**
 * Upstream labels this plugin matches to find controls.
 *
 * These are never rendered: they are the vocabulary of the shell being
 * decorated. Keeping every known locale here is what makes the matching
 * language-independent — adding a language does not touch `client.js`.
 */
export const PROBES = {
	/** The account/menu button that opens Settings. */
	accountMenu: ["Account menu", "アカウントメニュー"],
	/** The Settings row inside that menu. */
	settingsMenu: ["Settings", "設定"],
	/** Localized leaves of the phone's default hide list. The English names
	 *  stay in client.js; these are the committed ja renderings of the same
	 *  controls ("Open configuration file", "More actions", …). */
	hideControls: [
		"設定ファイルを開く",
		"その他の操作",
		"フィードバック",
		"サインイン",
		"キーボードショートカット",
		"コーディングビューを表示",
		"組み込みプラグイン",
	],
	/** Sidebar rows folded into the landscape More menu. */
	navPlugins: ["Plugins", "插件", "プラグイン"],
	navAutomation: ["Automation tasks", "自动化任务", "自動化タスク"],
	/** The Automation-tasks detail's close control: the only way back to the list
	 *  once upstream hides the list on a phone. */
	closeTaskDetail: ["Close details", "关闭详情", "詳細を閉じる"],
	/** A session row's own "..." trigger. */
	actions: ["actions", "操作"],
	/** A button that stops the running turn (must not mark a phone send). */
	stop: ["stop", "停止"],
	/** The activity chip: "3 turns" / "3 steps". */
	turns: ["turns", "turn", "steps", "step", "ターン", "ステップ"],
	/** The usage chip: "Cache hit 40%" / "キャッシュヒット 40%". */
	cacheHit: ["cache hit", "キャッシュヒット"],
	/** The context chip: "40% context". */
	context: ["context", "コンテキスト"],
	/** A running activity chip: "3 background jobs running" / "3 subagents running".
	 *  The ja wording puts the counter before the noun ("3 件の…が実行中"). */
	activityRunning: ["running", "运行中", "正在运行", "実行中"],
	/** Count-first count chips: en, zh and the ja running/job forms attach the
	 *  counter to the number ("3件のバックグラウンドジョブ"). */
	activityChip: ["subagent", "subagents", "background job", "background jobs", "shell command", "shell commands", "个子智能体", "个后台任务", "件のサブエージェント", "件のバックグラウンドジョブ"],
	/** Count-last nouns: the committed ja subagent total is noun-first
	 *  ("サブエージェント 3 件"), so the number is not at the start. */
	activityChipCountLast: ["サブエージェント", "バックグラウンドジョブ"],
	/** The trailing counter that closes a noun-first ja count chip. */
	activityChipCounter: ["件"],
	/** The subagent noun inside a count chip, for choosing its glyph. */
	activitySubagentChip: ["subagents", "subagent", "子智能体", "サブエージェント"],
	/** Any aria-label that identifies the stats dock. */
	stats: ["tok", "turns", "context", "ターン", "コンテキスト"],
	/** A control that starts a new session (sidebar button, brand row, workspace "+"). */
	newSession: ["new session", "新建会话", "中新建会话", "新しいセッション"],
	/** Labels of a session that has no name yet. */
	untitled: ["new session", "new chat", "untitled", "新しいセッション", "新しいチャット", "無題", "未命名", "新会话"],
	/** The right panel's "make this pane fullscreen" control. */
	fullscreen: ["Enter fullscreen", "Fullscreen", "全屏", "全画面表示"],
	/** The same panel's "leave fullscreen" control, which a phone hides. */
	fullscreenExit: ["Exit fullscreen", "全画面表示を終了"],
	/** The dock's pane-split control, which a phone hides at every width. */
	split: ["Split", "分割"],
	/** The composer's model trigger. The label carries the current model and
	 *  effort, so only its opening words are stable ("モデルを選択（現在 …）"). */
	modelTrigger: ["Select model", "选择模型", "モデルを選択"],
	/** The breadcrumb navigation above the chat (#97). */
	sessionHierarchy: ["Session hierarchy", "会话层级", "セッション階層"],
	/** A session row's "..." trigger: en puts it first, zh/ja attach it to the
	 *  session name ("{name} のセッション操作"). */
	sessionActions: ["Session actions", "的操作", "のセッション操作"],
	/** The edit summary card's headline, with {count} as the file count. */
	editedFiles: ["Edited {count} files", "已编辑 {count} 个文件", "{count} ファイルを編集しました"],
	/** The left drawer's toggle, in both states. */
	sidebarOpen: ["Open sidebar", "打开侧边栏", "サイドバーを開く"],
	sidebarCollapse: ["Collapse sidebar", "收起侧边栏", "サイドバーを折りたたむ"],
	/** The right panel's toggle, in both states. */
	rightPanelOpen: ["Open right sidebar", "打开右侧边栏", "右サイドバーを開く"],
	rightPanelCollapse: ["Collapse right sidebar", "收起右侧边栏", "右サイドバーを折りたたむ"],
};

/** Keys the service worker needs, picked out of {@link COPY}. */
const SW_KEYS = [
	"sw.documentTitle",
	"sw.offlineHeading",
	"sw.offlineBody1",
	"sw.offlineBody2",
	"sw.retry",
	"sw.pushTitle",
	"sw.pushBody",
	"sw.open",
];

/**
 * One language's strings, falling back to English key by key.
 *
 * @param {string} [lang] - a language id such as `en` or `ja`.
 * @param {object} [table] - dictionary to read; defaults to {@link COPY}.
 * @returns {Record<string, string>} every key this package renders.
 */
export function copyFor(lang, table = COPY) {
	const base = { ...table.en };
	const extra = typeof lang === "string" && lang !== "en" && table[lang] !== undefined
		? table[lang]
		: {};
	for (const [key, value] of Object.entries(extra)) {
		if (typeof value === "string" && value !== "") base[key] = value;
	}
	return base;
}

/**
 * The subset the service worker renders, for `__RDSH_PWA_CONFIG__`.
 *
 * @param {string} [lang] - a language id.
 * @returns {Record<string, string>} offline/push copy.
 */
export function serviceWorkerCopy(lang) {
	const strings = copyFor(lang);
	return Object.fromEntries(SW_KEYS.map((key) => [key, strings[key]]));
}
