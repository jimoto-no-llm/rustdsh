# rdsh の設定画面

DSH の「設定」を開き、左メニューから「rdsh」を選択すると、rdsh の設定を変更できます。

## できること

- 予算の変更（トークン上限など）
- 検索・圧縮・記憶のオン／オフ
- 作業メモ（目標、作業中ファイル、未解決タスク）の記入
- 過去の決定事項や制約の保存
- 実験的機能のオン／オフ

## 開き方

1. DSH の左下「設定」を開く
2. 左メニューの「rdsh」を押す（見えないときは下へスクロール）
3. 変更したら「保存する」を押す

## 入っていないとき

```sh
PROFILE=web ./plugins/install.sh
```

でインストールできます。`headless` の場合は `PROFILE=headless`（初期値）でも同様です。

## 表示言語を日本語にする

言語パックに対応した DSH では、同梱の `rdsh-settings` が日本語を登録します。
Settings → General → Language で **日本語** を選択すると、設定画面の一般項目と共通操作が日本語になります。
翻訳がない項目は英語で表示されます。画面全体の翻訳ではありません。

ローカルの Web UI では、選択した言語が DSH の設定として保存され、再起動後も反映されます。
DSH が非ループバックのページとして扱う接続では、DSH の仕様により、言語の選択はそのページを開いている間のみ有効です。
この選択は `rdsh.json` の設定とは異なります。

日本語が表示されない場合は、言語パック API（`locale.addLanguage`）に対応した DSH へ更新し、
同梱プラグインを再インストールして画面を再読み込みしてください。
旧 DSH でも従来の言語メニューと rdsh 設定を引き続き利用できます。
別のプラグインがすでに日本語を登録している場合は、そのプラグインの翻訳が使用されます。

## コマンドから見る

```sh
rdsh settings show    # 今の設定を見る
rdsh settings keys    # いじれるキー一覧
rdsh settings get search.max
rdsh settings set search.max 50
rdsh settings set context.goal "dsh互換性を維持する"
rdsh settings set guard.deny '["rm -rf /*","*token*"]'
rdsh settings set general.language ja
```

`rdsh guard` に `--policy-file` を指定すると、既知のファイル操作スキーマを
Read/Write/Edit に分類して判定します（未知のツールやシェルはブロックされます）。
指定しない場合は、従来どおり deny パターンによる照合を行います。deny パターンは、
クォート除去、同一行の変数展開、パス正規化（`..` の畳み込みとシンボリック
リンク解決）を行った後の候補とも照合するため、`r"m" -rf` のような難読化でも
すり抜けられません。判定は引き続き構造的なパターン照合であり、許可リスト方式では
ありません。

```sh
rdsh settings unset search.max   # 既定値に戻す
rdsh settings set beta.context_engine true  # 実験機能を使う場合だけ
rdsh context status   # 有効化後に記憶の状態を見る
```

設定は `$DSH_HOME/rdsh.json` に保存され、コマンドと画面の間で共有されます。
旧 `rdsh-context.json` は、`rdsh.json` に context が存在しない場合のみ読み込まれます。

`general.language` は `auto`、`en`、`zh-CN`、`ja` のいずれかです。CLI と独立ダッシュボードにおける `auto` は、空ではない最初のロケール環境変数を使用し、未設定または未対応の場合は英語になります。DSH 内の rdsh 設定プラグインでは、`auto` はブラウザーの言語に従います。優先順位は CLI の `--language`、`RDSH_LANG`、本設定、`LC_ALL`、`LC_MESSAGES`、`LANG` の順です。`general.language` に不正な値を明示して指定した設定ファイルは、通常の設定破損時と同様に処理を停止し、元のファイルを保持します。

`settings init --force` は破損した設定の復旧用です。`task-outcomes` と `subagents plan` は、明示された `--language`、`RDSH_LANG`、OS のロケール環境変数の順に言語を解決します。`subagents plan` はこれに加えて `subagents` セクションのみを読み込み、設定ファイルが欠落または破損している場合でも組み込みの既定値で計画の生成を続行するため、無関係な設定の破損によって計画が中断することはありません（どちらが使用されたかは `rdsh subagents defaults` の `source` で確認できます）。これらの JSON コマンドは設定ファイルを変更しません。他のコマンドは、設定が破損している場合は処理を停止し、元のファイルを保持します。

ローカル状態画面と Web 検索のオン／オフは、`setup --web` の Extras、または
`rdsh settings set extras.enable serve,search-web` で変更します。
ローカル状態画面の既定ポートは 38080 です。

