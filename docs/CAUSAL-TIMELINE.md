# 指示から回答適用までの相関

プロジェクト画面の「詳細」にある「指示・回答の相関」で、同じconsumerの
指示、受領、ACP入力結果、試験、質問、回答、回答適用を確認できます。
通常は記録数と未確認箇所の要約です。「未確認区間と原記録を調べる」から、
確認できたID相関、各区間の記録、折りたたまれた原記録を開きます。
相関のある回答revisionと現行の質問は別の記録として数えます。
この表示は [Issue #25](https://github.com/jimoto-no-llm/rustdsh/issues/25) の実装です。

## どこまで進んだかの判断

| 区間 | 記録と照合するID | 記録が意味すること |
| --- | --- | --- |
| 指示 | immutable instruction command ID | 人が投稿した入力の保存 |
| 受領 | 同じcommand IDとconsumer/run/session | 対象consumerによる読取 |
| 入力実行 | native command ID、owner、session、入力hash | 既存台帳で照合できたACP入力処理の結果 |
| 試験 | 同じtaskのacceptance evidence ID | integrityとfreshnessを確認した受入検証 |
| 質問 | question ID、revision、fingerprint | 対象consumerを明示した現行の質問、または回答時のrevision |
| 回答 | reply command ID、feedback sequence、answer event ID | その質問revisionへの保存済み回答 |
| 回答適用 | replyからnative commandへの同じ照合 | ACPによる回答入力の処理結果 |

受領は実行成功を示しません。`begin` は送信前の永続intentで、native command IDが
あっても結果が照合できなければ「未確認」です。ACP入力結果があっても、taskの
完了や全体試験の成功は別途確認します。試験は「現行の全体試験成功」と表示できる
full/current/intactなローカル結果だけを区別し、部分試験、報告だけのpass、
変更前のコードでのpassを全体試験の成功へ昇格させません。

個々の入力実行→試験→質問の因果IDは、既存の保存契約にはありません。
同じtaskの試験、同じconsumer/run/sessionを明示した質問は関連記録として表示し、
その間の因果は未確認と示します。時刻の近さ、文章の類似、受信順から矢印を作りません。
表示される矢印は実際に照合できたID相関だけです。

旧質問revisionへの回答は旧revisionのまま残ります。元の回答eventが失われた場合は
欠落を示し、保存済み回答からeventを作り直しません。相関IDのない旧報告・質問や
対象sessionの一致しない質問は、独立した「相関のない報告・質問」に残ります。
順不同の時刻や欠落・破損・途中までのnative台帳も未確認として示します。

## 読み取りと表示範囲

`GET /api/timeline?after=0&limit=10` は要約だけを返し、入力本文・原記録・相関の
詳細配列を含めません。`GET /api/timeline?trace_id=tl_<32桁のhex>` はその実行の
詳細を返します。どちらも人用ブラウザーキー、または管理者キーで認証します。
MCPキーでは読めません。trace IDはプロジェクトとconsumer、記録IDはプロジェクトと
元台帳の種類・IDから決定的に生成され、再読込でも変わりません。

要約は10件ずつ、APIの上限は20件です。各実行の最新100入力・100質問、
各受入条件の最新20試験記録を読みます。記録の表示窓を超える場合は
省略区間を未確認と示します。各台帳は独立した時点で読み取り、全台帳に共通する
atomic snapshotを取得したとは表示しません。画面は5秒ごとの再読取と既存の状態更新に
追従し、開いている原記録は保持します。

保存形式、6個のMCPツール、agent loop、元のACP送信・profile bootは変更しません。
表示のための送信、再試行、台帳修復、回答再適用は行いません。試験の秘密argvや
ログ本文、画像bytesを表示用APIへ渡しません。詳細の質問・指示本文は原記録なので、
認証された同じプロジェクトの利用者だけが閲覧できます。

## 検証

```sh
cd dashboard && npm ci && node --test test/causal-timeline.test.mjs
```

実ブラウザー操作は `npm run test:timeline --prefix tests/e2e` です。
[実ブラウザーの再現手順](../tests/e2e/README.md)と
[観測結果](evidence/causal-timeline/README.md)を参照してください。
native受領結果のfixtureと実ローカルQAを分けて記録しています。
