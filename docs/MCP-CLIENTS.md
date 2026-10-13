# Claude Code / Codex から MCP で使う

今のコーディングエージェントに、rustdsh のプロジェクトダッシュボードを追加します。
タスク、進捗、質問、構造化 UI を同じ画面へ提示し、人間の回答を MCP で読み取れます。
この入口には Node.js 22 以上と、このリポジトリのチェックアウトが必要です。
DSH のインストール、Rust のビルド、認証情報の取り込みは不要です。

English: keep Claude Code or Codex as your coding agent and connect this dashboard
as an MCP server. Install the Node dashboard, start it for your project, register
the stdio command below, then call `dashboard_get_state` to check the connection.

## 1. ダッシュボードを起動する

リポジトリのルートで依存関係を導入します。

```sh
npm ci --ignore-scripts --prefix dashboard
```

Linux / macOS / WSL では、起動用端末と MCP 登録用端末の両方で次の変数を設定します。
`/absolute/path/to/` は実際の絶対パスへ置き換えてください。

```sh
RDSH_MCP_NODE="$(command -v node)"
RDSH_MCP_CLI="/absolute/path/to/rustdsh/dashboard/cli.mjs"
RDSH_MCP_PROJECT="/absolute/path/to/your/project"
RDSH_MCP_STATE="$HOME/.local/state/rdsh/dashboard"
```

起動用端末で実行し、その端末を開いたままにします。

```sh
RDSH_DASHBOARD_HOME="$RDSH_MCP_STATE" "$RDSH_MCP_NODE" "$RDSH_MCP_CLI" \
  project --project "$RDSH_MCP_PROJECT" --no-tailscale --open
```

MCP サーバーは同じマシン上のダッシュボードへ接続します。
クラウド側のエージェントから接続する場合は、その実行環境から到達できる
[HTTP 接続・トンネル](../dashboard/README.md)を用意してください。

## 2. 普段のエージェントへ登録する

登録用端末を対象プロジェクトへ移動します。両方を利用する場合も、接続先は同じです。
プロジェクトごとに `rdsh-project` の名前を変えると、接続先を区別できます。

```sh
cd "$RDSH_MCP_PROJECT"

# Claude Code: このプロジェクトにだけ登録
claude mcp add --scope local --transport stdio \
  --env "RDSH_DASHBOARD_HOME=$RDSH_MCP_STATE" rdsh-project -- \
  "$RDSH_MCP_NODE" "$RDSH_MCP_CLI" mcp --project "$RDSH_MCP_PROJECT"

# Codex: 明示したプロジェクトへ接続
codex mcp add rdsh-project --env "RDSH_DASHBOARD_HOME=$RDSH_MCP_STATE" -- \
  "$RDSH_MCP_NODE" "$RDSH_MCP_CLI" mcp --project "$RDSH_MCP_PROJECT"
```

Claude Code の local scope は対象プロジェクト専用です。
Codex の `mcp add` は通常ユーザー設定に登録するため、この設定を使う他の作業でも
`--project` で指定した接続先が使われます。必要ならプロジェクトの
`.codex/config.toml` に `[mcp_servers.<名前>]` の `command`・`args`・`env` を設定します。
登録方法は [Claude Code の公式 MCP 資料](https://code.claude.com/docs/en/mcp)と
[Codex の公式 MCP 資料](https://developers.openai.com/codex/mcp)に基づきます。

Windows の PowerShell でも同じ Node CLI を使えます。次の値を各端末で設定します。

```powershell
$rdshNode = (Get-Command node).Source
$rdshCli = 'C:\absolute\path\to\rustdsh\dashboard\cli.mjs'
$rdshProject = 'C:\absolute\path\to\your\project'
$rdshState = Join-Path $env:LOCALAPPDATA 'rdsh\dashboard'
$env:RDSH_DASHBOARD_HOME = $rdshState
```

起動用端末では次を実行します。

```powershell
& $rdshNode $rdshCli project --project $rdshProject --no-tailscale --open
```

対象プロジェクトの登録用端末で、利用するクライアントへ登録します。

```powershell
Set-Location $rdshProject
claude mcp add --scope local --transport stdio --env "RDSH_DASHBOARD_HOME=$rdshState" rdsh-project -- $rdshNode $rdshCli mcp --project $rdshProject
codex mcp add rdsh-project --env "RDSH_DASHBOARD_HOME=$rdshState" -- $rdshNode $rdshCli mcp --project $rdshProject
```

ダッシュボードは、状態ディレクトリの `projects/<project-id>/mcp-config.json` に
Node の絶対パス、プロジェクト、保存先を含む stdio 設定も生成します。
その `command`・`args`・`env` をクライアントへ追加しても接続できます。
この stdio 設定に接続鍵は含まれません。
`mcp-http-config.json` は接続鍵を含むため、公開用の設定ファイルとは分けて扱います。

## 3. 最初の接続を確かめる

クライアントを再起動して `/mcp` で `rdsh-project` を確認します。
次の依頼から始めると、接続先とタスク表示を確かめられます。

> dashboard_get_state を呼び、接続先のプロジェクト名を確認してください。
> dashboard_upsert_task で id=mcp-first-task、title=MCP接続確認、status=doing のタスクを追加してください。

次に `dashboard_ask_question` で質問を提示し、画面で回答します。
`dashboard_get_feedback({"after":0})` で回答を取得し、以後は返された `next_cursor` を使います。
構造化 UI は `dashboard_present_ui` で提示できます。

複数クライアントが同じプロジェクトへ接続すると、タスクとフィードバックは共有されます。
タスク・質問の ID にはクライアントや作業を識別できる名前を付けてください。
各クライアントが自分の質問・セッション ID を確認して回答を扱います。
取得操作は回答を消費せず、他のクライアントの取得済み状態には影響しません。
画面からの回答を受け取っても、実行には各エージェントの既存の権限確認が適用されます。

## 接続できない場合

- ダッシュボードが停止中なら、同じ `--project` と保存先で起動します。
- 起動コマンド、Node、対象プロジェクトの絶対パスと、`RDSH_DASHBOARD_HOME` を確認します。
- 再起動後の stdio 接続は最新の接続鍵を読みます。HTTP 接続は再生成された設定を読み直します。
- MCP のタスク・質問・UI 連携と、CLI の start/resume/interrupt は別の機能です。
  Claude Code／Codex のネイティブセッション制御は
  [CLI adapter contract](CLI-ADAPTERS.md)で未実装と明示されています。

`dashboard/test/mcp-clients.test.mjs` は生成設定、独立した stdio 接続、共有タスク、
空白・日本語を含むパス、保存先の変更、ダッシュボード再起動後の鍵更新を検証します。
これは MCP プロトコルの検証です。Claude Code／Codex のモデル実行を伴う
実クライアントでの受け入れ確認は別途必要です。公式資料とローカル CLI ヘルプの
確認日: 2026-10-13。
