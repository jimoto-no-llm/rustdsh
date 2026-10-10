# 元DSH Harnessの接続2セル

公式DSH 0.2.0-rc.2の実画面を確認。Project dashboardの合成fixtureからの推測ではない。Default workspaceと入力欄の表示までで、モデル実行・会話送信・作業完了は未確認。

このファイルは原結果JSONとそこに列挙された観測資料を対応づける公開用の要約です。原画像・端末固有の接続先・実行ユーザー名・認証情報は含めません。ここでの再実行や独立した追認は行っていません。原証拠ラベルは監査対応用の名前であり、配布ファイルへのリンクではありません。結果の採録元JSONのハッシュは [来歴](provenance.md) にあります。

## harness-desktop-wsl-tailscale

状態: **pass**。原記録時刻: 2026-10-08T08:19:27.763Z。

環境: Windows PC → Tailscale Serve → WSL Ubuntu DSH / Node 22.23.3 / DSH 0.2.0-rc.2 / Codex in-app browser（版未取得） / desktop PC

実Tailscale経由の通常Harness入口からWSL上の公式DSH 0.2.0-rc.2へ接続。隔離XDG修正後、Default workspace・入力欄を実ブラウザー確認。 モデル実行・会話送信・作業完了の検証ではない。

観測値:

```json
{
  "detail": "実Tailscale経由の通常Harness入口からWSL上の公式DSH 0.2.0-rc.2へ接続。隔離XDG修正後、Default workspace・入力欄を実ブラウザー確認。 初期default workspaceエラーは隔離HOMEのXDG Documents定義不足で、専用設定後に解消。製品コードは変更していない。別ブラウザーの認証引継ぎは対象外。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/normal-entry-and-input.md`
- `current/harness-tailnet-screen.json`
- `current/harness-workspace-fixed.json`
- `current/harness-workspace-fixed.jpg`
- `current/harness-env/provenance.json`
- `current/harness-env/workspace-diagnostic-after.json`
- `source-provenance.json`

## harness-mobile-wsl-tailscale

状態: **pass**。原記録時刻: 2026-10-08T08:20:43.173Z。

環境: iPhone15 / iOS版未取得 → Windows Serve → WSL Ubuntu DSH / Node 22.23.3 / DSH 0.2.0-rc.2 / ChatGPTアプリ内ブラウザー表示（画像確認）、Safari版未取得 / physical-phone

iPhone15のChatGPTアプリ内ブラウザー表示から元DSH画面のDefault workspace・入力欄を実画像で確認。外部Safariへの切替成功とはしない。tested_atは修正後画像の保存mtimeで、撮影秒は未取得。 モデル実行・会話送信・作業完了の検証ではない。

観測値:

```json
{
  "detail": "iPhone15のChatGPTアプリ内ブラウザー表示から元DSH画面のDefault workspace・入力欄を実画像で確認。外部Safariへの切替成功とはしない。tested_atは修正後画像の保存mtimeで、撮影秒は未取得。 初期default workspaceエラーは隔離HOMEのXDG Documents定義不足で、専用設定後に解消。製品コードは変更していない。別ブラウザーの認証引継ぎは対象外。"
}
```

原証拠ラベル（ローカル保持、未同梱）:

- `current/normal-entry-and-input.md`
- `current/harness-tailnet-screen.json`
- `current/harness-workspace-fixed.json`
- `current/harness-workspace-fixed.jpg`
- `current/harness-env/provenance.json`
- `current/harness-env/workspace-diagnostic-after.json`
- `source-provenance.json`
- `current/harness-phone-fixed-ui.jpg`
- `current/harness-phone-fixed-preview.jpg`