設定の破損時は読み込みを停止します。元のファイルを退避し、既定値に戻すと判断した
場合のみ `rdsh settings init --force` を実行してください。
[復旧後の確認と利用の流れ](USER-FLOW.md#4-設定が読めないとき)。

## 機能スイッチ（on/off）

`rdsh features` で機能一覧を確認でき、`rdsh features on <id>` または `rdsh features off <id>` で切り替えられます。

設定に記載されていない id は既定値のまま動作するため、既存の挙動が変わることはありません。また、旧キー（`discord.enabled` / `extras.enable` / `beta.context_engine`）も引き続き動作しますが、`features.<id>` が指定されている場合はそちらが優先されます。

| id | 既定 | 内容 |
| --- | --- | --- |
| discord | on | Discord Rich Presence（DSH Web が動作しているときのみ表示） |
| update_check | on | 更新確認と更新バナーの表示 |
| update_notifications | on | 更新が見つかったときの通知 |
| sound | on | DSH サウンド通知の導入（不要ならインストーラの SOUND=0／`features.sound=false`） |
| gitview | on | DSH Git パネルの導入（不要ならインストーラの GITVIEW=0／`features.gitview=false`） |
| serve | off | ローカル閲覧画面（rdsh serve） |
| search-web | off | SearXNG 経由の Web 検索 |
| context_engine | off | 実験的なコンテキストエンジン |
| models_sync | on | 毎日の自動更新でプロバイダのモデルカタログも更新する（`RDSH_MODELS_SYNC=0` で1回だけスキップ） |
| compute | off | 常駐 pure-compute worker 連携（RDSH_COMPUTE=1） |
| budget_guard | on | 予算ガードフック |
| answer_guard | on | 本文が空（reasoning のみ）でターンが終了する際、再出力を1回だけ促す |
| agent_tool_sandbox | off | 委譲したエージェントツールの権限を --share-file の範囲に限定（ネットワーク・ホストへの書き込みなし） |
| release_probe | off | リリース検証プローブ（環境変数が設定されているときだけ実行） |
| setup_web | on | rdsh setup --web |
| sessions_token_cache | on | セッションの token サイズキャッシュ |
| node_compile_cache | on | Node コンパイルキャッシュ |
| slim_lazy_plugins | on | slim 時にプラグインを遅延読み込み |
| slim_disable_voice | on | slim 時に DSH の音声機能を停止 |
| slim_disable_auto_review | on | slim 時に自動レビューを停止 |

なお、`rdsh settings set features.<id> true|false` でも同様に設定できます。

## 機能スイッチの効き方

- ネイティブ側（`serve` / `search-web` / `context_engine` / `setup_web`）は、無効化されたコマンドを実行すると理由と有効化方法を表示して終了します。
- slim のヒント（`slim_lazy_plugins` / `slim_disable_voice` / `slim_disable_auto_review`）と `node_compile_cache` は、委譲して起動する DSH プロセスの環境変数に反映されます。
- プラグイン側（`discord` / `sound` / `gitview` / `compute` / `budget_guard` / `answer_guard` / `release_probe` / `update_check` / `update_notifications`）は `rdsh.json` を読み込んで動作を停止します。DSH を再起動すると反映されます。

## context engine（実験的、既定OFF）

```sh
rdsh settings set beta.context_engine true   # 使うときだけON
rdsh context status
rdsh context build --query "認証" --json
```

優先度は goal > constraints > related_files > git_diff > decisions >
open_tasks > retrieved の順で、予算超過時は retrieved から削減されます。

## context の自動注入（inject）

`rdsh context inject` は、DSH の `UserPromptSubmit` フックとして毎ターンの文脈を注入します。
組み立てに失敗してもプロンプトを停止しない fail-open です。

```sh
rdsh context hook install          # $DSH_HOME/hooks.json に追記（冪等、バックアップ自動作成）
rdsh context hook status --json
rdsh context hook remove           # 追加した1件だけを消す
```

| 設定キー | 既定 | 範囲 | 意味 |
| --- | --- | --- | --- |
| `context.inject_budget` | 1200 | 200-8000 | 1回の注入に使うトークン予算 |
| `context.inject_deadline_ms` | 1200 | 100-10000 | 組み立ての期限。超えたら検索と依存閉包を省略 |
| `context.inject_sessions` | true | | 直近セッションの継承を含める |
| `context.inject_session_count` | 2 | 0-10 | 継承するセッション数 |

`rdsh context build --sessions N` と `--require-stable` は、1回のみ既定値を上書きします。
`--require-stable` は、リポジトリに変更がある場合に加え、git の状態を読み取れない場合も exit 3 で終了します
（安定性を証明できない場合は成功と判定しないため）。

## 記憶（memory）

```sh
rdsh context remember "APIの互換性を必ず保つ" --kind constraint
rdsh context memory --json
rdsh context distill --session <transcript> --json     # 既定は dry-run
rdsh context distill --session <transcript> --apply
rdsh context forget <id>
```

保存先は `$DSH_HOME/rdsh-context-memory.json`（schema 1）です。撤回や重複には決定的な規則で
`superseded_by` を付与し、context には active な項目だけが `[mem]` 付きで登録されます。

## 依存グラフ（deps）

`dep_graph` は既定で ON です（読み取り専用の解析コマンドであるため）。

```sh
rdsh deps build --json
rdsh deps query engine_score --json
rdsh deps impact src/core.rs --depth 3 --json
```

索引の保存先は `$DSH_HOME/rdsh-index/<root-key>.json` です。size+mtime が同一のファイルは再解析しません。

## サブエージェント計画の既定値（subagents）

`rdsh subagents plan` の要求で `limits` が省略された場合の既定値です。要求に
指定された値が常に優先され、`null` は既定値のまま維持されます。

| キー | 組み込み既定 | 範囲 |
| --- | --- | --- |
| `subagents.max_parallel` | 3 | 1-16 |
| `subagents.max_items_per_agent` | 3 | 1-20 |
| `subagents.max_weight_per_agent` | 9 | 1-128 |
| `subagents.budget_units` | 0（警告なし） | 0-100000 |

```sh
rdsh settings set subagents.max_parallel 2
rdsh subagents defaults --json
```

`rdsh subagents defaults` は、有効な既定値と `source`（`settings` または
`builtin`）を JSON で出力します。範囲外の値はファイル読み込み時に
クランプされ、計画そのものは失敗しません。
