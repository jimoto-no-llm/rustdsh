# rdsh official SDK bridge

CursorとAntigravityの公式SDKをDSHのモデルプロバイダーとして使い、会話ループ・ツール実行・承認をrdsh/DSHに維持する、任意導入のプラグインです。Devinは承認必須の `devin_cli` ツールとして登録します。

## 動作

SDKには毎回、DSHの履歴とツールの説明をテキストとして渡します。各SDKは独立した空の一時ワークスペースで、操作ツール・MCP・subagent・ambient設定を無効化し、1つのJSON回答を返します。SDK自体の内部ランタイムは存在しますが、DSHの会話ループやツール実行を委譲しません。

JSON変換層は宣言したツール名・引数のJSON Schema・呼出しIDの重複・追加フィールドを検証します。不正JSONだけ最大1回修正を要求し、認証・通信失敗を別経路への切替で隠しません。回答は検証完了後にDSHへ返すため、モデルの部分出力は配信しません。現在はテキスト入力のみ対応します。

`devin_cli` はDSHの承認後に、現在のセッションのワークスペース内でインストール済みCLIを起動します。CLIの信頼・権限設定を保持し、shellを介さず、タイムアウト・キャンセル・出力量制限を適用します。Devin内部のエージェントループと操作はDevinが所有するため、DSHは委譲全体を承認します。既定実行ファイルは `~/.local/bin/devin` です。

## 導入

DSHの `llm`・`tools`・`credentials` サービスが必要です。DSH 0.2.0-rc.2、Node.js 25で実動確認しました。Antigravity SDKはPython 3.10以上を要求します。

リポジトリのルートから実行します。

```sh
npm ci --prefix plugins/rdsh-direct-models
python3 -m venv plugins/rdsh-direct-models/.venv
plugins/rdsh-direct-models/.venv/bin/pip install -r plugins/rdsh-direct-models/requirements.txt
export RDSH_AGY_PYTHON="$PWD/plugins/rdsh-direct-models/.venv/bin/python"
dsh plugin --profile web add "$PWD/plugins/rdsh-direct-models"
rdsh web
```

`RDSH_AGY_PYTHON` は実際にDSHを起動する環境に設定してください。未指定ならプラグイン直下の `.venv/bin/python` を使います。インストール先に仮想環境を複製する必要はありません。別プロフィールへ導入する場合は `--profile web` を変更してください。Rustランチャーや既存プロフィールの既定モデルは変更しません。

GUIのモデル一覧で `Cursor (official SDK, rdsh tools)` または `Antigravity (official SDK, rdsh tools)` を選択します。DSHの構成へ直接挿入する場合は、次のpatchも使用できます。

```yaml
- insert:
    - id: rdsh-direct-models
      name: /absolute/path/to/rustdsh/plugins/rdsh-direct-models/index.mjs
- id: agent-default-model
  config:
    provider: cursor-sdk
    model: composer-2.5
```

Antigravityの確認済み組合せは `provider: agy-sdk` / `model: gemini-3.8-flash` です。Cursorは公式SDKのモデル一覧を取得します。Antigravityの一覧はインストール済みSDKの既定モデルを表示するため、利用権限の確認は実際の生成時に行います。

## 認証

- Cursor: `CURSOR_API_KEY` または公式SDKが管理する `~/.cursor/sdk/auth.json`。キーの発行・保存はこのプラグインでは行いません。
- Antigravity: 呼出しごとにDSH credential serviceの `GEMINI_API_KEY`、`GOOGLE_API_KEY` を解決し、SDK子プロセスの環境へ渡します。環境変数・SDKのVertex設定も使用できます。Antigravity CLIのOAuthやサブスクリプションを引き継ぐ経路ではありません。
- Devin: CLI自身の既存認証とワークスペース信頼設定を使用します。追加の信頼や権限を自動付与しません。

キーをpromptや設定例に埋め込まないでください。SDK診断は秘密を含む可能性があるため破棄し、失敗分類だけを返します。Devin出力は既知の秘密とAPIキー形式をマスクしますが、任意の機密情報を完全に除去する仕組みではありません。

## 検証

DSHを通常の `~/.local/lib/node_modules/@deepseek-ai/dsh` へ導入した環境で、次を実行します。

```sh
npm test --prefix plugins/rdsh-direct-models
node plugins/rdsh-direct-models/sdk-runtime-smoke.mjs
```

33テストでJSON境界、SDK能力の無効化、タイムアウト、キャンセル、出力上限、秘密の切断境界、ワークスペース制限を確認します。実DSH ToolRuntime/Cordisを使い、不正引数の遮断、承認拒否、承認後のファイル読取、結果の履歴反映、Devin拒否時の非起動も検証します。通常テストは外部APIやCLIを呼びません。

実Devinを検証する場合は、CLIで信頼済みの検証専用フォルダーを指定してください。通常の信頼設定を迂回しません。検証fixture内の承認サービスは、固定の無害な確認要求1件だけを許可し、本番の承認設定を変更しません。

```sh
node plugins/rdsh-direct-models/sdk-runtime-smoke.mjs --live-devin --workspace /absolute/path/to/trusted-smoke-workspace
```

2026-10-15の実確認: Cursor `composer-2.5` とAntigravity `gemini-3.8-flash` の生成、DSH経由でpromptに含めないランダムnonceファイルを読み取った後の継続回答、両方のGUI生成に成功しました。Devinは実ToolRuntimeから応答マーカーの生成と終了コード0を確認しました。認証・課金・モデルの利用可否は各アカウントに依存します。テスト結果に個人の認証情報やホーム設定は含めません。
