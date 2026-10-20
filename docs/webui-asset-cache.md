# Web シェル資産キャッシュ — 実装契約

rdsh が起動時にシェル資産を **Rust で事前圧縮**し、DSH 側の小さなプラグインが
それを配信する。Node は圧縮をしない（CPU ゼロ）、クライアントは brotli を得る。

実測（4 資産、raw 1,785,636 B）:

| 方式 | bytes | 圧縮時間 |
| ---- | ----- | -------- |
| gzip L1 | 632,582 | 7.7 ms |
| gzip L6 | 486,474 | 40.7 ms |
| br q9 | 448,100 | 136 ms |
| **br q11** | **408,561** | 1.74 s（直列） |

br q11 は現行より **-25.6%**、gzip L6 より **-16.2%**。
圧縮は一度だけディスクにキャッシュするので、2 回目以降の起動コストはゼロ。

---

## 1. キャッシュディレクトリ

```text
$DSH_HOME/webui/assets/<fingerprint>/
```

`fingerprint` = 次を連結した文字列の sha256 先頭 16 hex:

```text
"v1\0" + brotli_quality + "\0" + gzip_level + "\0"
+ 各ファイル（相対パス昇順）: relpath + "\0" + size + "\0" + mtime_ns + "\n"
```

これにより、DSH 更新・品質変更のどちらでも自動的に作り直される。
同一 fingerprint のディレクトリが既に `manifest.json` を持てば**再構築しない**。

## 2. 生成物

```text
<fingerprint>/manifest.json
<fingerprint>/index-CN7NIWNw.js.br
<fingerprint>/index-CN7NIWNw.js.gz
<fingerprint>/langs/rust-B1yitclQ.js.br     ← サブディレクトリ構造を保つ
...
```

圧縮対象: `.js .mjs .css .json .map .svg .html .txt`
圧縮しない: `.woff2 .woff .png .jpg .webp .ico`（既に圧縮済み）とサイズ 0。
圧縮しないファイルも manifest には載せる（`br: null, gzip: null`）。

## 3. manifest.json

```json
{
  "version": 1,
  "source": "/abs/path/to/dist/assets",
  "assets": {
    "index-CN7NIWNw.js": {
      "identity": 939867,
      "br": 209730,
      "gzip": 285293,
      "etag": "\"a1b2c3d4e5f60718\""
    },
    "fonts/KaTeX_Main-Regular-B22Nviop.woff2": {
      "identity": 10000,
      "br": null,
      "gzip": null,
      "etag": "\"1122334455667788\""
    }
  }
}
```

- `identity` = 元ファイルのバイト数
- `br` / `gzip` = 圧縮後のバイト数（圧縮しない場合は `null`）
- `etag` = 元ファイル内容の sha256 先頭 16 hex を**ダブルクォートで囲んだ** HTTP ETag 値
- キーは `source` からの相対パス（`/` 区切り）

## 4. rdsh が渡す環境変数

DSH を起動するとき:

```text
RDSH_WEB_ASSETS=<キャッシュディレクトリの絶対パス>
```

未設定なら DSH は従来どおり（プラグインは何もしない）。

## 5. プラグインの挙動

`RDSH_WEB_ASSETS` が未設定、または manifest が読めない/不正 →
**ルートを登録しない**（従来動作のまま。fail-safe）。

有効なとき `/assets` の prefix ルートを登録し、以下を行う。

1. `GET` / `HEAD` 以外は 405。
2. パスから `/assets/` を除いた相対パスを取る。空・`..` を含む・絶対パスは 404。
3. manifest に無い場合:
   - `source` 配下に実ファイルがあれば **identity で配信**（安全網）
   - 無ければ 404
4. manifest にある場合、`Accept-Encoding` を見て優先順に選ぶ:
   `br` → `gzip` → `identity`（`q=0` は除外。`*` は考慮しない）
5. レスポンスヘッダ:
   ```text
   content-type: <拡張子から決定>
   content-encoding: br | gzip | （identity では付けない）
   cache-control: public, max-age=31536000, immutable
   etag: <manifest の etag>
   content-length: <実際に送るバイト数>
   vary: accept-encoding          （identity 以外を選びうる場合）
   ```
6. `If-None-Match` が etag と一致 → **304** をヘッダ付きで返しボディなし。
7. HEAD はボディを送らない。

content-type の表（dist と同一にする）:

```text
.js  text/javascript; charset=utf-8
.css text/css; charset=utf-8
.svg image/svg+xml
.json application/json
.map application/json
.webmanifest application/manifest+json
.html text/html; charset=utf-8
.woff2 font/woff2
.woff font/woff
.png image/png
.ico image/x-icon
既定 application/octet-stream
```

## 6. 失敗時の原則

**最悪でも最適化が効かないだけで、起動と表示は壊れない。**

- rdsh 側: 事前圧縮に失敗したら環境変数を渡さない（プラグインは無効化される）
- プラグイン側: manifest が不正なら登録しない
- 個別ファイルの読み取り失敗は 404（dist と同じ挙動）

## 7. 実装担当

| 範囲 | 担当 |
| ---- | ---- |
| `src/webui_assets.rs`（走査・圧縮・manifest・並列化・テスト） | rust-assets |
| `plugins/rdsh-web-cache`（配信ルート・交渉・304・テスト） | web-plugin |
| 統合（passthrough で env 設定）・Docker 計測・レポート | lead |
