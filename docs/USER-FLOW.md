# 導入から利用・復旧まで

rdsh は端末で使う高速な補助CLIです。会話やモデル通信は本家DSHが担当します。
Desktopアプリ全体の起動時間・常駐メモリと、CLIの測定結果は区別してください。

## 1. 導入を確認する

[インストール手順](../README.ja.md#インストール)のあと、次を確認します。

```sh
rdsh --version
rdsh doctor
```

`doctor` で本家DSHの場所・版・接続状態を確認します。元のCLIが見つからない場合、
トークン推定などの単独機能は使えますが、会話開始の委譲には本家DSHが必要です。

## 2. 会話に使う接続と、補助機能を設定する

```sh
rdsh setup --web
```

表示された `#key=...` 付きURLを開きます。接続を確認し、必要なら認証を行います。
接続状態の表示だけではモデルの応答を確認したことにはなりません。
実際に `rdsh tui` で会話を開始し、選んだモデルの応答まで確認してください。

Web検索とローカル状態画面は既定でOFFです。設定画面のExtrasで必要なものだけ
有効にするか、コマンドで指定します。この指定は一覧全体を置き換えます。

```sh
rdsh settings set extras.enable serve,search-web
rdsh settings get extras.enable
```

Web検索には別途SearXNGが必要です。DSH内のrdsh設定プラグインと、
`setup --web` の初回設定画面は別の入口です。[設定画面の詳細](RDSH-SETTINGS.md)。

## 3. 目的に合う入口を選ぶ

| 目的 | 入口 | 必要なもの |
| --- | --- | --- |
| AIとの会話 | `rdsh tui` / `rdsh --profile web` | 本家DSHとモデル接続 |
| トークン推定・検索・圧縮 | `rdsh tokens` / `search` / `prune` | rdshバイナリ |
| 手元の状態を確認 | `rdsh serve --port 0` | `serve` をExtrasで有効化 |
| プロジェクト指標・人への質問と回答 | `node dashboard/cli.mjs project --project <path> --no-tailscale --open` | Node.js 22+、dashboard依存の導入 |
| Windows/WSL上の本家Web画面の中継 | `rdsh-dashboard harness` | 対応するWindows/WSL環境 |

`rdsh serve` のURLも起動ごとの鍵を含みます。既定ポートは38080で、
DSH webの既定3080とは異なります。スマホ向けの接続は
[Node dashboardの説明](../dashboard/README.md#qr-access)を確認してください。
Tailscaleの導入・ログイン・共有設定はローカルCLI導入とは別の操作です。

## 4. 設定が読めないとき

通常コマンドは破損した `rdsh.json` を読み飛ばさず停止します。設定画面も
正常な既定値として表示せず、読み込みエラーを返します。
元のファイルを退避・確認し、設定をすべて既定値へ戻すと決めた場合だけ実行します。

```sh
rdsh settings init --force
rdsh settings show --json
```

復旧後、denyルール・Extras・独自の設定を再確認します。`--force` は既存設定を
置き換えます。既存設定を保持する通常の `settings init` とは異なります。

## 動線の図

![導入・設定・利用・復旧の動線](diagrams/user-flow.svg)

[編集用Mermaid](diagrams/user-flow.mmd)。現在のCLIとdashboardの入口を示します。
未マージPRの実行管理・予算・バックアップ機能は、この利用手順の対象外です。

## 検証されている範囲

CLIとローカルHTTPはRustのE2Eテスト、設定・状態画面は実サーバーに接続する
ブラウザテストで検証します。[検証一覧と残件](evidence/e2e-20261008.md)。
本家DSH内のrdsh設定プラグインは保存から破損時の再読み込みまで確認済みですが、
スマホ幅で本文が狭くなる問題が残っています。モデルの応答、Desktop全体の動作、
Tailscale経由の実機接続は別途確認が必要です。
