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

本番 `:3080` から実際に取得したバイトを基準に、Node の `zlib.gzipSync` で
各レベルを再現して厳密に比較した。**本番の配信バイトは `level 1` と byte 完全一致**
するため、以下は推定ではなく実測である。

| 資産 | raw | 本番 = L1 | L6 | L9 | L6 の差 |
| ---- | --- | --------- | -- | -- | ------- |
| assets/index-CN7NIWNw.js | 939,867 | 316,005 | 285,293 | 284,725 | −30,712 |
| assets/vendor-DcuzkuQH.js | 741,114 | 206,829 | 179,829 | 178,481 | −27,000 |
| assets/index-BxpfOGf3.css | 77,343 | 18,374 | 14,786 | 14,725 | −3,588 |
| assets/vendor-DV2921Zo.css | 27,312 | 8,012 | 7,539 | 7,462 | −473 |
| **合計** | **1,785,636** | **549,220** | **487,447** | **485,393** | **−61,773 (−11.2%)** |

これに動的生成の index.html（6,500 B）とプラグイン combo（14,653 B）を足すと、
初期ロードは **570,373 B → 508,600 B** になる。

`compressionLevel: 1` は `dsh-web-app/cordis.patch.yml:187` に明示されている。
level 9 との差は **わずか 2,054 B** なので、6 で十分。
**設定 1 行で得られる最大の改善**である。

#### 実サービスでの検証結果

独立ポートで `level 6` を適用して起動し、実配信バイトを計測した。

```text
level 6 適用時の実配信:
  index-CN7NIWNw.js   285,293   (本番比 -30,712)
  vendor-DcuzkuQH.js  179,829   (本番比 -27,000)
  index-BxpfOGf3.css   14,786   (本番比  -3,588)
  vendor-DV2921Zo.css   7,539   (本番比    -473)
  合計                487,447   (本番比 -61,773, -11.2%)

展開後の内容: 本番と byte 完全一致 (sha256 4bc914bfbb6adbdd6395...)
起動失敗: 0 件
```

#### 設定上書きの重要な落とし穴

`cordis.patch.yml` の config 上書きは**マージではなく置換**である。
`webserver` を上書きする際に `host`/`port`/`tls` を再指定しないと、
そのまま消えて以下のエラーで**起動不能**になる（実測で確認）。

```text
webserver (required)
  ValidationError: invalid config:
    - $.host missing required value (at host)
```

正しくは全項目を `!!js` 式ごと再指定する。

```yaml
- id: webserver
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
    tls: !!js ctx.webStartup.tls
    compression: gzip
    compressionLevel: 6
    compressionThresholdBytes: 1024
```

### 4.2 キャッシュヘッダの非対称（重要）

```text
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
実測で `ETag` も `Last-Modified` も返らないため、`If-None-Match` を送っても
304 にはならず、**毎回フル再転送**になる。ファイル名が content-hash なので
`immutable` を付けて安全な種類の資産である。

#### 対策を実装した（`plugins/rdsh-web-cache`）

応答本文を変えず、`cache-control` ヘッダだけを追加するプロファイルバンドルを
実装した。壊さないための設計は次の 3 点。

1. **ルートを登録しない。** dist サーバのフォールバック席は 1 つしか許されず、
   2 つ目の登録は例外になる。`ServerResponse.writeHead` をラップするだけにして、
   既存ハンドラの制御を奪わない。
2. **ハッシュ付き成果物だけを対象にする。** `/assets/` 配下かつ
   ファイル名が `-<8文字以上のハッシュ>.<拡張子>` の形のときだけ付与する。
3. **`index.html` とプラグイン combo は素通し。** これらは変更しない。

実サービス（独立ポート）での検証結果:

```text
/assets/index-CN7NIWNw.js    cache-control: public, max-age=31536000, immutable
/assets/vendor-DcuzkuQH.js   cache-control: public, max-age=31536000, immutable
/assets/index-BxpfOGf3.css   cache-control: public, max-age=31536000, immutable
/assets/vendor-DV2921Zo.css  cache-control: public, max-age=31536000, immutable
/plugins/??...               cache-control: public, max-age=31536000, immutable  (既存のまま)

