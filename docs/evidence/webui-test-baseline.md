# WebUI lighter 変更 — リグレッションテストのベースライン (未変更 HEAD)

- 実施日: 2026-10-20 (Asia/Tokyo)
- 対象 worktree: `/var/tmp/wt-uiperf`
- ブランチ: `test/webui-lighter`
- HEAD: `2b8a1f7c` feat(pr): add the PR policy workflow and the reviewer CLI
- 作業ツリー: 未変更 (`git status --porcelain` の出力は他担当の `?? docs/evidence/webui-plugin-inventory.md` のみ)
- ツール: cargo/rustc 1.99.0 (Fedora 1.99.0-1.fc44) / node v22.23.1 / npm 10.9.8 / python3 3.14.8 / rtk 1.0.1
- 方針: **本番サービス `dsh-web.service` (127.0.0.1:3080) は停止・再起動せず、`~/.dsh` の実設定も書き換えていない。** ログは全て `cargo run`/`target` 配下と `/tmp` のみ。

## 1. 検証マトリクスの出典

`CONTRIBUTING.md` の "Full test matrix before a PR" を正式な検証コマンドとして採用した。

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --release
cargo test --release --example benchmark_extended
cargo test --release --example benchmark_models
node --test tests/model_benchmark/fence.test.mjs
sh tests/regress.sh
(cd dashboard && npm ci && npm test)   # if you touched dashboard/
RDSH_E2E_BIN=./target/release/rdsh npm test --prefix tests/e2e   # if UI or HTTP behavior changed
```

`docs/RELEASING.md` の "Prepare and verify" 追加分:

```sh
python3 scripts/prepare-release.py vX.Y.Z
python3 -m unittest discover -s tests -p 'test_release_*.py'
tests/install-isolated.sh --source local --require-musl   # podman/docker がある場合
```

`.github/workflows/ci.yml` のジョブ定義 (fmt+clippy / test / plugin-security / security-boundaries) も
突き合わせ、CI と同一の node テスト集合を実行した。

## 2. 結果サマリ

| # | コマンド | 結果 | 備考 |
| --- | --- | --- | --- |
| 1 | `cargo build` | **PASS** | 10.82s、exit 0 |
| 2 | `cargo test` | **PASS** | 全スイート exit 0 |
| 3 | `plugins/rdsh-compute` `npm test` | **PASS** | 18 pass / 0 fail |
| 4 | `plugins/workflow-board` `npm test` | **PASS (環境修正後)** | 素の実行は 13 fail。原因は環境、`RDSH_BIN` 指定で 14 pass / 0 fail / 1 skip |
| 5 | `cargo fmt --check` | **PASS** | exit 0 |
| 6 | `cargo clippy --all-targets -- -D warnings` | **PASS** | warning 0、exit 0 |
| 7 | `sh tests/regress.sh` | **FAIL (1件)** | 55 ok / 1 fail。失敗は既存の `rustup-init` フィクスチャ |
| 8 | `cargo test --example benchmark_extended` | **PASS** | 2 pass |
| 9 | `cargo test --example benchmark_models` | **PASS** | 5 pass |
| 10 | CI の node スイート (plugin-security 系 8 ファイル) | **PASS (環境修正後)** | 78 pass / 1 skip / 0 fail |
| 11 | CI の node スイート (security-boundaries 系 3 ファイル) | **PASS** | 25 pass / 0 fail |
| 12 | `node --test tests/runtime-compatibility.test.mjs tests/icon-assets.test.mjs` | **PASS** | 5 pass / 0 fail |
| 13 | `node --test tests/model_benchmark/fence.test.mjs` | **PASS** | 2 pass / 0 fail |
| 14 | `tests/upstream-approval-integrity.test.mjs` | **PASS (前提導入後)** | 3 pass。CI が入れる pinned パッケージが必要 |
| 15 | `python3 -m unittest discover -s tests -p 'test_release_*.py'` | **PASS** | Ran 39 tests, OK |
| 16 | `cargo build --release` | **PASS** | 47.72s、exit 0 |
| 17 | `npm test --prefix tests/e2e` (E2E) | **SKIP** | 依存未導入 + Playwright/実サーバ起動で重いため (下記 5 節) |
| 18 | `tests/install-isolated.sh` | **SKIP** | podman/docker が必要 |

**未変更 HEAD に対するコード起因の回帰は 1 件も検出されなかった。**
確認された 3 件の失敗はすべて「この実行環境固有」で、うち 1 件 (rustup-init) は
pristine な `main` でも同一に再現する既存不具合である (4 節)。

## 3. 失敗の生ログ (要約せず原文)

### 3.1 `plugins/workflow-board` `npm test` — 素の実行 (13 fail)

```
> node --test tests/source-patch.test.mjs

