# iPhone実接続の旧結果16セル

旧結果の時刻と限界を保持。Tailscaleの5合格セルは先行Windowsサーバーでの試行、WSLの6合格セルとTailscaleの二度押し1セルは同じ後続WSL試行。後続試行は診断observer付き。物理的なWi-Fi切断ではなく、fixture中継で障害を発生させた。4 blockedは外付けキーボードなし。

このファイルは原結果JSONとそこに列挙された観測資料を対応づける公開用の要約です。原画像・端末固有の接続先・実行ユーザー名・認証情報は含めません。ここでの再実行や独立した追認は行っていません。原証拠ラベルは監査対応用の名前であり、配布ファイルへのリンクではありません。結果の採録元JSONのハッシュは [来歴](provenance.md) にあります。

## project-mobile-wsl-answer

状態: **pass**。原記録時刻: 2026-10-08T09:00:14.048Z。

環境: iPhone 15（iOS版未取得）→ Windows Tailscale Serve → WSL Ubuntu内Projectサーバー / Node 22.23.3（WSL Linux） / Safari（利用者への同一タブ案内と本人報告。版未取得） / physical-phone

本人が入力した文章1件の表示を確認。実保存本文はwsl_日本語の下書き\n続けて入力。例文の大文字とは異なるが、追加入力を含む本人入力が保存された。tested_atは耐久保存時刻。 WSL実体+Tailscaleの同じ実機試行。経路別セルは独立2試行を意味しない。 診断observer付きrun NyTthQ。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "本人が入力した文章1件の表示を確認。実保存本文はwsl_日本語の下書き\\n続けて入力。例文の大文字とは異なるが、追加入力を含む本人入力が保存された。tested_atは耐久保存時刻。 WSL実体+Tailscaleの同じ実機試行。経路別セルは独立2試行を意味しない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `final-evidence/wsl-phone-observations.md`
- `final-evidence/wsl-phone-auth-trace.log`
- `source-provenance-final.json`
- `final-evidence/wsl-phone-sse-saved-state.json`
- `final-evidence/wsl-phone-double-final-result.json`

## project-mobile-wsl-keyboard

状態: **blocked**。原記録時刻: 2026-10-08T09:06:39.945Z。

環境: iPhone 15（iOS版未取得）→ Windows Tailscale Serve → WSL Ubuntu内Projectサーバー / Node 22.23.3（WSL Linux） / Safari（利用者への同一タブ案内と本人報告。版未取得） / physical-phone

iPhone15に外付けキーボードがなく、Tab/EnterまたはEscapeを含むカタログ操作を実施できない。PCやタッチ操作の結果で代用しない。tested_atは今回のセッションのカウンター記録時刻。

観測値:

