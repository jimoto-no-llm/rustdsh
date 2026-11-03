# 初回の自動準備の検証

2026-11-04 に Linux x64 で検証しました。画面は日本語、1280px と 390px 幅です。変更前の画面は main の b6aac05b を使っています。

## 実配布物の確認

- 空の HOME と Node.js / npm / pnpm / DSH のない PATH から `install.sh --runtime-only` を実行。
  公式 Node.js 24.22.1 を SHA-256 検証後に展開し、pnpm 10.34.9 と DSH 0.2.2-alpha.3 が起動しました。
- 同じ隔離 HOME で Codex CLI 0.166.0 を追加し、`--version` を確認しました。
- 実際のセットアップ HTTP サーバーへ、トークン付きの `local-model` アクションを送りました。
  Ollama v0.40.14 の約 1.5 GB の配布物を検証・展開し、専用ポートで起動。
  `qwen3:1.7b` の取得、completion / tools 機能の確認、選択の保存まで成功しました。
- 取得中の状態 API は最後に表示したモデル一覧を保持します。毎回の認証・ポート再走査を避け、
  進行状況の取得が遅くなる問題を修正しました。
- 実際の DSH 0.2.2-alpha.3 に生成したパッチを渡し、`--dump-config` の成功と
  `rdsh-local` / `qwen3:1.7b` の反映を確認しました。

実配布物は一時ディレクトリだけに導入しました。既存の設定やモデルの保存先は使っていません。
追加で専用 Ollama のチャット API に短い入力を送り、ローカルモデルから `OK` の完了応答を確認しました。
クラウドへの推論リクエストは送っていません。

DSH alpha.3 の新規環境では TUI プロファイルがないことも確認しました。未導入の TUI を起動ボタンで案内せず、Web を優先します。

## 自動テスト

- `sh scripts/check.sh quick`：fmt / clippy 警告ゼロ / Rust 1233 tests。
- `tests/regress.sh`：117 checks、および doctor のパイプ切断テスト。
- リリース関連 Python：154 tests。テスト用 Git リポジトリのみ tag.gpgsign=false を指定。
- `scripts/crate-release.py check`：Windows インストーラを含むコンパイル入力が梱包されています。
- `tests/runtime-bootstrap.sh`：pnpm 未導入、空白・引用符を含む HOME、native-only、改ざん Node アーカイブの拒否。
- Node のカタログ / セキュリティ境界テスト：16 pass、実ランタイム用の未指定 fixture は 6 skip。
- `tests/e2e/setup-provision.mjs`：16 checks。二重開始防止、進行状況、中止・再試行、
  モデル選択、既存接続の自動選択、プロファイルに応じた起動ボタン、390px 幅の横あふれなし。

ブラウザテストは実際の HTML / JavaScript と模擬 API 応答を使います。
認証・Origin・不正アクション拒否は Rust の実ループバック HTTP テストで検証します。
Windows の実導入は `tests/runtime-bootstrap.ps1` を Windows CI で確認します。

## 画面

- [変更前の準備画面](before-ready.png)
- [変更後の準備画面](after-ready.png)
- [モデル選択](after-models.png)
- [ダウンロードの進行状況](after-progress.png)
- [スマホ幅の完了画面](after-mobile.png)

画面のモデル名・状態はテスト用です。実際の認証情報は含みません。

## Modern Web Guidance

適用したガイドと実装上の対応です。

- progress: “Use a native `<progress>` element” — label を関連付け、未確定時は value を外します。
- forms: “use `<fieldset>` and `<legend>` to group related controls.” — モデルの大きさをネイティブのラジオボタンで選びます。
- accessibility: “Prefer native HTML elements and attributes to ARIA” — button / label / select と控えめな状態通知を使います。
