# Rust TUIからDSHのツール・プラグインを使う

```sh
rdsh native-tui --backend dsh --dsh-profile web --workspace /path/to/project
```

画面、入力、スクロール、モデル選択、承認・質問への回答はRustが描画します。
指定した既存DSHプロファイルを、ブラウザーを開かずに子プロセスとして起動します。
DSH側のツール、プラグイン、MCP、skills、モデル登録、認証、承認・sandbox設定を
そのまま使用します。DSHのTUIプラグインを呼び出すコマンドではありません。
DSHと、そのバージョンに対応するNodeのインストールが必要です。

新規会話は指定パスをDSHのworkspaceへ登録・再利用してから作成します。
保存会話はIDと履歴、既存のworkspace所属を維持します。旧会話に所属がない場合だけ、
保存されたcwdと一致するworkspaceへ関連付けます。確認できない場合は警告を表示します。

RustXNG / SearXNGの検索連携も、通常のDSH起動と同じ初期化を使います。
`rdsh rustxng install`、`rdsh rustxng start` で検索エンジンを用意し、
同じプロファイルへ `rdsh-web-search-searxng` を導入すると、到達性を確認して
`web_search` をローカル検索へ接続します。既存の検索先指定と無効化設定は尊重します。
詳しくは[検索連携](WEB-SEARCH.md)を参照してください。

DSHのbase構成が`web.config.searchProvider: deepseek-official`を明示している場合は、
環境変数よりその指定が優先されます。RustXNGを検索先として選ぶ場合は、
対象プロファイルの`cordis.patch.yml`に次の設定を追加します。

```yaml
- id: web
  config:
    searchProvider: rdsh-rustxng
```

この明示指定ではRustXNGが未接続なら検索が失敗します。DSHを再起動して反映してください。

