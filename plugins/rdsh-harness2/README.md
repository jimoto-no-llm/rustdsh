# rdsh Harness² adapter

Google Researchの[Harness²](https://github.com/google-research/harness2)を、rdshの任意導入プラグインとして接続します。Python側は本家の `run_parallel(k=1)` によるPropose–Probe–Composeを使い、各試行と改善セッションは実際の `rdsh` → DSH headlessで実行します。別のエージェントループは実装しません。

通常のプロファイルに追加しただけでは何も変更しません。明示的な比較要求がある場合だけ、Markdownの指示文を追加し、実行記録とプロバイダーが返した使用量を取得します。Rustランチャー、本家harness2、既存の認証情報・プロファイルは変更しません。

[2026-10-19の実モデル比較結果](evaluation/RESULTS.md): 未使用3課題は両版とも正解し、この小規模比較では品質改善を確認できませんでした。失敗した候補も記録しています。

[コード修正・テストを含む追加比較](evaluation/coding-RESULTS.md): 非公開テストは通常版23/24、固定合成版24/24でした。平均時間は58.7秒対68.8秒です。事後の別ケースでは合成版だけの不具合も確認しました。

[8課題×3回の拡大比較](evaluation/coding-expanded-RESULTS.md): 全課題成功は通常版9/24、合成版13/24でした。改善は課題に偏り、別のカーソル衝突も残りました。全訓練込みで純増1成功当たり約7.5分かかり、現時点では既定採用の根拠は不足しています。

## 対応範囲

- 改善対象は `systemprompt.md`、`tool-guidance.md`、`skills/<name>/SKILL.md` のみです。スキル本文はこの初期版では指示文として組み立てます。
- プラグイン・スクリプトの生成、権限・認証・承認フックの変更は対象外です。
- 読取比較では通常版・改善版とも `harness2_read` だけを利用します。コード修正比較では、明示したソースへの単一置換 `harness2_edit` と、固定の公開テストを実行する `harness2_test` も利用できます。任意のshellコマンド、ネットワーク、委譲は利用できません。
- 標準DSHのプロンプトに、共通の計測・fixture用説明を追加した比較です。通常版の候補Markdownは空です。日常の全ツールを使う作業での性能を測ったものではありません。
- 各プロセスで新しい作業領域、`DSH_HOME`、セッションを使用します。プロバイダーは明示指定したものから切り替えません。
- 現在は1段階のタスク内改善です。過去タスクの学習ライブラリ・振り返りの永続化は未対応です。

## 準備

Node.js 22以上、rdsh、Node版DSH、およびPython 3.12を使用します。検証対象のDSHは `0.2.0-rc.2` です。

ローカルのチェックアウトを直接使う場合は、プラグインの固定依存を`npm ci --ignore-scripts --prefix /absolute/path/to/rustdsh/plugins/rdsh-harness2`で導入します。コード採点の構文検査にはAcornを使用します。

```sh
git clone https://github.com/google-research/harness2.git /path/to/harness2
git -C /path/to/harness2 checkout 1cfe254e8d25b15f37048c3730134686abe60335
uv venv --python 3.12 /path/to/harness2/.venv
uv pip install --python /path/to/harness2/.venv/bin/python -e /path/to/harness2
```

本家のCLIは `oc` / `cx` に限定されるため、このプラグインのPythonエントリーを使います。本家内部のプロンプト表へrdshの説明を追加する互換層があり、上記commitに固定します。本家の再帰アルゴリズムや組み込み実行基盤の説明は書き換えません。

## プラグインの追加

通常の追加はDSHのプラグイン管理を使用できます。

```sh
dsh plugin --profile web add /absolute/path/to/rustdsh/plugins/rdsh-harness2
```

比較用runnerはこの追加操作を要求せず、一時プロファイルへ絶対パスでプラグインを配置します。設定に `requestPath` と `telemetryPath` があるときだけ有効です。これらは信頼したローカルの呼び出し元が作成する要求・記録ファイルであり、モデル出力を設定パスとして扱いません。

## 比較の実行

まず既存認証を使用できる、秘密値を含まないモデル用overlayを用意します。既存ルートがAPIキー参照を使う場合は参照名を渡し、キーそのものをoverlayへ書きません。資格情報のコピーや認証設定の変更は不要です。runnerはモデル用overlayの後に比較用overlayを適用します。

例えば既存のCursor SDKログインを使う場合は、`model.patch.json` から導入済みのSDKブリッジを指定します。

```json
[
  {
    "insert": [
      {
        "id": "rdsh-direct-models",
        "name": "/absolute/path/to/rustdsh/plugins/rdsh-direct-models/index.mjs"
      }
    ]
  }
]
```

この例では `--provider cursor-sdk --model composer-2.5` を使用します。SDKブリッジ自体の依存導入は[SDKブリッジの説明](../rdsh-direct-models/README.md)を参照してください。利用できるモデル・認証は既存アカウントに依存します。

```sh
export RDSH_HARNESS2_DSH_PACKAGE=/absolute/path/to/node_modules/@deepseek-ai/dsh
export RDSH_HARNESS2_MODEL_PATCH=/absolute/path/to/model.patch.json
export RDSH_HARNESS2_BIN=/absolute/path/to/rdsh

/path/to/harness2/.venv/bin/python \
  /absolute/path/to/rustdsh/plugins/rdsh-harness2/python/rdsh_harness2.py \
  --suite /absolute/path/to/rustdsh/plugins/rdsh-harness2/evaluation/small-tasks.json \
  --runner /absolute/path/to/rustdsh/plugins/rdsh-harness2/runner.mjs \
  --provider YOUR_PROVIDER --model YOUR_MODEL \
  --output /absolute/path/to/new-comparison-run \
  --timeout-ms 120000 --max-steps 16
```

これは実モデルを呼び出すコマンドです。1件の改善用タスクに通常実行1回・候補実行2回・合成後の実行1回・改善セッション3回、未使用タスク1件につき通常版と固定改善版の2回を使用します。不正な改善案の修正は本家と同じく最大1回です。モデル・プロバイダー側の内部呼び出し回数とは区別してください。

同梱suiteは改善用1件と未使用3件です。正解を実行領域や改善用の証拠に渡さず、返答のJSON構造・値を採点側で厳密比較します。未使用タスクでは改善案を作り直しません。出力先は新規ディレクトリを指定し、既存結果の上書き・再利用は拒否します。

`report.json` にはタスク別成否、改善段階の状態、通常実行からの追加時間、全セッションの使用量を記録します。プロバイダーが使用量や費用を返さない場合は `null` です。inputTokensは非キャッシュ入力で、キャッシュ読み書きは別計上します。単一回の小規模比較で品質向上や統計的有意差は断定しません。

途中の候補が失敗しても、実際の合成案が検証と最終実行を通れば、その合成案で未使用タスクを評価します。`fallbackWarnings` と `adaptationComplete` に失敗を残し、全段階が成功するまで全体の `complete` と終了コードを成功扱いにしません。合成段階自体がfallbackした場合は自動採用しません。

生成済みハーネスの比較だけを繰り返す場合は、同じコマンドに `--frozen-harness /absolute/path/to/previous-run/frozen-harness` を追加します。このモードでは改善セッションを呼ばず、suiteの未使用タスクだけを両版で実行します。供給元パスと内容のSHA256を記録し、過去の改善成功を推測で認定しません。

## コード修正とテストを含む比較

`rdsh_coding.py` は本家と同じ改善ループを、使い捨てのコード課題で実行します。[課題設計](evaluation/coding-task-design.md)はTTL/LRUキャッシュ、並列処理制御、ページ取得、依存順序の4種類です。1件を改善に使用し、残り3件には固定した合成版を適用します。各課題は2モジュールを修正対象とし、元の公開テスト2件と非公開テスト8件を持ちます。

前節のモデル用環境変数を設定してから実行します。

```sh
PYTHONPATH=/absolute/path/to/rustdsh/plugins/rdsh-harness2/python \
  /path/to/harness2/.venv/bin/python \
  /absolute/path/to/rustdsh/plugins/rdsh-harness2/python/rdsh_coding.py \
  --suite /absolute/path/to/rustdsh/plugins/rdsh-harness2/evaluation/coding-tasks.json \
  --runner /absolute/path/to/rustdsh/plugins/rdsh-harness2/runner.mjs \
  --provider cursor-sdk --model composer-2.5 \
  --output /absolute/path/to/new-coding-run \
  --timeout-ms 600000 --max-steps 24
```

テストはmacOSの`/usr/bin/sandbox-exec`内で、固定したNodeコマンドだけを実行します。読取は検証用ソース・信頼したテスト・Nodeの依存ライブラリに限定し、書込は使い捨てscratchだけを許可します。検証領域外の読取、ソース自体の実行時書換え、ネットワーク、子プロセス起動を拒否します。Linuxなど未対応の環境では実行を拒否し、cwd制限だけの実行には切り替えません。

コード比較の動作確認はNode.js 26.12.0で行っています。Nodeのテスト分離オプションとmacOSのsandboxを使うため、別バージョンでは同梱テストで対応を確認してください。

非公開テストはモデルの作業領域と改善用の証拠に配置しません。合成案の選択後、採点側が修正済みソースに対して公開・非公開テストを再実行します。合格にはソース変更、編集・テストツールの実行、編集範囲の遵守、元テストの不変性、公開テスト成功、非公開テストの所定件数すべての成功を要求します。回答で「修正した」と述べただけでは合格しません。差分、各軸の成否、ツール実行数、モデル所要時間と採点所要時間を別々に保存します。

採点前に固定のソース一覧を検査し、同一覧内の静的な相対importだけを許可します。`process`による終了・出力や、`node:assert`などの組込みimportを使った直接の採点操作を拒否します。この制限は小規模な純粋ESM課題向けの補助策です。テストと実装は同じJavaScript実行環境を使うため、計算したプロパティ名などによる任意の敵対的コードへの採点隔離は保証しません。比較結果では生成ソースも独立に点検します。

## 反復比較

[拡大比較計画](evaluation/coding-expanded-plan.md)では、既知のカーソル反例を主評価に含めた8課題を3ラウンド評価します。各ラウンドのハーネスは同じ訓練課題から独立生成し、評価課題の成績や過去の成功結果で選び直しません。非公開テストは改善へ渡しません。

```sh
PYTHONPATH=/absolute/path/to/rustdsh/plugins/rdsh-harness2/python \
  /path/to/harness2/.venv/bin/python \
  /absolute/path/to/rustdsh/plugins/rdsh-harness2/python/rdsh_coding_repeated.py \
  --suite /absolute/path/to/rustdsh/plugins/rdsh-harness2/evaluation/coding-expanded-tasks.json \
  --runner /absolute/path/to/rustdsh/plugins/rdsh-harness2/runner.mjs \
  --provider cursor-sdk --model composer-2.5 \
  --output /absolute/path/to/new-repeated-run \
  --rounds 3 --workers 2 --seed 271828 \
  --timeout-ms 600000 --max-steps 24
```

実行順と集計のseedは固定しますが、SDKのモデル生成seedやtemperatureを固定したとは主張しません。出力先へスイート・コード・設定のハッシュを保存し、同じコマンドに`--resume`を加えると完了した処理を再利用します。結果のない開始済みモデル処理は中断として記録し、自動でモデルを呼び直しません。`--phase train`は訓練だけを先行し、同じ設定の`--resume`で評価へ進めます。

`report.json`は全課題成功率、ラウンド別・課題別の改善と回帰、native失敗と採点エラー、課題単位の不確実性を分けます。訓練費用と評価時間差を集計し、追加成功1件当たりの時間や、失敗の修復に60・300・900秒かかると仮定した場合の差も出します。未知の時間をゼロに置換しません。並列経過時間、合計セッション時間、採点時間は別の指標です。

上のコマンドは歴史的な主評価を再現します。設定マージの仕様解釈の曖昧さと、別プロンプトによる事後追試は[拡大結果](evaluation/coding-expanded-RESULTS.md#仕様の曖昧さと追試)を参照してください。元スイートや元の結果は追試で置き換えていません。

## 検証

```sh
npm test --prefix plugins/rdsh-harness2
PYTHONPATH=plugins/rdsh-harness2/python \
  /path/to/harness2/.venv/bin/python -m unittest discover \
  -s plugins/rdsh-harness2/python/tests -v
```

テスト用の決定的応答は契約と採点の確認にだけ使用します。実モデル比較の結果とは別に記録します。