✖ checks without writing; applies to a checkout with spaces; repeats with nested new files (151.569871ms)
﹣ Windows drive-letter casing still identifies the same source root (0.151535ms) # SKIP
✖ rejects modified source, untracked files, wrong roots and unsupported revisions (108.425303ms)
✖ rejects changed patch bytes, header and unexpected paths before writing (120.489329ms)
✖ rejects unsafe or unpinned manifest paths (122.595865ms)
✖ a conflicting multi-file patch applies no partial changes (94.499262ms)
✖ user whitespace preferences cannot reject the pinned patch (96.418256ms)
✖ already-applied refuses unrelated tracked or untracked changes (94.855663ms)
✖ reverse-applicable target edits still fail exact blob verification (95.147964ms)
✖ a different staged target cannot hide behind matching working files (96.519356ms)
✖ CRLF text checkout bytes match the pinned Git text blobs (104.894195ms)
✖ Git ownership protection is retained (104.709477ms)
✖ preparation never invokes repository fsmonitor commands (110.943274ms)
✔ bundled checksum, patch header, numstat and blob coverage agree (41.534095ms)
✖ CLI executes through a linked bundle and diagnoses non-Git package directories (211.891901ms)
ℹ tests 15
ℹ suites 0
ℹ pass 1
ℹ fail 13
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 1623.509661

✖ failing tests:

