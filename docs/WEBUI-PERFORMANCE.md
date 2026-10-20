# Web UI 軽量化の計測と改善

対象: `dsh web` (127.0.0.1:3080) の起動時間・メモリ・ブラウザ転送量。

計測環境: Fedora / Linux x86_64, Node 22.23.1, DSH 0.2.1-rc.2, rdsh 0.3.3。
本番サービス `dsh-web.service` は計測中も停止・再起動していない（MainPID 400989,
NRestarts=0 を計測前後で確認）。全計測は別ポート (39080-39520) と
`DSH_HOME=/tmp/dsh-*` で実施した。

## 1. 結論

軽量化の余地は「起動」と「転送」にあり、**効果の大きい順**に次でした。

| # | 手段 | 実測効果 | 変更の種類 |
| - | ---- | -------- | ---------- |
| 1 | **gzip level 1 → 6** | 初期ロード **-86,039 B (-15.0%)** | 設定1行 |
| 2 | **NODE_COMPILE_CACHE** | モジュールコンパイル **-303 ms (-25.5%)**、起動 -0.30 s (-8.1%) | 環境変数 |
| 3 | **静的資産のキャッシュヘッダ** | 再訪問時の転送が実質ゼロ | upstream 実装 |
| 4 | **失敗プラグインの除去** | 起動 -約0.7 s（プラグイン11件全体の寄与） | プロファイル設定 |

**最大の single cause は ESM モジュールコンパイル**でした。CPU プロファイルで
`compileSourceTextModule` が 798 ms (12.2%) を占め、単一関数として最大です。
手段2はここに直接効きます。

## 2. 起動時間

### 2.1 構成別（中央値）

| 構成 | median | n | 負荷 |
| ---- | ------ | - | ---- |
| 現状 (プラグイン11件) キャッシュなし | 3.56 s | 6 | load 2.6-6.0 |
| 現状 + NODE_COMPILE_CACHE | 3.27 s | 5 | load 2.6-6.0 |
| 最小 DSH_HOME キャッシュなし | 2.88 s | 2 | load ~3 |
| 最小 DSH_HOME + NODE_COMPILE_CACHE | 2.29 s | 2 | load ~3 |

高負荷下 (load 6.0-6.2) の A/B 交互測定 n=5:

| 構成 | median | mean | sd |
| ---- | ------ | ---- | -- |
| COLD | 3.70 s | 3.8 s | 0.3 |
| WARM | 3.40 s | 3.3 s | 0.3 |

→ **-0.296 s (-8.1%)**。負荷が高いほど差は縮む。

読み取れること:

- プラグイン11件の寄与は **約0.7秒**（3.56 s − 2.88 s）。
- 両者を併用した最小構成で **2.29秒**、現状比 **-35%**。

### 2.2 CPU プロファイル（メインスレッド 6.54 s, 5937 サンプル）

| self time | 割合 | 関数 |
| --------- | ---- | ---- |
| 1003.7 ms | 15.4% | (idle) |
| **798.3 ms** | **12.2%** | **compileSourceTextModule** (node:internal/modules/esm/utils) |
| 340.0 ms | 5.2% | (garbage collector) |
| 128.5 ms | 2.0% | (program) |
| 104.1 ms | 1.6% | parseRecord (dsh-storage-json) |
| 91.5 ms | 1.4% | hasIntrinsicConstructor (dsh-util-values) |
| 85.9 ms | 1.3% | walkJsonValue (dsh-util-values) |

バケット別: node-internal 43.4% / @dsh/dsh 33.4% / idle 23.1%。
distinct URL 677 本、フレームを持つパッケージ 182 個。

## 3. NODE_COMPILE_CACHE の効果（交互測定）

150 本の ESM モジュールを import する時間を、キャッシュなし / ありで
**交互に各10回**測定（負荷ドリフトを相殺するため）。

| 構成 | median | mean | sd | min | max |
| ---- | ------ | ---- | -- | --- | --- |
| キャッシュなし | 1187.5 ms | 1327.0 | 280.4 | 1145.4 | 1894.7 |
| キャッシュあり | **884.1 ms** | 962.3 | 213.3 | 841.4 | 1545.7 |

- **median delta = -303.4 ms (-25.5%)**
- **対応ペアで 9/10 回キャッシュありが高速**
- median の 95% 信頼区間（ブートストラップ 10,000 回）:
  キャッシュなし 1159.9-1528.3 ms、あり 872.9-971.4 ms → **重ならない**

→ 統計的に有意。ただしキャッシュの初回生成コストは別途かかる
（150 モジュールで 15 MB / 2,570 ファイル）。

### 3.1 既知の問題: キャッシュ肥大

このマシンの `~/.cache/rdsh-node-compile-cache` は **146 MB / 21,052 ファイル**
まで膨張し、Node 22 と 24 の両方のエントリが混在していた。この状態では
起動が 4.6 s に悪化する測定も出た。**導入前に一度削除することを勧める。**

## 4. ブラウザ転送量

### 4.1 初期ロード（実測 wire バイト）

| 資産 | raw | gzip L1 (現状) | gzip L6 | brotli q11 |
| ---- | --- | -------------- | ------- | ---------- |
| assets/index-*.js | 939,867 | 328,450 | 284,681 | 239,789 |
| assets/vendor-*.js | 741,114 | 216,687 | 179,560 | 149,312 |
| assets/index-*.css | 77,343 | 19,357 | 14,828 | 12,981 |
| assets/vendor-*.css | 27,312 | 8,181 | 7,567 | — |
| HTML (動的, gzip) | 38,945 | 6,500 | 6,500 | — |
| **合計** | **1,824,581** | **579,175** | **493,136** | — |

