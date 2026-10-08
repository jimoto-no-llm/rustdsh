# Contributing (寄稿ガイド)

English summary first, 日本語の詳細は後に続きます.

## Quick start

```sh
git clone https://github.com/sahenjp/rustdsh.git
cd rustdsh
cargo build
cargo test
```

Full test matrix before a PR:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --release
cargo test --release --example benchmark_extended
cargo test --release --example benchmark_models
node --test tests/model_benchmark/fence.test.mjs
sh tests/regress.sh
(cd dashboard && npm ci && npm test)   # if you touched dashboard/
# If UI or HTTP behavior changed, follow tests/e2e/README.md and run:
RDSH_E2E_BIN=./target/release/rdsh npm test --prefix tests/e2e
```

## Pull Request

- PR body is 4 lines: overview / changes / verification / caveats.
- All green before opening: fmt, clippy (zero warnings), tests, regress.
- Behavior changes need a before/after output diff attached.
- Keep PRs small and single-topic; hot-path changes need benchmark numbers
  (see `docs/BENCHMARKS.md`).

## UI changes (required)

- Attach real before/after PNG screenshots. Text-only descriptions are not enough.
- Animated flows: add a short GIF plus PNGs for steps a GIF cannot show.
- Screenshots must be real captures, never mockups.
- Add measured numbers for anything performance-related.

## Architecture rules

- Never reimplement the agent loop or profile boot (see `docs/ARCHITECTURE.md`).
- Delegation stays byte-identical; `--passthrough` is the reference behavior.
- `doctor` must stay truthful about wrappers, shadowing, and auth state.

## Issues

Use the issue forms (bug / feature / performance / docs). Include:
`rdsh --version`, `rdsh doctor`, OS/shell, repro steps.

For the full proposal backlog, see the index at
[issue #74](https://github.com/sahenjp/rustdsh/issues/74)
(all 72 proposals mapped to feature issues, priority P0-P3).

## Branch protection (`main`)

Admin settings live in [issue #11](https://github.com/sahenjp/rustdsh/issues/11).
Contributors only need this: open PRs against `main`, keep checks green.

---

## 日本語

### main の保護設定

設定は管理者権限が必要なため、詳しくは
[Issue #11](https://github.com/sahenjp/rustdsh/issues/11)を見てください。
寄稿者は `main` へのPRとチェック通過だけ意識すれば十分です。

### Pull Request

- 本文は4行で書きます（概要／変更／検証／注意点）。
- `cargo fmt --check`、`cargo clippy --release --all-targets`（警告ゼロ）、
  `cargo test --release`、`tests/regress.sh` の全通過を確認してから出します。
- 既存の動作を変えるときは、新旧の出力差分を添えてください。

### UIを変えるときの約束

- 見た目の変更は、必ずPNG画像をPRに添付します。文言だけの説明は不可です。
- 変更前と変更後の2枚を並べるのが基本です。
- 動きのある変更（遷移・アニメ・操作手順）は、短いGIFも付けます。
  GIFだけでは追えない箇所はPNGを併用します。
- 画像とGIFは実際に動かした画面の撮影にし、モックや想像図は混ぜません。
- 応答速度など数値で示すべきものは、計測値も一緒に書きます。
