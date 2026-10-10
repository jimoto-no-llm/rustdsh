# 旧localブラウザー試験18セル

ec5fbf7での実施を引き継ぐ。6040075または最終UI版で全18セルを再実施したものではない。mobile-localはPCの390×844 viewportとPC入力であり、iPhoneの結果ではない。

このファイルは原結果JSONとそこに列挙された観測資料を対応づける公開用の要約です。原画像・端末固有の接続先・実行ユーザー名・認証情報は含めません。ここでの再実行や独立した追認は行っていません。原証拠ラベルは監査対応用の名前であり、配布ファイルへのリンクではありません。結果の採録元JSONのハッシュは [来歴](provenance.md) にあります。

## project-desktop-local-answer

状態: **pass**。原記録時刻: 2026-10-08T06:53:04.384Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / desktop viewport (client 1265x720)

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 保存済み本文が入力と一致。Q-sseの回答とkeyboardは同じ試行を2セルに記録。独立した2回の試験ではない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 保存済み本文が入力と一致。Q-sseの回答とkeyboardは同じ試行を2セルに記録。独立した2回の試験ではない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/desktop-keyboard.json`
- `legacy/desktop-answer-visible.jpg`
- `legacy/environment/browser-source-provenance.json`
- `source-provenance.json`

## project-desktop-local-keyboard

状態: **pass**。原記録時刻: 2026-10-08T06:53:04.384Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / desktop viewport (client 1265x720)

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 Tab4回→回答入力→Tab→Return。送信後フォーム消失に伴いfocusはBODY。Q-sseの回答とkeyboardは同じ試行を2セルに記録。独立した2回の試験ではない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 Tab4回→回答入力→Tab→Return。送信後フォーム消失に伴いfocusはBODY。Q-sseの回答とkeyboardは同じ試行を2セルに記録。独立した2回の試験ではない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/desktop-keyboard.json`
- `legacy/desktop-answer-visible.jpg`
- `legacy/environment/browser-source-provenance.json`
- `source-provenance.json`

## project-desktop-local-sse-draft

状態: **pass**。原記録時刻: 2026-10-08T06:52:28.397Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / desktop viewport (client 1265x720)

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 logによる更新後も日本語2行とTEXTAREA focusを保持。POST0、feedback0。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": true,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 logによる更新後も日本語2行とTEXTAREA focusを保持。POST0、feedback0。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/desktop-unsent.json`
- `legacy/desktop-sse.jpg`
- `legacy/environment/browser-source-provenance.json`
- `source-provenance.json`

## project-desktop-local-reload

状態: **pass**。原記録時刻: 2026-10-08T06:52:28.525Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / desktop viewport (client 1265x720)

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 再読込後、未送信の日本語2行を復元。POST0、feedback0。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": null,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 再読込後、未送信の日本語2行を復元。POST0、feedback0。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/desktop-unsent.json`
- `legacy/desktop-back.jpg`
- `legacy/environment/browser-source-provenance.json`
- `source-provenance.json`

## project-desktop-local-back

状態: **pass**。原記録時刻: 2026-10-08T06:52:28.598Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / desktop viewport (client 1265x720)

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 about:blankへ移動し戻る。接続済み表示と未送信本文を復元。POST0、feedback0。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": null,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 about:blankへ移動し戻る。接続済み表示と未送信本文を復元。POST0、feedback0。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/desktop-unsent.json`
- `legacy/desktop-back.jpg`
- `legacy/environment/browser-source-provenance.json`
- `source-provenance.json`

## project-desktop-local-cancel

状態: **pass**。原記録時刻: 2026-10-08T06:52:28.474Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / desktop viewport (client 1265x720)

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 Ctrl+Kでコマンドパレットを開きEscapeで閉じる。元の送信ボタンへfocus復帰、本文保持。質問取消/送信取消ではない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": true,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 Ctrl+Kでコマンドパレットを開きEscapeで閉じる。元の送信ボタンへfocus復帰、本文保持。質問取消/送信取消ではない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/desktop-unsent.json`
- `legacy/desktop-back.jpg`
- `legacy/environment/browser-source-provenance.json`
- `source-provenance.json`

## project-desktop-local-double-submit

