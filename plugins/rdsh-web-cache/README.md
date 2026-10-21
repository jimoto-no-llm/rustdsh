# rdsh-web-cache

DSH Web のシェル資産を **事前圧縮したまま配信**し、あわせて
`Cache-Control: immutable` を付与するプロファイルバンドルです。
実装契約は [docs/webui-asset-cache.md](../../docs/webui-asset-cache.md)。

## 2 つの動作

### 1. 事前圧縮配信ルート（RDSH_WEB_ASSETS があるとき）

rdsh が起動時にシェル資産を brotli q11 / gzip L6 で圧縮し、
`$DSH_HOME/webui/assets/<fingerprint>/` に `manifest.json` と
`<asset>.br` / `<asset>.gz` を書きます（Rust 側の担当）。
環境変数 `RDSH_WEB_ASSETS` がそのディレクトリを指すとき、本プラグインは
`/assets` の prefix ルートを登録し、以下を行います。

| 項目 | 挙動 |
| ---- | ---- |
| メソッド | `GET` / `HEAD` 以外は 405 |
| 表現選択 | `br` → `gzip` → `identity` の優先順。`q=0` は除外。`*` は考慮しない |
| ヘッダ | `content-type`（契約の表と同一）、`content-encoding`、`cache-control: public, max-age=31536000, immutable`、`etag`、`content-length`、必要なら `vary: accept-encoding` |
| 再検証 | `If-None-Match` が manifest の etag と一致したら 304（ボディなし） |
| HEAD | GET と同じヘッダを返し、ボディは送らない |
| manifest に無いパス | `source` 配下に実ファイルがあれば identity で配信（安全網）、無ければ 404 |
| 不正パス | 空・`..` を含む・絶対パス・壊れた percent-encoding は 404 |
| 読み取り失敗 | 404（dist サーバと同じ） |

交渉の補足: 明示された coding を優先するため、`Accept-Encoding: gzip` だけの
クライアントには gzip を返します。`br;q=0` のように br だけを拒否した場合は、
gzip が利用可能かつ未指定なら gzip に落ちます。ヘッダが無い・どの coding も
使えない場合は identity を返します（406 にはしません。最悪でも最適化が
効かないだけにするため）。

Node は圧縮しません。圧縮済みファイルを読むだけなので、リクエスト path の
圧縮 CPU はゼロです。

### 2. キャッシュヘッダのタップ（常時）

`RDSH_WEB_ASSETS` が無い場合の従来動作です。DSH のフロントエンドサーバは
`/assets/*` に `content-type` しか返しません
(`dsh-host-frontend-static/lib/index.js` の
`res.writeHead(200, { "content-type": type })`)。本プラグインは
`ServerResponse.writeHead` をラップし、**ハッシュ付き**のシェル資産にだけ
`cache-control` を足します。応答本文は変更しません。ルート側が自分で
`cache-control` を設定した場合はタップが触らないため、二重付与は起きません。

## 何をしないか（安全側の設計）

1. **manifest が無い/壊れている/読めないときはルートを登録しません。**
   DSH は従来どおり dist サーバが配信します（fail-safe）。
2. **応答本文は作り変えません。** 圧縮済みバイト列をそのまま送るだけです。
3. **manifest に無い実ファイルは identity で配信します。** symlink や
   作り直し直後の資産でシェルが欠けないための安全網です。
4. **dist サーバのフォールバック席は奪いません。** prefix ルートだけを
   登録し、`index.html` や `/plugins/??` は素通しです。

## 環境変数

| 変数 | 意味 |
| ---- | ---- |
| `RDSH_WEB_ASSETS` | 事前圧縮キャッシュの絶対パス。未設定ならルートを登録しない |
| `RDSH_WEB_CACHE=0` | プラグイン全体を無効化（ヘッダタップもルートも登録しない） |

`config.enabled: false` でも同じく無効化できます。

## 検証

```sh
node --check index.js
node --test test/cache-control.test.js test/headers.test.js test/assets-route.test.js
```

- `cache-control.test.js`: 純粋関数 `cacheControlFor` の単体テスト 5 件
- `headers.test.js`: 実 HTTP サーバでのヘッダタップ 3 件
- `assets-route.test.js`: 実 HTTP サーバ + tmpdir フィクスチャでの
  交渉 / 304 / HEAD / 405 / 404 / トラバーサル / 安全網 / manifest 不正 /
  inject 登録経路 22 件

合計 30 件です。
