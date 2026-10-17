# rdsh-settings (test prototype)

DSH設定サイドバーに rdsh セクションを追加するテスト用プラグインです。
デザインはDSHそのまま (settings.section スロットを使い、DSH変数で描画)。

## 入る場所

- 設定モーダルの縦ナビに rdsh が追加されます
- 順序は Models(10) / Built-in plugins(15) の次: order 20
- クリックすると、トークン予算、retriever/packer/verifier、goal、作業ファイル、未解決タスクを調整できます

## 表示言語

「表示言語」で英語（`en`）・簡体字中国語（`zh-CN`）・日本語（`ja`）を選ぶと、設定画面とプレビューがその場で切り替わります。保存すると `general.language` に記録されます。`auto` はこの画面ではブラウザーの言語を使用します。読み込みエラーが発生した場合でも直前に選んだ表示言語を保持し、破損した設定で上書き保存することはありません。CLIや独立ダッシュボードにおける選択順は、[設定リファレンス](../../docs/RDSH-SETTINGS.md) を参照してください。

設定キー、プロファイル名、パス、goal などの入力本文、および明示的に指定した Discord 表示文は翻訳されません。Discord の既定表示文と稼働状態は、サーバー側で解決された言語に従います。`auto` では設定画面の言語と異なる場合があり、プレビューと反映確認には `/api/rdsh-discord` の `language` を使用します。空の `discord.details` は言語別の既定文を選択する指定であり、以前に保存された日本語を含む明示的な表示文はそのまま維持されます。

## 保存先

- DSH_HOME/rdsh.json（単一の設定元。context・beta・全体設定のすべて）
- 旧 DSH_HOME/rdsh-context.json は読み替え専用です。rdsh.json に context が
  ない場合（nullを含む）は画面に旧文脈を読み込み、全体保存で移行します。
  contextを含まない部分保存では、未設定のcontextを新規作成しません。
  旧ファイルを削除する前に、rdsh.jsonへの文脈の保存を確認してください。
- Rust側 `rdsh context build/search/status/explain` と同じファイルを読み書きします。

## 試す

APIにはDSHのGUIセッション認証とHost/Origin検証を適用します。
`connection.requestRejection` を提供するDSHが必要です（0.2.0-rc.2で検証済み）。
`webServer`と`connection`が揃った場合のみHTTPルートを登録します。
Discord連携はweb/headless/TUIの各プロファイルでも動作します。
サービスに認証APIがない場合、リクエストは503で拒否されます。
設定画面が扱わない既存キー（`extras.enable`など）は、保存時にも保持されます。
GETと保存応答は画面が扱う項目のみを返し、未対応項目はディスク上で保持されます。
設定保存のリクエスト上限は1MiBです。これには画面が返す項目の最大サイズを含みます。
Working Filesの空リストは明示的な指定として扱い、旧形式のファイル一覧には戻りません。
旧キー`context.files`は保存時に`working_files`へ移行します。
この読み込み動作を反映するには、Rustランチャーも更新してください。

```sh
dsh plugin --profile web add ./plugins/rdsh-settings
```

外すときは、プロファイルのプラグイン一覧から rdsh-settings を削除します。
テスト実装のため context engine は既定でOFF（beta.context_engine=false）です。
使用するときのみONにします。

## Discord Rich Presence

設定 → rdsh → **Discordの作業状態**（英語では **Discord Rich Presence**）で変更します。既定ではONです。

新規設定時やDiscord設定が未指定の場合は、そのまま作業状態を表示します。
表示しない場合は「Discordに作業状態を表示する」をOFFにして保存します。
保存済みのOFF設定は維持されます。
Discordデスクトップアプリを起動し、Discord側でも活動の表示を有効にしてください。
共通のdshアプリ（Application ID: `1557873849280888903`）を同梱しているため、
利用者がDeveloper Portalでアプリを作成したりIDを入力したりする必要はありません。
このIDは公開識別子であり、Bot tokenやClient secretではありません。

独自のアプリを使う場合のみ「独自のDiscordアプリを使う」を開いてIDを変更します。
Application IDが未設定または空欄のときや、`rdsh settings unset discord.application_id` で
リセットしたときは、共通のdshアプリに戻ります。

