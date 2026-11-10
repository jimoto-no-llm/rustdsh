# Rust製SDKハーネス

`rdsh native-web` は、DSHを起動せずに動く独立したWeb GUIです。既存の
`rdsh web`、`rdsh --profile web`、GPUIデスクトップのDSH接続は変更しません。

```sh
rdsh native-web --port 8791 \
  --workspace /absolute/path/to/project \
  --sdk-dir /absolute/path/to/rustdsh/plugins/rdsh-direct-models
```

ブラウザーで `http://127.0.0.1:8791/` を開き、起動時に示される保護済み
トークンファイルの内容を入力します。トークン値はログやURLに出力しません。
サーバーは127.0.0.1だけで待ち受け、Host・Origin・認証トークンを検証します。
APIと画面はキャッシュされず、他サイトからのフレーム埋め込みも拒否します。

## 処理の所有者

| 処理 | 実装・実行主体 |
| --- | --- |
| 会話履歴・モデル選択・最大12ステップの推論ループ | Rust `native_harness::engine` |
| JSON応答とツール引数の検証 | Rust、未知フィールド・未知ツール・重複IDを拒否 |
| 承認・拒否・キャンセル | Rust、個別承認IDまたは明示選択した自動承認設定 |
| ファイル読み取り・Devin起動 | Rust `native_harness::tools` |
| モデルの生成 | Cursor / Antigravity公式SDKの生成専用プロセス、またはRustから登録APIへの直接通信 |
| Webサーバー・GUI API | Rust、既存のローカルHTTPフレーミングを再利用 |

Node/Pythonは公式SDKの生成アダプターだけに使用します。DSHのJavaScript
プラグイン、Cordis、DSHの会話ループ・ツールランタイム・承認APIは読み込みません。
SDKごとに毎回新しい隔離用一時ディレクトリを作り、SDK内のツール、MCP、skills、
subagentsを無効にします。SDKからの呼び出し提案をRustが検証し、承認後に実行し、
結果を次のSDK呼び出しへ返します。JSON形式の不正応答だけ修正要求を1回行います。

Claude CLIの親ターンは`--json-schema`で構造化し、`structured_output`をRustで再検証します。
形式違反の通常テキストへはフォールバックしません。`model_call`の子ターンも同じ構造化応答とRustのツール実行を使います。CLIのツール・MCP・hooksは無効のままです。

公式SDKの依存関係は `plugins/rdsh-direct-models/README.md` に従って用意します。
Cursorは公式SDKの既存認証ストア、または `CURSOR_API_KEY` を利用します。
Antigravityは `GEMINI_API_KEY` / `GOOGLE_API_KEY` の環境変数、または承認済みの
既存 `~/.dsh/.credentials.yaml` の同名refを読み取り利用します。認証ストアへの
書き込み・新規キー発行・契約変更は行いません。既知の秘密値をGUI表示とモデル履歴で
マスクし、SDKの生のエラー出力は公開しません。

## ツールと承認

native実装は `read`、`write`、`devin_cli`、`model_call` を持ちます。
DSHの既存プラグインを自動で移植・実行するものではありません。

- `read {"path":"relative/file.txt"}`: 明示したワークスペース内のUTF-8通常ファイル、
  64KiB以下。絶対パス・親への移動・隠しファイル・既知の認証ファイルを拒否します。
  Unixでは各パス成分を `openat` / `O_NOFOLLOW` で開き、承認待ち中のsymlink置換も
  追跡しません。読み取り内容を選択中のプロバイダーへ送信する前にRustの権限設定を適用します。
  読み取り失敗は、対象の相対パスと欠損・権限不足・リンク等の理由を区別して表示します。