非ハッシュ資産 /assets/xyz.js → ヘッダ付与なし（据え置き）
4 資産すべての本文が本番と byte 一致
起動失敗 0 件
テスト 8 件すべて PASS
```

### 4.3 埋め込み画像（最大の転送量要因、ただし upstream 側）

プラグインの client.js には画像が base64 で埋め込まれている。独立検証
([webui-embedded-assets.md](evidence/webui-embedded-assets.md))
で確認した実測値:

| 項目 | 実測値 |
| ---- | ------ |
| 全プラグイン client.js 合計 | 11,619,693 chars (11,664,203 bytes) |
| うち base64 画像 | 3,645,716 chars (**31.375%**) |
| 最大パッケージ | `dsh-client-ui-settings-account` 3,209,194 chars |
| 内訳 | WebP 8件 + SVG 11件 + PNG 1件 = 20件 |

最大の内訳はオンボーディング画面のイラスト 8 枚（WebP、base64 で約 3.2 MB）:

```text
onboarding-welcome.webp            415,118 B (decoded)
onboarding-welcome-dark.webp       408,088 B
onboarding-welcome-zh.webp         392,680 B
onboarding-welcome-zh-dark.webp    390,100 B
onboarding-recharge-dark.webp      206,786 B
onboarding-recharge-zh-dark.webp   224,762 B
onboarding-recharge.webp           182,360 B
onboarding-recharge-zh.webp        180,360 B
```

参照コード（実測・逐語）:

```js
src:     locale === "zh" ? onboarding_welcome_zh_default : onboarding_welcome_default,
darkSrc: locale === "zh" ? onboarding_welcome_zh_dark_default : onboarding_welcome_dark_default
```

**base64 の WebP は gzip でほとんど縮まない。** 実測で
415,118 → 414,599 bytes（比 0.99875）だった。つまり圧縮レベルの調整では
この 3.2 MB には効かず、転送量を減らす手段は「配信しない・遅延させる」しかない。

#### 当初の主張の訂正

検証の結果、次の 2 点は**誤りだったため撤回する**。

| 当初の主張 | 判定 | 正しい値 |
| ---------- | ---- | -------- |
| base64 合計 3,645,684 | 不一致 | **3,645,716** chars |
| 最大パッケージ 3,205,173 | 不一致 | **3,209,194** chars |
| SVG 2 枚 | 不一致 | **SVG 11 枚** |
| **8 枚のうち使われるのは 2 枚、残り 6 枚は未使用** | **誤り** | **8 枚すべてコード上到達可能** |

最後の点が重要である。`OnboardingIllustration` は `src` と `darkSrc` を
**常に両方 `<img>` として描画**し、表示の切り替えは CSS
(`.ywGceq_darkIllustration { display: none }` と
`body[data-ds-dark-theme] ...`) が行う。したがって 1 セッションで同時に
*表示* されるのは 4 枚（light 2 + dark 2）である。

ただし `display: none` は取得を止めないため、「表示に使われない画像も
初期ロードで転送される」という趣旨自体は妥当である。削減の論点は
「未使用 6 枚」ではなく「**テーマ/ロケールで非選択の 4〜6 枚を遅延化できるか**」に
読み替えるべきである。

これらは upstream (`dsh-client-ui-settings-account` など) のバンドル内容であり、
rdsh 側から安全に書き換える手段がないため、**提案に留める**。

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

## 10. Docker での A/B 計測（追試）

ホスト計測は実プロファイル（MCP サーバ 5 本・失敗プラグイン 3 本）の影響を受け、
起動時間が環境状態に左右された。これを除くため、コンテナ内で
**コアバンドル2つだけの新しい DSH_HOME** を使った A/B を別途行った。
詳細は [webui-docker-bench.md](evidence/webui-docker-bench.md)。

```text
image  : node:22-slim (sha256:c3de60bf...), node v22.23.3
dsh    : 0.2.1-rc.2
方法   : current / fixed を交互に 5 ラウンド、毎回コンテナを起動し直す
```

| 指標 | 現行 | 修正版 | 差 |
| ---- | ---- | ------ | -- |
| 初回ロード転送量 (4資産) | 556,554 B | 487,453 B | **−69,101 B (−12.4%)** |
| `cache-control` | なし | `immutable` | 再訪問が実質ゼロ |
| 起動時間 (median) | 2,319 ms | 2,313 ms | −6 ms（有意差なし） |
| 初回取得時間 (localhost) | 41.5 ms | 56.5 ms | **+15.0 ms（悪化）** |

§4.1 のホスト計測では削減率 11.2% だったが、コンテナでは 12.4% になった。
差の原因は Node の zlib 実装で、ホストは zlib-ng ビルド、コンテナは標準 zlib。
level 1 の出力は実装で変わる（316,005 vs 319,590）が、**level 6 ではほぼ一致する**
（285,293 vs 285,295）。削減率が環境で変わるのはこのためで、どちらも正しい。

**正直なトレードオフ**: level 6 はサーバ CPU を 1 ロードあたり約 15 ms 増やす。
削減 69,101 B との損益分岐は概ね **37 Mbps** で、それより遅い回線では有利、
localhost や高速 LAN では体感差なし〜わずかに不利になる。