状態: **pass**。原記録時刻: 2026-10-08T06:55:35.991Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / desktop viewport (client 1265x720)

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 hold中の二度押し後もPOST1。log/SSE後も本文readonlyと送信disabledを確認。release後feedback1。disabled要素へのツール操作は送出されない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 hold中の二度押し後もPOST1。log/SSE後も本文readonlyと送信disabledを確認。release後feedback1。disabled要素へのツール操作は送出されない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/desktop-double.json`
- `legacy/desktop-double-sse.jpg`
- `legacy/environment/browser-source-provenance.json`
- `legacy/desktop-held.json`
- `source-provenance.json`

## project-desktop-local-disconnect-before

状態: **pass**。原記録時刻: 2026-10-08T06:56:21.890Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / desktop viewport (client 1265x720)

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 drop-before時の本文保持、feedback0を確認。resume後の手動再送でfeedback1。POST2のうち保存1。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 2,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 drop-before時の本文保持、feedback0を確認。resume後の手動再送でfeedback1。POST2のうち保存1。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/desktop-before-final.json`
- `legacy/desktop-after-saved.jpg`
- `legacy/environment/browser-source-provenance.json`
- `legacy/desktop-before-offline.json`
- `legacy/desktop-before-offline.jpg`
- `source-provenance.json`

## project-desktop-local-disconnect-after

状態: **pass**。原記録時刻: 2026-10-08T06:57:33.759Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / desktop viewport (client 1265x720)

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 drop-after時に本文保持とfeedback1、resume後の回答表示を確認。自動/手動再送なし、POST1/feedback1。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 drop-after時に本文保持とfeedback1、resume後の回答表示を確認。自動/手動再送なし、POST1/feedback1。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/desktop-final.json`
- `legacy/desktop-after-saved.jpg`
- `legacy/environment/browser-source-provenance.json`
- `legacy/desktop-after-offline.json`
- `legacy/desktop-after-offline.jpg`
- `source-provenance.json`

## project-mobile-local-answer

状態: **pass**。原記録時刻: 2026-10-08T07:08:31.436Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / mobile viewport 390x844 (client 375x844); desktop pointer/keyboard, not physical-phone

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 保存済み本文が入力と一致。Q-sseの回答とkeyboardは同じ試行を2セルに記録。独立した2回の試験ではない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 保存済み本文が入力と一致。Q-sseの回答とkeyboardは同じ試行を2セルに記録。独立した2回の試験ではない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/mobile390-keyboard.json`
- `legacy/mobile390-answer-visible.jpg`
- `legacy/environment/browser-source-provenance.json`
- `source-provenance.json`

## project-mobile-local-keyboard

状態: **pass**。原記録時刻: 2026-10-08T07:08:31.436Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / mobile viewport 390x844 (client 375x844); desktop pointer/keyboard, not physical-phone

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 Tab4回→回答入力→Tab→Return。送信後フォーム消失に伴いfocusはBODY。Q-sseの回答とkeyboardは同じ試行を2セルに記録。独立した2回の試験ではない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 Tab4回→回答入力→Tab→Return。送信後フォーム消失に伴いfocusはBODY。Q-sseの回答とkeyboardは同じ試行を2セルに記録。独立した2回の試験ではない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/mobile390-keyboard.json`
- `legacy/mobile390-answer-visible.jpg`
- `legacy/environment/browser-source-provenance.json`
- `source-provenance.json`

## project-mobile-local-sse-draft

状態: **pass**。原記録時刻: 2026-10-08T07:08:18.446Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / mobile viewport 390x844 (client 375x844); desktop pointer/keyboard, not physical-phone

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 logによる更新後も日本語2行とTEXTAREA focusを保持。POST0、feedback0。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": true,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 logによる更新後も日本語2行とTEXTAREA focusを保持。POST0、feedback0。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/mobile390-unsent.json`
- `legacy/mobile390-sse.jpg`
- `legacy/environment/browser-source-provenance.json`
- `source-provenance.json`

## project-mobile-local-reload

状態: **pass**。原記録時刻: 2026-10-08T07:08:18.587Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / mobile viewport 390x844 (client 375x844); desktop pointer/keyboard, not physical-phone

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 再読込後、未送信の日本語2行を復元。POST0、feedback0。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": null,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 再読込後、未送信の日本語2行を復元。POST0、feedback0。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/mobile390-unsent.json`
- `legacy/mobile390-reload.jpg`
- `legacy/environment/browser-source-provenance.json`
- `source-provenance.json`

