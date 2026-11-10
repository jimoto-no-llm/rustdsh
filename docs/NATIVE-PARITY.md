# Rust Web GUIとTUIの対応範囲

比較元は `RDSH.app` が起動する `rdsh native-web` です。
`native-tui --backend native` は同じEngine、登録モデル、生成接続、ツール実装、承認ゲートを直接利用します。
UIごとに別の推論ループを作りません。

| Rust Web GUIの機能 | TUIでの操作 | 共通の処理 |
| --- | --- | --- |
| 作業場所の指定・表示 | `--workspace`、ヘッダー、`/status` | 正規化済みworkspace |
| プロバイダー・モデル選択 | F2、`/model`、検索・貼り付け | 登録モデルの検証 |
| 計画・権限 | `/mode`・`/plan`・`/permission`、適用前の確認 | 会話単位の制御、Devin実行ゲート |
| API / SDK / Claude CLI / Codex OAuth生成 | メッセージ送信 | 同じ生成アダプター |
| 会話履歴・新着追従・スクロール | PgUp/Dn、Home/End、ホイール | Rustの会話状態 |
| `read`によるファイル読み取り | 提案の引数を確認して承認 | 選択中の権限設定、境界検証 |
| `write`による作成・更新 | 提案の引数を確認して承認 | workspace境界、既存内容の照合、原子的な置換 |
| Devinへの依頼 | `devin_cli`の提案を承認 | ACP、内部の権限要求も同じ設定で処理 |
| 別モデルへの依頼 | `model_call`の提案を承認 | 同じworkspace・承認ゲートで子モデルがread/write/Devinを実行 |
| 拒否・停止 | Esc、Ctrl+C、`/cancel` | 要求ID検証・キャンセル・子孫終了 |
| 実行ログの全文閲覧 | `/logs`、↑↓・PgUp/Dn・Home/End | 全イベント。サイドパネルは最新分 |
| 接続診断・利用不可の理由 | `/diagnostics`、スクロール | 同じ診断とモデル別理由 |
| エラー表示 | 通知欄、スクロール可能な`/status` | 共通のマスキング済みエラー |
| トークン・キャッシュ使用量 | 下部表示、`/usage` | 同じ実測カウンター |

TUIは小さい端末で非表示になった確認操作を受け付けません。拡大して実際に画面を
再描画するまで確認を再開せず、選択は拒否へ戻します。キャンセル・終了は利用できます。
GUIのHTTP接続トークンはブラウザー接続のためだけに使います。TUIはHTTPサーバーを
起動せず同じEngineを直接呼ぶため、接続トークンの入力は不要です。

TUIの `/permission full-access` は確認後、通常モードのツールとDevin内部操作を
自動承認します。Plan中はwriteとDevinを禁止し、読み取り・別モデルへの依頼は個別承認です。
起動時の既定値は毎回確認です。詳細は[Planとパーミッション](NATIVE-TUI.md#planとパーミッション)を参照してください。

## 実測値の意味

- OpenAI Responses / Chat: 入力にキャッシュを含むため、読込分を再加算しません。
- Anthropic / Claude CLI: 入力の通常分・キャッシュ読込・キャッシュ作成を合算します。
- Gemini: prompt tokenとcached content tokenを利用し、thought tokenは出力へ一度だけ加算します。
- APIが返さない値、無効な値、SDKから取得できない値は未取得です。推定値へ置き換えません。
- キャッシュ率は使用量が揃った呼び出しの読込合計÷入力合計です。単純な率の平均ではありません。
- JSON修復の追加要求と委譲先も集計対象です。中止・失敗で使用量を受け取れなかった要求は
  リクエスト数に含め、既知の小計には`*`を付けます。利用料金や残枠を示すものではありません。
- Devin CLI内部のモデル生成量は未取得で、このRust側のモデル集計には含めません。

フィールドの定義: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)、
[Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、
[Gemini token metadata](https://ai.google.dev/api/tokens)。

## DSHとの関係

`rdsh web`、`rdsh --profile <name>`、従来の `rdsh tui` はDSHへ委譲し、
そのプロファイルのDSHツール・プラグインを利用します。
`native-web` と `native-tui --backend native` はRust独立実装です。DSH設定からモデル登録・共有済み認証を
読むことと、DSHのプラグイン実行基盤を利用することは異なります。
DSH全プラグイン、write/edit、MCP、skills、subagents、永続セッションなどを
nativeモードが自動継承するとは扱いません。nativeモードの保存・再開と逐次ストリーミングは未対応です。

Rust TUIでDSHのツール・プラグインを使う場合は
[`--backend dsh`](DSH-TUI-BACKEND.md)を指定します。DSHモードでは既存Webプロファイルを
ホストとして使い、履歴保存・再開と逐次配信、承認、質問をRust画面で扱います。
管理操作は `/manage`、対話シェルは `/terminal` で利用できます。
Web独自画面は `/webui` でTUI内に表示し、マイク入力は `/record` で確認してから行います。
公開APIとブラウザー固有画面の違いは [TUI管理機能](TUI-ADMIN.md) を参照してください。

## 検証

Rustの結合テストで別モデルの許可・拒否・キャンセル・履歴非共有・実測集計、
Claude JSONとCodex SSEの使用量、SDK未取得を検証します。疑似端末で承認画面・
モデル呼び出し結果・使用量表示・診断・全ログのスクロール・サイズ変更を検証します。
実ログインでの疎通は固定のテスト依頼文だけを用い、ユーザーのファイルや会話を送りません。
