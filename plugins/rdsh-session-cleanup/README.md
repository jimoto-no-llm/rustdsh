# Headless セッションのリソース解放

このプラグインは、rdsh専用headlessランタイムが作成したルートAgentのセッションだけを対象に、破棄またはプロファイル終了時のWebSocket切断完了を待ちます。重複する終了通知では同じセッションを再度解放せず、終了時は未完了の処理を待ち、元の失敗を`AggregateError.errors`に保持します。

対象は`@earendil-works/pi-ai@0.87.1`へ`rdsh`のheadlessランタイム作成手順で非同期終了APIを追加した構成です。公式pi-aiの`0.87.1`と`1.1.0`が公開する`cleanupSessionResources(): void`は切断完了を返しません。この関数で代用せず、必要な`cleanupSessionResourcesAsync`がない構成では、`RDSH_SESSION_CLEANUP_RUNTIME`でプラグインの有効化を拒否します。同梱のheadlessパッチは必須の`headless-runner`へ`rdshSessionCleanupReady`依存を追加し、API検証と終了処理の登録が完了するまで実行を開始しません。パッチを省いてプラグインだけを挿入した場合、プロファイル全体の起動拒否は保証しません。元の外部モジュール読み込みエラーは`cause`へ保持します。

Web・Desktopなどheadless以外では、pi-aiを読み込む前に何も登録せず終了します。正式Harness `0.2.1-alpha.3` Webプロファイルでの読み込みは、この非headless動作の確認であり、未変更のpi-ai `1.1.0`でheadlessの終了待機を確認した結果ではありません。既存のheadlessランタイム・インストール・外部ライブラリーはこのプラグインから変更しません。

利用者向けのランタイム不足と終了失敗の文は、`$DSH_HOME/rdsh.json`の`general.language`で`en`・`zh-CN`・`ja`を切り替えます。未指定・`auto`では`RDSH_LANG`、`LC_ALL`、`LC_MESSAGES`、`LANG`、Nodeのロケールの順で判定します。エラーコードと外部の元のエラー本文は変更しません。

```sh
node --test plugins/rdsh-session-cleanup/test/*.test.mjs
```

`RDSH_CANDIDATE`を新しい不変候補へ指定した`node --test scripts/headless-runtime/test/actual-*.test.mjs`では、3言語で準備完了と所有セッションだけの切断待機、必須API欠落時の起動拒否を確認します。通常完了のCLI試験は私有ループバックのWebSocket応答を使い、有料APIへ接続しません。必須依存を削除した私有の負対照は失敗し、同梱設定を省いた有効化拒否だけを正常起動防止と取り違えないようにしています。
