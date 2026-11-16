# Blue/Purple Enablement (experimental)

rdsh / DeepSeek Harness (DSH) と併用する **検知→修復→再攻撃の証拠コントロールプレーン**です。これは初期の実用スライスであり、SIEM・脆弱性スキャナ・攻撃ハーネス・Oracle 自体は内蔵していません。Node.js 22+、追加依存なしで動作します。`rdsh` の本体・DSH の権限設定は変更しません。

## 役割

- **rdsh + DSH:** Blue の調査・修復タスクを、既存の承認・作業範囲の下で実行する。`handoff` が作った JSON をタスク入力として渡せます（自動実行はしません）。
- **RustXNG:** 既存の別プロセス／MCP 検索を利用する。検索情報は未信頼の参考資料であり Oracle 判定には使いません。AGPL コードは同梱しません。
- **kaggle-campaign-ops:** baseline/challenger の独立性、immutable evidence、fault 時 HOLD の運用原則を参考にした設計であり、コード依存はありません。
- **Red:** 許可された隔離環境での検証結果を `red_attempt` として供給。Blue のブラインド分析時には隠します。
- **Oracle:** Red/Blue と別のテストランナーが再攻撃と正常系回帰の証拠を生成し、オペレーターが `oracle_*` receipt を登録します。

## Quick start（合成データ）

```sh
node tools/blue-purple/cli.mjs init /tmp/purple-demo
cat > /tmp/sensor.json <<'JSON'
{"case_id":"api-authz-1","kind":"sensor_observation","actor":"sensor","outcome":"observed","evidence":{"source":"synthetic-access-log","ref":"fixture://access/001"}}
JSON
node tools/blue-purple/cli.mjs record /tmp/purple-demo /tmp/sensor.json
node tools/blue-purple/cli.mjs handoff /tmp/purple-demo --case api-authz-1 --mode blind
node tools/blue-purple/cli.mjs report /tmp/purple-demo # HOLD は exit 2
```

生成された `api-authz-1-blind-handoff.json` を DSH の Blue Agent に渡すか、任意の **ローカル** OpenAI互換 Chat Completions サーバーへ以下で送信します。

```sh
node tools/blue-purple/cli.mjs analyze /tmp/purple-demo \
  --case api-authz-1 --mode blind \
  --url http://127.0.0.1:8000/v1/chat/completions --model YOUR_LOCAL_MODEL
```

`analyze` の出力は **advisory-only**、修復実行も Oracle 判定も行いません。別マシンの DGX Spark を使う場合、例えば SSH トンネルで `127.0.0.1` に転送してください。直接の外部宛て、資格情報付きURL、リダイレクトは拒否します。

## Evidence event 契約（schema 1）

JSON に共通して `case_id`, `kind`, `actor`, `outcome`, `evidence: {source, ref}` を指定します。`case_id` は ASCII 英数字・`.`・`_`・`-` の最大80文字です。イベントには1連番と SHA256 のハッシュチェーンを付け `events.jsonl` に追記します。ハッシュチェーンは **偶発破損の検知** が目的で、悪意あるローカル書き換えに対する改ざん防止署名ではありません。

| kind | actor | outcome |
| --- | --- | --- |
| red_attempt | red | succeeded / failed |
| sensor_observation | sensor | observed |
| blue_detection | blue | detected / missed |
| blue_remediation | blue | proposed / applied |
| oracle_retest | oracle | blocked / succeeded |
| oracle_regression | oracle | passed / failed |

`report` は Red 攻撃成功の各ケースについて、Blue検知・修復適用・Oracle再攻撃 blocked・正常系回帰 passed が揃い、再攻撃 succeeded や回帰 failed の記録がない場合に限り `GO` とします。その他は `HOLD`（終了コード2）。存在しない証拠を成功とみなしません。**Oracleの actor 値は自己申告**なので、実運用には外部テスト結果と署名／信頼境界の紐付けが追加で必要です。

## 安全境界・制限

- 初期スライスは読取り・記録・プロンプト生成・ローカル推論のみ。攻撃実行・ブロック・本番パッチは自動実行しません。
- ブラインドモードでは `sensor_observation` だけをBlueに見せ、Red成果・正解ラベル・Oracle結果は隠します。協調改善時は `--mode collaborative` を使います。
- センサーのログ、Web検索結果、モデル出力は未信頼。機密ログは収集側でマスクし、推論前に人が確認してください。
- `record` は単一ライターの排他ロックを使用します。障害後の `.record.lock` は原因確認後に手動回復してください。
- `GO` は登録済み証拠に対するローカル判定であり、本番安全性の保証ではありません。最初は隔離済みの認可環境だけで使用してください。

## テスト

```sh
node --test tools/blue-purple/test.mjs
```

現段階で未実装: CodeQL/Trivy/Wazuh/Sigmaの実アダプター、署名付きOracle、DSHへの自動ジョブ投入、複数同時実行、検知Precision計測、RustXNG検索の取得物の来歴管理。本PRではこれらを動作済みとみなしません。
