# rdsh official SDK bridge

CursorとAntigravityの公式SDKをDSHのモデルプロバイダーとして利用し、会話ループ・ツール実行・承認をrdsh/DSH側で維持する、任意導入のプラグインです。Devinは承認必須の `devin_cli` ツールとして登録します。

## 動作

SDKには毎回、DSHの履歴とツールの説明をテキストとして渡します。各SDKは独立した空の一時ワークスペースで、操作ツール・MCP・subagent・ambient設定を無効化し、1つのJSON回答を返します。SDK自体の内部ランタイムは存在しますが、DSHの会話ループやツール実行は委譲しません。

一時ワークスペースとSDKの保存領域は、通常終了時に加えて、タイムアウト・キャンセル・出力上限による強制終了時にも子プロセスの終了を待って削除します。削除に失敗した場合はエラーを返します。

JSON変換層は、宣言されたツール名、引数のJSON Schema、呼出しIDの重複、追加フィールドを検証します。不正なJSONに対してのみ最大1回修正を要求し、認証や通信の失敗を別経路への切り替えで隠すことはしません。回答は検証完了後にDSHへ返すため、モデルの部分出力は配信しません。現在はテキスト入力にのみ対応しています。

`temperature`・`maxTokens`・`stop` による生成制御には対応していません。指定された場合は、認証解決やSDK生成を開始する前に `UNSUPPORTED_GENERATION_OPTION` で拒否します。

`devin_cli` はDSHの承認後に、現在のセッションのワークスペース内でインストール済みのCLIを起動します。CLIの信頼・権限設定を保持し、shellを介さずにタイムアウト・キャンセル・出力量制限を適用します。Devin内部のエージェントループと操作はDevinが担うため、DSHは委譲全体を承認します。既定の実行ファイルは `~/.local/bin/devin` です。

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

`RDSH_AGY_PYTHON` は実際にDSHを起動する環境に設定してください。未指定の場合はプラグイン直下の `.venv/bin/python` を使用します。インストール先に仮想環境を複製する必要はありません。別のプロファイルへ導入する場合は `--profile web` を変更してください。Rustランチャーや既存プロファイルの既定モデルは変更しません。

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

Antigravityの確認済みの組み合わせは `provider: agy-sdk` / `model: gemini-3.8-flash` です。Cursorは公式SDKのモデル一覧を取得します。Antigravityの一覧はインストール済みSDKの既定モデルを表示するため、利用権限の確認は実際の生成時に行います。

## 認証

- Cursor: `CURSOR_API_KEY` または公式SDKが管理する `~/.cursor/sdk/auth.json` を使用します。キーの発行・保存はこのプラグインでは行いません。
- Antigravity: 呼出しごとにDSHの credential service から `GEMINI_API_KEY`、`GOOGLE_API_KEY` を解決し、SDK子プロセスの環境へ渡します。環境変数の同名キーや、`GOOGLE_GENAI_USE_VERTEXAI` / `GOOGLE_GENAI_USE_ENTERPRISE`、`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`、`GOOGLE_APPLICATION_CREDENTIALS` も使用できます。接続設定の `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`（小文字名も可）、`SSL_CERT_FILE` / `SSL_CERT_DIR` も保持します。子プロセスへはこれらと必要なOS実行環境だけを渡し、他のプロバイダーのキーやコード注入用の環境設定、TLS秘密情報の記録設定は継承しません。Antigravity CLIのOAuthやサブスクリプションを引き継ぐ経路ではありません。
- Devin: CLI自身の既存の認証とワークスペース信頼設定を使用します。追加の信頼や権限を自動で付与することはありません。

Windowsではproxy名の大文字・小文字を同一視し、呼出し側の明示的な設定を優先します。同じ入力に大小両方の名前がある場合は、大文字名の文字列値（空文字を含む）を優先します。Unixでは両方の名前を保持し、優先順位はSDK側のtransportに従います。

キーをpromptや設定例に埋め込まないでください。SDKの診断情報は機密情報を含む可能性があるため破棄し、失敗の分類結果だけを返します。Devinの出力は既知の秘密情報やAPIキーの形式をマスクしますが、任意の機密情報を完全に除去する仕組みではありません。

## 検証

DSHを通常の `~/.local/lib/node_modules/@deepseek-ai/dsh` へ導入した環境で、以下を実行します。

```sh
npm test --prefix plugins/rdsh-direct-models
python3 -I -B plugins/rdsh-direct-models/agy-sdk.test.py
node plugins/rdsh-direct-models/sdk-runtime-smoke.mjs
```

Nodeの66件のテストとPythonの4件のテストで、JSON境界、SDK機能の無効化、タイムアウト、キャンセル、出力上限、秘密情報の隔離境界、ワークスペース制限、子プロセスの環境制限と接続設定の保持、Windowsにおける大文字・小文字にまたがるproxyの上書き、生成制御の拒否、Enterprise認証判定、強制終了後の一時領域の削除を確認します。実際のDSH ToolRuntime/Cordisを使用し、不正な引数の遮断、承認拒否、承認後のファイル読み取り、結果の履歴への反映、Devin拒否時の非起動も検証します。通常のテストでは外部APIやCLIを呼び出しません。

実Devinを検証する場合は、CLIで信頼済みの検証専用フォルダーを指定してください。通常の信頼設定を迂回することはありません。検証fixture内の承認サービスは、固定の無害な確認要求1件のみを許可し、本番の承認設定を変更しません。

```sh
node plugins/rdsh-direct-models/sdk-runtime-smoke.mjs --live-devin --workspace /absolute/path/to/trusted-smoke-workspace
```

2026-10-15の実動確認: Cursor `composer-2.5` とAntigravity `gemini-3.8-flash` での生成、DSH経由でpromptに含めないランダムnonceファイルを読み取った後の継続回答、および両方のGUIでの生成に成功しました。Devinは実際のToolRuntimeから応答マーカーの生成と終了コード0を確認しました。認証・課金・モデルの利用可否は各アカウントに依存します。テスト結果に個人の認証情報やホーム設定は含みません。