`compressionLevel: 1` は `dsh-web-app/cordis.patch.yml:187` に明示されている。
これを 6 にすると **-86,039 B (-15.0%)**。level 9 との差は 511 B のみなので
6 で十分。**設定1行で得られる最大の改善**。

### 4.2 キャッシュヘッダの非対称（重要）

```
GET /assets/index-CN7NIWNw.js
  → content-type のみ。cache-control / etag / last-modified なし

GET /plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=...
  → cache-control: public, max-age=31536000, immutable
```

プラグイン側は `immutable` が付くのに、シェル資産側は付いていない。
原因は `dsh-host-frontend-static/lib/index.js:73`:

```js
res.writeHead(200, { "content-type": type });
res.end(body);
```

さらに毎回 `readFile` で全ファイルを読み、ETag/304 の経路もない。
ファイル名が content-hash なので `immutable` を付けて安全な種類の資産である。
（非対称が意図的かは不明。**推測**: 実装上の見落とし。）

## 5. プラグイン棚卸し

実測で **11件中3件が起動に失敗**していた。失敗しても起動コストは払う。

| プラグイン | 状態 |
| ---------- | ---- |
| `@local/rea-mcp` | cannot resolve profile bundle |
| `dsh-gitview` | dsh 0.2.1-rc.2 と非互換 (engines.dsh: 0.2.0-rc.2) |
| 配下 MCP の slack / blender2 / unity2 | 実行ファイル不在・トークン未設定 |

分類（詳細は `docs/evidence/webui-plugin-inventory.md`）:

- **無効化しても安全**: rea-mcp, dsh-gitview, dsh-sound, opencode-live,
  opencode-zen-usage, rdsh-update-banner
- **条件付きで安全**: google-mcp, superlist-mcp, dsh-copy-deliverable,
  rdsh-no-feedback, rdsh-mobile-ui
- **必要**: dsh-base, dsh-web-app, dsh-experimental-agent-team-profile, rdsh-settings

**転送量削減の主戦場は自作プラグインではない。** 自作の client.js 合計は
149,281 B だが、DSH 標準の client.js は 75 本で合計 11,664,203 B。最大は
`dsh-client-ui-settings-account` の 3,417,829 B 1本である。

## 6. 実施した変更

`scripts/webui-bench.sh` を追加した。3モードを持ち、すべて使い捨てポートで
動くため本番サービスに触れない。

```sh
scripts/webui-bench.sh boot --n 6 --port 39300
scripts/webui-bench.sh boot --n 6 --port 39310 --cache ~/.cache/dsh-compile
scripts/webui-bench.sh payload --port 3080
scripts/webui-bench.sh profile
```

## 7. 提案する変更（効果の順）

1. **gzip level を 1 → 6 に上げる**。設定1行で初期ロード -15%。
   圧縮は起動時に一度だけなので CPU 影響は無視できる。
2. **NODE_COMPILE_CACHE を web 起動にも適用する**。rdsh の slim 経路は
   既に対応済み (`src/passthrough.rs:322-345`) だが、このマシンの
   `dsh-web-local` は `dsh-orig` を直接 exec しており rdsh を経由しないため
   恩恵を受けていない。**適用前に肥大した既存キャッシュ (146 MB) を削除する。**
3. **静的資産に `cache-control: public, max-age=31536000, immutable` を付ける**。
   ハッシュ付きファイル名なので安全。再訪問時の転送が実質ゼロになる。
4. **失敗しているプラグインを外す**（rea-mcp, dsh-gitview, および
   slack / blender2 / unity2 の個別 MCP）。

## 8. 検証状況

未変更 HEAD `2b8a1f7c` に対する回帰は **0 件**。詳細は
`docs/evidence/webui-test-baseline.md`。

- PASS: cargo build / build --release / test / fmt --check /
  clippy -D warnings / rdsh-compute npm test (18) /
  plugin-security (78+25+5) / examples / unittest (39)
- FAIL 3件はいずれも環境起因:
  1. workflow-board 13 fail → `RDSH_BIN` が PATH 上の古い rdsh を指していた。
     正しいバイナリ指定で 14 pass / 0 fail。
  2. plugin-security の versions.rdsh 不一致 → `env -u RDSH_BIN` で 18/18 pass。
  3. rustup-init pinned checksum → **main (c44a2a7e) でも同一に失敗**。
     本ブランチの回帰ではなく既存不具合。

## 9. 限界

- 起動時間は**ホスト負荷に強く依存する**。load 6.9 の状況では WARM が COLD を
  上回る逆転測定も出た。§2.1 の数値は負荷を併記して読むこと。
- brotli は `compression@1.8.2` 自体は対応しているが、dsh の設定 schema が
  `none|gzip` の2択に制限しているため**設定だけでは有効化できない**。
- CPU プロファイルの 6.54 s は wall clock の起動時間ではなく、
  サンプリング総量である。
- すべてこのマシン・この DSH ビルドでの実測であり、他環境へ一般化はできない。
- プラグイン無効化は**実施していない**（設定を壊すリスクがあるため提案に留めた）。