Claude Codeの既存ログインでClaudeを使う場合は、`rdsh-direct-models`の
`claude-cli`経路を選択します（例: `/model claude-cli claude-opus-5-5`）。
生成は`claude -p`、ツールと承認はDSHが担当します。
旧Anthropic OAuth経路はモデル一覧へ表示しません。旧`anthropic`指定や保存会話は
同じモデルの`claude-cli`へ移行し、CLIにないモデルなら選択を拒否します。
プロファイルの`llm-pi-ai.providers.anthropic`も退役すると、DSH Web GUIからも
旧経路が消えます。認証データや会話本文を削除する操作ではありません。
詳しくは[Claude CLI経路](../plugins/rdsh-direct-models/README.md#claude-cli経路)を参照してください。

`--backend native`（既定値）はRust独立ハーネスです。
[native-webとの対応表](NATIVE-PARITY.md)の処理を共有します。
DSHモードでは `--sdk-dir`、`--dsh-catalog`、`--devin-bin` は指定できません。
既存DSHプロファイルで設定してください。

## 操作

- F2、`/model`、`/model <provider> <model>`: DSHのモデル一覧から選択。
- 承認: 引数と理由を確認し、Tabで一回限りの許可を選んでEnter。初期選択は拒否。
  引数がまだ届いていない要求は許可できません。Escで拒否します。
- 質問: ↑↓で選択肢を移動、Spaceで選択、Tab/Shift+Tabで質問を移動。
  Ctrl+Eで自由回答を編集し、Ctrl+Sで回答全体を送信します。初期選択は空です。
  Escで実行を中止します。plan-reviewの承認も明示的に選んで送信します。
- `/sessions`: 現在のworkspaceの保存済みセッションを表示し、Enterで再開。
- `/new`: 旧セッションを残して、新しいセッションを開始。
- `/plugins`、`/settings`: 現在のプロファイルのプラグインと秘匿済み設定を閲覧。
  設定変更・インストール・削除は `/manage` から操作します。
- `/usage`、`/status`、`/logs`、`/diagnostics`: 使用量、接続情報、実行記録を閲覧。
- Esc、Ctrl+C、`/cancel`: DSH側の実行を中止。Ctrl+Q、`/quit`: 終了。

DSHの公開`session/selectModel`は、Web GUIと同じく選択したモデルを全体の既定値へ
保存します。起動時の `--provider` と `--model` は両方指定した場合だけ選択します。
未指定では既存の既定値を使用します。

## Planと権限のコマンド

`/mode`、`/permission` は現在の状態と利用可能な候補を表示します。
`/mode plan`・`/plan on` はDSHの `/plan`、`/mode normal`・`/plan off` は
DSHの `/plan off` へ対応します。裸の `/plan` は投影済みの現在状態から切替先を決めます。
モードは計画・通常の切替で、DSHのAgent presetを変更する操作ではありません。

`/permission <preset>` はホストが公開する候補だけを選択できます。
内容・効果を表示した確認画面で「設定を適用」を明示的に選ぶまで変更しません。
`custom` は現在値の表示専用です。ホストが公開する `auto` 等を選ぶ場合も確認が必要です。
Rust独立モードの `ask`・`read-only` とDSH側のプリセット名は別の一覧です。

利用可能性は公開 `commands/list` と `permissionPresets/catalog` で確認し、
設定操作は `commands/execute` へ送ります。未対応構成・拒否・未登録応答は
ローカルエラーとし、コマンドをモデルのメッセージへ変換しません。
実行中・承認待ち中の設定変更は拒否します。計画の確定・切替待ちと権限現在値は
ホストの `plan`・`permissions` 投影に追従し、成功応答だけで確定状態を作りません。
`/new` 後は新セッションのホスト状態を使用します。

`/clear`・`/exit`・`/stop`・`/resume` も、それぞれ既存の
`/new`・`/quit`・`/cancel`・`/sessions` と同じ動作で使えます。

## 状態と使用量

画面上部の `DSH runtime` がDSH接続中の目印です。回答はホストの逐次配信を表示し、
確定した履歴を重複表示しません。切断時は入力を止め、再接続後のsnapshotから
履歴を再構築します。要求への回答を自動再送・自動承認しません。

DSHの永続セッションが持つ通常入力、キャッシュ読込、キャッシュ作成、出力の
実測値を表示します。入力総計は前三者の合計です。キャッシュ率は内訳を取得できた
モデル要求のキャッシュ読込÷入力で計算し、欠損を0扱いしません。
表示履歴が一部の場合の要求件数は `?`、既知の小計は `*` を付けます。
コンテキスト容量の推定値、料金、契約の残枠とは異なります。

表示する履歴は最新1500イベントまでです。古い履歴はDSHの保存先に残ります。
画面の診断に表示範囲の制限を明示します。
子セッションの承認はDSHのカタログで親子関係を確認できた対象だけ表示します。
所有関係の投影より先に届いた要求は、この画面では引き受けず診断に記録します。画像・ファイルの履歴は添付の存在を
テキスト表示します。添付のアップロードとbinary保存は `/manage` から利用できます。
ブラウザー専用のDOM・canvas・メディア画面は `/webui` の文字/画像表示から操作できます。

## 接続境界

専用に起動した子ホストの127.0.0.1起動URLだけを受け付けます。起動トークンと
HTTP/WSの認証CookieはRust側ではメモリ内で扱い、ログや画面へ出しません。
`/webui` の専用Chromeはアクセス制限した一時プロファイルを使い、終了時にその領域を除去します。
既存ホストへの無断attach、既存セッションの削除、承認policyの緩和は行いません。
終了時は自分が起動したホストだけを停止します。

## ホストコマンドと管理操作

`/dsh` は現在のセッションに登録されたDSHコマンドを表示します。
`/dsh compact` のようにホストコマンドを実行できます。引数はそのまま公開APIへ渡し、
未登録コマンドはエラーにします。モデルへの通常メッセージへは変換しません。
`/dsh permission PRESET` も通常の権限確認画面を使います。

`/manage` は稼働中ホストの公開APIを検索し、入力schemaを見ながらJSONを編集する管理画面です。
設定・モデル・プラグイン・会話・workspace・ジョブ・音声などの公開操作と、RDSH独自HTTP操作を
ブラウザーを開かずに実行します。操作の内容は送信前に確認し、秘密入力はマスクします。
継続処理は結果を逐次表示し、中止できます。未知の操作はモデルのメッセージにしません。

```sh
dsh plugin --profile web add ./plugins/rdsh-tui-admin
dsh plugin --profile web add ./plugins/rdsh-model-call
```

- `/manage settings/describe`: 設定とrevisionを取得。
- `/manage settings/update`: `ns`、`patch`、`expectedRevision`で更新。競合はホストが拒否します。
- `/manage pluginManager`: プラグイン一覧、インストール、切替、削除。
  `restart-required` や `pendingBuilds` を確認し、必要な追加操作は明示的に選択します。
- `/manage credentials/set`: credentialを登録。入力値を会話履歴や結果へ残しません。
- `/manage fileUploads/upload`: `request.data` に `{"$file":"相対パス"}` を指定して添付をアップロード。
  返されたreceipt/fileは `session/prompt` のcontentへ渡します。
- `/terminal`: 確認後に現在のセッションでシェルを起動。`/terminal ID` は既存端末へ接続。
  Ctrl+]で会話へ戻り、もう一度 `/terminal` で復帰します。Ctrl+Cはシェルへ送信します。
- `/webui`: 同じHostのWeb画面を専用headless Chrome経由でTUI内に表示。
  プラグイン独自画面、アップロード・ダウンロード、設定文書、確認・パス選択を操作できます。
- `/record`: 明示確認して録音し、別途送信先を確認して文字起こし。結果は下書きへ戻ります。

管理画面の操作と制限、検証範囲は [TUI管理機能](TUI-ADMIN.md) を参照してください。

DSHの `subagent` は親のworkspaceとツール構成を継承し、read/write・shell・検索・MCP等を
親の許可範囲内で利用します。子は追加の権限昇格を対話要求できないため、親で許可された
workspace/sandboxの範囲で作業してください。モデル選択は既存のsubagent設定で管理します。

`rdsh-model-call` は `model_call` をDSH既存の `subagent` に接続する別名ツールです。
provider/modelを両方省略すると子の既定モデルを使い、指定時は既存の許可モデル一覧を使います。
子が追加承認を要求できない制約はDSH側に従います。