- `devin_cli {"prompt":"...","timeout":60}`: Rustが固定のDevin CLIを直接起動します。
  作業ディレクトリはRustのワークスペース、promptはシェルを介さずACPのJSON-RPCで渡します。
  timeoutは1〜300秒、フレーム1MiB、通信合計8MiB、回答テキスト64KiBを上限にします。通常の認証・信頼・承認を
  維持し、承認バイパスフラグは渡しません。Rust GUIまたはTUIの権限設定で承認します。
  CLIの場所は `--devin-bin` で明示できます。既定は `~/.local/bin/devin` です。
  現在はACPで起動し、Devin内部の操作承認も同じRustの権限設定で処理します。
  `processStarted` と `completed` を区別します。詳細は [NATIVE-DEVIN-ACP.md](NATIVE-DEVIN-ACP.md)。
- `model_call {"provider":"...","model":"...","prompt":"..."}`: 登録済みの利用可能な
  モデルへ、Rustの権限設定で承認した依頼文だけを送信します。親履歴は自動共有せず、相手の
  read/write/Devinは親と同じ権限設定で実行します。再帰委譲は禁止し、結果と実測使用量を主モデルへ返します。

拒否は未実行のツール結果として履歴に入り、永続的な許可にはなりません。
個別承認は再利用できず、キャンセル後は実行開始ゲートで新たな起動を拒否します。
起動時は毎回確認です。TUIの `/permission full-access` を確認して選ぶと、通常モードでは
全ツールとDevin内部操作を自動承認します。ACPには要求ごとの `allow_once` を返し、
Devin側へ永続的な許可を保存しません。PlanではwriteとDevinは禁止、readとmodel_callは個別承認です。
実行中プロセスは時間・出力制限で停止し、Unixではキャンセル時に子孫も終了します。

会話は現在のサーバープロセスのメモリーに保存されます。ディスクへのセッション保存、
複数ワークスペース、一般シェル・編集ツールはこの初期実装には含みません。
安全なファイル読み取りと子孫終了の実装対象はUnix/macOSです。非Unixではreadを拒否し、
Windowsの子孫終了の同等保証は未実装です。

## このPCでの実生成確認（2026-10-19）

検証ワークスペースは `/Users/eightman/dev/tools/rdsh-local-setup/smoke-workspace` のみ。
専用GUIで次を実行しました。

- Cursor / Composer 2.5: 生成→Rustのread承認→Rustのファイル読み取り→最終回答が成功。
- Antigravity / Gemini 3.7 Flash: GUIモデル切り替え後、同じ承認・read・最終回答が成功。
- Antigravityから `devin_cli` を提案→Rust GUIで一度だけ許可→Devinが終了コード0で
  `RUST_RDSH_DEVIN_GUI_OK` を生成→Rustが結果を返して最終回答が成功。
- Gemini 3.8 Flashは既存無料キーの日次クォータ超過。3.7での成功と区別します。

DSHサーバーを停止した状態でもDevin結果後のモデル生成が完了することを確認しました。
実生成の証拠とスクリーンショットはPC側の `rdsh-local-setup` に保存し、秘密値や
個人環境のログをリポジトリには追加しません。

## DSH登録モデルの共有

```sh
rdsh native-web --workspace /absolute/path/to/project --dsh-profile web
```

`--dsh-profile`（未指定時は存在する `web` を自動使用、なければSDKのみ）で指定した `$DSH_HOME/profiles/<name>/cordis.yml` と
`cordis.patch.yml` の明示的な `llm-pi-ai.config.providers` を読み取り、GUIへ
「DSH登録」プロバイダーとして追加します。プロファイルは混ぜず、後続パッチのpi-ai
設定が先行設定を置き換えます。設定・認証ファイルへの書き込みは行いません。
省略されたモデル一覧・API・接続先は、インストール済みpi-aiの
`dist/providers/data/<provider>.json` から補います。DSH起動先の実体から自動検出し、
見つからない環境では `--dsh-catalog /absolute/path/to/dist/providers/data` で指定できます。
JSONをデータとして読むだけで、DSH・Cordis・カタログのJavaScriptは実行しません。
`models` の明示リストはカタログを置き換えます。変更反映にはnative-webを再起動します。

