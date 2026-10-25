# MCP resource の内容を添付ファイルとして扱う rustdsh 用パッチ

このディレクトリには検証済みのDSH source patchを同梱しています。このpatchではMCP resourceの内容を安全で永続的な画像・ファイル添付として利用できます。resource linkを一覧表示しても、リンク先のresourceは取得しません。modelが `open_mcp_resource_link` を呼び出せるのは、利用者がresourceの読み取りや確認を求めたあとで、正確なserver名とURIを指定する場合に限られます。

## 対応内容

- link projectionはMCP server名とURIをそのまま保持します。`resources/read` はcaller scopeに紐づくprovider経由で送信し、任意のURLを直接fetchせず、`ui://` URIは送信前に拒否します。
- binary base64はmodelが参照するtextに含めません。保存前にcanonical base64とMIME構文を検証し、1 itemあたり8 MiB、1回のreadあたり16 MiB、最大16 content partsという上限を確認します。長いtextとactive text MIME typeは添付に変換します。
- PNG/JPEG/WebP/GIFのバイト列は、attachment backendで検証します。現在のmodel routeが画像入力を受け付ける場合のみimage blockとし、それ以外はinert file attachmentとして保存します。その他のbinary dataとHTML/JavaScript/SVGは `.bin`、長いtextやactive textは `.txt` として保存し、内容を実行することはありません。
- 添付が拒否された場合は、その理由を分かりやすく表示します。添付の保持期間は設定されたbackendのpolicyに従い、自動expiryは提供しません。保持期間がbackend policyに従う旨も表示します。
- paginationと再接続の処理は既存のproviderに任せます。別serverや別の接続generationへresourceを持ち越すcacheは追加しません。

## 対応するDSH source

Node.js 22以降とGitが必要です。cleanで隔離されたDSH source checkoutを用意し、base `f97c0438fb1608bbc4c08c88a27344249795ea22`（`@deepseek-ai/dsh-mcp-resources` `0.1.7-rc.2`）に合わせてください。patch commitは `3b7c71fc79c4fe438e1c08f6d0e98680c83d17b2` です。変更対象は固定された10個のsource、test、lockfile、catalogファイルのみです。

rustdshのcheckoutから実行します。デフォルトは `--check` で、読み取り専用です。

```sh
node plugins/mcp-resource-artifacts/source-patch.mjs --source ../dsh-resource-source --check
node plugins/mcp-resource-artifacts/source-patch.mjs --source ../dsh-resource-source --apply
```

source root、exact base revision、patch checksumとcommit header、対象file一覧、cleanな作業ツリー、適用後のGit blobを検証します。未commitの変更やuntracked fileがあるsource treeは、変更を加えずに拒否します。別revisionとの互換性を推測して適用したり、導入済みのDSH checkoutに直接適用したりしません。

このツールはDSHをbuild・installせず、profileも変更しません。patchを適用したsourceは別途buildし、そのbuildを採用するかどうかは別に判断してください。DSHのMIT license noticeは `DSH-LICENSE` に同梱しています。

## 検証

```sh
node --test plugins/mcp-resource-artifacts/tests/source-patch.test.mjs
```

上流sourceでMCP resourceとclientに絞って実行したtestは、77/77件通過しています。検証checkoutでは `@standard-schema/spec`、`zod`、`undici` の依存リンクが欠けているため、source全体のTypeScript buildを完了できていません。rustdsh側のfixture testsでは、patchのcheck/apply/repeatに加え、不正な入力があっても既存の内容を保持することを検証しています。patchを適用したDSHはbuildしておらず、実profileにも採用していません。runtime UIも実際の導入環境では確認していません。
