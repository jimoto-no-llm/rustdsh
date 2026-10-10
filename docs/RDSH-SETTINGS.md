# rdsh の設定画面

DSH の「設定」を開き、左のメニューから「rdsh」を選ぶと、rdsh の設定を変えられます。

## できること

- 予算の変更（トークン上限など）
- 起動の最適化、検索件数、圧縮のトークン上限の変更
- セッション表示件数とトークン推定の再計算間隔の変更
- Discordの作業状態のプレビュー・保存・反映確認
- 作業メモ（目標、作業中ファイル、未解決タスク）の記入
- 過去の決定事項や制約の保存
- 実験的機能のオン／オフ

## 開き方

1. DSH の左下「設定」を開く
2. 左メニューの「rdsh」を押す（見えないときは下へスクロール）
3. 変えたら「保存する」を押す

上部の「Discord」「起動とコマンド」「文脈（実験）」から項目へ移動できます。
保存ボタンはスクロール中も上部に残ります。未保存の変更は表示され、
「再読み込み」では破棄してよいか確認します。タブを閉じる際の確認は
ブラウザーの対応と操作履歴によります。自動保存ではありません。

保存中は編集を止め、失敗時は入力を残して再試行できます。
「Discord設定を保存」はDiscordだけを保存し、他の項目の下書きを保持します。
Discordの「保存済み」と実際の「反映しました」は別々に確認できます。
それ以外の設定は次のrdshコマンド実行から使われ、実行中のDSHを再起動しません。

「1行1件」の欄は改行しながら編集できます。保存時に空行と行頭・行末の空白を
除いて配列へ変換します。各一覧は50件まで、作業ファイルは1件300文字、
それ以外の一覧は1件500文字までです。文字数はUnicodeの文字単位で扱います。既定プロファイルは200文字、
目標とSearXNG URLは2000文字までです。表示と保存の上限はCLIに合わせています。
数値欄を空にすると、その項目の既定値に戻ります。保存時はCLIと同じ範囲に収めます。

## 項目の意味

| 表示・キー | 何を変えるか |
| --- | --- |
| 起動を最適化する / `general.slim` | DSHへ渡す起動環境を調整します。会話機能や出力の削減ではありません。 |
| 起動の最適化を使わずDSHに渡す / `general.passthrough` | 起動環境の調整を外します。必須のツール隔離は維持します。 |
| 起動コマンドだけ表示する / `general.dry_run` | 委譲コマンドを表示し、DSHを実行しません。 |
| 既定プロファイル / `general.default_profile` | `tui`、`web`など、省略時に使うDSHプロファイルです。 |
| `tokens.default_budget` / `compact.max_tokens` | CLIのprune / compactで上限を省略した場合の推定トークン予算です。モデル固有のトークナイザーではありません。 |
| `search.dir` / `search.max` | ファイル検索の起点と表示する最大件数です。文字列の完全な部分一致を探します。 |
| `search.searxng_url` / `search.web_limit` | SearXNGの接続先とWeb検索の件数です。追加機能の有効化も必要です。 |
| `sessions.limit` | 新しい順に表示するセッション数です。履歴の保持数ではなく、削除もしません。 |
| `sessions.with_tokens` | セッション一覧にトークン推定値を付けます。 |
| `sessions.stale_secs` | 更新中の圧縮履歴の推定値を再利用する秒数（0〜3600、既定60）です。0では毎回再計算します。 |
| `logs.tail` | 最新ログから表示する末尾の行数です。 |
| `serve.port` / `setup.web_port` | ローカル状態画面 / 初回設定のポートです。setupは0で空きポートを選びます。CLIのserveも`--port 0`に対応します。 |
| `guard.deny` / `guard.reason` | guardへ渡された入力に照合する拒否パターンと理由です。`*`と`?`が使えます。 |
| `bench.n` | CLIの起動時間を測る回数です。モデルの回答速度は測りません。 |
| `beta.context_engine` / `context.*` | 実験的な文脈の組み立てと、その目標・決定事項・制約・ファイル・未解決タスクです。 |

## 入っていないとき

```sh
PROFILE=web ./plugins/install.sh
```

で入ります。`headless` の場合は `PROFILE=headless`（初期値）で同じです。

## コマンドから見る

```sh
rdsh settings show    # 今の設定を見る
rdsh settings keys    # いじれるキー一覧
rdsh settings get search.max
rdsh settings set search.max 50
rdsh settings set context.goal "dsh互換性を維持する"
rdsh settings set guard.deny '["rm -rf /*","*token*"]'
rdsh settings unset search.max   # 既定値に戻す
rdsh settings set beta.context_engine true  # 実験機能を使う場合だけ
rdsh context status   # 有効化後に記憶の状態を見る
```

設定は `$DSH_HOME/rdsh.json` に保存され、コマンドと画面で共有されます。
旧 `rdsh-context.json` は `rdsh.json` に context がないときだけ読みます。

ローカル状態画面とWeb検索のオン／オフは `setup --web` のExtras、または
`rdsh settings set extras.enable serve,search-web` で変更します。
ローカル状態画面の既定ポートは38080です。
CLIの`extras.enable`指定は一覧全体を置き換えます。初回設定画面のチェック欄は
現在の一覧を読み直し、変更した機能以外の値を保持して保存します。
DSH内のrdsh設定プラグインはExtrasや未対応の設定を変更しません。

設定破損時は読み込みを止めます。元のファイルを退避し、既定値へ戻すと決めた
場合だけ `rdsh settings init --force` を実行してください。
[復旧後の確認と利用の流れ](USER-FLOW.md#4-設定が読めないとき)。

## context engine（実験的、既定OFF）

```sh
rdsh settings set beta.context_engine true   # 使うときだけON
rdsh context status
rdsh context build --query "認証" --json
```

優先度は goal > constraints > related_files > git_diff > decisions >
open_tasks > retrieved の順で、予算超過時は retrieved から削ります。
`context build`の結果はCLIに出力します。DSHの会話への自動適用や、
過去セッションの自動取り込みはありません。実際の文脈に使う場合は、
出力を確認してから自分で会話に渡してください。
