# Web シェル資産を Rust で事前圧縮する — 計測結果

計測日: 2026-10-20 (JST) / branch `test/webui-lighter`
実装契約: [webui-asset-cache.md](../webui-asset-cache.md)
再現: `ROUNDS=6 bash scripts/webui-docker-bench3.sh`

## 0. 結論

シェル資産の圧縮を **Rust に移し、起動時に一度だけ**行うようにした。
配信時に Node は圧縮しない。3 つの指標がすべて改善した。

| 指標 | 現行 | Rust 版 | 改善 |
| ---- | ---- | ------- | ---- |
| 初回ロード転送量（4資産） | 556,554 B | **408,561 B** | **−147,993 B (−26.6%)** |
| 4資産の取得時間（localhost） | 42.5 ms | **24.5 ms** | **−18.0 ms (−42.4%)** |
| 起動時間（温間, median n=6） | 2,290 ms | **1,814 ms** | **−476 ms (−20.8%)** |
| 応答ヘッダ | なし | `immutable` + ETag | 再訪問が実質ゼロ |

ただし起動時間の大半は既存の `NODE_COMPILE_CACHE` によるもので、
資産キャッシュ単独の寄与は小さい（§3）。正確には次の内訳である。

```text
現行                      2,290 ms
+ NODE_COMPILE_CACHE      1,869 ms  (-421 ms, -18.4%)
+ Rust 資産キャッシュ      1,814 ms  ( -56 ms,  -3.0%)
```

## 1. 何を Rust に移したか

`src/webui_assets.rs`（新規 749 行）が起動時に一度だけ以下を行う。

1. `<dsh-web-frontend>/dist/assets` を再帰走査（86 ファイル / 5.3 MB、サブディレクトリ含む）
2. 内容とサイズと mtime から fingerprint を計算
3. 未構築なら **brotli q11 と gzip 6 を並列で**全ファイルに適用し、`manifest.json` と
   ともにディスクへ書く（一時ファイル→rename、manifest が commit point）
4. 構築済みなら即 return（実測 0.2 ms）
5. 得たディレクトリを `RDSH_WEB_ASSETS` として DSH に渡す

DSH 側のプラグイン（`plugins/rdsh-web-cache`）が `/assets` の prefix ルートを
持ち、**圧縮済みファイルをそのまま返す**。Node は圧縮を一切しない。

## 2. 圧縮の実測（4資産, raw 1,785,636 B）

| 方式 | サイズ | 圧縮時間 |
| ---- | ------ | -------- |
| gzip L1（現行の実効値） | 632,582 | 7.7 ms |
| gzip L6 | 486,474 | 40.7 ms |
| brotli q9 | 448,100 | 136 ms |
| **brotli q11** | **408,561** | 1.74 s（直列） |

q11 は q9 より 9% 小さい。1.74 s は**初回起動時に一度だけ**で、以降はディスクから
読むだけ（温間 0.2 ms）。この「一度払って資産として再利用する」構造が Rust に
移した理由そのものである。

86 ファイル全体では raw 5,349,338 B → **brotli 707,719 B（13.2%）**、
gzip 880,354 B（16.5%）。brotli は gzip の 80.4%。

## 3. 起動時間の内訳

計測は 3 変種を順序を回転させて 6 ラウンド（順序バイアスを消すため）。

| 変種 | 内容 | median | 生データ |
| ---- | ---- | ------ | -------- |
| plain | 現行（rdsh を経由しない） | 2,290 ms | 2199 2243 2245 2335 2384 2390 |
| plaincc | plain + `NODE_COMPILE_CACHE` | 1,869 ms | 1849 1851 1860 1878 1946 1953 |
| rust | rdsh 経由（compile cache + 資産キャッシュ） | 1,814 ms | 1702 1719 1775 1852 1885 1928 |

**起動時間の主因は ESM のコンパイルで、`NODE_COMPILE_CACHE` がそれを消す。**
これは rdsh が既に実装済みだったが、このマシンの `dsh-web-local` は
`dsh-orig` を直接 exec しており **rdsh を迂回しているため効いていなかった**。

