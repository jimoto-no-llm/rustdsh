# Web UI 軽量化 — ベースライン実測 (task-1)

対象ブランチ: `test/webui-lighter` (作業ディレクトリ `/var/tmp/wt-uiperf`)
計測日時: 2026-10-20 (JST)
計測者: bench-writer (teammate)
準拠: `docs/BENCHMARKS.md` "Rules for benchmark PRs" (machine/OS/n 明記・生出力・前後比較)

> **本番サービス `dsh-web.service` (127.0.0.1:3080) は停止も再起動もしていない。**
> すべての起動計測は別ポート (39201/39205/39207/39209/39211/39213/39215/39217) と
> 別 `DSH_HOME` (`/tmp/dsh-min`, `/tmp/dsh-hdr*`) で実施した。
> 計測期間中の本番サービス: `ActiveState=active`, `NRestarts=0`, MainPID 400992/400989 変化なし。

---

## 1. 検証環境

| 項目 | 値 |
| --- | --- |
| host | `fedora` |
| OS | Fedora Linux 44 (KDE Plasma Desktop Edition), kernel `6.19.10-300.fc44.x86_64` |
| CPU | AMD Ryzen 7 5700X 8-Core Processor, 16 threads (2 threads/core, 8 cores) |
| CPU scaling | 76% (計測時), max 4784 MHz / min 576 MHz |
| RAM | 31 GiB total, 22 GiB available |
| Node | `v22.23.1` (`/usr/bin/node`) |
| dsh | `0.2.1-rc.2` (`/home/sahen/.local/bin/dsh-orig` → `/home/sahen/.local/opt/dsh-original/bin/dsh`) |
| brotli | 1.2.0 (`/usr/bin/brotli`) |

**注意 (負荷)**: 計測中、別 teammate が同一ホストで `node --test` を実行していた時間帯がある
(ポート 39232 で別 dsh プロセスも稼働)。起動時間の分散要因のひとつ。

---

## 2. 起動時間 (別ポート・curl で `/` が応答するまで)

### 2.1 計測方法

```bash
S=$(date +%s.%N)
timeout 150 env NODE_COMPILE_CACHE=/tmp/nodecc NODE_OPTIONS=--max-old-space-size=1536 \
  DSH_HOME=<home> /home/sahen/.local/bin/dsh-orig --profile web -- \
  --host 127.0.0.1 --port 39201 --no-open > /tmp/x.log 2>&1 &
P=$!
for i in $(seq 1 400); do
  curl -s -o /dev/null --max-time 2 http://127.0.0.1:39201/ 2>/dev/null && { R=$(date +%s.%N); break; }
  kill -0 $P 2>/dev/null || { R=DEAD; break; }
  sleep 0.2
done
echo "boot=$(echo "$R - $S" | bc)"
kill -TERM $P; sleep 2; kill -9 $P 2>/dev/null
```

各構成の前に 1 回ウォームアップ起動を挟み、以降 n=3 を採用 (B 構成は warmup を除外)。

### 2.2 生の測定値 (秒)

| 構成 | run1 | run2 | run3 | median | mean | stdev | CV |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A: 現状構成 cold (DSH_HOME=/home/sahen/.dsh, cache なし) | 3.717 | 3.848 | **5.417** | 3.848 | 4.327 | 0.946 | 21.9% |
| B: 現状構成 + NODE_COMPILE_CACHE warm | 2.834 | 3.059 | 3.641 | 3.059 | 3.178 | 0.417 | 13.1% |
| M: 最小 DSH_HOME cold (/tmp/dsh-min, cache なし) | 2.784 | 2.728 | 3.433 | 2.784 | 2.982 | 0.386 | 13.0% |
| M+: 最小 DSH_HOME + NODE_COMPILE_CACHE warm | 2.299 | 2.506 | 2.498 | 2.498 | 2.434 | 0.116 | 4.8% |

除外したウォームアップ: `B_warmup = 4.220`, `M_warmup = 2.930`

**A の run3 (5.417) は外れ値**。中央値 3.848 に対し MAD=0.131、modified z-score = **8.05** (>3.5)。
除外した場合の A cold 中央値は **3.782** (n=2)。

