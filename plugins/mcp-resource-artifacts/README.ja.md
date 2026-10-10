# rustdsh用MCP resource成果物パッチ

DSHのMCP resourceを、会話内で安全に開ける画像・ファイル添付として扱うsource patchです。resource linkは一覧時に取得せず、利用者が明示的に読むよう求めた後で `open_mcp_resource_link` を呼びます。

## 対応内容

- resource linkにMCP server名とURIを保持し、同じcaller scope内のserverへ明示的に `resources/read` を送ります。任意のURLを直接fetchせず、`ui://` URIは要求前に拒否します。
- binary base64をモデル向けテキストに展開しません。canonical base64、MIME、1 item 8 MiB、1回16 MiB、最大16 content partsを保存前に確認します。長いtextとactive MIMEのtextは添付へ回します。
- PNG/JPEG/WebP/GIFは実データをattachment backendで検証します。現在のmodel routeが画像入力に対応すればimage attachmentにし、それ以外はinert fileとして保存します。他のbinaryとHTML/JavaScript/SVGは `.bin`、長い/active textは `.txt` として保存し、実行しません。
- 添付が拒否された場合は理由を表示します。自動expiryは提供されないため、保持期間はbackend policyに従うと表示します。
- pagination cursorと再接続後のgenerationは既存providerに任せます。resourceを別serverや接続世代へ持ち越すcacheは追加しません。

## 対応DSH source

Node.js 22以降とGitが必要です。DSHのcleanで隔離したsource checkoutを、base `f97c0438fb1608bbc4c08c88a27344249795ea22`（`@deepseek-ai/dsh-mcp-resources` `0.1.7-rc.2`）へ合わせてください。patch commitは `3b7c71fc79c4fe438e1c08f6d0e98680c83d17b2` です。10個のsource、test、lockfile、catalogファイルだけを変更します。

rustdsh checkoutから実行します。既定の `--check` は読み取り専用です。

```sh
node plugins/mcp-resource-artifacts/source-patch.mjs --source ../dsh-resource-source --check
node plugins/mcp-resource-artifacts/source-patch.mjs --source ../dsh-resource-source --apply
```

source root、exact base、patch checksum、commit header、対象file一覧、適用後Git blobを照合します。作業ツリーに未commit変更やuntracked fileがあれば拒否し、既存変更を保持します。別revisionへの適用や、導入済みDSHへの直接適用は行いません。

このツールはDSHをbuild・installせず、profileも変更しません。patch適用後のbuildと、そのbuildを使う判断は別工程です。DSHのMIT license noticeを `DSH-LICENSE` に同梱します。

## 検証

```sh
node --test plugins/mcp-resource-artifacts/tests/source-patch.test.mjs
```

上流sourceのresource/client focused testsは77件通過しています。source全体のTypeScript buildは、検証checkoutで `@standard-schema/spec`、`zod`、`undici` の依存リンクが欠けており完了できていません。rustdsh側のfixture testsはpatchのcheck/apply/repeatと不正条件での保全を検証します。DSHのbuild、実profileへの採用、runtime UIの実機確認は未実施です。