## project-mobile-local-back

状態: **pass**。原記録時刻: 2026-10-08T07:08:18.675Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / mobile viewport 390x844 (client 375x844); desktop pointer/keyboard, not physical-phone

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 about:blankへ移動し戻る。接続済み表示と未送信本文を復元。POST0、feedback0。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": null,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 about:blankへ移動し戻る。接続済み表示と未送信本文を復元。POST0、feedback0。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/mobile390-unsent.json`
- `legacy/mobile390-back.jpg`
- `legacy/environment/browser-source-provenance.json`
- `source-provenance.json`

## project-mobile-local-cancel

状態: **pass**。原記録時刻: 2026-10-08T07:08:18.519Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / mobile viewport 390x844 (client 375x844); desktop pointer/keyboard, not physical-phone

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 Ctrl+Kでコマンドパレットを開きEscapeで閉じる。元の送信ボタンへfocus復帰、本文保持。質問取消/送信取消ではない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": true,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 Ctrl+Kでコマンドパレットを開きEscapeで閉じる。元の送信ボタンへfocus復帰、本文保持。質問取消/送信取消ではない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/mobile390-unsent.json`
- `legacy/mobile390-cancel.jpg`
- `legacy/environment/browser-source-provenance.json`
- `source-provenance.json`

## project-mobile-local-double-submit

状態: **pass**。原記録時刻: 2026-10-08T07:09:19.517Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / mobile viewport 390x844 (client 375x844); desktop pointer/keyboard, not physical-phone

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 hold中の二度押し後もPOST1。log/SSE後も本文readonlyと送信disabledを確認。release後feedback1。disabled要素へのツール操作は送出されない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 hold中の二度押し後もPOST1。log/SSE後も本文readonlyと送信disabledを確認。release後feedback1。disabled要素へのツール操作は送出されない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/mobile390-double.json`
- `legacy/mobile390-double-saved.jpg`
- `legacy/environment/browser-source-provenance.json`
- `legacy/mobile390-held.json`
- `legacy/mobile390-double-sse.jpg`
- `source-provenance.json`

## project-mobile-local-disconnect-before

状態: **pass**。原記録時刻: 2026-10-08T07:09:32.340Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / mobile viewport 390x844 (client 375x844); desktop pointer/keyboard, not physical-phone

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 drop-before時の本文保持、feedback0を確認。resume後の手動再送でfeedback1。POST2のうち保存1。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 2,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 drop-before時の本文保持、feedback0を確認。resume後の手動再送でfeedback1。POST2のうち保存1。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/mobile390-before-final.json`
- `legacy/mobile390-before-saved.jpg`
- `legacy/environment/browser-source-provenance.json`
- `legacy/mobile390-before-offline.json`
- `legacy/mobile390-before-offline.jpg`
- `source-provenance.json`

## project-mobile-local-disconnect-after

状態: **pass**。原記録時刻: 2026-10-08T07:10:55.857Z。

環境: Windows / Node 22.23.3 / Codex in-app browser (Chromium系、版番号未取得) / mobile viewport 390x844 (client 375x844); desktop pointer/keyboard, not physical-phone

【旧版引継ぎ】ec5fbf7で実施（日時は原記録）。6040075での再実行ではない。 drop-after時に本文保持とfeedback1、resume後の回答表示を確認。自動/手動再送なし、POST1/feedback1。Q-navigationの再確認を採用。初回Q-afterの末尾文字差異は原因未確定のためこのセルの証拠に使わない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "旧版ec5fbf7の実測を引継ぎ。 drop-after時に本文保持とfeedback1、resume後の回答表示を確認。自動/手動再送なし、POST1/feedback1。Q-navigationの再確認を採用。初回Q-afterの末尾文字差異は原因未確定のためこのセルの証拠に使わない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `legacy/browser-checks.md`
- `legacy/browser-observations.json`
- `legacy/mobile390-final.json`
- `legacy/mobile390-after-recheck-saved.jpg`
- `legacy/environment/browser-source-provenance.json`
- `legacy/mobile390-after-recheck-offline.json`
- `legacy/mobile390-after-recheck-offline.jpg`
- `source-provenance.json`