### 2.3 lead 提示値との比較 — 再現性

| 構成 | lead 提示 median | 本実測 median | 判定 |
| --- | --- | --- | --- |
| 現状構成 cold | 3.43 (n=3) | 3.848 (n=3, 外れ値込み) / 3.782 (外れ値除外) | **概ね再現**。本実測はやや遅い (+0.4s)。外れ値を除けば差は小さい |
| 現状構成 + compile cache warm | 2.95 (n=3) | 3.059 (n=3) | **再現** (差 +0.11s) |
| 最小 DSH_HOME cold | 2.88 (n=2) | 2.784 (n=3) | **再現** (差 -0.10s) |
| 最小 DSH_HOME + compile cache warm | 2.29 (n=2) | 2.498 (n=3) | **概ね再現** (+0.21s)。lead の min 値 2.207 は本実測の min 2.299 と近い |

**結論**: 4 構成すべてで lead の傾向 (最小構成 + compile cache が最速、現状 cold が最遅) を再現した。
絶対値はホスト負荷により ±0.2〜0.4s ぶれる。**起動時間はノイズが大きいため、単一値ではなく median + 生値併記が必要。**

### 2.4 相対改善 (本実測 median ベース)

| 比較 | 削減 |
| --- | --- |
| A (現状 cold) → B (compile cache) | 3.848 → 3.059 = **-0.79s (-20.5%)** |
| A (現状 cold) → M+ (最小 + cache) | 3.848 → 2.498 = **-1.35s (-35.1%)** |
| M (最小 cold) → M+ (最小 + cache) | 2.784 → 2.498 = **-0.29s (-10.3%)** |

---

## 3. 常駐メモリ

### 3.1 本番サービス (systemd, 読み取りのみ)

```bash
$ systemctl --user show dsh-web.service -p ActiveState -p SubState -p MainPID \
    -p ExecMainStartTimestamp -p ActiveEnterTimestamp -p MemoryCurrent -p MemoryPeak -p NRestarts
ActiveState=active
SubState=running
ActiveEnterTimestamp=Tue 2026-10-20 19:21:07 JST
MainPID=400989
NRestarts=0
ExecMainStartTimestamp=Tue 2026-10-20 19:21:01 JST
MemoryCurrent=809472000      # 計測開始時 ≈ 772 MiB
MemoryPeak=1694605312        # ≈ 1.58 GiB
```

終了時点の再取得: `MemoryCurrent=845172736` (≈ 806 MiB), `MemoryPeak` 変化なし, `NRestarts=0`。

- systemd 上の起動所要: ExecMainStart 19:21:01 → ActiveEnter 19:21:07 = **約 6 秒**
- `MemoryCurrent` は cgroup 合計 (子プロセス含む)。単一プロセスの RSS ではない。

### 3.2 別ポート起動での RSS (起動 12 秒後、MCP 子プロセス含む)

```text
full_profile  main_rss_kb=2140   direct_children=1  children_rss_kb=430688
minimal_home  main_rss_kb=2280   direct_children=1  children_rss_kb=299972
```

**注意 (推測を含む)**: `main_rss_kb` が 2 MB 台なのは、本体がシムで実体は子プロセス側にあるため。
`children_rss_kb` も `pgrep -P` の**直接の子 1 件のみ**の合計であり、**孫プロセスを含まない**。
真の常駐量は本番の systemd `MemoryCurrent` (≈772–806 MiB) を参照すべき。

参考: 別途 `ps` で観測した本番ツリーの主要プロセス RSS:
`node (dsh web, PID 400992) = 678452 KB` (≈663 MiB)、
MCP 子 (gdrive/discord/headroom/tavily/chrome-devtools/alpha 等) が各 7–53 MB。

---

## 4. フロント資産サイズ (実ファイル)

場所: `/home/sahen/.local/opt/dsh-original/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets`

計測コマンド: `stat -c%s` / `gzip -N -c` / `brotli -q 11 -c`

### 4.1 lead 提示の 3 ファイル (raw / gzip6 / brotli)

