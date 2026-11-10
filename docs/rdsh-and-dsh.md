# dsh と rustdsh の関係、Web UIと更新設定

rdsh は、モデル接続・プロセス管理・検索・セッション管理などを扱う Rust マイクロオーケストレータです。
本書は、そのうち同梱DSHアダプターを使う経路を説明します。
ネイティブの道具や `rdsh native-web` は別の実行経路です。

## 1. 同梱アダプターを使うときの役割

| 名前 | 役割 |
| --- | --- |
| dsh（DeepSeek Harness） | Node.js上で会話・ツール実行・モデル接続・DSHのWeb画面を提供する |
| rdsh | Rust側の設定・診断・セッション管理・更新処理や、委譲するプロセスの管理を行う |

接続先のモデルはDeepSeekだけに限定されません。OpenAI互換APIやローカル推論などを利用できます。
アダプターの範囲は [HARNESS-ADAPTER.md](HARNESS-ADAPTER.md)、機能ごとの対応版は
[DSH-COMPATIBILITY.md](DSH-COMPATIBILITY.md)を確認してください。

## 2. DSHのWeb画面に追加されるもの

`rdsh --profile web` で開く画面（既定 `http://127.0.0.1:3080`）は、委譲先DSHのWeb UIです。
対象プロファイルへ同梱プラグインを導入すると、次の機能を追加できます。

1. **設定タブ「rdsh」** — モデル・プロバイダ共有・Discord表示・追加機能などの設定。
2. **更新のお知らせ** — 保存された更新状態の表示、詳細、通知の終了、画面からの更新操作。
3. **便利プラグイン** — 効果音、Git表示、モバイル向け表示など。導入・有効化の条件はプラグインごとに異なります。

日次の自動更新は、インストールしただけでは設定されません。
`rdsh update auto on` で明示的に設定する機能です。
管理下のプラグイン・rustxngには別の自動更新経路があるため、[通信の既定値](PRIVACY.md)と
[自動更新](AUTO-UPDATE.md)を確認してください。

## 3. はじめて使う場合

導入手順は [SETUP.md](SETUP.md) の順に進めてください。
公開版v0.15.0ではNode.js・pnpmを別途用意します。Unix版のDSH導入は案内のみで、Windows版はnpmがある対話端末で確認後に導入を試みます。実行環境をすべて自動導入するとは案内しません。

1. **初回セットアップ** — `rdsh setup --web` を開き、使うモデルの接続先を一つ選びます。
2. **推奨プラグイン** — `rdsh plugins install --recommended=starter` で対象プロファイルに導入します。
3. **Web UIの起動** — `rdsh --profile web` を実行します。常時起動サービスは、設定した場合だけ使います。
4. **設定変更** — Web画面の設定タブ「rdsh」から変更します。

日次更新の状態は `rdsh update auto status`、専用アプリとの連携状況は `rdsh desktop status` で確認できます。
Linuxの `systemctl` コマンドを、すべてのOSで必要な導入手順として案内しないでください。

## 4. よくある質問

**会話は消える？**
DSHアダプターの会話はDSH側の保存先（既定 `~/.dsh`）を使います。既存の設定・会話を消して入れ直す必要はありません。

**動作は速くなる？**
rdshの検索・診断などはRust実装です。モデルの生成速度は接続先・モデル・機材に依存します。

**更新に失敗したら？**
rdshの更新処理は検証とロールバックを行います。全プラグイン・外部サービスの障害を復旧できるという保証ではありません。

**Web UI以外で使いたい**
既存のTUIプロファイルがあれば `rdsh tui`、DSHのDesktopアプリがあればrdshのDesktop連携を使えます。
TUIの導入・互換性は [TUI-SETUP.md](TUI-SETUP.md)、アプリ連携は [DESKTOP-INTEGRATION.md](DESKTOP-INTEGRATION.md)を確認してください。