```json
{
  "detail": "iPhone15に外付けキーボードがなく、Tab/EnterまたはEscapeを含むカタログ操作を実施できない。PCやタッチ操作の結果で代用しない。tested_atは今回のセッションのカウンター記録時刻。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `final-evidence/wsl-phone-observations.md`
- `final-evidence/wsl-phone-auth-trace.log`
- `source-provenance-final.json`

## project-mobile-wsl-sse-draft

状態: **pass**。原記録時刻: 2026-10-08T08:58:18.658Z。

環境: iPhone 15（iOS版未取得）→ Windows Tailscale Serve → WSL Ubuntu内Projectサーバー / Node 22.23.3（WSL Linux） / Safari（利用者への同一タブ案内と本人報告。版未取得） / physical-phone

log1による更新後、本人が「全文が残り、そのまま入力できる」と確認。全文・focusは本人報告による測定で、DOM activeElementは未取得。送信前POST0/feedback0。tested_atはlog直後のカウンター記録時刻。 WSL実体+Tailscaleの同じ実機試行。経路別セルは独立2試行を意味しない。 診断observer付きrun NyTthQ。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": true,
  "detail": "log1による更新後、本人が「全文が残り、そのまま入力できる」と確認。全文・focusは本人報告による測定で、DOM activeElementは未取得。送信前POST0/feedback0。tested_atはlog直後のカウンター記録時刻。 WSL実体+Tailscaleの同じ実機試行。経路別セルは独立2試行を意味しない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `final-evidence/wsl-phone-observations.md`
- `final-evidence/wsl-phone-auth-trace.log`
- `source-provenance-final.json`
- `final-evidence/wsl-phone-sse-unsent-result.json`
- `final-evidence/wsl-phone-sse-saved-state.json`

## project-mobile-wsl-reload

状態: **pass**。原記録時刻: 2026-10-08T08:58:18.658Z。

環境: iPhone 15（iOS版未取得）→ Windows Tailscale Serve → WSL Ubuntu内Projectサーバー / Node 22.23.3（WSL Linux） / Safari（利用者への同一タブ案内と本人報告。版未取得） / physical-phone

同じSafariタブの再読込後、本人が未送信本文の全文保持を確認。Q-sseを送信する前の試行。tested_atは直前の未送信カウンター記録時刻をセッション基準として使用し、再読込の正確な秒は未取得。後の送信は1回のみ。 WSL実体+Tailscaleの同じ実機試行。経路別セルは独立2試行を意味しない。 診断observer付きrun NyTthQ。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": null,
  "detail": "同じSafariタブの再読込後、本人が未送信本文の全文保持を確認。Q-sseを送信する前の試行。tested_atは直前の未送信カウンター記録時刻をセッション基準として使用し、再読込の正確な秒は未取得。後の送信は1回のみ。 WSL実体+Tailscaleの同じ実機試行。経路別セルは独立2試行を意味しない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `final-evidence/wsl-phone-observations.md`
- `final-evidence/wsl-phone-auth-trace.log`
- `source-provenance-final.json`
- `final-evidence/wsl-phone-sse-unsent-result.json`
- `final-evidence/wsl-phone-sse-saved-state.json`

## project-mobile-wsl-cancel

状態: **blocked**。原記録時刻: 2026-10-08T09:06:39.945Z。

環境: iPhone 15（iOS版未取得）→ Windows Tailscale Serve → WSL Ubuntu内Projectサーバー / Node 22.23.3（WSL Linux） / Safari（利用者への同一タブ案内と本人報告。版未取得） / physical-phone

iPhone15に外付けキーボードがなく、Tab/EnterまたはEscapeを含むカタログ操作を実施できない。PCやタッチ操作の結果で代用しない。tested_atは今回のセッションのカウンター記録時刻。

観測値:

```json
{
  "detail": "iPhone15に外付けキーボードがなく、Tab/EnterまたはEscapeを含むカタログ操作を実施できない。PCやタッチ操作の結果で代用しない。tested_atは今回のセッションのカウンター記録時刻。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `final-evidence/wsl-phone-observations.md`
- `final-evidence/wsl-phone-auth-trace.log`
- `source-provenance-final.json`

## project-mobile-wsl-double-submit

状態: **pass**。原記録時刻: 2026-10-08T09:06:39.945Z。

環境: iPhone 15（iOS版未取得）→ Windows Tailscale Serve → WSL Ubuntu内Projectサーバー / Node 22.23.3（WSL Linux） / Safari（利用者への同一タブ案内と本人報告。版未取得） / physical-phone

hold中に連打→log2のSSE後も再タップ不可・本文保持。ユーザー追加の再読込で保留POSTを中断し、本人が全文保持と明示再送後の1件表示を確認。実本文wsl_連打確認。POST2/forward1/feedback1は中断1回+明示再送1回で重複保存0。releaseは未実施。このvariationでカタログの保留連打・SSE後再試行・POST/耐久回答別記録を満たす。tested_atは最終カウンター記録時刻。 WSL実体+Tailscaleの同じ実機試行。経路別セルは独立2試行を意味しない。 診断observer付きrun NyTthQ。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 2,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "hold中に連打→log2のSSE後も再タップ不可・本文保持。ユーザー追加の再読込で保留POSTを中断し、本人が全文保持と明示再送後の1件表示を確認。実本文wsl_連打確認。POST2/forward1/feedback1は中断1回+明示再送1回で重複保存0。releaseは未実施。このvariationでカタログの保留連打・SSE後再試行・POST/耐久回答別記録を満たす。tested_atは最終カウンター記録時刻。 WSL実体+Tailscaleの同じ実機試行。経路別セルは独立2試行を意味しない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `final-evidence/wsl-phone-observations.md`
- `final-evidence/wsl-phone-auth-trace.log`
- `source-provenance-final.json`
- `final-evidence/wsl-phone-double-held-sse-result.json`
- `final-evidence/wsl-phone-double-after-reload-result.json`
- `final-evidence/wsl-phone-double-final-result.json`
- `final-evidence/wsl-phone-final-state.json`

## project-mobile-wsl-disconnect-before

状態: **pass**。原記録時刻: 2026-10-08T09:10:19.877Z。

環境: iPhone 15（iOS版未取得）→ Windows Tailscale Serve → WSL Ubuntu内Projectサーバー / Node 22.23.3（WSL Linux） / Safari（利用者への同一タブ案内と本人報告。版未取得） / physical-phone

drop-before後、本人が全文保持・結果確認待ちを確認。offline時POST1/forward0/feedback0。resume後に送信結果を確認→本文を確認して手動再送し、本人が同文1件の表示を確認。実本文wsl_保存前の切断。最終POST2/forward1/feedback1。無操作の自動復帰ではない。tested_atは最終カウンター記録時刻。 WSL実体+Tailscaleの同じ実機試行。経路別セルは独立2試行を意味しない。 診断observer付きrun NyTthQ。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 2,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "drop-before後、本人が全文保持・結果確認待ちを確認。offline時POST1/forward0/feedback0。resume後に送信結果を確認→本文を確認して手動再送し、本人が同文1件の表示を確認。実本文wsl_保存前の切断。最終POST2/forward1/feedback1。無操作の自動復帰ではない。tested_atは最終カウンター記録時刻。 WSL実体+Tailscaleの同じ実機試行。経路別セルは独立2試行を意味しない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `final-evidence/wsl-phone-observations.md`
- `final-evidence/wsl-phone-auth-trace.log`
- `source-provenance-final.json`
- `final-evidence/wsl-phone-before-offline-result.json`
- `final-evidence/wsl-phone-before-final-result.json`
- `final-evidence/wsl-phone-final-state.json`

## project-mobile-wsl-disconnect-after

状態: **pass**。原記録時刻: 2026-10-08T09:13:20.237Z。

環境: iPhone 15（iOS版未取得）→ Windows Tailscale Serve → WSL Ubuntu内Projectサーバー / Node 22.23.3（WSL Linux） / Safari（利用者への同一タブ案内と本人報告。版未取得） / physical-phone

drop-after後、本人が全文保持・結果確認待ちを確認。offline時に既にPOST1/forward1/feedback1。resume後は送信結果を確認だけを押し、再送せず同文1件の表示を本人が確認。POST1のまま増加なし。実本文wsl_保存の確認は案内例文と異なるが、本人入力を根拠にする。無操作の自動復帰ではない。tested_atは最終カウンター記録時刻。 WSL実体+Tailscaleの同じ実機試行。経路別セルは独立2試行を意味しない。 診断observer付きrun NyTthQ。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "drop-after後、本人が全文保持・結果確認待ちを確認。offline時に既にPOST1/forward1/feedback1。resume後は送信結果を確認だけを押し、再送せず同文1件の表示を本人が確認。POST1のまま増加なし。実本文wsl_保存の確認は案内例文と異なるが、本人入力を根拠にする。無操作の自動復帰ではない。tested_atは最終カウンター記録時刻。 WSL実体+Tailscaleの同じ実機試行。経路別セルは独立2試行を意味しない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `final-evidence/wsl-phone-observations.md`
- `final-evidence/wsl-phone-auth-trace.log`
- `source-provenance-final.json`
- `final-evidence/wsl-phone-after-offline-result.json`
- `final-evidence/wsl-phone-final-result.json`
- `final-evidence/wsl-phone-final-state.json`

## project-mobile-tailscale-answer

状態: **pass**。原記録時刻: 2026-10-08T07:47:27.837Z。

環境: iPhone 15 / iOS版未取得。ProjectサーバーはWindows / Node 22.23.3（Windowsサーバー） / ユーザー呼称Safari。Projectの各段階が独立Safariかアプリ内表示かは未確定、版未取得 / physical-phone

ユーザーが回答済みの同一本文1件を確認。実保存本文は「あああ\nいいい」で、案内例文は期待値に使わない。tested_atは耐久保存時刻。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "ユーザーが回答済みの同一本文1件を確認。実保存本文は「あああ\\nいいい」で、案内例文は期待値に使わない。tested_atは耐久保存時刻。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/phone-observations.md`
- `current/phone-result-final.json`
- `current/phone-state-final.json`
- `source-provenance.json`

## project-mobile-tailscale-keyboard

状態: **blocked**。原記録時刻: 2026-10-08T09:06:39.945Z。

環境: iPhone 15（iOS版未取得）→ Windows Tailscale Serve → WSL Ubuntu内Projectサーバー / Node 22.23.3（WSL Linux） / Safari（利用者への同一タブ案内と本人報告。版未取得） / physical-phone

iPhone15に外付けキーボードがなく、Tab/EnterまたはEscapeを含むカタログ操作を実施できない。PCやタッチ操作の結果で代用しない。tested_atは今回のセッションのカウンター記録時刻。

観測値:

```json
{
  "detail": "iPhone15に外付けキーボードがなく、Tab/EnterまたはEscapeを含むカタログ操作を実施できない。PCやタッチ操作の結果で代用しない。tested_atは今回のセッションのカウンター記録時刻。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `final-evidence/wsl-phone-observations.md`
- `final-evidence/wsl-phone-auth-trace.log`
- `source-provenance-final.json`

## project-mobile-tailscale-sse-draft

状態: **pass**。原記録時刻: 2026-10-08T07:43:41.124Z。

環境: iPhone 15 / iOS版未取得。ProjectサーバーはWindows / Node 22.23.3（Windowsサーバー） / ユーザー呼称Safari。Projectの各段階が独立Safariかアプリ内表示かは未確定、版未取得 / physical-phone

log1後も全文保持し、そのまま入力継続できるとユーザー確認。focus保持はこの自己申告による。DOMのactiveElementは未取得。送信前POST0/feedback0。tested_atはlog時刻。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": true,
  "detail": "log1後も全文保持し、そのまま入力継続できるとユーザー確認。focus保持はこの自己申告による。DOMのactiveElementは未取得。送信前POST0/feedback0。tested_atはlog時刻。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/phone-observations.md`
- `current/phone-result-final.json`
- `current/phone-state-final.json`
- `source-provenance.json`

## project-mobile-tailscale-reload

状態: **pass**。原記録時刻: 2026-10-08T08:02:25.236Z。

環境: iPhone 15 / iOS版未取得。ProjectサーバーはWindows / Node 22.23.3（Windowsサーバー） / ユーザー呼称Safari。Projectの各段階が独立Safariかアプリ内表示かは未確定、版未取得 / physical-phone

Q-sseの未送信本文が再読込後も残ることをユーザー確認。送信前POST0/feedback0。tested_atは当該セッションの最終カウンター記録時刻であり、再読込操作の正確な秒は未取得。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": null,
  "detail": "Q-sseの未送信本文が再読込後も残ることをユーザー確認。送信前POST0/feedback0。tested_atは当該セッションの最終カウンター記録時刻であり、再読込操作の正確な秒は未取得。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/phone-observations.md`
- `current/phone-result-final.json`
- `current/phone-state-final.json`
- `source-provenance.json`

## project-mobile-tailscale-cancel

状態: **blocked**。原記録時刻: 2026-10-08T09:06:39.945Z。

環境: iPhone 15（iOS版未取得）→ Windows Tailscale Serve → WSL Ubuntu内Projectサーバー / Node 22.23.3（WSL Linux） / Safari（利用者への同一タブ案内と本人報告。版未取得） / physical-phone

iPhone15に外付けキーボードがなく、Tab/EnterまたはEscapeを含むカタログ操作を実施できない。PCやタッチ操作の結果で代用しない。tested_atは今回のセッションのカウンター記録時刻。

観測値:

```json
{
  "detail": "iPhone15に外付けキーボードがなく、Tab/EnterまたはEscapeを含むカタログ操作を実施できない。PCやタッチ操作の結果で代用しない。tested_atは今回のセッションのカウンター記録時刻。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `final-evidence/wsl-phone-observations.md`
- `final-evidence/wsl-phone-auth-trace.log`
- `source-provenance-final.json`

## project-mobile-tailscale-double-submit

状態: **pass**。原記録時刻: 2026-10-08T09:06:39.945Z。

環境: iPhone 15（iOS版未取得）→ Windows Tailscale Serve → WSL Ubuntu内Projectサーバー / Node 22.23.3（WSL Linux） / Safari（利用者への同一タブ案内と本人報告。版未取得） / physical-phone

hold中に連打→log2のSSE後も再タップ不可・本文保持。ユーザー追加の再読込で保留POSTを中断し、本人が全文保持と明示再送後の1件表示を確認。実本文wsl_連打確認。POST2/forward1/feedback1は中断1回+明示再送1回で重複保存0。releaseは未実施。このvariationでカタログの保留連打・SSE後再試行・POST/耐久回答別記録を満たす。tested_atは最終カウンター記録時刻。 WSL実体+Tailscaleの同じ実機試行。経路別セルは独立2試行を意味しない。 診断observer付きrun NyTthQ。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 2,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "hold中に連打→log2のSSE後も再タップ不可・本文保持。ユーザー追加の再読込で保留POSTを中断し、本人が全文保持と明示再送後の1件表示を確認。実本文wsl_連打確認。POST2/forward1/feedback1は中断1回+明示再送1回で重複保存0。releaseは未実施。このvariationでカタログの保留連打・SSE後再試行・POST/耐久回答別記録を満たす。tested_atは最終カウンター記録時刻。 WSL実体+Tailscaleの同じ実機試行。経路別セルは独立2試行を意味しない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `final-evidence/wsl-phone-observations.md`
- `final-evidence/wsl-phone-auth-trace.log`
- `source-provenance-final.json`
- `final-evidence/wsl-phone-double-held-sse-result.json`
- `final-evidence/wsl-phone-double-after-reload-result.json`
- `final-evidence/wsl-phone-double-final-result.json`
- `final-evidence/wsl-phone-final-state.json`

## project-mobile-tailscale-disconnect-before

状態: **pass**。原記録時刻: 2026-10-08T07:59:44.196Z。

環境: iPhone 15 / iOS版未取得。ProjectサーバーはWindows / Node 22.23.3（Windowsサーバー） / ユーザー呼称Safari。Projectの各段階が独立Safariかアプリ内表示かは未確定、版未取得 / physical-phone

実際の障害設定drop-beforeをQ-afterで実施。通信断中の再読込は白画面。復旧後同じSafariとユーザーが報告した画面で本文「テスト」と再送待ちを確認し、明示再送で1件保存。最初のQ-before試行は保持不明で採用しない。tested_atは再送の耐久保存時刻。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 2,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "実際の障害設定drop-beforeをQ-afterで実施。通信断中の再読込は白画面。復旧後同じSafariとユーザーが報告した画面で本文「テスト」と再送待ちを確認し、明示再送で1件保存。最初のQ-before試行は保持不明で採用しない。tested_atは再送の耐久保存時刻。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/phone-observations.md`
- `current/phone-result-final.json`
- `current/phone-state-final.json`
- `source-provenance.json`
- `current/phone-reload-restored.jpg`
- `current/phone-offline-reload-blank.jpg`

## project-mobile-tailscale-disconnect-after

状態: **pass**。原記録時刻: 2026-10-08T08:02:25.236Z。

環境: iPhone 15 / iOS版未取得。ProjectサーバーはWindows / Node 22.23.3（Windowsサーバー） / ユーザー呼称Safari。Projectの各段階が独立Safariかアプリ内表示かは未確定、版未取得 / physical-phone

実際のdrop-afterをQ-navigationで実施。「保存後の確認」がPOST1/forward1/feedback1。復旧後ユーザーの明示再読込で回答済み、追加POSTなし。再読込なし自動復帰は未確認。tested_atは最終カウンター記録時刻であり、画面確認の正確な秒は未取得。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "実際のdrop-afterをQ-navigationで実施。「保存後の確認」がPOST1/forward1/feedback1。復旧後ユーザーの明示再読込で回答済み、追加POSTなし。再読込なし自動復帰は未確認。tested_atは最終カウンター記録時刻であり、画面確認の正確な秒は未取得。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/phone-observations.md`
- `current/phone-result-final.json`
- `current/phone-state-final.json`
- `source-provenance.json`
