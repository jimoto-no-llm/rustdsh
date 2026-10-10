# 旧API回帰セル

このセルは当時の50/50を保持する。旧ブランチの後続74/74はfollowup-verification.mdに別記し、過去のセルの日時・証拠をmain統合後の実行に見せかけない。

このファイルは原結果JSONとそこに列挙された観測資料を対応づける公開用の要約です。原画像・端末固有の接続先・実行ユーザー名・認証情報は含めません。ここでの再実行や独立した追認は行っていません。原証拠ラベルは監査対応用の名前であり、配布ファイルへのリンクではありません。結果の採録元JSONのハッシュは [来歴](provenance.md) にあります。

## project-api-fixture

状態: **pass**。原記録時刻: 2026-10-08T08:14:04.429Z。

環境: Windows / WSL Ubuntu Linux / Node 22.23.3（両OS） / 使用なし（自動テスト） / none

Windowsの実npm testログは50/50。WSL Node22直接実行も50/50。試験ソース29ファイルと6040075の一致をsource-provenance.jsonで照合。tested_atはWindowsログ保存mtime。自動テストをブラウザー操作の代用にはしない。

観測値:

```json
{
  "detail": "50 tests / 50 pass / 0 fail / 0 skipped（各OS）。Windowsはnpm script経由、WSLは同じtest本体をNode直接実行。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/startup-tests/npm-test-windows.log`
- `current/startup-tests/linux-after-all.log`
- `current/startup-tests/linux-command-source-verification.json`
- `source-provenance.json`