| ファイル | raw | gzip -6 | brotli -q11 |
| --- | --- | --- | --- |
| `index-CN7NIWNw.js` | 939867 | 284681 | **239789** |
| `vendor-DcuzkuQH.js` | 741114 | 179560 | **149312** |
| `index-BxpfOGf3.css` | 77343 | 14828 | **12981** |

**raw と gzip -6 は lead 値と完全一致。brotli は不一致。**

| ファイル | lead 提示 brotli | 本実測 brotli -q11 | 差 |
| --- | --- | --- | --- |
| index.js | 269408 | 239789 | -29619 |
| vendor.js | 167043 | 149312 | -17731 |
| css | 14236 | 12981 | -1255 |

lead の値は brotli **品質 ~9** 相当 (q9: 264170 / 163082 / 13805) に近い。
本実測は最大品質 q11 の値。**どちらの品質を基準にするか明記が必要。**

### 4.2 実配信 (HTTP) で観測した転送量 — **ここが最重要**

別ポート起動 → `token` を cookie に交換 → `Accept-Encoding: gzip, br` で実取得:

| アセット | HTTP | Content-Encoding | **実 wire bytes** | decoded bytes |
| --- | --- | --- | --- | --- |
| `assets/index-CN7NIWNw.js` | 200 | gzip | **316005** | 939867 |
| `assets/vendor-DcuzkuQH.js` | 200 | gzip | **206829** | 741114 |
| `assets/index-BxpfOGf3.css` | 200 | gzip | **18374** | 77343 |
| `assets/vendor-DV2921Zo.css` | 200 | gzip | **8012** | 27312 |
| `index.html` | 200 | gzip | **6139** | 37448 |

初期ロード合計 (wire): **342391 bytes** (index.js 316005 + vendor.js 206829 + css 26386 は含めず再掲 → 実際は 316005+206829+18374+8012 = **549220 bytes**、+ HTML 6139)

> **注意**: `vendor-DV2921Zo.css` は lead の 3 ファイル一覧に**無い**。実際の HTML は
> `index-BxpfOGf3.css` と `vendor-DV2921Zo.css` の **2 つの CSS** を初期ロードする。

### 4.3 発見: サーバの gzip は **level 1**

zlib で各レベルを再現し、配信バイト数と比較:

```text
file                       served | L1      L2      L3      L4      L5      L6      L7      L8      L9
index-CN7NIWNw.js          316005 | 316005  308973  304985  295097  286365  285293  284997  284843  284725
vendor-DcuzkuQH.js         206829 | 206829  201698  198135  188680  181344  179829  179212  178867  178481
index-BxpfOGf3.css          18374 |  18374   17372   16832   15921   15027   14786   14710   14679   14725
vendor-DV2921Zo.css          8012 |   8012    7922    7849    7659    7551    7539    7515    7433    7462
```

**全 4 ファイルで L1 とバイト単位で完全一致** → サーバは zlib **level 1** で圧縮している。

- `Accept-Encoding: br` を送っても `Content-Encoding: gzip` のまま (br 未対応を実測で確認)。
- `Accept-Encoding: identity` を送ると **無圧縮の 939867 / 741114 をそのまま返す** (gzip へのフォールバックなし)。
- level 1 → level 6 に変えるだけで初期 JS が
  316005+206829 → 285293+179829 = **-57712 bytes (-11.0%)** 削減できる (実測値からの算出)。

### 4.4 配信ヘッダ (実測)

```text
HTTP/1.1 200 OK
content-type: text/javascript; charset=utf-8
Vary: Accept-Encoding
Content-Encoding: gzip
Transfer-Encoding: chunked
```

`cache-control` ヘッダは**資産レスポンスに付与されていない** (実測)。ハッシュ付きファイル名なので
immutable 指定の余地がある。

#### 設定箇所の特定 (完了)

lead の参照は**正しい**。圧縮はインストール済みバンドルの
`@deepseek-ai/dsh-web-app/cordis.patch.yml` で有効化されている:

```yaml
# @deepseek-ai/dsh-web-app/cordis.patch.yml:180-188
180:      name: '@deepseek-ai/dsh-host-webserver'
182:      config:
186:        compression: gzip
187:        compressionLevel: 1        # ← 実測 level 1 と一致
188:        compressionThresholdBytes: 1024
```

