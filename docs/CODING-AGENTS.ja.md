# Claude Code／Codexをそのまま使って始める

[English](CODING-AGENTS.md) · [rdshのインストール](../README.ja.md#インストール)

普段のログインと作業の進め方を保ったまま、rdshのローカルツールを追加できます。
テキスト処理とプロジェクト画面に、本家DSH・DSHのアカウント・APIキーは不要です。

| したいこと | 使うもの | 必要なもの |
| --- | --- | --- |
| 指示ファイルの大きさを見積もる | `rdsh tokens AGENTS.md` / `CLAUDE.md` | rdsh |
| 長いログを上限内に収める | `rdsh prune build.log --max-tokens 4000` | rdsh |
| ファイルから文字列を探す | `rdsh search TODO --dir . --max 20` | Unixのrdsh |
| 進捗を見る・質問に答える | MCP経由のプロジェクト画面 | Node.js 22+・ソースcheckout・対応するクライアント |
| DSHで会話する | DSHランチャー・初回設定 | 本家DSH・モデル接続 |

## ローカルツールを試す

[Unix／Windowsの導入手順](../README.ja.md#インストール)でビルド済みバイナリを入れます。
Rustは不要です。作業するプロジェクトのディレクトリで実行します。

```sh
rdsh --version
printf 'hello rdsh\n' | rdsh tokens
```

PowerShellの場合：

```powershell
rdsh --version
"hello rdsh" | rdsh tokens
```

既存ファイルには次を使えます。存在する指示ファイルを選び、ログは自分のものを指定してください。

```sh
rdsh tokens AGENTS.md       # Codex向けの指示がある場合
rdsh tokens CLAUDE.md       # Claude Code向けの指示がある場合
rdsh prune build.log --max-tokens 4000 > build-for-review.txt
```

pruneは先頭と末尾を残して切り詰めます。意味を要約する処理ではなく、途中の重要な行が省かれる場合があります。
元ファイルを残し、必要な箇所は原文で確認してください。トークン数は概算で、モデル固有の数や請求額ではありません。
ネイティブ検索は現在Windowsで停止する設計です。WSLで使うか、普段のクライアントの検索を使ってください。

使い方をエージェントに伝えるなら、既存の`AGENTS.md`／`CLAUDE.md`へ以下を追記できます。

```text
大きなテキストを渡す前に、必要ならrdsh tokensで推定サイズを確認し、
rdsh pruneで先頭と末尾を上限内に収めてください。元のファイルは残し、
省かれた内容が必要なら原文を確認してください。Unixではrdsh searchで
文字列を検索できます。既存の実行権限の範囲で、役立つ場合に使ってください。
```

## 進捗と質問をMCPで共有する

MCP（Model Context Protocol）は、今使っているエージェントに外部ツールをつなぐ仕組みです。
rdshの画面へ進捗や質問を報告し、回答を読めます。エージェント本体を切り替える必要はありません。

プロジェクト画面は任意のNodeコンポーネントです。ReleaseのアーカイブにはRust CLIを収録し、
画面はソースcheckoutから別途導入します。登録後もcheckoutをその場所に残してください。

```sh
git clone https://github.com/jimoto-no-llm/rustdsh.git
cd rustdsh
npm ci --prefix dashboard
```

Unixではcheckoutと作業プロジェクトの絶対パスを指定し、画面を起動します。

```sh
rdsh_repo="$PWD"
work_project="/absolute/path/to/your/project"
node "$rdsh_repo/dashboard/cli.mjs" project --project "$work_project" --no-tailscale --open
```

Windows PowerShellでは次の形です。

```powershell
$rdshRepo = (Get-Location).Path
$workProject = "C:\Projects\my-app"
node "$rdshRepo/dashboard/cli.mjs" project --project "$workProject" --no-tailscale --open
```

起動した端末は開いたままにします。2つ目の端末でも同じcheckout・プロジェクトのパスを設定し、
作業プロジェクトへ移動してから、使っているクライアントだけを登録します。
`rdsh-my-app`は他のプロジェクトと重ならない名前にしてください。

```sh
rdsh_repo="/absolute/path/to/rustdsh"
work_project="/absolute/path/to/your/project"
cd "$work_project"
```

Codexの場合：

```sh
codex mcp add rdsh-my-app -- node "$rdsh_repo/dashboard/cli.mjs" mcp --project "$work_project"
codex mcp get rdsh-my-app
```

Claude Codeの場合（このプロジェクトで自分だけが使う設定）：

```sh
claude mcp add --transport stdio --scope local rdsh-my-app -- node "$rdsh_repo/dashboard/cli.mjs" mcp --project "$work_project"
claude mcp get rdsh-my-app
```

PowerShellの登録コマンド：

```powershell
$rdshRepo = "C:\Projects\rustdsh"
$workProject = "C:\Projects\my-app"
Set-Location $workProject
# 使っているクライアントの行だけ実行します。
codex mcp add rdsh-my-app -- node "$rdshRepo/dashboard/cli.mjs" mcp --project "$workProject"
claude mcp add --transport stdio --scope local rdsh-my-app -- node "$rdshRepo/dashboard/cli.mjs" mcp --project "$workProject"
```

Codexは名前付きサーバーを設定へ保存し、Claudeのlocal設定は登録したプロジェクトだけに適用します。
コマンドの仕様は[Codex公式MCP手順](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)と
[Claude Code公式のstdio・local設定](https://code.claude.com/docs/en/mcp)を参照しています。
登録後は新しいエージェントのセッションを開き、6つのツールが使えることを確認してください。
WindowsとWSLではパスも状態ファイルも異なるため、サーバーとクライアントは同じ環境で起動します。
GUIのクライアントではMCP設定画面、またはCLIと共有する設定を使います。
[生成済みの設定](../dashboard/README.md#report-project-data-through-mcp)には、正確なNode実行ファイルと引数が入っています。

stdioの中継は操作ごとに、このプロジェクトの最新の認証情報を読みます。
登録コマンドへ鍵を貼る必要はなく、サーバーを再起動しても登録の書き換えは不要です。
モデル用のログインは、今使っているクライアントに残します。

エージェントへ伝える例：

```text
今回の作業ではrdshのプロジェクトMCPを使ってください。最初にdashboard_get_stateで状態を確認し、
dashboard_upsert_taskでタスクを登録・更新し、dashboard_publish_eventで進捗を報告してください。
判断が必要ならdashboard_ask_questionで私に質問し、dashboard_get_feedbackで回答を読んでください。
次回の取得には返されたnext_cursorを使い、数値は実測したものだけ報告してください。
回答が保存されたことだけで、新しい実行権限が与えられたとは扱わないでください。
```

画面に出るのはエージェントが報告したデータです。他のクライアントの履歴や請求額を自動収集しません。
Codex／Claudeの起動・resume・割り込み・停止・厳格な予算制御は、現時点の[アダプター](CLI-ADAPTERS.md)では未対応です。
作業は元のクライアントで続け、回答はMCPで読んでください。クライアントへの自動入力は実装していません。

## つながらないとき・解除する

画面を起動した端末、Node依存、クライアントとサーバーの絶対パスを確認します。
再表示は `node /absolute/path/to/rustdsh/dashboard/cli.mjs open --project /absolute/path/to/your/project` です。
中継は画面を止めてもツール一覧を出せるため、`dashboard_get_state`の成功まで確認してください。

解除は登録したプロジェクトで、使っているクライアントの名前だけを指定します。

```sh
codex mcp remove rdsh-my-app
claude mcp remove --scope local rdsh-my-app
```

画面は起動した端末のCtrl-C、または対象プロジェクトの`stop`コマンドで終了します。
MCP登録の解除は、保存した報告や回答を削除しません。

困ったときは[Issueフォーム](https://github.com/jimoto-no-llm/rustdsh/issues/new/choose)へ、
rdshの版・OS・クライアント・再現手順を記載してください。鍵や起動URLは載せないでください。
DSHの接続は別の[導入・復旧手順](USER-FLOW.md)で説明しています。