資産キャッシュ単独の寄与は −56 ms（−3.0%）である。起動時は圧縮をしないので、
これは主に「配信時に Node が gzip しない」ことによる間接効果と、
取得シーケンスの短縮によるものと考えられる（この分解は 1 標本あたりの
ばらつきが大きく、−56 ms は有意とは言い切れない）。

## 4. 取得時間（localhost, 10 回交互）

4 資産をまとめて取得する時間。

```text
現行  : 48 42 45 43 45 39 38 40 38 77   median 42.5 ms
Rust版: 124 26 32 25 23 23 22 25 25 24  median 24.5 ms
```

Rust 版の初回 124 ms は JIT とページキャッシュの立ち上がりで、定常では 22–32 ms。
**配信時の圧縮がゼロになったぶん、そのまま速くなっている。**
なお前回の gzip level 6 は同じ条件で +15.0 ms（悪化）だったので、
Rust 版はその回帰も解消している。

## 5. ヘッダと再訪問

```text
現行  : （cache-control なし、ETag なし）→ 再訪問で全量再転送
Rust版: cache-control: public, max-age=31536000, immutable
        etag: "…"
        vary: accept-encoding
```

`If-None-Match` 一致で 304 を返す経路も実装・テスト済み。
ブラウザは immutable により再検証すら行わない。

## 6. 壊さないための設計

| 危険 | 対策 | 検証 |
| ---- | ---- | ---- |
| 圧縮に失敗して起動不能 | 全失敗経路が `None` を返し `RDSH_WEB_ASSETS` を渡さない | 単体テスト（存在しない dist / 空 dist / 書込不可） |
| manifest が壊れて UI が真っ白 | 不正・欠落ならルートを登録しない（従来動作に戻る） | 単体テスト |
| 資産の取りこぼし | manifest に無くても実ファイルがあれば identity で配信 | 統合テスト |
| パストラバーサル | `..`・絶対パス・NUL・壊れた percent-encoding を 404 | 統合テスト |
| ヘッダの二重付与 | ルートが付けた `cache-control` はタップが見ない | 統合テスト |
| 設定の置換事故 | 資産キャッシュは `--patch` を使わない（env のみ） | — |

`/assets` 以外の経路（`index.html` のフォールバック、SSE、WebSocket）は
一切触っていない。ルートは prefix `/assets` に限定される。

## 7. 有効化と無効化

```text
features.web_assets = false        # rdsh.json（既定 true）
RDSH_WEB_ASSETS=                   # 明示的に空にすると無効
RDSH_WEB_ASSETS_DIST=<dir>         # dist の場所を明示（自動探索の上書き）
```

**注意**: 現行の `dsh-web-local` は `dsh-orig` を直接 exec しており rdsh を迂回する。
これらの改善を受けるには rdsh 経由で起動する必要がある。

## 8. 検証結果

| 検証 | 結果 |
| ---- | ---- |
| `cargo fmt --check` | PASS |
| `cargo clippy --all-targets -- -D warnings` | PASS |
| `cargo test --bin rdsh` | **285 passed / 0 failed** |
| うち webui_assets | 11 件 |
| うち passthrough（統合） | 6 件（新規 2 件） |
| プラグイン `node --test` | **30 passed / 0 failed** |
| うち配信ルート | 22 件 |

## 9. 限界

- 4 資産のみを測っている。`index.html` は認証必須、プラグイン combo も含まない。
- 起動時間の内訳（compile cache と資産キャッシュの分解）は 1 変種 6 標本で、
  −56 ms の項は有意とは言い切れない。
- ブラウザ実機での FCP/LCP・再訪問削減量は未計測。ヘッダ付与と 304 までを実測。
- 帯域制限（tc）は行っていないため、実ネットワークでの体感は未計測。
  brotli は gzip より 19.6% 小さいので、回線が細いほど有利になる方向。
- 冷間初回は 1.2–1.4 s の圧縮コストを払う（DSH 更新時に一度だけ）。