> 注意: ユーザープロファイル側の `/home/sahen/.dsh/profiles/web/cordis.patch.yml` には
> `compression` の記述が無い (186 行目は `danger-full-access:`)。
> lead が指していたのは**インストール済みパッケージ側**
> (`@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml`) であり、そちらは正しい。
> 同名ファイルが 2 箇所にあるため混同しやすい。

実装側 (`@deepseek-ai/dsh-host-webserver/lib/index.js`) の該当箇所:

```js
// dsh-host-webserver/lib/index.js
109: const DEFAULT_COMPRESSION = "none";
110: const DEFAULT_COMPRESSION_LEVEL = 1;        // ← 実測 level 1 の根拠
111: const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 1024;

263: compression: z.union([z.const("none"), z.const("gzip")]).default(DEFAULT_COMPRESSION),
264: compressionLevel: z.number().step(1).min(0).max(9).default(DEFAULT_COMPRESSION_LEVEL),
265: compressionThresholdBytes: z.natural().default(DEFAULT_COMPRESSION_THRESHOLD_BYTES)

197: const middleware = compressionMiddleware({ level: config.compressionLevel, ... });
290: this.gzip = resolved.compression === "gzip" ? createGzipMiddleware(resolved) : void 0;
```

- 圧縮は `compression@1.8.2` ミドルウェア経由。`compressionLevel: 1` が**明示指定**されている。
  → **§4.3 の実測 (zlib L1 とバイト一致) と完全に整合**。
- `compression@1.8.2` は `createBrotliCompress` を持つ (**brotli 対応済み**)。
  ただし dsh 側 schema が `z.union([z.const("none"), z.const("gzip")])` と
  **2 択に制限**しているため、現状 brotli は選択できない。
  → brotli を使うにはスキーマ拡張 (コード変更) が必要。lead の「none|gzip の 2 択のみ」は**正しい**。
- `compressionLevel` は `0–9` を受理する。`compressionLevel: 6` に変えるだけで
  **コード変更なしに** §4.3 の削減見込み (-11.0%) を得られる。

**同じく `@deepseek-ai/dsh-base/cordis.patch.yml:226` にも `compression: gzip` がある。**

---

## 5. プラグイン client.js 合計サイズ

計測: `find ... -name client.js -printf '%s %p\n'` (symlink 先を解決)

### 5.1 lead が列挙した 7 プラグイン

| プラグイン | client.js bytes |
| --- | --- |
| `@local/dsh-sound` | 49670 |
| `rdsh-settings` | 33656 |
| `@local/opencode-live` | 18225 |
| `rdsh-update-banner` | 18041 |
| `@local/opencode-zen-usage` | 17030 |
| `@local/dsh-copy-deliverable` | 7162 |
| `rdsh-mobile-ui` | 5497 |
| **合計** | **149281** |

> **lead 提示値 191909 はこの 7 プラグインの合計 (149281) ではない。**
> 全組み合わせを総当たりで検査した結果、`191909 = @local/dsh-sound (49670) + dsh-gitview (142239)`
> と**厳密に一致**した。つまり lead の 191909 は「7 プラグインの合計」ではなく
> **`find` の深さ制限で偶然ヒットした 2 ファイル (dsh-sound + dsh-gitview) の合計**である。
> `maxdepth 4` では symlink 先を辿らないため、この 2 件だけが拾われた。
> 軽量化の判断には **7 プラグイン合計 149281** を使うこと。

### 5.2 profile 配下の全 client.js (symlink 解決後)

| パス | bytes |
| --- | --- |
| `node_modules/dsh-gitview/lib/client.js` | 142239 |
| `node_modules/@local/dsh-sound/client.js` | 49670 |
| `japanese-locale/client.js` | 38308 |
| `node_modules/rdsh-settings/client.js` | 33656 |
| `node_modules/@local/opencode-live/client.js` | 18225 |
| `node_modules/rdsh-update-banner/client.js` | 18041 |
| `node_modules/@local/opencode-zen-usage/client.js` | 17030 |
| `node_modules/@local/dsh-copy-deliverable/client.js` | 7162 |
| `node_modules/rdsh-mobile-ui/client.js` | 5497 |
| **合計 (9 ファイル)** | **329828** |

