# #52: 利用経路QAの再確認と残件

> これは当時の監査記録です。後の実機接続・戻る・UI・認証の確認を含む提出用集約は [最新版](../issue-52-submission/README.md) を参照してください。以下の結果と対象版は履歴として保持します。

公開用コピーでは、Windows環境記録とWindows/WSLの初回テストログに含まれる個人の絶対パス接頭辞を一般化しています。試験結果・時刻・ソースハッシュは変更せず、元ファイルはローカルに保持しています。

対象は `ec5fbf7c7ee5342fe9952dc0da0097c887aa427e`。2026-10-08に、
QAの記録条件と表示を修正し、回答復旧後のProject dashboardを再確認した。
[結果JSON](results.json)、[HTMLレポート](report.html)、
[実ブラウザーの手順と証拠](browser-checks.md)を一緒に読む。

## 必須要件との照合

| #52の要件 | 実装・確認範囲 |
| --- | --- |
| 指定した端末・操作・接続経路を一覧にし、未実施を絞り込む | Projectの2端末×3接続×9操作、API回帰1、Harness接続2の計57セル。欠損結果は`not-run`。状態・端末・操作・接続・証拠水準で絞り込める |
| 入力中の更新、二度押し、送信中の切断を実ブラウザーで判定する | desktop local、mobile表示幅local、Windowsブラウザー→WSL内サーバーで各9操作を実施。入力保持、画面の回答、POST試行数と耐久feedback件数を別々に確認 |
| ローカル成功を未実施の実接続へ流用しない | 実機phone、Tailscale、元DSH Harnessは別セルで未確認。NodeテストやPCの表示幅試験を実機接続のpassにしない |
| 対象版・環境・時刻・証拠を残す | 結果JSON、DOM観測、操作段階ごとの集計、画面、Node 22の実行ログを保存。異なる対象版の旧結果は変更しない |

今回の判定修正では、Project操作のpassに必要な実測を必須にした。
送信後はfeedback 1件、未送信操作はPOST・feedbackとも0件を要求する。
同じ試験を複数セルへ参照しても重複回答の実件数を二重加算しないよう、
概要は「重複があったセル数」で表示する。keyboardの送信後はフォームが消えるため、
focusを同じ入力欄に維持できたという値を捏造せず、実際の移動先を記録する。

## 実施状況

| 対象 | セル数 | 状況 |
| --- | ---: | --- |
| desktop・local | 9 | 実ブラウザーで実施、pass |
| desktop・WSL | 9 | WindowsブラウザーからWSL内サーバーへ接続して実施、pass |
| mobile表示幅・local | 9 | 幅390px、DOM幅375pxで実施、pass。PC幅だった初回runは採用しない |
| API回帰 | 1 | Node 22.23.3のWindows/Linuxで各45テスト成功 |
| 実機mobile・WSL | 9 | 未実施 |
| desktop/mobile・Tailscale | 18 | 未実施 |
| desktop/mobile・元DSH Harness | 2 | 未実施 |

採用結果はpass 28、fail 0、blocked 0、not-run 29。
採用しなかった観測と未解明事項は下記と[実施記録](browser-checks.md)に残す。
API回帰は1セルに両OSの証拠を持たせる。45テスト×2環境を90セルとは数えない。
回答とkeyboardは同じ送信結果を共有するため、セル数は独立した試験回数でもない。
全57セルのpassは#52の完了条件ではない。実施結果を証拠で判断でき、残る経路を
未確認として表示することが必要である。

## 残件・拡張候補と推奨順

| 区分・順序 | 次にすること | 難易度 | 何をもって完了とするか |
| --- | --- | --- | --- |
| 1. 未解明の観測 | mobile保存後応答消失の初回入力で末尾に全角`ｋ`が入った原因を調べる | 中・再現条件未確定 | 送信直前の本文と各入力操作を記録して再現し、入力側/アプリ側のどこで差が生じるか特定する。今回の再試験passを原因解明とは扱わない |
| 2. 未確認経路 | 実機phoneのWSL接続と、Tailscale経由を試す | 中・端末/接続環境が必要 | 実際の端末・経路で所定9操作を実施し、本文と保存結果を確認。未実施は`not-run`、試みて前提不足なら`blocked` |
| 3. 未確認経路 | 元DSH Harnessを既存ランチャーから開く | 中・既存DSH環境が必要 | desktop/phoneで対象Web UIと接続を確認。Project fixtureの成功を転記しない |
| 任意拡張 | 操作前後の証拠保存を補助する | 中 | 画面・件数・時刻を対応付け、後続操作で比較元を失わない。現在は手動保存 |
| 任意拡張 | 前回と今回のレポートを比較する画面 | 中 | 同じセルの結果と対象版・環境の違いを並べる。現在は版ごとに別の静的HTML |
| 任意拡張 | 通常ランチャー、実機タッチ、日本語IME変換中の操作を追加する | 中 | 該当する入口・入力方法で操作し、別の証拠を残す。現在の試験から成功を推定しない |

mobileの保存後応答消失は、初回の本文に意図しない末尾文字が見られたため、
未使用の別質問で送信直前・切断中・復帰後の本文を照合して再試験した。
採用した再試験は一致したが、初回の差の原因は未確定である。

## 他Issueとの境界

- [#71](https://github.com/sahenjp/rustdsh/issues/71): 圏外でページ全体を読むためのsnapshot、
  別端末で変わった状態との照合など。現在の下書き復旧は同じタブ・origin・project/questionが
  基本であり、#71全体の完了ではない。
- [#7](https://github.com/sahenjp/rustdsh/issues/7): バージョン更新、配布、installer、
  リリース手順。QAレポート作成を配布・公開の確認に置き換えない。
- [#74](https://github.com/sahenjp/rustdsh/issues/74): 提案の索引。全案の採用や一括実装を
  意味しない。接続診断、証拠の自動失効なども今回追加した機能ではない。

## 再確認

リポジトリルートで実行する。HTMLは既存ファイルを上書きしないため、新しい出力名を使う。

```sh
node dashboard/qa/cli.mjs validate docs/evidence/issue-52-audit/results.json
node dashboard/qa/cli.mjs report docs/evidence/issue-52-audit/results.json docs/evidence/issue-52-audit/report-2.html
```

今回の自動試験はdashboardを作業ディレクトリとして、Node 22.23.3の実行ファイルから
`--test`へ全`test/*.test.mjs`を渡した。WindowsはPowerShellのFullName配列、Linuxは
bashのglob展開を使用。`package.json`のtest本体と同じで、npm test経由では実行していない。
[Windows実行ログ](environment/windows-node22-tests.txt)、
[Linux実行ログ](environment/linux-native-node22-tests.txt)、
[対象ソースと結果の照合](environment/node22-verification-summary.json)を参照。
これらはローカルでの実行記録であり、GitHub CI実行成功の主張ではない。

[修正前の#52記録](../issue-52/browser-checks.md)のpass9/fail3/not-run45は過去の対象版の結果。
[回答復旧の記録](../answer-recovery/browser-checks.md)と今回の結果を分けて保持する。
