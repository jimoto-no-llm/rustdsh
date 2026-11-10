# DSH model_call

`model_call` を既存DSHの `subagent` へ接続する小さなプラグインです。
子はDSHのワークスペースとツール構成を引き継ぎ、許可された範囲で読み書き・検索等を実行します。
Rust独立ハーネスの `model_call` とは別実装です。

```json
{"prompt":"README.mdを読み、作業用summary.txtへ要約を書いてください"}
```

別モデルを指定するときは既存 `list_subagent_models` で候補を確認し、
`provider` と `model` を同時に渡してください。省略すると子の既定ルートを使います。
DSHの設定namespace `subagent-model-selection-settings` で `enabled` と
`allowedModels` を設定した後、新規セッションで利用します。既存セッションには遡及しません。
このプラグインは許可リストや認証を変更せず、別の `list_subagent_models` も登録しません。

## 導入

リポジトリのルートで、既存Webプロファイルへ通常のDSH CLIから導入します。

```sh
dsh plugin --profile web add ./plugins/rdsh-model-call
```

パッケージの `dsh.bundle.patch` が `cordis.patch.yml` を指すため、Plugin Managerが
既存bundleの後に追加します。HMRが無効な場合はHostを再起動し、新規セッションを作成してください。
既存の `@deepseek-ai/dsh-tool-subagent` が呼出し元エージェントに登録されている構成が必要です。
Cordisの手動entryを使う場合は `name` に配置した `index.js` の `file://` URLを指定します。
`cordis.patch.yml` でbundleとして導入する場合は `rdsh-model-call` パッケージ名を解決できる状態にします。

## 実行契約

aliasは `ctx.tools.execute` を使い、呼出し元agent、rootCallId、parent token、
AbortSignalを内側の `subagent` へ渡します。直接tool実装を呼んだり、シェルを実行したりしません。
`run_in_background: false` で結果を待ち、追加コンテキストと正常完了時のturn終了を伝搬します。
失敗は例外として外側の失敗になり、成功JSONには変換しません。

モデルの許可リスト・深さ制限・sandboxは既存DSHが検証します。同じagentでのalias再入は拒否します。
DSH子エージェントは追加承認を対話要求できないため、親の許可範囲外の操作は失敗します。
フルアクセス等の設定をこのプラグインが自動で変更することはありません。

## 検証

```sh
node --test plugins/rdsh-model-call/test/*.test.mjs
```

固定fixtureで入力、scope、権限pipelineへのdispatch、取消、失敗、追加context、turn終了を検証します。
外部モデルへの要求や実際のワークスペース変更は行いません。
`DSH_TEST_NODE_MODULES` にインストール済みDSHの `node_modules` を指定すると、
実際のToolRuntimeで子のpolicy拒否と正常応答を検証する統合fixtureも実行します。
未指定時はこの統合fixtureのみSKIPします。
