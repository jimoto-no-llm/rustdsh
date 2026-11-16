# rdsh-compaction

DSH 0.2.1-rc.2 の BasicCompactionEngine を継承する任意プラグインです。
絶対値のしきい値、要約指示の差し替え、ルート別の自動圧縮停止、費用による早期判断を接続します。

設定と有効化は [Native Compaction](../../docs/COMPACTION-POLICY.md) を参照してください。
インストールだけではバックエンドを追加しません。rdsh が起動時に headless と Web の各プリセットを構成します。

要約要求の最後の user 指示だけを変更し、共有の LLM サービスは変更しません。
要約・ツール境界・永続記録・再試行は DSH が担当します。形状が変わった場合は要約を失敗させます。

`npm test` は単体テストです。実 DSH との照合には `RDSH_DSH_COMPACTION_BASIC` へ
`@deepseek-ai/dsh-compaction-basic/lib/index.js` の絶対パスを渡します。
費用ブリッジの実バイナリ試験には `RDSH_BIN` を指定します。
CI の `native-compaction` ワークフローは両方を指定し、スキップなしで検証します。