日本語の既定表示文は「dshで作業中」です。表示文、agentの状態や稼働数、経過時間を
個別に変更できます。DSHの `agent/status` イベントから「agent稼働中 (2)」や
「待機中」へと更新され、終了したagentは集計から除外されます。読み込み済みのagentも
現在の状態から集計されます。プロンプト、ファイル名、プロジェクトパスは送信しません。
表示文はDiscordの送信上限に合わせてUTF-8で128バイト以内に短縮されます。

設定画面には保存前の表示プレビュー、未保存の印、Discord専用の保存ボタンがあります。
Discordのみを保存しても、他の項目の編集中データは保持されます。
接続完了と表示への反映は分けて扱い、Discordから更新の応答が返ってから反映済みにします。
活動の共有をDiscord側で無効にしている場合、接続済みであっても他の人には表示されません。

「詳細設定」ではメンバー一覧に出す内容を表示文・agent状態・アプリ名から選択できます。
agentの表示をOFFにしている場合、一覧のagent状態は表示文に切り替わります。
共通アプリ名はDeveloper Portalで登録された `rdsh` です。画像は登録済みのアイコンを
既定で使い、「アプリの画像を表示する」でOFFにできます。プレビューには添付元のPNG
`assets/rushDSH.png` を同梱し、認証済みの `/api/rdsh-discord/icon` から表示します。
Discord本体はDeveloper Portalに登録済みのアプリアイコンをCDNから取得します。
共通アプリの公開メタデータを最大1分間キャッシュし、App Iconの変更に自動追従します。
メタデータの取得に失敗しても、ローカルIPC連携は維持されます。
添付PNGはDeveloper PortalのGeneral Information → App Iconにも登録してください。
カスタム画像は
Rich Presence → Art Assetsの画像キー（半角英小文字・数字・`_`・`-`）か公開画像URLを指定します。
リンクボタンは名前とhttp/https URLの両方を指定します。Discordの仕様上、
ボタンは他の人には見えますが、自身のプロフィールには表示されません。
画像やリンクを空欄にすると既定に戻ります。独自アプリで画像が空欄の場合は画像を送信しません。

送信は5秒以上の間隔を空け、連続したagent状態の変化は最新の状態にまとめられます。
OFFへの変更は待機中の更新を取り消し、表示を解除します。

Linux/macOSはローカルのUnix socket、Windowsは名前付きパイプを使用します。
WSLではローカルのDiscordが見つからなければ、Windows PowerShellを介して
Windows側のDiscordに接続します。Discord未起動時は5秒間隔で再接続を試みます。
常駐サービスで`WSL_DISTRO_NAME`がない場合も、カーネル情報からWSLを判定します。
Windowsの実行ファイルがPATHにない環境では、存在確認済みの
`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`を使います。
設定をOFFにするかプラグインを外すと表示を解除します。
Discord Web版には対応していません。

設定は `$DSH_HOME/rdsh.json` の `discord` セクションで、Rust CLIと共有されます。
CLIからも変更でき、起動中のプラグインが5秒以内を目安に再読み込みします。

```sh
rdsh settings set discord.enabled true
rdsh settings set discord.show_agent_status true
rdsh settings set discord.show_elapsed true
rdsh settings set discord.show_image true
rdsh settings set discord.status_display state
rdsh settings set discord.details 'dshで作業中'
rdsh settings set discord.enabled false
```

使うプロファイルにプラグインを追加してください。headless/TUIの場合も同じパッケージです。

```sh
dsh plugin --profile headless add ./plugins/rdsh-settings
```

接続状態は設定画面に表示されます。認証済みGET `/api/rdsh-discord` でも
`state`、`running_agents`、`started_at`（Unix秒）、`updated_at`（Unixミリ秒）、
`published_activity`（応答が返った最新の送信内容）を取得できます。
画面をスマートフォン幅で開くと、rdsh設定のナビゲーションが上部に配置されます。ホストの
`data-shortcut-modal="settings"` を持つ設定モーダルに限定した調整です。
プロトコルは [Discord公式IPCの説明](https://github.com/discord/discord-rpc/blob/master/documentation/hard-mode.md)
と [RPCのSET_ACTIVITY仕様](https://docs.discord.com/developers/topics/rpc#set-activity)、
[Activityの表示フィールド](https://docs.discord.com/developers/events/gateway-events#activity-object)
に基づいています。