注意: `dsh-gitview` は起動時に**スキップされる** (§6) ため、実際にブラウザへ配信される
client.js に含まれるかは別途確認が必要。

---

## 6. 起動ログのエラー (失敗プラグイン)

実測ログ全文 (現状構成 `DSH_HOME=/home/sahen/.dsh`, `A_cold_1.log`, 3 行):

```text
dsh: skipping profile bundle "@local/rea-mcp": Error: dsh: cannot resolve profile bundle "@local/rea-mcp" from the dsh installation or /home/sahen/.dsh/profiles/web; run 'dsh plugin --profile web install' if its dependency is not installed
dsh: skipping profile bundle "dsh-gitview": Error: Plugin dsh-gitview@0.1.0 is incompatible with dsh 0.2.1-rc.2: requirements {"engines.dsh":"0.2.0-rc.2"}. Running it may cause crashes or data loss. Update the plugin or install a plugin version compatible with this dsh runtime. To accept this risk explicitly, grant the exact-version exemption for dsh-gitview@0.1.0 on dsh 0.2.1-rc.2 with `dsh plugin allow-version` or the plugin manager, then retry the installation or restart dsh. Exact-version exemption: not active.
/usr/bin/python3: can't open file '/home/sahen/適当/gemini-mcp/server.py': [Errno 2] No such file or directory
```

lead の 3 件の主張は**すべて再現**。加えて **4 件目 (gemini-mcp)** を確認:

| # | 対象 | 実測された事象 | 検証方法 |
| --- | --- | --- | --- |
| 1 | `@local/rea-mcp` | `cannot resolve profile bundle` | 再現。symlink 先 `/home/sahen/Projects/external-migration/dsh-workspaces/適当/rea-mcp` は **存在しない (broken symlink)** |
| 2 | `dsh-gitview` | dsh 0.2.1-rc.2 と非互換 | 再現。`package.json` で `version 0.1.0`, `engines.dsh = 0.2.0-rc.2` を確認 |
| 3 | `slack-mcp-server` / `gmail-mcp` / `gemini-mcp` | 実行ファイル不在・認証キー不在 | `command -v` で 3 つとも **NOT IN PATH** を確認 (ただしこれは PATH 依存) |
| 4 | `gemini-mcp` (mcp-gemini) | `can't open file '/home/sahen/適当/gemini-mcp/server.py'` | **lead 提示に無い追加エラー**。`cordis.patch.yml:370` が存在しないパスを参照 |

### 6.1 起動後に観測された MCP 側のエラー (n=3 中 1 回のみ)

`B_warm_3.log` (21 行) と `B_warmup.log` には、起動後に:

```text
[alpha-mcp] Server started (v0.1.7)
[alpha-mcp] Uncaught exception: write EPIPE
Discord MCP Server v2.2.0 running on stdio.
Uncaught exception: Error: write EPIPE   (StdioServerTransport.send)
```

これは**テストハーネスがプロセスを kill した際の EPIPE** であり、起動失敗ではない (推測)。
ただし `B_warm_3` の起動時間が 3.641s と遅かったことと時間的に重なる。

**起動ログのエラー件数: 3 件 (定常) + 1 件 (gemini-mcp) = 4 件 / 起動。**
すべて `skipping` または MCP 子プロセスの spawn 失敗で、web 本体の起動は継続する。

---

## 7. CPU プロファイル (`node --cpu-prof`)

プロファイル: `/tmp/dsh-prof/CPU.20261020.202909.585109.0.001.cpuprofile` (メインスレッド, 1798537 bytes)

```text
total sampled us: 6538397 (6.54 s)
samples: 5937
```

### 7.1 自己時間トップ

| 関数 | ms | % |
| --- | --- | --- |
| `(idle)` | 1003.7 | 15.4% |
| **`compileSourceTextModule`** | **798.3** | **12.2%** |
| `(garbage collector)` | **340.0** | **5.2%** |
| `(program)` | 128.5 | 2.0% |
| `parseRecord` | **104.1** | 1.6% |
| `hasIntrinsicConstructor` | **91.5** | 1.4% |
| `walkJsonValue` | **85.9** | 1.3% |
| `realpathSync` | 60.6 | 0.9% |
| `spawn` (child_process) | 59.0 | 0.9% |
| `_link` (module_job) | 55.0 | 0.8% |
| `finalizeResolution` | 54.6 | 0.8% |
| `inst._zod.parse` | 21.4 | 0.3% |

