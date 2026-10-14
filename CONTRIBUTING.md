# Contributing (寄稿ガイド)

English summary first, 日本語の詳細は後に続きます.

## Quick start

```sh
git clone https://github.com/jimoto-no-llm/rustdsh.git
cd rustdsh
sh scripts/dev-setup.sh   # toolchain check, git hooks, conflict-friendly git config
sh scripts/check.sh       # CI-equivalent checks for the areas you changed
```

See [DEVELOPMENT.md](docs/DEVELOPMENT.md) for the dev container, hooks and the
conflict-avoidance workflow.

Full test matrix before a PR:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --release
cargo test --release --example benchmark_extended
cargo test --release --example benchmark_models
node --test tests/model_benchmark/fence.test.mjs
sh tests/regress.sh
# Installer or release packaging changes (containers, offline file:// base):
tests/install-isolated.sh --source local
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
- Branch from a fresh `origin/main` and update early when `main` moves.
  Before pushing, `sh scripts/check-conflicts.sh --open-prs` shows conflicts
  with `main` and open PRs touching the same files. PRs that stop merging
  cleanly get the `needs-rebase` label automatically.

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
[issue #74](https://github.com/jimoto-no-llm/rustdsh/issues/74)
(all 72 proposals mapped to feature issues, priority P0-P3).

## Branch protection (`main`)

Admin settings live in [issue #11](https://github.com/jimoto-no-llm/rustdsh/issues/11).
Contributors only need this: open PRs against `main`, keep checks green.

Current repository settings and label conventions are documented in
[PROJECT-SETUP.md](docs/PROJECT-SETUP.md). Release preparation follows
[RELEASING.md](docs/RELEASING.md) and the published v0.2.0 format.

---

## 日本語

### main の保護設定

設定は管理者権限が必要なため、詳しくは
[Issue #11](https://github.com/jimoto-no-llm/rustdsh/issues/11)を見てください。
寄稿者は `main` へのPRとチェック通過だけ意識すれば十分です。

### 開発環境

最初に `sh scripts/dev-setup.sh` を実行し、検証は `sh scripts/check.sh` で
まとめて行います。dev container と hooks の説明、コンフリクトを避ける進め方は
[DEVELOPMENT.md](docs/DEVELOPMENT.md) にあります。

### Pull Request

- 本文は4行で書きます（概要／変更／検証／注意点）。
- `cargo fmt --check`、`cargo clippy --release --all-targets`（警告ゼロ）、
  `cargo test --release`、`tests/regress.sh` の全通過を確認してから出します。
- 既存の動作を変えるときは、新旧の出力差分を添えてください。
- 最新の `origin/main` から分岐し、`main` が進んだら早めに取り込みます。
  push 前に `sh scripts/check-conflicts.sh --open-prs` で衝突と、
  同じファイルを触る open PR を確認できます。衝突した PR には
  `needs-rebase` ラベルが自動で付きます。

### UIを変えるときの約束

- 見た目の変更は、必ずPNG画像をPRに添付します。文言だけの説明は不可です。
- 変更前と変更後の2枚を並べるのが基本です。
- 動きのある変更（遷移・アニメ・操作手順）は、短いGIFも付けます。
  GIFだけでは追えない箇所はPNGを併用します。
- 画像とGIFは実際に動かした画面の撮影にし、モックや想像図は混ぜません。
- 応答速度など数値で示すべきものは、計測値も一緒に書きます。
