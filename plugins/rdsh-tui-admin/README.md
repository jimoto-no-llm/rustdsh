# Rust TUI administration catalog

既存DSH Hostの公開Typert descriptorを `rdshTuiAdmin/catalog` でJSONへ投影します。
Rust TUIは一覧から選んだ元のRPC/HTTP endpointを既存の認証済みgatewayへ送ります。
このプラグインは実行proxyを持たず、peer/operator判定、Hostの確認、取消を変更しません。

```sh
dsh plugin --profile web add ./plugins/rdsh-tui-admin
```

`ctx.typert.local.list()` と `subscribe()` のみで実行定義の追加・削除を追従します。
strict codecは `create()` 後にschema自身の公開 `toJSONSchema({ unrepresentable: 'any', io: 'input' })`
で投影します。installed Zodの公開instance methodを利用し、外部npm依存はありません。
codecが公開projectorを持たない場合や投影に失敗した場合は固定warningとして返し、その項目のschemaは `{}` になります。
catalog自身のresult codecはTypert公開契約の `parse()` でJSON構造を検証します。
設定値・認証値を取得するメソッドやlookupは実行しません。schemaに含まれたsecret系fieldの
default/examples/const/enumも除去します。

返却は `{ version, revision, actions, warnings, httpAvailability }` です。各actionは
`id,label,description,transport,mode,schema,defaults,sensitive` を持ちます。
RPCのidは `namespace/method`。`descriptor` は元のservice、引数source、codecの型/schema、
context受信wire、scope、result、uplink、cancellationを保持します。
入力schemaにはJSON引数とlookupのwire identity、context受信wireを含めます。
省略可能なのは `acceptsUndefined: true` の引数だけです。取消signalは引数JSONに含めません。
uplinkがあるstreamは `uplink: true` と `uplinkSchema` も返します。

RDSH独自HTTP endpointは公開一覧APIがないため、`http-actions.js` に監査したmanifestを置きます。
これらは `availability: 'manifest'` と明示します。pluginが無効なら通常の404等が返り、
利用可能とは推定しません。HTTP idは `METHOD /api/path`、`method/path` で送信先を表します。
GETの入力はquery、POSTの入力はJSON bodyです。`query` が指定された場合はそのキーのみ送ります。
画像は `responseType: 'binary'`、SSEは `mode: 'stream', streamFormat: 'sse'` です。
GUI専用の任意DOM、画像、グラフの描画を端末で再現するものではありません。

## 検証

リポジトリrootで実行できます。依存導入や `NODE_PATH` は不要です。

```sh
node --test plugins/rdsh-tui-admin/test/*.test.mjs
```

installed DSHのruntime統合fixtureも実行する場合は、その `node_modules` を
`DSH_TEST_NODE_MODULES` に設定します。fixtureはschemaと登録だけを扱い、
設定変更・API呼出し・実モデル呼出しをしません。
`DSH_TEST_PACKAGE_INSTALL=1` では使い捨てディレクトリへnpm packとoffline installを行い、
通常のパッケージ名importも検証します。local file URLからのimportは常時検証します。