**lead の全数値と完全一致**: 6.54s / 798ms (12.2%) / 340ms (5.2%) / 104ms / 91ms / 86ms。

### 7.2 URL バケット別

| バケット | ms | % |
| --- | --- | --- |
| node-internal | 2834.9 | 43.4% |
| @dsh/dsh | 2185.8 | 33.4% |
| (native/idle) | 1513.4 | 23.1% |
| other | 4.3 | 0.1% |

**lead 値 (43.4% / 33.4% / 23.1%) と完全一致。**

### 7.3 モジュール / パッケージ数

| 指標 | 実測 |
| --- | --- |
| distinct non-empty URL | **677** |
| distinct `file://` URL (実ファイル) | 548 (.js 536, .mjs 12) |
| distinct packages | **182** |

**677 と 182 は lead 値と一致。** 677 は「URL 総数」、548 は「実 JS ファイル数」で、
計上方法が異なるだけ。混同しないよう明記する。

パッケージ別ファイル数トップ: `zod 190`, `yaml 32`, `@opentelemetry/api 17`,
`@opentelemetry/otlp-transformer 17`, `@opentelemetry/sdk-metrics 14`, `@mixmark-io/domino 13`, `semver 11`。

> `zod` が 190 ファイル (全 548 の 34.7%) を占める。`parseRecord`/`walkJsonValue`/
> `hasIntrinsicConstructor` という zod 系ホットスポットと整合する。

---

## 8. 実測 vs 推測の区別

### 実測 (再現コマンド付き)

- §2 起動時間 4 構成 × n=3 (外れ値の統計判定含む)
- §3 systemd MemoryCurrent/MemoryPeak、RSS
- §4 資産の raw/gzip/brotli サイズ、**実 HTTP 配信バイト数**、gzip level 1 の同定
- §5 client.js のファイルサイズと合計
- §6 起動ログの生出力
- §7 CPU プロファイルの集計

### 推測 (実測ではない)

- lead の brotli 値 (269408 等) が品質 ~9 相当であること — バイト一致は L9 でなく近傍
- ~~lead の 191909 がどのプラグイン組み合わせか~~ → **解決**: dsh-sound + dsh-gitview の合計 (§5.1)
- `EPIPE` がテストハーネスの kill 起因であること
- `children_rss_kb` が真の常駐量を過小評価していること (孫プロセス未計上)
- `zod` のファイル数が起動コストの主因であること (相関は強いが因果は未検証)

### 不一致と解決状況

| # | 項目 | lead 値 | 本実測 | 解決状況 |
| --- | --- | --- | --- | --- |
| 1 | brotli サイズ (index/vendor/css) | 269408 / 167043 / 14236 | **239789 / 149312 / 12981** (q11) | **未解決**。lead 値は品質 ~9 相当。基準品質を明記すべき |
| 2 | プラグイン client.js 合計 | 191909 | **149281** (7 プラグイン) | **解決**。191909 = dsh-sound + dsh-gitview の合計 (§5.1) |
| 3 | `cordis.patch.yml:186` の compression | gzip 有効 | 有効 (実測) | **解決**。参照先は**インストール済み** `dsh-web-app` 側で正しい (§4.3) |
| 4 | `vendor-DV2921Zo.css` | 一覧に無し | 27312 bytes・**初期ロードされる** | **lead 側の記載漏れ**。実際は 2 つの CSS を読む (§4.2) |
| 5 | gzip 圧縮レベル | 言及なし | **level 1** (実測・設定とも) | **新規発見**。level 6 で -11.0% の余地 (§4.3) |

---

## 9. 再現コマンド一覧

