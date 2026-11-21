# Rust TUI administration catalog

既存DSH Hostの公開Typert descriptorを `rdshTuiAdmin/catalog` でJSONへ投影します。
Rust TUIは一覧から選んだ元のRPC/HTTP endpointを既存の認証済みgatewayへ送ります。
汎用実行proxyは持ちません。元の操作は既存のpeer/operator判定、Hostの確認、取消に従います。
設定文書の限定RPCだけはこのプラグインが提供し、Connectionのoperatorを要求します。

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

## TUI内の設定文書編集

外部エディタを開く `settings/openSettingsDocument` の代わりに、認証済みGatewayから使います。

- `rdshTuiAdmin/readSettingsDocument {}` → `{path,content,revision,writable}`
- `rdshTuiAdmin/saveSettingsDocument {content,expectedRevision}` → `{revision,applied:true,backupPath}`

両actionはcatalogで `sensitive: true` です。内容には秘密値が含まれ得るため、TUIは会話・履歴・ログへ
転載せず管理・編集画面内だけで扱います。渡せるパス引数はなく、`settings.prepareDocument()`、
`configEditor.documentPath`、profileの管理先が一致する `cordis.patch.yml` だけを扱います。
通常ファイル・UTF-8・512 KiB上限を検査し、symlinkを拒否します。

保存はSHA-256のリビジョンを比較し、既存Hostと同じ `package.json` writer lockとHMR排他処理を使います。
DSHの公開YAML dialectで構文とパッチを検査後、同じ場所に0600の `rdsh-backup-*` を保存し、
atomic writeと通常のLoader reconciliationで適用します。適用失敗時は文書と実行時設定を戻します。
競合時は `settings/document-conflict`、適用して復元済みなら `settings/document-apply-failed`、
復元も失敗した場合は `settings/document-rollback-failed` を返します。診断に文書の値は含めません。
バックアップは自動削除しません。外部エディタがHostのwriter lockを無視する場合、保存直前にも
リビジョンを再確認しますが、その後の外部書込みまで排他できるものではありません。

runtimeは実行Host/profileの公開パッケージから解決するため、local file URLのpluginにも別のnpm依存は不要です。

## ブラウザ面のセッション接続

起動前に `globalThis.__RDSH_TUI_BRIDGE_ENABLED__ === true` を注入したブラウザだけに、
`__RDSH_TUI_WORKSPACE__` を公開します。`openSession(id)` は公開 `UiWorkspace.openSession(id)` を呼び、
`{requestedSessionId:id}` を返します。要求の受付であり、会話の読込み完了を表すものではありません。
開始前に `navigationReady(id)` を待ちます。公開Session一覧が `phase:'ready'` となり、対象IDが
一覧に到着するまで `false` です。一覧同期前の `sessions.retain: unknown session` を防ぎます。
要求前に公開 `layout.beginNavigation()` で、それ以前の非同期ワークスペース移動を取り消します。
`selectedSessionId()` は公開 `sidebarRight.mounted.getSnapshot()` で実表示Sessionを返します。
グローバル設定画面など、Sessionが画面上にない場合は `null` です。
`openWorkspacePath({path,action?,application?})` は、通常ファイルを公開Sidebarの文書previewへ、
フォルダを内部一覧ダイアログへ開きます。`action:'reveal'` は親フォルダを開き、対象パスと
対象を開くボタンを表示します。フォルダ移動・ファイルpreview・閉じる操作は同じ画面内です。
フォルダ一覧は公開 `uiWorkspace.listDirectory`、ファイル一覧と確認は認証済み `workspaceFiles` を使います。
ワークスペース外ではフォルダ移動と指定ファイルpreviewを提供しますが、ファイルの列挙はHostの許可範囲に従います。
`application` を指定した外部アプリ起動も内部previewへ置き換え、OSのopen/revealは呼びません。
一般のWeb起動ではbridgeを作らず、service/contextを丸ごと公開することもありません。

## 検証

リポジトリrootで実行できます。依存導入や `NODE_PATH` は不要です。

```sh
node --test plugins/rdsh-tui-admin/test/*.test.mjs
```

installed DSHのruntime統合fixtureも実行する場合は、その `node_modules` を
`DSH_TEST_NODE_MODULES` に設定します。fixtureは使い捨てprofileと実Hostの設定provider/Loader/
Gateway/Connectionを使って編集・適用・再読込み・競合・拒否を検証します。実ユーザーの設定・
認証・実モデルには触れません。書込み失敗と適用失敗の復元はfault injectionでも検証します。
`DSH_TEST_PACKAGE_INSTALL=1` では使い捨てディレクトリへnpm packとoffline installを行い、
通常のパッケージ名importも検証します。local file URLからのimportは常時検証します。
