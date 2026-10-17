# Contributing (寄稿ガイド)

English summary first, 日本語の詳細は後述します。

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

設定には管理者権限が必要なため、詳しくは
[Issue #11](https://github.com/jimoto-no-llm/rustdsh/issues/11)を参照してください。
寄稿者は `main` への PR とチェックの通過だけを意識すれば十分です。

### 開発環境

初めに `sh scripts/dev-setup.sh` を実行し、検証は `sh scripts/check.sh` で
まとめて行います。dev container や hooks の説明、コンフリクトを回避するワークフローについては
[DEVELOPMENT.md](docs/DEVELOPMENT.md) に記載されています。

### Pull Request

- PR 本文は4行で記述します（概要／変更／検証／注意点）。
- `cargo fmt --check`、`cargo clippy --release --all-targets`（警告ゼロ）、
  `cargo test --release`、`tests/regress.sh` の全通過を確認してから提出します。
- 既存の動作を変更する場合は、新旧の出力差分を添付してください。
- 最新の `origin/main` から分岐し、`main` が更新されたら早めに取り込みます。
  push 前に `sh scripts/check-conflicts.sh --open-prs` でコンフリクトや、
  同じファイルを変更している open PR を確認できます。コンフリクトが発生した PR には
  `needs-rebase` ラベルが自動で付与されます。

### UIを変えるときの約束

- 見た目を変更する場合は、必ず PNG 画像を PR に添付します。テキストのみの説明は不可です。
- 変更前と変更後の2枚を並べるのが基本です。
- 動きのある変更（画面遷移・アニメーション・操作手順）は、短い GIF も添付します。
  GIF だけでは追えない箇所は PNG を併用します。
- 画像や GIF は実際に動作させた画面のキャプチャとし、モックやイメージ図は含めません。
- 応答速度など数値で示すべき項目は、実測値も併記します。