| `api` | Rustの直接送信先 |
| --- | --- |
| `openai-completions` | `<baseURL>/chat/completions` |
| `openai-responses` | `<baseURL>/responses` |
| `google-generative-ai` | `<baseURL>/models/<model>:generateContent` |
| `anthropic-messages` | `<baseURL>/messages`（baseURLに `/v1` がなければ補完） |

モデルは生成専用です。既存と同じJSON応答契約を使い、Rustが承認・ツール実行・結果の
次回推論への受け渡しを行います。APIの自律ツール実行機能には委譲しません。
非ストリーミング、要求タイムアウト180秒、応答上限8MiB。出力上限はモデルの
`maxTokens` と8192の小さい方（未指定4096）を使用します。Chatはカタログの
`compat.maxTokensField`、またはOpenAI公式ホストでは `max_completion_tokens`、その他では
`max_tokens`、Responsesは `max_output_tokens`、Messagesは `max_tokens`、Googleは `maxOutputTokens` を送ります。

専用のAnthropic経路は `dsh:claude-cli` に統一し、`claude -p`の既存認証を利用します。
モデル一覧はDSHの旧Anthropic登録から独立した組み込みカタログを使います。
旧 `dsh:anthropic` は非表示のCLI互換aliasで、APIキーやDSHのOAuthは参照しません。

その他のAPI認証は登録済み `apiKeyEnv` の環境変数を優先し、なければ既存credential refを使用します。
キーなしのローカルAPIもDSHと同じ `apiKeyEnv` の `no-key` refで利用できます。
認証値をモデル一覧・要求本文・エラー本文へ出さず、HTTPリダイレクトは追跡しません。
APIからの失敗応答はステータス番号だけを表示します。APIモデルだけなら `--sdk-dir` は
不要です。Cursor・Antigravityを併用する場合は従来どおり公式SDKブリッジを指定します。

OAuth専用API（例 `openai-codex-responses`）、未知プロトコル、
不足したキー・カタログ、追加のheaders/compat/reasoning/modelOverrides等は利用不可理由を
GUIに表示します。modelのreasoning真偽値・contextWindow・input・costは能力情報として
扱いますが、画像入力や推論強度指定を実装するものではありません。
この読み取りは明示設定用の限定YAML構造に対応し、動的bundle/include/group、任意のCordis
挿入・条件評価、追加 `--patch`、組み込み認証の自動推測は行いません。構造が曖昧な設定は
起動時に拒否します。別APIやDSHへの暗黙のフォールバックはありません。

API仕様: [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat/create)、
[Responses](https://platform.openai.com/docs/api-reference/responses/create)、
[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)。

2026-10-19の実接続確認: このPCの `web` に登録したHAIモデルで、RustのGUI APIから
生成→read承認→Rustのファイル読み取り→結果を使った最終回答まで成功しました。
Cerebrasは既存アカウントがHTTP 402を返したため生成未確認、購入・契約変更は行っていません。
他プロバイダーのモデル一覧読み込みは確認済みですが、全モデルの実生成を保証するものでは
ありません。4プロトコルの要求・応答、エラー秘匿、承認の許可・拒否はmock HTTPでも検証します。

Google API仕様: [GenerateContent](https://ai.google.dev/api/generate-content)。認証は`x-goog-api-key`ヘッダーを使い、thoughtパートを最終応答から除外します。

Rust TUIとWeb GUIはモデル・ツール・使用量を共有実装で処理します。
機能対応と実測値の意味は [NATIVE-PARITY.md](NATIVE-PARITY.md) を参照してください。

`write` はworkspace内の64KiB以下のUTF-8ファイルを作成します。既存更新は `expected_content`
による内容確認を必須とし、競合やsymlinkを拒否します。原子的な置換を使い、既存hardlinkの
別の参照先を変更しません。非協調ライターに対する完全なcompare-and-swapではありません。
