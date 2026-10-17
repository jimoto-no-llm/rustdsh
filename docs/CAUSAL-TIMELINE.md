# 指示から回答適用までの相関

プロジェクト画面の「詳細」にある「指示・回答の相関」で、同じconsumerにおける
指示、受領、ACP入力結果、試験、質問、回答、回答適用を確認できます。
通常は記録数と未確認箇所の要約が表示されます。未確認箇所がある場合は「未確認区間と原記録を調べる」から、
すべて確認できた場合は「全記録とID相関を調べる」から、各区間の記録と原記録を開けます。
相関のある回答revisionと現行の質問は、個別の記録として数えます。
この表示は [Issue #25](https://github.com/jimoto-no-llm/rustdsh/issues/25) の実装です。

## どこまで進んだかの判断

| 区間 | 記録と照合するID | 記録が意味すること |
| --- | --- | --- |
| 指示 | immutable instruction command ID | 人が投稿した入力の保存 |
| 受領 | 同じcommand IDとconsumer/run/session | 対象consumerによる読み取り |
| 入力実行 | native command ID、owner、session、入力hash | 既存台帳で照合できたACP入力処理の結果 |
| 試験 | acceptance evidence ID、記録時に明示した入力command ID | integrityとfreshnessを確認した受入検証。入力command IDは利用者が保存した参照 |
| 質問 | question ID、revision、fingerprint、`causal_source_evidence_ids` | 対象consumerを明示した現行の質問、回答時のrevision、および利用者が保存した受入記録参照 |
| 回答 | reply command ID、feedback sequence、answer event ID | その質問revisionに対する保存済みの回答 |
| 回答適用 | replyからnative commandへの同じ照合 | ACPによる回答入力の処理結果 |

受領は実行の成功を示すものではありません。`begin` は送信前の永続intentであり、native command IDが
あっても結果を照合できなければ「未確認」となります。ACP入力結果が得られていても、taskの
完了や全体試験の成功は別途確認します。試験では「現行の全体試験成功」と表示できる
full/current/intactなローカル結果のみを区別し、部分試験や報告のみのpass、
変更前のコードにおけるpassを全体試験の成功へと昇格させることはありません。

入力実行→試験の関係は、受入検証時に `--causal-source-command-id <command_id>` を
1件以上指定すると保存されます。指定するIDは、同じtaskのconsumerに属し、native入力intentが
記録されたcommandに限られます。質問→試験の関係は、MCPの
`dashboard_ask_question` の `decision.causal_source_evidence_ids` に受入evidence IDを
明示して保存します。どちらも安定した参照IDですが、利用者が記録した参照であり、因果関係を
独立して検証したものではありません。native結果、試験のfreshness、質問revisionは個別に判定します。

参照IDが省略・欠落している場合や読み取り範囲外の場合は、その区間は未確認のままとなります。同じtaskの試験や、
同じconsumer/run/sessionを明示した質問であっても、時刻の近さ、文章の類似度、受信順などから矢印を生成することはありません。
明示的な参照を追加した後も、元のnative receiptや現在の試験結果は別途照合します。

旧質問revisionへの回答は旧revisionのまま残ります。元の回答eventが失われた場合は
欠落として示し、保存済みの回答からeventを再生成することはありません。相関IDのない過去の報告や質問、
ならびに対象sessionが一致しない質問は、独立した「相関のない報告・質問」に残ります。
時刻の順不同や、欠落・破損・作成途中のnative台帳も未確認として示します。

## 読み取りと表示範囲

`GET /api/timeline?after=0&limit=10` は要約のみを返し、入力本文や原記録、相関の
詳細配列は含みません。`GET /api/timeline?trace_id=tl_<32桁のhex>` はその実行の
詳細を返します。どちらも人間用のブラウザーキー、または管理者キーで認証します。
MCPキーでは読み取れません。trace IDはプロジェクトとconsumer、記録IDはプロジェクトと
元台帳の種類・IDから決定的に生成され、再読み込みを行っても変わりません。

要約は10件ずつ取得され、APIの上限は20件です。各実行における最新100件の入力と100件の質問、
各受入条件における最新20件の試験記録を読み取ります。記録が表示範囲を超える場合は、
省略された区間を未確認として示します。各台帳はそれぞれ独立した時点で読み取られるため、全台帳に共通する
atomic snapshotを取得したかのような表示は行いません。画面は5秒ごとの再読み取りと既存の状態更新に
追従し、開いている原記録は保持されます。

保存形式、6個のMCPツール、agent loop、元のACP送信・profile bootは変更しません。
表示のための送信、再試行、台帳修復、回答の再適用は行いません。試験の秘密argvや
ログ本文、画像bytesを表示用APIへ渡すことはありません。詳細に含まれる質問・指示の本文は原記録であるため、
認証された同一プロジェクトの利用者のみが閲覧できます。

## 検証

```sh
cd dashboard && npm ci && node --test test/causal-timeline.test.mjs
```

実ブラウザー操作は `npm run test:timeline --prefix tests/e2e` です。
[実ブラウザーの再現手順](../tests/e2e/README.md)と
[観測結果](evidence/causal-timeline/README.md)を参照してください。
native受領結果のfixtureと実際のローカルQA結果を分けて記録しています。
