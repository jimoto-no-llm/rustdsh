# Headless セッションのリソース解放

このプラグインは、rdsh専用のheadlessランタイムが作成したルートAgentのセッションのみを対象とし、破棄時またはプロファイル終了時におけるWebSocketの切断完了を待ちます。重複する終了通知に対して同一セッションを二重に解放することはせず、終了時には未完了の処理を待ち、元の失敗を`AggregateError.errors`に保持します。

対象となるのは、`@earendil-works/pi-ai@0.87.1`へ`rdsh`のheadlessランタイム作成手順で非同期終了APIを追加した構成です。公式pi-aiの`0.87.1`および`1.1.0`が公開している`cleanupSessionResources(): void`は、切断完了を返しません。この関数で代用することはせず、必要な`cleanupSessionResourcesAsync`が存在しない構成では、`RDSH_SESSION_CLEANUP_RUNTIME`によってプラグインの有効化を拒否します。同梱のheadlessパッチは、必須の`headless-runner`へ`rdshSessionCleanupReady`の依存関係を追加し、API検証と終了処理の登録が完了するまで実行を開始しません。パッチを適用せずにプラグインのみを導入した場合、プロファイル全体の起動拒否は保証されません。元の外部モジュール読み込みエラーは`cause`に保持します。

WebやDesktopなどのheadless以外の環境では、pi-aiを読み込む前に何も登録せずに終了します。正式Harness `0.2.1-alpha.3`のWebプロファイルにおける読み込みは、この非headless動作を確認するためのものであり、未変更のpi-ai `1.1.0`でheadlessの終了待機を確認した結果ではありません。既存のheadlessランタイム、インストール環境、外部ライブラリを、このプラグインから変更することはありません。

利用者向けのランタイム不足や終了失敗に関する文言は、`$DSH_HOME/rdsh.json`の`general.language`で`en`・`zh-CN`・`ja`を切り替えます。未指定または`auto`の場合は、`RDSH_LANG`、`LC_ALL`、`LC_MESSAGES`、`LANG`、Nodeのロケールの順に判定します。エラーコードと外部由来の元のエラー本文は変更しません。

```sh
node --test plugins/rdsh-session-cleanup/test/*.test.mjs
```

`RDSH_CANDIDATE`に新しい不変候補を指定した`node --test scripts/headless-runtime/test/actual-*.test.mjs`では、3言語での準備完了通知、所有セッションのみの切断待機、および必須API欠落時の起動拒否を確認します。正常に完了するCLIテストでは専用ループバックのWebSocket応答を使用し、有料APIへは接続しません。必須の依存関係を削除した独自の負対照テストは失敗し、同梱設定を省いたことによる有効化拒否だけを正常な起動防止と取り違えないようにしています。
