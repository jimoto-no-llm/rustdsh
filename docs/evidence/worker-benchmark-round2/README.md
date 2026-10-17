# worker-git 比較ベンチマーク（round 2）

Issue #586 の JS oracle と native `worker-git` の比較は、
`scripts/bench-worker-git.mjs` の NDJSON 出力をそのまま証跡にします。
親セッションが macOS arm64 / Node 24.22.0 の release binary で4操作の出力一致を
確認しました。Windows の結果と性能閾値は未受入です。

## 再現方法

対象の `rdsh` を別の出力先で release build し、絶対パスを渡します。

```sh
npm ci --prefix dashboard --ignore-scripts --no-audit --no-fund
RDSH_BENCH_BIN=/absolute/path/to/rdsh node scripts/bench-worker-git.mjs \
  > /absolute/path/to/worker-git-round2.ndjson
```

先頭行には、capability確認に使った native binary の絶対 `sourcePath`、専用copyの
絶対 `executionPath` と SHA-256、プラットフォーム、fixture 件数、warmup 回数、
交互実行回数を記録します。native request は `executionPath` のcopyだけへ送るため、
計測中にsource binaryが置換されても1つの出力に異なるbinaryの標本は混ざりません。
後続の4行は
`repository`、`sourceSnapshot`、`dirtyPaths`、`observeWorktree` の各操作です。
各行に JS と Rust の未丸め7標本、表示用の中央値、比率、出力一致結果を残します。

計時は1件の operation request の直前から応答受領までです。binary discovery、
`worker-git --help` の capability preflight、fixture 作成、出力同値確認、warmup は
計時から除外します。JS は公開wrapperを通さずlegacy実装へ直接dispatchし、nativeと
同じくdiscovery/preflightを標本に含めません。JS/Rust は同じ fixture で1回 warmup後に
7組を交互順序で実行し、各応答を JS oracle と比較します。

Windows は未測定です。OS・Node・binary SHA-256 が異なる結果を混在比較せず、
Windows の実測 NDJSON を取得してから同一環境内の比率だけを評価します。現時点で
性能の合格閾値は採用しません。

## 親セッションのrelease測定

[未丸め7標本と集計](macos-arm64-release.json)を保存しました。公開用ファイルではローカルの
source/execution pathだけを置換し、そのことを`paths_redacted`で明示しています。
source SHAは`0d7b5d4241166bc39c881c8ea0f4aeefbbddbbda`、binary SHA-256は
`b20f7eb0f745e985f2011748d45145c33a4713d9d236c9663f91dc44ce688f54`です。

| 操作 | JS中央値 ms | Rust中央値 ms | Rust/JS |
| --- | ---: | ---: | ---: |
| repository | 33.96 | 33.18 | 0.98 |
| sourceSnapshot | 44.70 | 34.38 | 0.77 |
| dirtyPaths | 12.33 | 21.02 | 1.71 |
| observeWorktree | 101.66 | 75.73 | 0.74 |

全4操作の応答は一致しましたが、dirtyPathsはこのMacの小fixtureでもRustが遅い結果です。
並行する他の作業もある1回の7組計測なので、安定した性能保証やWindowsの選択条件には使いません。
今回の変更は測定の誤判定と再現情報を直すもので、速度改善やIssue #586全体の完了ではありません。

親の回帰コマンドは`node --test dashboard/test/worker-git-benchmark.test.mjs dashboard/test/worker-sandbox.test.mjs dashboard/test/worker-scopes-compat.test.mjs dashboard/test/workers.test.mjs`で、32件中30成功・環境skip2件・失敗0です。
