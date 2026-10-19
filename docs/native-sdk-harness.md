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
| 承認・拒否・キャンセル | Rust、呼び出しごとの一回限りの承認ID |
| ファイル読み取り・Devin起動 | Rust `native_harness::tools` |
| モデルの生成 | Cursor公式SDK / Antigravity公式SDKの生成専用プロセス |
| Webサーバー・GUI API | Rust、既存のローカルHTTPフレーミングを再利用 |

Node/Pythonは公式SDKの生成アダプターだけに使用します。DSHのJavaScript
プラグイン、Cordis、DSHの会話ループ・ツールランタイム・承認APIは読み込みません。
SDKごとに毎回新しい隔離用一時ディレクトリを作り、SDK内のツール、MCP、skills、
subagentsを無効にします。SDKからの呼び出し提案をRustが検証し、承認後に実行し、
結果を次のSDK呼び出しへ返します。JSON形式の不正応答だけ修正要求を1回行います。

公式SDKの依存関係は `plugins/rdsh-direct-models/README.md` に従って用意します。
Cursorは公式SDKの既存認証ストア、または `CURSOR_API_KEY` を利用します。
Antigravityは `GEMINI_API_KEY` / `GOOGLE_API_KEY` の環境変数、または承認済みの
既存 `~/.dsh/.credentials.yaml` の同名refを読み取り利用します。認証ストアへの
書き込み・新規キー発行・契約変更は行いません。既知の秘密値をGUI表示とモデル履歴で
マスクし、SDKの生のエラー出力は公開しません。

## ツールと承認

最初のnative実装は `read` と `devin_cli` の2ツールを持ちます。
DSHの既存プラグインを自動で移植・実行するものではありません。

- `read {"path":"relative/file.txt"}`: 明示したワークスペース内のUTF-8通常ファイル、
  64KiB以下。絶対パス・親への移動・隠しファイル・既知の認証ファイルを拒否します。
  Unixでは各パス成分を `openat` / `O_NOFOLLOW` で開き、承認待ち中のsymlink置換も
  追跡しません。読み取り内容を選択中のプロバイダーへ送信する前に毎回承認が必要です。
- `devin_cli {"prompt":"...","timeout":60}`: Rustが固定のDevin CLIを直接起動します。
  作業ディレクトリはRustのワークスペース、promptはシェルを介さず一引数で渡します。
  timeoutは1〜300秒、stdout/stderr合計64KiB。Devin自身の通常の認証・信頼・承認を
  維持し、承認バイパスフラグは渡しません。毎回Rust GUIの承認が必要です。
  CLIの場所は `--devin-bin` で明示できます。既定は `~/.local/bin/devin` です。

拒否は未実行のツール結果として履歴に入り、永続的な許可にはなりません。
承認は再利用できず、キャンセル後は実行開始ゲートで新たな起動を拒否します。
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
