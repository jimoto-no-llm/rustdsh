# rdsh-web-cache

DSH Web のシェル資産に `Cache-Control` を付与し、再訪問時の再転送をなくす
プロファイルバンドルです。

## 何をするか

DSH のフロントエンドサーバは `/assets/*` に対して `content-type` しか返しません
(`dsh-host-frontend-static/lib/index.js` の `res.writeHead(200, { "content-type": type })`)。
このためブラウザは、訪問のたびにシェル全体を再取得します。一方、`/plugins/??` 経由の
プラグインバンドルには `cache-control: public, max-age=31536000, immutable` が既に付いています。
本プラグインは、シェル資産をこの既存ポリシーに揃えるだけです。

実測値（この開発機、2026-10-20）:

| 対象 | サイズ (gzip) |
|---|---|
| index.html | 6,500 B |
| `assets/index-*\.js` | 316,005 B |
| `assets/vendor-*\.js` | 206,829 B |
| `assets/index-*\.css` | 18,374 B |
| `assets/vendor-*\.css` | 8,012 B |
| plugins combo | 14,653 B |
| **合計** | **570,373 B** |

`Cache-Control` が無いため、この転送がリロードごとに繰り返されます。

## 何をしないか

壊さないことを最優先に、以下を守ります。

1. **応答本文を変更しません。** 追加するのは `cache-control` ヘッダ 1 つだけです。
2. **ルートを登録しません。** dist サーバのフォールバック席は 1 つしか許されず、
   2 つ目の登録は例外になります。本プラグインは `ServerResponse.writeHead` を
   ラップするだけで、既存ハンドラの制御を奪いません。
3. **ハッシュ付きの成果物だけを対象にします。** バンドラは `index-<hash>.js` のように
   内容ハッシュをファイル名に含めるため、同一 URL は同一バイト列に対応し、
   長い `max-age` で古い内容が配られることはありません。
4. **index.html とプラグイン combo には触れません。** これらは素通しです。

## 無効化

```bash
RDSH_WEB_CACHE=0 dsh web
```

または `config.enabled: false` を渡します。

## 検証

```bash
node --test test/cache-control.test.js test/headers.test.js
```

純粋関数 `cacheControlFor` の単体テスト 5 件と、実際に HTTP サーバを立てて
ヘッダと本文を確認する統合テスト 3 件の計 8 件です。

実サービスでの確認結果（`level 6` と同時適用、独立ポート 39980）:

```text
/assets/index-CN7NIWNw.js   public, max-age=31536000, immutable
/assets/vendor-DcuzkuQH.js  public, max-age=31536000, immutable
/assets/index-BxpfOGf3.css  public, max-age=31536000, immutable
/assets/vendor-DV2921Zo.css public, max-age=31536000, immutable
/plugins/??...              public, max-age=31536000, immutable   (既存のまま)
```

4 資産すべてで本文が本番と byte 一致、起動失敗 0 件を確認済みです。
