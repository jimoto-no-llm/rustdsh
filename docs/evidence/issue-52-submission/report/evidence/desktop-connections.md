# desktop WSL・Tailscale試験18セル

同じWSL上のProjectサーバーへTailscaleを通じて接続した9操作を、通過した2経路で参照している。18回の独立試行ではない。保存後切断セルだけはPCの390×844 viewportで実施し、実機phoneとは扱わない。

このファイルは原結果JSONとそこに列挙された観測資料を対応づける公開用の要約です。原画像・端末固有の接続先・実行ユーザー名・認証情報は含めません。ここでの再実行や独立した追認は行っていません。原証拠ラベルは監査対応用の名前であり、配布ファイルへのリンクではありません。結果の採録元JSONのハッシュは [来歴](provenance.md) にあります。

## project-desktop-wsl-answer

状態: **pass**。原記録時刻: 2026-10-08T08:23:47.728Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

Tab移動・typeText・Enterによる回答。保存本文WSL_PC_日本語の下書きと画面本文が一致。keyboardと同じ1送信。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "Tab移動・typeText・Enterによる回答。保存本文WSL_PC_日本語の下書きと画面本文が一致。keyboardと同じ1送信。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-wsl-keyboard

状態: **pass**。原記録時刻: 2026-10-08T08:23:47.728Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

BODYからTab4回で回答欄へ移動・入力、回答ボタンでEnter送信。送信後BODYへfocus、画面と保存本文一致。answerと同じ1送信。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "BODYからTab4回で回答欄へ移動・入力、回答ボタンでEnter送信。送信後BODYへfocus、画面と保存本文一致。answerと同じ1送信。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-wsl-sse-draft

状態: **pass**。原記録時刻: 2026-10-08T08:23:00.081Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

log1後も全文WSL_PC_日本語の下書きとTEXTAREA focusを保持。未送信POST0/feedback0。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": true,
  "detail": "log1後も全文WSL_PC_日本語の下書きとTEXTAREA focusを保持。未送信POST0/feedback0。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-wsl-reload

状態: **pass**。原記録時刻: 2026-10-08T08:23:00.234Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

同じタブを再読込し、全文と認証済み表示を復元。未送信POST0/feedback0。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": null,
  "detail": "同じタブを再読込し、全文と認証済み表示を復元。未送信POST0/feedback0。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-wsl-back

状態: **pass**。原記録時刻: 2026-10-08T08:23:00.455Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

同じタブでabout:blankへ移動して戻り、全文と認証済み表示を復元。未送信POST0/feedback0。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": null,
  "detail": "同じタブでabout:blankへ移動して戻り、全文と認証済み表示を復元。未送信POST0/feedback0。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-wsl-cancel

状態: **pass**。原記録時刻: 2026-10-08T08:23:26.318Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

回答ボタンからCtrl+K→Escapeでパレットを閉じ、回答ボタンへfocus復帰。本文保持、未送信。textarea上のCtrl+Kは対象外。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": true,
  "detail": "回答ボタンからCtrl+K→Escapeでパレットを閉じ、回答ボタンへfocus復帰。本文保持、未送信。textarea上のCtrl+Kは対象外。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-wsl-double-submit

状態: **pass**。原記録時刻: 2026-10-08T08:25:43.663Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

hold中dblclick→log2のSSE→再クリックとEnterを試す。入力/送信/破棄が無効のまま追加POSTなし。release後同一本文1件。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "hold中dblclick→log2のSSE→再クリックとEnterを試す。入力/送信/破棄が無効のまま追加POSTなし。release後同一本文1件。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-wsl-disconnect-before

状態: **pass**。原記録時刻: 2026-10-08T08:26:13.501Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

drop-before中に本文保持、POST1/forward0/feedback0。resume後「送信結果を確認」→明示再送し、同一本文1件。自動復帰とはしない。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 2,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "drop-before中に本文保持、POST1/forward0/feedback0。resume後「送信結果を確認」→明示再送し、同一本文1件。自動復帰とはしない。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-wsl-disconnect-after

状態: **pass**。原記録時刻: 2026-10-08T08:27:11.716Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

PCのviewport390×844で送信前から全文を記録。drop-after後もロック本文保持、POST1/forward1/feedback1。resume後の手動状態確認で保存済み表示、追加POSTなし。全角ｋなし。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "PCのviewport390×844で送信前から全文を記録。drop-after後もロック本文保持、POST1/forward1/feedback1。resume後の手動状態確認で保存済み表示、追加POSTなし。全角ｋなし。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-tailscale-answer

