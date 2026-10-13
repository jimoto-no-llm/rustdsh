# MCP 対応エージェントからダッシュボードを使う

今のコーディングエージェントに、rustdsh のプロジェクトダッシュボードを追加します。
タスク、進捗、質問、構造化 UI を同じ画面へ提示し、人間の回答を MCP で読み取れます。
この入口には Node.js 22 以上と、このリポジトリのチェックアウトが必要です。
DSH のインストール、Rust のビルド、認証情報の取り込みは不要です。

English: keep Claude Code, Codex, Cursor, VS Code Copilot, OpenCode or Gemini CLI
as your coding agent and connect this dashboard
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

## Cursor / VS Code / OpenCode / Gemini CLI

同じ stdio ブリッジを他の MCP クライアントにも追加できます。
生成された `mcp-config.json` の `command`・`args`・`env` を基準にし、
クライアントごとの設定形式に合わせます。次の表は各公式資料で確認した形式です。

| クライアント | プロジェクトの設定ファイル | 接続定義 |
| --- | --- | --- |
| [Cursor](https://cursor.com/docs/mcp) | `.cursor/mcp.json` | `mcpServers.<名前>`、`type: stdio`、`command`、`args`、`env` |
| [VS Code Copilot](https://code.visualstudio.com/docs/agent-customization/mcp-servers) | `.vscode/mcp.json` | `servers.<名前>`、`type: stdio`、`command`、`args`、`env` |
| [OpenCode](https://opencode.ai/docs/mcp-servers/) | `opencode.json` / `opencode.jsonc` | `mcp.<名前>`、`type: local`、コマンド配列、`environment` |
| [Gemini CLI](https://geminicli.com/docs/tools/mcp-server/) | `.gemini/settings.json` | `mcpServers.<名前>`、`command`、`args`、`env` |

Cursor の例です。Node・チェックアウト・対象プロジェクト・状態ディレクトリの
パスを、それぞれ生成された stdio 設定の値へ置き換えてください。

```json
{
  "mcpServers": {
    "rdsh-project": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/rustdsh/dashboard/cli.mjs", "mcp", "--project", "/absolute/path/to/your/project"],
      "env": { "RDSH_DASHBOARD_HOME": "/absolute/path/to/dashboard-state" }
    }
  }
}
```

VS Code ではルートの `mcpServers` を `servers` に変え、同じ接続定義を追加します。
`MCP: List Servers` でサーバーを起動し、チャットのツール一覧で確認します。
Gemini CLI では `type` を省いた同じ `command`・`args`・`env` を、
既存の `.gemini/settings.json` の `mcpServers` へ追加します。

OpenCode は形式が異なります。`command` に Node と引数をまとめた配列を渡し、
保存先は `environment` で指定します。

```json
{
  "mcp": {
    "rdsh-project": {
      "type": "local",
      "command": ["/absolute/path/to/node", "/absolute/path/to/rustdsh/dashboard/cli.mjs", "mcp", "--project", "/absolute/path/to/your/project"],
      "environment": { "RDSH_DASHBOARD_HOME": "/absolute/path/to/dashboard-state" },
      "enabled": true
    }
  }
}
```

既存の設定へこの接続だけを追加します。Windows の JSON パスは `C:/...` または
`C:\\...` で表記します。接続先は `--project` で固定されるため、他のプロジェクトでも
同じ名前のユーザー設定を使う場合は対象パスを確認してください。

## 最初の接続を確かめる

クライアントを再起動して MCP の一覧で `rdsh-project` を確認します。
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
  エージェントごとのネイティブセッション制御の対応範囲は
  [CLI adapter contract](CLI-ADAPTERS.md)で確認できます。

`dashboard/test/mcp-clients.test.mjs` は生成設定、独立した stdio 接続、共有タスク、
空白・日本語を含むパス、保存先の変更、ダッシュボード再起動後の鍵更新を検証します。
これは MCP プロトコルの検証です。Claude Code／Codex のモデル実行を伴う
実クライアントでの受け入れ確認は別途必要です。6つの接続名を使う stdio の試験と、
各製品の UI / モデル実行の受け入れ確認を区別しています。公式資料とローカル CLI ヘルプの
確認日: 2026-10-13。