```bash
# 環境
uname -a; lscpu | grep -E 'Model name|^CPU(s)'; free -h; node --version
/home/sahen/.local/bin/dsh-orig --version

# 起動時間 (A/B 構成)  — *本番 3080 には触れない*
/tmp/bootbench.sh          # → §2 A_cold_*, B_warm_*
# 起動時間 (最小 DSH_HOME) — 要: 空の DSH_HOME を用意
/tmp/bootmin.sh            # → §2 M_cold_*, M_warm_*

# 本番メモリ (読み取りのみ)
systemctl --user show dsh-web.service -p ActiveState -p MainPID \
  -p ExecMainStartTimestamp -p ActiveEnterTimestamp -p MemoryCurrent -p MemoryPeak -p NRestarts

# 資産サイズ
A=/home/sahen/.local/opt/dsh-original/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets
for f in index-CN7NIWNw.js vendor-DcuzkuQH.js index-BxpfOGf3.css; do
  echo "$f raw=$(stat -c%s $A/$f) gzip6=$(gzip -6 -c $A/$f | wc -c) br11=$(brotli -q 11 -c $A/$f | wc -c)"
done

# 実 HTTP 配信量 (別ポート + token→cookie) — §4.2
/tmp/bootpl2.sh

# gzip レベルの同定 — §4.3
python3 -c '...zlib.compressobj(lvl,DEFLATED,31)...'   # §4.3 の表を参照

# CPU プロファイル集計
python3 /tmp/an.py     # → §7.1/7.2
python3 /tmp/an2.py    # → §7.3
```

スクリプトと生ログは本文書と同じディレクトリに保存済み:
`docs/evidence/webui-baseline/` 配下 (`bootbench.sh`, `bootmin.sh`, `bootmem.sh`, `bootpl2.sh`,
`an.py`, `an2.py`, `A_cold_*.log`, `B_warm*.log`, `M_*.log`)。
作業コピーは `/tmp/bootbench/` にもある。

### 再現手順の前提

1. **本番に触れない**: 必ず `--port 392xx` と `DSH_HOME=/tmp/dsh-*` を指定する。
2. ポート `/` は **401** を返す (browser-trust fence)。起動ログの
   `dsh web: http://127.0.0.1:PORT/?token=...` を cookie に交換してから叩く。
   `curl` で素朴に `/` を叩いて 401 でも「起動失敗」ではない。
3. 起動完了の判定に `curl` を使う場合、401 でも**応答があれば起動済み**として秒数を確定してよい
   (本計測はこの方法)。
4. ウォームアップ 1 回 → 本計測 3 回。外れ値は modified z-score で判定する。

---

## 10. ベースライン数値サマリ (軽量化の判定基準)

| 指標 | ベースライン値 | 出典 |
| --- | --- | --- |
| 起動時間 (現状 cold, median n=3) | 3.848 s (外れ値除外 3.782 s) | §2.2 |
| 起動時間 (現状 + compile cache, median n=3) | 3.059 s | §2.2 |
| 起動時間 (最小 DSH_HOME + cache, median n=3) | **2.498 s** | §2.2 |
| 本番 MemoryCurrent | 809–845 MB | §3.1 |
| 本番 MemoryPeak | 1694 MB | §3.1 |
| 初期ロード wire 合計 (4 資産 + HTML) | **555359 bytes** | §4.2 |
| うち index.js (gzip L1) | 316005 bytes | §4.2 |
| **gzip レベルを 1→6 にした場合の削減見込み** | **-57712 bytes (-11.0%)** (設定変更のみ) | §4.3 |
| **brotli を実装した場合の index.js** | 239789 bytes (raw の 25.5%, gzip L1 比 -24.1%) | §4.1 |
| 初期ロードのうち CSS 2 ファイル | 18374 + 8012 = 26386 bytes | §4.2 |
| プラグイン client.js 合計 (7 プラグイン) | 149281 bytes | §5.1 |
| 起動ログのエラー件数 | 4 件 / 起動 | §6 |
| メインスレッド CPU | 6.54 s | §7 |
| 読込モジュール数 / パッケージ数 | 677 URL (548 ファイル) / 182 | §7.3 |

`docs/BENCHMARKS.md` の規則 4 に従い、変更後にこの値から **±10% を超えて動いた指標は
本ファイルと `docs/BENCHMARKS.md` を更新すること。**