状態: **pass**。原記録時刻: 2026-10-08T08:23:47.728Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

Tab移動・typeText・Enterによる回答。保存本文WSL_PC_日本語の下書きと画面本文が一致。keyboardと同じ1送信。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "Tab移動・typeText・Enterによる回答。保存本文WSL_PC_日本語の下書きと画面本文が一致。keyboardと同じ1送信。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-tailscale-keyboard

状態: **pass**。原記録時刻: 2026-10-08T08:23:47.728Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

BODYからTab4回で回答欄へ移動・入力、回答ボタンでEnter送信。送信後BODYへfocus、画面と保存本文一致。answerと同じ1送信。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "BODYからTab4回で回答欄へ移動・入力、回答ボタンでEnter送信。送信後BODYへfocus、画面と保存本文一致。answerと同じ1送信。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-tailscale-sse-draft

状態: **pass**。原記録時刻: 2026-10-08T08:23:00.081Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

log1後も全文WSL_PC_日本語の下書きとTEXTAREA focusを保持。未送信POST0/feedback0。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": true,
  "detail": "log1後も全文WSL_PC_日本語の下書きとTEXTAREA focusを保持。未送信POST0/feedback0。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-tailscale-reload

状態: **pass**。原記録時刻: 2026-10-08T08:23:00.234Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

同じタブを再読込し、全文と認証済み表示を復元。未送信POST0/feedback0。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": null,
  "detail": "同じタブを再読込し、全文と認証済み表示を復元。未送信POST0/feedback0。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-tailscale-back

状態: **pass**。原記録時刻: 2026-10-08T08:23:00.455Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

同じタブでabout:blankへ移動して戻り、全文と認証済み表示を復元。未送信POST0/feedback0。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": null,
  "detail": "同じタブでabout:blankへ移動して戻り、全文と認証済み表示を復元。未送信POST0/feedback0。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-tailscale-cancel

状態: **pass**。原記録時刻: 2026-10-08T08:23:26.318Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

回答ボタンからCtrl+K→Escapeでパレットを閉じ、回答ボタンへfocus復帰。本文保持、未送信。textarea上のCtrl+Kは対象外。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 0,
  "feedback_count": 0,
  "focus_preserved": true,
  "detail": "回答ボタンからCtrl+K→Escapeでパレットを閉じ、回答ボタンへfocus復帰。本文保持、未送信。textarea上のCtrl+Kは対象外。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-tailscale-double-submit

状態: **pass**。原記録時刻: 2026-10-08T08:25:43.663Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

hold中dblclick→log2のSSE→再クリックとEnterを試す。入力/送信/破棄が無効のまま追加POSTなし。release後同一本文1件。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "hold中dblclick→log2のSSE→再クリックとEnterを試す。入力/送信/破棄が無効のまま追加POSTなし。release後同一本文1件。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-tailscale-disconnect-before

状態: **pass**。原記録時刻: 2026-10-08T08:26:13.501Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

drop-before中に本文保持、POST1/forward0/feedback0。resume後「送信結果を確認」→明示再送し、同一本文1件。自動復帰とはしない。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 2,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "drop-before中に本文保持、POST1/forward0/feedback0。resume後「送信結果を確認」→明示再送し、同一本文1件。自動復帰とはしない。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`

## project-desktop-tailscale-disconnect-after

状態: **pass**。原記録時刻: 2026-10-08T08:27:11.716Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu 24.04のProjectサーバー / Node 22.23.3（WSL Linux） / Codex in-app browser（Chromium系、版番号未取得） / desktop PC（disconnect-afterのみviewport390×844。実機phoneではない）

PCのviewport390×844で送信前から全文を記録。drop-after後もロック本文保持、POST1/forward1/feedback1。resume後の手動状態確認で保存済み表示、追加POSTなし。全角ｋなし。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。

観測値:

```json
{
  "input_lost": false,
  "duplicate_answers": 0,
  "answer_requests": 1,
  "feedback_count": 1,
  "focus_preserved": null,
  "detail": "PCのviewport390×844で送信前から全文を記録。drop-after後もロック本文保持、POST1/forward1/feedback1。resume後の手動状態確認で保存済み表示、追加POSTなし。全角ｋなし。 WSL実体+Tailscaleの共通試行を経路別2セルで参照し、独立2試行とは数えない。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/wsl-tail-desktop.md`
- `current/wsl-tail-desktop-observations.json`
- `current/wsl-tail-desktop-result.json`
- `current/wsl-tail-desktop-state.json`
- `source-provenance.json`
