# タスク成果カードの before/after

Issue #14 の目的・担当・成果・次の一手と固定した受入条件を、既存の
Project dashboard、MCP と受入条件台帳へ接続します。

同じ隔離fixtureの task を実サーバーで表示した [変更前](before.png) と
[変更後](after.png)、[実際の操作の流れ](flow.gif) を記録します。
スマホ幅は [変更前](before-mobile.png) / [変更後](after-mobile.png) を比較します。

対象の意味が変わった成功は [再検証が必要な表示](after-stale.png) へ戻します。
`done` と [未実施の検証](after-unverified.png) を分け、
[一部の条件だけを満たした状態](after-partial.png) も保持します。

実行コマンド、sourceのハッシュ、観測結果は最終検証後の
`browser-observations.json` と `validation.json` を参照してください。
検査は隔離したfixtureのコードだけを実行します。
実モデル、課金API、外部認証、正式採用、main mergeは行いません。