test at tests/source-patch.test.mjs:50:1
✖ checks without writing; applies to a checkout with spaces; repeats with nested new files (151.569871ms)
  Error: Build a current rdsh binary and inspect the source before retrying.
      at prepare (file:///var/tmp/wt-uiperf/plugins/workflow-board/source-patch.mjs:33:11)
      at TestContext.<anonymous> (file:///var/tmp/wt-uiperf/plugins/workflow-board/tests/source-patch.test.mjs:52:16)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.start (node:internal/test_runner/test:1262:14)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:14) {
    code: 'RDSH_FAILED'
  }

test at tests/source-patch.test.mjs:69:1
✖ rejects modified source, untracked files, wrong roots and unsupported revisions (108.425303ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
    Comparison {
  +   code: 'RDSH_FAILED'
  -   code: 'SOURCE_DIRTY'
    }
  
      at TestContext.<anonymous> (file:///var/tmp/wt-uiperf/plugins/workflow-board/tests/source-patch.test.mjs:72:10)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
      at Test.postRun (node:internal/test_runner/test:1542:19)
      at Test.run (node:internal/test_runner/test:1467:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: Error: Build a current rdsh binary and inspect the source before retrying.
        at prepare (file:///var/tmp/wt-uiperf/plugins/workflow-board/source-patch.mjs:33:11)
        at assert.throws.code (file:///var/tmp/wt-uiperf/plugins/workflow-board/tests/source-patch.test.mjs:72:23)
        at getActual (node:assert:611:5)
        at strict.throws (node:assert:759:24)
        at TestContext.<anonymous> (file:///var/tmp/wt-uiperf/plugins/workflow-board/tests/source-patch.test.mjs:72:10)
        at Test.runInAsyncScope (node:async_hooks:227:14)
        at Test.run (node:internal/test_runner/test:1402:25)
        at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
  }
```

残りの失敗も同一の `RDSH_FAILED` 起因で、期待コードとの差分は次のとおり。

```
+   code: 'RDSH_FAILED'
-   code: 'PATCH_INTEGRITY'

+   code: 'RDSH_FAILED'
-   code: 'MANIFEST_INVALID'

+   code: 'RDSH_FAILED'
-   code: 'PATCH_CONFLICT'

+   code: 'RDSH_FAILED'
-   code: 'SOURCE_UNSAFE'
```

### 3.2 CI の node スイート (plugin-security 系) — `RDSH_BIN` 未対策時

```
test at tests/plugin-security.test.mjs:102:11
✖ authenticated reads, saves and updater remain usable (4.138873ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  
  '' !== '0.0.0-test'
  
      at TestContext.<anonymous> (file:///var/tmp/wt-uiperf/tests/plugin-security.test.mjs:108:12)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async TestContext.<anonymous> (file:///var/tmp/wt-uiperf/tests/plugin-security.test.mjs:102:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: '',
    expected: '0.0.0-test',
    operator: 'deepStrictEqual',
    diff: 'simple'
  }
```

### 3.3 `tests/upstream-approval-integrity.test.mjs` — 前提パッケージ未導入時

```
node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: DSH_TOOL_BASH_SOURCE must point to the pinned DSH tool-bash implementation
    at file:///var/tmp/wt-uiperf/tests/upstream-approval-integrity.test.mjs:12:8
    at ModuleJob.run (node:internal/modules/async_hooks:262:14)
    at async ModuleLoader.import (node:internal/modules/esm/loader:560:24)
    at async loadESM (node:internal/process/esm_loader:97:7)
    at async handleMainPromise (node:internal/modules/run_main:65:12) {
  generatedError: false,
  code: 'ERR_ASSERTION',
  actual: undefined,
  expected: true,
  operator: '==',
  diff: 'simple'
}

Node.js v24.21.0
```

### 3.4 `sh tests/regress.sh` — 既存の rustup-init フィクスチャ失敗

55 件が `ok:`、以下 1 件が失敗 (末尾の生ログ):

```
rdsh installer: Linux/x86_64
error: could not find `Cargo.toml` in `/var/tmp/tmp.dPbkhYxHaY/valid/project` or any parent directory
pinned rustup-init fixture did not install
FAIL(output): rustup-init pinned checksum
```

## 4. 失敗 3 件の切り分け (いずれも環境起因 / 既存)

### (a) workflow-board 13 fail → `RDSH_BIN` が指す古い rdsh が使われた

`plugins/workflow-board/source-patch.mjs:12-20` の `nativeBin()` は
`process.env.RDSH_BIN` を最優先で返す。この実行環境では:

```
RDSH_BIN=/home/sahen/.local/bin/rdsh
/home/sahen/.local/bin/rdsh --version  →  rdsh 0.9.2
/usr/bin/rdsh --version                →  rdsh 0.9.2
./target/debug/rdsh --version          →  rdsh 0.3.3   (この worktree のビルド)
```

つまり worktree の 0.3.3 ではなく、PATH 上の古い 0.9.2 が呼ばれていた。
古いバイナリは新しい `workflow-board` のエラーコード体系を持たないため
JSON 以外を stderr に返し、`source-patch.mjs:32` の `JSON.parse` が失敗して
汎用フォールバック `RDSH_FAILED` になっていた。

切り分けの証拠:

```sh
# 実際に返っていた生の stderr (自前フィクスチャ + バンドル manifest)
{"error":"UNSUPPORTED_BASE","message":"Inspect the selected source checkout before retrying."}

# worktree のバイナリを明示指定すると全通過
RDSH_BIN=/var/tmp/wt-uiperf/target/debug/rdsh npm test
```

修正後の結果:

```
✔ checks without writing; applies to a checkout with spaces; repeats with nested new files (102.605904ms)
﹣ Windows drive-letter casing still identifies the same source root (0.126228ms) # SKIP
✔ rejects modified source, untracked files, wrong roots and unsupported revisions (78.770966ms)
✔ rejects changed patch bytes, header and unexpected paths before writing (57.185693ms)
✔ rejects unsafe or unpinned manifest paths (53.493531ms)
✔ a conflicting multi-file patch applies no partial changes (43.522107ms)
✔ user whitespace preferences cannot reject the pinned patch (55.26141ms)
✔ already-applied refuses unrelated tracked or untracked changes (72.068115ms)
✔ reverse-applicable target edits still fail exact blob verification (54.338202ms)
✔ a different staged target cannot hide behind matching working files (59.269617ms)
✔ CRLF text checkout bytes match the pinned Git text blobs (52.894815ms)
✔ Git ownership protection is retained (35.070323ms)
✔ preparation never invokes repository fsmonitor commands (40.624601ms)
✔ bundled checksum, patch header, numstat and blob coverage agree (31.075882ms)
✔ CLI executes through a linked bundle and diagnoses non-Git package directories (103.005928ms)
ℹ tests 15
ℹ pass 14
ℹ fail 0
ℹ skipped 1
```

### (b) plugin-security の `versions.rdsh` 不一致 → `RDSH_BIN` がテストのスタブを回避

`tests/plugin-security.test.mjs:14-21` は `childProcess.execFile` を差し替え、
**`args[0] === 'rdsh'` (ベア名) のときだけ** `rdsh 0.0.0-test` を返す。
一方 `plugins/rdsh-settings/index.js:27-28` の `resolveRdshBin()` は
`env.RDSH_BIN` が非空なら**絶対パスをそのまま返す**。
`RDSH_BIN=/home/sahen/.local/bin/rdsh` のため `args[0]` が絶対パスになり
スタブに一致せず、実バイナリの `0.9.2` (または失敗時の空文字) が読まれていた。

`RDSH_BIN` を外すと通過する (テスト自体は変更していない):

```sh
env -u RDSH_BIN node --test tests/plugin-security.test.mjs
```

```
ℹ tests 18
ℹ pass 18
ℹ fail 0
```

CI 相当の 8 ファイル構成でも:

```
ℹ tests 79
ℹ pass 78
ℹ fail 0
ℹ skipped 1
```

### (c) `rustup-init pinned checksum` → pristine `main` でも同一に失敗する既存不具合

`tests/rustup-init-pin.sh:96-110` は空の `$work/project` で `install.sh` を実行するが、
`Cargo.toml` を作らない。一方 `install.sh:463` は `--from-release` 無しの経路で
**カレントディレクトリ**に対し `cargo build --release` を実行する。
フィクスチャの `cargo` スタブは成功時に `target/release/rdsh` を作るだけで、
Cargo プロジェクトは用意しないためビルドが失敗する。

この failure が本ブランチ固有でないことの証明として、**未変更の `main` を
detached で一時 worktree に展開し、同じテストを実行**した (実行後に worktree は削除済み):

```
=== main HEAD: c44a2a7e ===
rdsh installer: Linux/x86_64
error: could not find `Cargo.toml` in `/var/tmp/tmp.Sm1wKf69CO/valid/project` or any parent directory
pinned rustup-init fixture did not install
MAIN_FIXTURE_EXIT=1
```

さらに `install.sh` の該当箇所は main と本ブランチで同一である:

```sh
# main:install.sh:301-313 と 本ブランチ install.sh:451-463 は同じロジック
BIN_SRC="target/release/rdsh"
if [ "$FROM_RELEASE" = 1 ]; then
  BIN_SRC="$(install_release_binary)"
else
  ...
  cargo build --release
fi
# git diff main -- install.sh | grep -A8 "cargo build"  →  出力なし (差分なし)
```

したがって本件は **main に既存の、この環境で再現するフィクスチャ不備**であり、
本ブランチの回帰ではない。

## 5. スキップした項目と理由

| 項目 | 理由 |
| --- | --- |
| `npm test --prefix tests/e2e` (Playwright ブラウザ E2E) | `tests/e2e/node_modules` と `dashboard/node_modules` が未導入。実行には `npm ci` + `npx playwright install chromium` + 実サーバ起動が必要で、タスク指示どおり「重いので skip 可」。`target/release/rdsh` 自体はビルド済み |
| `(cd dashboard && npm ci && npm test)` | `dashboard/node_modules` 未導入。dashboard を触っていないため |
| `tests/install-isolated.sh --source local` | podman/docker が必要 (RELEASING.md に明記) |
| `python3 scripts/prepare-release.py vX.Y.Z` | リリース準備用。今回はバージョン変更を伴わないため対象外 |
| `cargo test --release` (release プロファイル) | 指示により省略可。`cargo test` (debug) と `cargo build --release` は実施済み |

## 6. 再現コマンド (この環境で環境変数を補正した版)

```sh
cd /var/tmp/wt-uiperf
export PATH=/home/sahen/.local/bin:$PATH

cargo build
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo build --release

# RDSH_BIN が古い rdsh を指すため、リポジトリのバイナリを明示する
RDSH_BIN=$PWD/target/debug/rdsh npm test --prefix plugins/workflow-board
npm test --prefix plugins/rdsh-compute

# plugin-security は execFile スタブがベア名 'rdsh' を前提にするため RDSH_BIN を外す
env -u RDSH_BIN node --test tests/plugin-security.test.mjs \
  tests/settings-client.test.mjs tests/update-banner.test.mjs \
  tests/rdsh-mobile-ui.test.mjs tests/feature-switches.test.mjs \
  tests/discord-presence.test.mjs tests/model_benchmark/fence.test.mjs \
  tests/context_inject_contract.mjs
env -u RDSH_BIN node --test tests/security-boundaries.test.mjs \
  tests/tool-isolation.test.mjs tests/desktop.test.mjs
env -u RDSH_BIN node --test tests/runtime-compatibility.test.mjs tests/icon-assets.test.mjs

python3 -m unittest discover -s tests -p 'test_release_*.py'
sh tests/regress.sh   # 55 ok / 1 fail (rustup-init は既存)
```

## 7. 注意点

- 本レポートは**未変更 HEAD のベースライン**であり、変更を加えていない。
- 環境変数 `RDSH_BIN=/home/sahen/.local/bin/rdsh` が設定されていると、
  workflow-board と plugin-security のテストが誤って失敗する。CI では未設定のため
  この 2 件は CI でも通過する見込みだが、**この作業環境で再実行する際は上記 6 節の
  補正が必要**。
- `tests/regress.sh` の rustup-init 失敗は main 既存のため、本ブランチの
  判定材料から除外してよい。
- `dsh-web.service` (127.0.0.1:3080) と `~/.dsh` の実設定には一切触れていない。
- 他担当が作成中の `docs/evidence/webui-plugin-inventory.md` (未追跡) は変更していない。
