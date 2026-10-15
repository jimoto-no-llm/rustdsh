# rdsh の設定画面

DSH の「設定」を開き、左のメニューから「rdsh」を選ぶと、rdsh の設定を変えられます。

## できること

- 予算の変更（トークン上限など）
- 検索・圧縮・記憶のオン／オフ
- 作業メモ（目標、作業中ファイル、未解決タスク）の記入
- 過去の決定事項や制約の保存
- 実験的機能のオン／オフ

## 開き方

1. DSH の左下「設定」を開く
2. 左メニューの「rdsh」を押す（見えないときは下へスクロール）
3. 変えたら「保存する」を押す

## 入っていないとき

```sh
PROFILE=web ./plugins/install.sh
```

で入ります。`headless` の場合は `PROFILE=headless`（初期値）で同じです。

## 表示言語を日本語にする

言語パックに対応したDSHでは、同梱の `rdsh-settings` が日本語を登録します。
Settings → General → Language で **日本語** を選ぶと、設定画面の一般項目と共通操作が日本語になります。
翻訳のない項目は英語で表示されます。画面全体の翻訳ではありません。

ローカルのWeb UIでは、選択した言語はDSHの設定として保存され、再起動後も反映されます。
DSHが非ループバックのページとして扱う接続では、DSHの仕様により言語の選択はそのページを開いている間だけ有効です。
この選択は `rdsh.json` の設定とは別です。

日本語が表示されない場合は、言語パックAPI（`locale.addLanguage`）に対応したDSHへ更新し、
同梱プラグインを入れ直して画面を再読み込みしてください。
旧DSHでは従来の言語メニューとrdsh設定を引き続き使えます。
別のプラグインがすでに日本語を登録している場合は、そのプラグインの翻訳を使います。

## コマンドから見る

```sh
rdsh settings show    # 今の設定を見る
rdsh settings keys    # いじれるキー一覧
rdsh settings get search.max
rdsh settings set search.max 50
rdsh settings set context.goal "dsh互換性を維持する"
rdsh settings set guard.deny '["rm -rf /*","*token*"]'
```

`rdsh guard` に `--policy-file` を付けると、既知のファイル操作スキーマを
Read/Write/Edit に分類して判定します（未知のツールやシェルはブロック）。
付けない場合は従来どおり deny パターン照合になります。

```sh
rdsh settings unset search.max   # 既定値に戻す
rdsh settings set beta.context_engine true  # 実験機能を使う場合だけ
rdsh context status   # 有効化後に記憶の状態を見る
```

設定は `$DSH_HOME/rdsh.json` に保存され、コマンドと画面で共有されます。
旧 `rdsh-context.json` は `rdsh.json` に context がないときだけ読みます。

ローカル状態画面とWeb検索のオン／オフは `setup --web` のExtras、または
`rdsh settings set extras.enable serve,search-web` で変更します。
ローカル状態画面の既定ポートは38080です。

設定破損時は読み込みを止めます。元のファイルを退避し、既定値へ戻すと決めた
場合だけ `rdsh settings init --force` を実行してください。
[復旧後の確認と利用の流れ](USER-FLOW.md#4-設定が読めないとき)。

## 機能スイッチ（on/off）

`rdsh features` で機能一覧を確認でき、`rdsh features on <id>` または `rdsh features off <id>` で切り替えられます。

設定に未記載の id は既定値のまま動作するため、既存の挙動が変わることはありません。また、旧キー（`discord.enabled` / `extras.enable` / `beta.context_engine`）も引き続き動作しますが、`features.<id>` が指定されている場合はそちらが優先されます。

| id | 既定 | 内容 |
| --- | --- | --- |
| discord | on | Discord Rich Presence（DSH Web が動いているときだけ表示） |
| update_check | on | 更新確認と更新バナーの表示 |
| update_notifications | on | 更新が見つかったときの通知 |
| sound | off | DSH サウンド通知の導入（インストーラの SOUND=1） |
| serve | off | ローカル閲覧画面（rdsh serve） |
| search-web | off | SearXNG 経由の Web 検索 |
| context_engine | off | 実験的なコンテキストエンジン |
| compute | off | 常駐 pure-compute worker 連携（RDSH_COMPUTE=1） |
| budget_guard | on | 予算ガードフック |
| agent_tool_sandbox | off | 委譲したエージェントツールを --share-file の範囲に限定（ネットワーク・ホスト書き込みなし） |
| release_probe | off | リリース検証プローブ（環境変数があるときだけ実行） |
| setup_web | on | rdsh setup --web |
| sessions_token_cache | on | セッションの token サイズキャッシュ |
| node_compile_cache | on | Node コンパイルキャッシュ |
| slim_lazy_plugins | on | slim 時にプラグインを遅延読み込み |
| slim_disable_voice | on | slim 時に DSH の音声機能を止める |
| slim_disable_auto_review | on | slim 時に自動レビューを止める |

なお、`rdsh settings set features.<id> true|false` でも同じように設定できます。

## 機能スイッチの効き方

- ネイティブ側（`serve` / `search-web` / `context_engine` / `setup_web`）は、無効なコマンドを実行すると理由と有効化方法を表示して終了します。
- slim のヒント（`slim_lazy_plugins` / `slim_disable_voice` / `slim_disable_auto_review`）と `node_compile_cache` は、委譲して起動する DSH プロセスの環境変数に反映されます。
- プラグイン側（`discord` / `sound` / `compute` / `budget_guard` / `release_probe` / `update_check` / `update_notifications`）は `rdsh.json` を読み込んで動作を停止します。DSH を再起動すると反映されます。

## context engine（実験的、既定OFF）

```sh
rdsh settings set beta.context_engine true   # 使うときだけON
rdsh context status
rdsh context build --query "認証" --json
```

優先度は goal > constraints > related_files > git_diff > decisions >
open_tasks > retrieved の順で、予算超過時は retrieved から削ります。
