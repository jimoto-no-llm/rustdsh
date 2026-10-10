# タスク成果カードの before/after

Issue #14 の目的・担当・成果・次の一手と固定した受入条件を、既存の
Project dashboard、MCP と受入条件台帳へ接続します。
`done` は作業の申告として表示し、確認時点で実際に成功した全検査だけを
「検証済み」と表示します。

同じ隔離fixtureを実サーバーで表示した [変更前](before.png) と
[変更後](after.png)、[未検証→一部合格→全条件合格の流れ](flow.gif) です。
GIFはこの3状態の実際のPNGを各2秒表示し、白い余白で高さを揃えています。

| 受入条件                                               | 実画面と検査                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 目的・担当・成果・次の一手・ブロッカー・検証結果に到達 | [成果カード](after.png)、実HTTP MCP・ブラウザー操作                                      |
| マイルストーンの終了条件と未充足条件を確認             | [未検証](after-unverified.png) → [一部合格](after-partial.png) → [全条件合格](after.png) |
| 作業の分割・追加で既達成の条件や母数が変わらない       | [2作業を追加後](after-mobile-milestone.png)、条件数2件・合格2件を維持                    |
| done と検証済みを別扱い、未実施を完了と表示しない      | [未検証](after-unverified.png)、部分検査・報告だけの成功・欠落した証拠の検査             |
| 対象コードの変更で過去の合格を失効                     | [再検証が必要な表示](after-stale.png)、古いSSE改訂の応答も表示しない                     |

スマホ幅の全体は [変更前](before-mobile.png) / [変更後](after-mobile.png)。
全パネルのPNGは固定操作バーが重ならないように撮影時の高さだけを広げます。
実際の390 x 844画面は [成果カード](after-mobile-viewport.png) と
[マイルストーン](after-mobile-milestone.png) です。横方向のはみ出しはありません。
分割タスク追加後の状態改訂では古いカード結果を破棄し、再確認ボタンを表示します。

## ソースと検証

実装 `e3cbbf1a88b862407d842be2ecd1dc7f04b6fc7a` のdashboard全体は、
Windowsで202/202、Linuxで197成功・Windows専用5skip、両OSで失敗0です。
後続 `3c8375a811541c1181fb446e47fa9464da7c1b49` は撮影用テストの調整と
main `81986d6` のRust1行修正を含み、dashboardのコード・検査は同一です。
この後続ソースでRust fmt・release Clippy警告0・Rust103件・examples7件・
fence2件・CLI回帰53件・境界11件、既存のブラウザー一式13フローが成功しました。
WindowsとLinuxの成果カード5フローもそれぞれ成功しています。

条件定義・検査は隔離fixture内の2種類の実コマンドだけを使います。
実モデル・課金API・外部認証・正式採用の確認は含みません。
PNGの変更前はmain `d705ed7` の実サーバーです。`81986d6` のdashboardも同一です。
画像は実ブラウザーの撮影で、UIを模した描画は加えていません。

実行範囲は [validation.json](validation.json)、8つの実装ファイルのSHA256と
5フロー、撮影サイズは [Windowsの観測](browser-observations.json) と
[Linuxの観測](linux-browser-observations.json) に記録しています。
PRのGitHub CIと正式な第三者承認は最新headで別に確認します。

```sh
npm ci --prefix dashboard
npm ci --prefix tests/e2e
RDSH_E2E_BIN=./target/release/rdsh npm test --prefix tests/e2e
```

描画計測は実コンポーネントをDOMへ取り付けてlayoutまで含め、warmup後5回。
検査実行と通信は0です。Windows/Chrome154では40カードの中央値6.8ms・最大7.6ms、
200カードの中央値31.7ms・最大41.0ms。Linux/Chromium151ではそれぞれ14.1/14.3msと
68.1/79.1msでした。ブラウザー・環境が違うため相互の速さを比較しません。
初回表示の単発値は通信を含む観測であり、速度改善の根拠には使いません。
