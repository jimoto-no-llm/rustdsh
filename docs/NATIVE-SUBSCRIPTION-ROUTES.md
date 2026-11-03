# native-web の Codex / Claude 接続

`rdsh native-web --workspace <directory>` はRustの会話ループ・JSON応答検証・
ツール実行・承認を使用します。DSHのWebアプリや会話ランタイムを起動しません。
モデル登録は `--dsh-profile`（既定: 既存の `web`）の設定と、インストール済み
pi-aiのJSONモデルカタログから読みます。

## Claude: `claude -p`

`anthropic: {}` のように `apiKeyEnv` を指定していない標準Anthropicルートは、
インストール済みClaude Code CLIの `claude -p --output-format json` で生成します。
ログイン・更新はClaude Code自身が管理します。rustdshはAnthropicのOAuthトークンを
読み取ったり、APIキーに変換したりしません。起動時のCLI検出はログイン成功や
モデルの利用権限の確認ではありません。CLIがなければモデルを利用不可として表示します。

子プロセスは空の一時フォルダで実行し、プロンプトは標準入力に渡します。
`--tools ""`、空のMCP設定と `--strict-mcp-config`、`--disable-slash-commands`、
`--setting-sources ""`、`--settings '{"disableAllHooks":true}'`、
`--no-session-persistence`、`--max-turns 1` を指定します。
既存のログインを維持するため `--bare` は使用しません（このモードはOAuthと
Keychainを読みません）。権限バイパスのフラグは渡しません。組織の管理ポリシーは
CLIの規則に従います。

CLIの成功JSONからテキストだけを取り出し、応答全体を囲むJSONコードフェンスが
あれば外した後、Rustが通常のJSON turnとして厳密に検証します。説明文からJSONを
探し出す処理は行いません。CLIエラー本文やstderrは画面に出しません。処理の中断・タイムアウト・
出力上限は既存の子プロセス管理に従います。Unixでは子プロセスグループも終了します。
これはCLIの認証を使う生成アダプターであり、CLIにワークスペース操作を委譲する
モードではありません。ただしCLIの内部の推論処理までRust実装になるわけではありません。

`apiKeyEnv` が明示されたルートは従来のAPIキー接続を維持し、不足しているキーを
CLI接続で黙って代替しません。独自の接続先や未対応設定をClaude CLIに読み替える
こともありません。

## Codex: 共有済みOAuthとRust SSE

`openai-codex` の `openai-codex-responses` APIでは、
`$DSH_HOME/.credentials.yaml` の既存の `llm-pi-ai/openai-codex` grantを読みます。
外部のCodexログインファイルは直接探索せず、新しい認証共有も開始しません。
未共有の場合は既存の `rdsh auth` の明示的な共有手順を使用してください。

プロファイルの `transport: sse` を受理し、RustのHTTPクライアントから
`https://chatgpt.com/backend-api/codex/responses` へBearer認証とアカウントIDを付け、
`stream: true`・`store: false` で推論を要求します。APIキー用の
`max_output_tokens` はこの接続へ送りません。応答は8 MiBに制限し、
正常な `response.completed` のテキストだけをRustのturn検証に渡します。
途中で切れたストリーム・失敗・不完全な応答はツール実行へ進みません。

接続先は公式のCodex接続先に限定し、リダイレクトを追いません。
プロファイルの任意URL・独自ヘッダー・WebSocket指定など、未対応の設定は
引き続き拒否します。認証トークンをモデル一覧・診断・HTTPエラー本文に出しません。

認証ストアは読み取り専用です。トークンの自動更新や書き換えは行いません。
起動時点のgrantを保持し、生成前にも期限を確認します。期限切れの場合は既存の
ログイン元で更新し、選択済みの共有を同期した後に `native-web` を再起動してください。
JWTとストアの期限が異なる場合は早い方を採用します。Unixで他ユーザーが読める
認証ストアは拒否し、権限を自動変更しません。

## 検証範囲

合成認証ストア、ローカルHTTP/SSEサーバー、偽のClaude CLIで接続選択・Bearerヘッダー・
SSE正常終端・不完全応答・リダイレクト拒否・CLIの引数/標準入力/一時作業領域・
エラー秘匿を検証します。実アカウントのログイン・契約・実生成の成功は、このfixtureの
成功からは判断できません。

参照: [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)、
[OpenAI: Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)。
