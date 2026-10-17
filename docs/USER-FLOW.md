# 導入から利用・復旧まで

rdsh は端末で利用する高速な補助CLIです。会話やモデルとの通信は本家DSHが担当します。
Desktopアプリ全体の起動時間や常駐メモリと、CLIの測定結果は区別してください。

## 1. 導入を確認する

[インストール手順](../README.ja.md#インストール)の完了後、以下を確認します。

```sh
rdsh --version
rdsh doctor
```

`doctor` で本家DSHの場所、バージョン、接続状態を確認します。元のCLIが見つからない場合、
トークン推定などの単独機能は利用できますが、会話開始の委譲には本家DSHが必要です。

## 2. 会話に使う接続と、補助機能を設定する

```sh
rdsh setup --web
```

localhost の画面を開き、端末に表示された保護済みトークンファイルの内容を貼り付けて
接続します。トークン自体は端末の出力やブラウザーの起動引数には含まれません。接続を確認し、
必要に応じて認証を行います。
接続状態の表示だけでは、モデルの応答を確認したことにはなりません。
実際に `rdsh tui` で会話を開始し、選択したモデルの応答まで確認してください。

Web検索とローカル状態画面は既定でOFFです。設定画面のExtrasで必要な項目のみ
有効にするか、コマンドで指定します。この指定は一覧全体を置き換えます。

```sh
rdsh settings set extras.enable serve,search-web
rdsh settings get extras.enable
```

Web検索には別途SearXNGが必要です。DSH内のrdsh設定プラグインと、
`setup --web` の初回設定画面は別の入口です。詳細は [設定画面の詳細](RDSH-SETTINGS.md) を参照してください。

表示言語は `--language` または `general.language` で英語、簡体字中国語、日本語を選択できます。CLI の `auto` はロケール環境変数を参照し、未設定または未対応の場合は英語になります。画面固有のラベル、日時、数値のみが切り替わり、モデルの応答、会話、タスク本文、API JSON、ファイル名は原文のまま保持されます。

## 3. 目的に合う入口を選ぶ

| 目的 | 入口 | 必要なもの |
| --- | --- | --- |
| AIとの会話 | `rdsh tui` / `rdsh --profile web` | 本家DSHとモデルへの接続 |
| トークン推定・検索・圧縮 | `rdsh tokens` / `search` / `prune` | rdshバイナリ |
| 手元の状態確認 | `rdsh serve --port 0` | Extrasでの `serve` の有効化 |
| プロジェクト指標・人への質問と回答 | `node dashboard/cli.mjs project --project <path> --no-tailscale --open` | Node.js 22+、dashboard依存関係の導入 |
| Windows/WSL上の本家Web画面の中継 | `rdsh-dashboard harness` | 対応するWindows/WSL環境 |
| デスクトップアプリの確認とプラグイン組み込み | `rdsh desktop status` / `rdsh desktop install --plugins-dir <rustdsh>` | 本家デスクトップアプリ（初回起動でプロファイル作成済み）、macOSまたはWindows |

デスクトップアプリ本体は専用のプロファイル（`$DSH_HOME/profiles/desktop`）を持つため、
プラグインの組み込みはアプリを終了した状態で行い、完了後に再度開いて反映します。
詳細は [DESKTOP-INTEGRATION.md](DESKTOP-INTEGRATION.md) を確認してください。

`rdsh serve` のURLも起動ごとの鍵を含みます。既定ポートは38080で、
DSH webの既定値3080とは異なります。スマートフォン向けの接続方法は
[Node dashboardの説明](../dashboard/README.md#qr-access) を確認してください。
Tailscaleの導入、ログイン、共有設定は、ローカルCLIの導入とは別の手順です。

## 4. 設定が読めないとき

通常のコマンドは破損した `rdsh.json` を読み飛ばさずに停止します。設定画面でも
正常な既定値としては表示されず、読み込みエラーを返します。
元のファイルを退避して確認し、設定をすべて既定値へ戻すと決めた場合のみ実行してください。

```sh
rdsh settings init --force
rdsh settings show --json
```

復旧後は、denyルール、Extras、独自の設定を再確認してください。`--force` は既存の設定を
置き換えます。既存の設定を保持する通常の `settings init` とは異なります。

## 動線の図

![導入・設定・利用・復旧の動線](diagrams/user-flow.svg)

[編集用Mermaid](diagrams/user-flow.mmd) です。現在のCLIとdashboardの入口を示します。
未マージPRの実行管理、予算、バックアップ機能は、この利用手順の対象外です。

## 検証されている範囲

CLIとローカルHTTPはRustのE2Eテスト、設定・状態画面は実サーバーに接続する
ブラウザテストで検証します。詳細は [検証一覧と残件](evidence/e2e-20261008.md) を参照してください。
本家DSH内のrdsh設定プラグインは、保存から破損時の再読み込みまで確認済みです。
スマートフォン幅で本文が狭くなる問題に対しては、同梱の
[`rdsh-mobile-ui`](../plugins/rdsh-mobile-ui/README.md)（Smart-DSH のモバイル表示を
もとにしたMITライセンスのレイアウト）が767px以下でチャットと入力欄を全幅表示にします。
実サーバー（DSH 0.2.0-rc.2）の390px表示で、列幅390px、入力欄383px、横スクロールなしを
確認済みです。実機のスマートフォン、Tailscale経由の接続、モデルの応答、Desktop全体の動作は
別途確認が必要です。
