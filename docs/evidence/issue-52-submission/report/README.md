# #52 提出用の検証記録

ここはmain `96dbcbb`への統合前に行った試験の履歴集約です。統合後の実機・WSL/Tailscaleを再試験した記録ではありません。[統合後の検証](../current-integration.md)とは分けて読んでください。

[結果一覧HTML](report.html) / [結果JSON](results.json) / [来歴と制約](evidence/provenance.md) / [UI・認証案内の後続検証](evidence/followup-verification.md)

**57セル中53 pass・4 blocked・0 fail・0 not-run。** 以前の51 pass・4 blocked・2 not-runから、実機の「戻る」2セルを後続の証拠で更新しました。残る4 blockedは、iPhoneに外付けキーボードがなく実施できなかったkeyboard/cancel × WSL/Tailscaleです。タッチによる「閉じる」はEscの代用にしていません。

これは複数の実施時点をまとめた履歴です。**最新版で57セルを再実施した、独立53試行を行った、すべての実機操作が合格した、という意味ではありません。** local18セルはec5fbf7の記録を維持し、その他も原記録の時刻・条件を残しました。WSL/Tailscaleは同じ接続試行を複数セルで参照します。PCのmobile viewportとiPhone実機は結果の環境欄で区別しています。

旧ブランチのUI・認証案内修正については、Windows/WSL各74/74の自動テスト、変更箇所の実ブラウザー確認、iPhoneのエラー案内と有効URLでの復旧を[後続検証](evidence/followup-verification.md)に記録しました。自動テスト件数と経路セル数は別の数字です。

公開用の証拠はこのreport配下に同梱したテキスト要約です。各セルから原資料ラベル、観測値、時刻、実施条件と限界を読めます。個人の接続先や認証情報を含む原ログ・画像は配布しません。要約から原資料の内容を独立に再検証したことにはしていません。

## 形式検査・再生成

Node.js 22+、リポジトリのルートで実行します。

```sh
node dashboard/qa/cli.mjs validate docs/evidence/issue-52-submission/report/results.json
node dashboard/qa/cli.mjs report docs/evidence/issue-52-submission/report/results.json docs/evidence/issue-52-submission/report/report-new.html
```

CLIはJSONの形式・値の整合性・証拠ファイルの存在を検査します。実機の再試験や要約内容の独立検証ではありません。HTMLは既存ファイルを上書きしないため、新しい出力名を指定してください。結果JSON・HTML・evidenceディレクトリを一緒に保持すれば、公開元のPCに依存せず読むことができます。
