# rdsh-devin-cli

rustdshのDSHプロファイルからDevin CLIへタスクを委譲する単独プラグインです。
Cursor / Antigravity SDK、APIキーの追加登録、`rdsh-direct-models`の導入は不要です。
必要なホストサービスは `tools` だけです。Node.js 22以降と、ログイン済みDevin CLIを使用します。

## 導入

Devin CLIで `devin auth status` を確認してください。未ログインの場合は
`devin auth login` でログインします。プラグインはログイン情報をコピーしません。

利用するDSHプロファイルを停止してから、リポジトリのルートで実行します。

```sh
dsh plugin --profile web add "$PWD/plugins/rdsh-devin-cli"
rdsh web
```

配布用tgzを受け取った場合は、任意の場所に展開してから導入します。

```sh
mkdir rdsh-devin-cli
tar -xzf rdsh-devin-cli-0.1.0.tgz -C rdsh-devin-cli --strip-components=1
dsh plugin --profile web add "$PWD/rdsh-devin-cli"
rdsh web
```

Devin実行ファイルは `~/.local/bin/devin` があればそれを使い、なければPATH上の
`devin` を使用します。プロファイルを再起動すると、モデルに `devin` ツールが見えます。

## 呼び出し

会話で「Devinにこの作業を依頼して」と指定すると、モデルが次のような呼び出しを
提案できます。実行前にはDSHの承認が必要です。

```json
{
  "prompt": "READMEを読み、改善案を3つ報告してください。ファイルは変更しないでください。",
  "cwd": ".",
  "timeout": 120
}
```

`prompt` は1〜32,000文字、`cwd` は省略時に現在のセッションの作業フォルダ、
`timeout` は1〜300秒（既定120秒）です。絶対パスやsymlinkを含め、作業フォルダ外への
移動を拒否します。引数はshellで解釈せず、そのまま `devin -p` へ渡します。

結果には `exitCode`・`signal`・`stdout`・`stderr`・`timedOut`・`truncated` を返します。
stdoutとstderrはそれぞれ64 KiBに制限し、タイムアウト・過大出力・キャンセル時は
子プロセスを停止します。Unixではプロセスグループも停止します。Windowsの子孫プロセス
全体の停止までは保証しません。既知の秘密値やトークン形式は出力からマスクしますが、
任意の秘密情報を完全に識別するものではありません。

Devinは自身のエージェントループで動作し、既存の権限設定に従ってファイル編集や
コマンド実行を行うことがあります。ホストの承認は委譲全体に対する承認です。
プラグインは権限バイパスや自動承認のフラグを付けません。非対話実行でDevin側の
追加承認が必要になった場合は、Devin側で停止・失敗することがあります。
利用には既存アカウントの利用枠が消費される場合があります。

既存の `rdsh-direct-models` が登録する `devin_cli` とは別名の `devin` として登録するため、
同時導入でもツール名は衝突しません。既存ツールやSDK連携は変更しません。

## Rust独自ハーネスとの関係

このプラグインの導入先は `rdsh web` などが起動するDSHプロファイルです。
`rdsh native-web` はDSHプラグインをロードしません。独自Rustハーネスには既に
承認付きの `devin_cli` があるため、そちらでは追加導入は不要です。

## 検証

```sh
npm test --prefix plugins/rdsh-devin-cli
npm pack --ignore-scripts ./plugins/rdsh-devin-cli
```

テストは偽の子プロセスで承認・引数・作業フォルダ境界・出力上限・キャンセルを確認し、
配布物を単独展開してSDK依存なしでロードできることも確認します。
