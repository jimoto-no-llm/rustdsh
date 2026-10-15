# Round 1 evidence — Rust化 / performance / parallel development

Date: 2026-10-15. All numbers below were produced by commands run in this round;
the block that reports each number names the command or query behind it, and
"Reproducing these measurements" collects the full invocations with the revision
they ran at. Rows marked `not re-run` were recorded in the round and were not
re-executed for this revision.

## Pull requests opened or rescued

以下は、このラウンドで扱った10件と、各PRのレビュー時に著者が記録した検証です。
現在のOPEN件数やmainへの取り込み済み件数を表す表ではありません。

| PR | Topic | Verification |
| -- | ----- | ------------ |
| #509 | Rust subagent planner (carried the stalled worktree) | 335 tests, fmt/clippy clean |
| #267 | Restore upstream DSH tool permissions | 328 tests; MCP probe realigned |
| #460 | Provider model list sync (`src/models.rs`, 1915 lines) | 331 tests + live `rdsh models` |
| #465 | Interval-based model auto-refresh | 349 tests + `models auto --dry-run` |
| #496 | Context injection and dependency graph | 431 tests |
| #512 | Windows archive pinned in `release-digests.tsv` | 39 release + 8 integrity checks |
| #517 | CI performance regression harness | see below |
| #518 | Parallel-dev worktree tooling | see below |
| #519 | Stop duplicate workflow runs per commit | see below |
| #521 | `task-outcomes` ported to Rust | byte-identical parity |

The verification counts in this table were recorded when each pull request was
reviewed; they were not re-counted for this revision.

2026-10-15 05:25 UTCにGitHubのPR APIで確認した状態は、#267/#460/#518がOPEN、
PR #509/#512/#517/#519/#521がmainへマージ済みです。#465は2026-10-14 16:44:05 UTC、
PR #496は同16:44:09 UTCにマージ済みですが、取り込み先はいずれも
`feat/codex-model-sync`であり、mainへのマージを示す記録ではありません。
復旧用#523は確認時点でclosed・未マージです。以降の技術記録は各節に示す当時の
revisionについての記録で、現在のmainや#525の実装・状態を示すものではありません。

状態の確認に使ったコマンド（`<number>`は上記各PR番号）:

```console
gh api repos/jimoto-no-llm/rustdsh/pulls/<number> \
    --jq '{number, state, merged, merged_at, base: .base.ref}'
```

`scripts/check-pr-conflicts.sh` reported `CONFLICTING: 40  MERGEABLE: 21` early in
the round and `MERGEABLE` rose as the rebases landed. Rebase conflicts were
resolved additively (both sides kept) in `CHANGELOG.md`, `src/main.rs`,
`src/auth.rs` and `src/file_security.rs`; every resolution was re-verified with
`cargo test` before pushing.

## Performance testing (PR #517)

`examples/benchmark_regression.rs` (1900 lines, 20 `#[test]` at `caaf1b41`;
counted with `wc -l` and `grep -c '#\[test\]'`) measures the real binary in an
isolated HOME/DSH_HOME/XDG. Measured on macOS aarch64 (Apple silicon), 18 cores,
at PR #517 head `027c8f392` (merged as `96d935507`) with `--n 15`:

| Case | median ms | p95 ms |
| ---- | --------- | ------ |
| `version_startup` | 7.85 | 8.74 |
| `tokens_1mib` | 7.51 | 9.94 |
| `tokens_10mib` | 9.63 | 10.67 |
| `search_tree_200_files` | 9.89 | 11.33 |

Peak RSS for `--version`: 2.6 MiB. The CI assert script (the inline Python step
of the `perf-regression` job in `.github/workflows/ci.yml`) was run against a
real report (4 cases correct, exit 0) and against a missing file (correctly
failed). The benchmark numbers are `not re-run` for this revision.

Both gates were exercised, not just asserted:

- A shell wrapper adding 250 ms made all four cases REGRESSED with exit code 1.
- A wrapper returning wrong token counts was caught by the correctness oracle,
  exit code 1.

## Parallel development (PR #518)

`scripts/parallel-dev.sh` creates one worktree per topic with a deterministic
port (49000-49999). Exercised end to end: `new` produced
`rustdsh-verify-scratch` on port 49685, a dirty worktree was refused with exit 1
and preserved, and `--force` removal cleaned up. After testing,
`git worktree list` returned to its baseline and no `parallel/*` branch remained.

`scripts/check-pr-conflicts.sh` prints the mergeability board and gates scripts
with a non-zero exit when conflicts exist.

Build caching was measured rather than assumed. `sccache` helps debug builds
(15.7s -> 5.0s of user CPU for a cold build) but is *slower* for this project's
release profile (4 parallel release builds: 23s without sccache, 38s with it),
because the dependency tree is small and fat LTO is not cacheable. Per-worktree
`target/` directories are therefore kept.

The method was a with/without comparison on the same macOS aarch64 host: one
cold debug build, then four concurrent `cargo build --release` runs, timed with
and without `RUSTC_WRAPPER=sccache` (user CPU via `/usr/bin/time -l`, plus wall
time). The individual shell invocations are not preserved in this repository
(`not recorded`), and these numbers are `not re-run` for this revision.

## CI throughput (PR #519)

At the start of the round the queue held 53 queued and 7 running runs. The
original invocation for that snapshot is not preserved in this repository; the
query in "Reproducing these measurements" returns the same measure and was
re-run at this revision. For the measured `ci` workflow the duplicate-run cause
was deterministic, not guessed: it triggered on `on: [push, pull_request]` and
keyed its concurrency group on `github.ref`, and a branch push
(`refs/heads/<branch>`) never shares a group with its pull request
(`refs/pull/<n>/merge`). The same commit therefore ran the `ci` matrix twice —
`chore/parallel-dev-tooling` at `7c6433c` had two `ci` runs for one SHA. The
queue total is not attributed to `ci` alone: other workflows differ
(`install-live` is scheduled/manual, `cd` is tag-only, `codeql` limits pushes
to `main`, the rest are path-filtered), so how much of the 53 came from this
mechanism was not measured.

An intermediate commit keyed the group on the branch
(`github.event.pull_request.head.ref || github.ref_name`, `a6f5d377`). Two
limitations are recorded rather than resolved:

- `head.ref` is only the source branch name, so two fork pull requests whose
  branches share a name (for example `patch-1`) land in the same group and
  cancel each other even though they are unrelated.
- GitHub does not guarantee which run wins `cancel-in-progress`, so a
  later-starting push run can cancel the `pull_request` run. In that variant,
  `.github/workflows/ci.yml` names branch-push jobs with a `[branch push]`
  suffix while the required checks use the unsuffixed names, so losing the race
  can leave a pull request without its required checks even though the push run
  passed.

Observed at `a6f5d377` (the commit that introduced the branch key): the `ci`,
`dashboard` and `docs` push runs were `cancelled` while their `pull_request`
runs completed. That is one observed ordering, not a guarantee.

PR #519 landed a different mechanism for `ci`: feature-branch pushes no longer
start the workflow at all (`push` is limited to `main` and `v*` tags), so there
is no push run to race with. The branch-key variant is still under review for
`codeql` in #525, where the two limitations above apply. The guarantee that a
required check cannot lose the cancellation race belongs to #519/#525, not to
this evidence record.

## Rust migration (PR #521)

`dashboard/task-outcomes.mjs` logic was ported to `src/task_outcomes.rs` and
exposed as `rdsh task-outcomes <apply|validate|schema> --input-file <request.json>`.
Parity was verified independently by importing the real JS module and diffing it
against the real binary, one request at a time (`node` importing
`dashboard/task-outcomes.mjs` on one side,
`cargo run --locked -- task-outcomes <apply|validate> --input-file <request.json>`
on the other). The differential driver was an ad-hoc script that is not in the
repository (`not recorded`), so the nine apply/validate cases are `not re-run`;
the two schema comparisons were re-run at `caaf1b41`. Commands are in
"Reproducing these measurements":

- `outcomeSchema` and `milestoneSchema`: byte-identical `JSON.stringify` text.
- 9/9 apply/validate cases agreed on the resulting `state.task_outcomes` payload
  and on the error text, including the already-stored and milestone-contract
  merge paths.

`applyTaskOutcomes` mutates state in place, so parity is asserted on the mutated
state. `serde_json` gained `preserve_order` because 15 cases otherwise differed
only in key order; the full suite (328 tests, counted at PR #521 review time)
was re-run with no regressions. The committed equivalents of the differential
run are `cargo test --locked --test task_outcomes_cli` (12 `#[test]`, re-run at
`caaf1b41`: 12 passed) and `node --test dashboard/test/task-outcomes.test.mjs`
for the JS side (`not re-run`).

The JS module was deliberately kept: `dashboard/state.mjs` calls
`validateTaskOutcomes` on every store open and every `mutate`, and
`dashboard/mcp.mjs` consumes the schemas as leaf fragments it re-wraps, so a
subprocess swap would change the store hot path and the MCP wire contract.

## Mistakes made and corrected in this round

- A `git push HEAD:<branch>` loop pushed one branch's commit to four refs and
  auto-closed PRs #512/#517/#518/#519. They were reopened once the cause was
  found, and all four branches were confirmed to hold their correct content.
- A stale local `main` was used as a rebase base. It was reset to `origin/main`
  and every affected branch was rebased again with the base verified by
  `git merge-base`.

## Reproducing these measurements

`not re-run` means the invocation is recorded from the round but was not
executed for this revision (`caaf1b41`); only the round's output exists for
those rows.

### Performance (PR #517, macOS aarch64, not re-run)

```console
$ cargo build --release
$ cargo run --release --example benchmark_regression -- \
    --bin ./target/release/rdsh --n 15 --output /tmp/rdsh-perf.json
```

The `perf-regression` job in `.github/workflows/ci.yml` runs
`cargo test --locked --example benchmark_regression`, then the same run command
against `$RUNNER_TEMP/rdsh-perf.json`, then an inline Python step that exits
non-zero unless every case is `correct`, is not `failed`, and carries
`median_ms`/`p95_ms` samples.

### sccache (not re-run)

Same host and method as described under "Parallel development": one cold debug
build and four concurrent release builds, with and without
`RUSTC_WRAPPER=sccache`, comparing user CPU and wall time. The exact shell
invocations were not preserved (`not recorded`).

### CI queue and duplicate runs (re-run at `caaf1b41`)

```console
$ gh run list --limit 300 --json status \
    --jq '[.[].status] | group_by(.) | map({(.[0]): length}) | add'
```

Round snapshot: 53 queued, 7 running. Re-run output on 2026-10-15 08:08 JST:
`{"completed":291,"in_progress":6,"queued":3}` — the most recent 300 runs, so
it is a window rather than a full-history total.

```console
$ gh api 'repos/jimoto-no-llm/rustdsh/actions/runs?branch=chore/parallel-dev-tooling&per_page=100' \
    --jq '[.workflow_runs[] | {sha: .head_sha[0:7], name: .name}] | group_by(.sha) \
          | map({sha: .[0].sha, ci: ([.[] | select(.name == "ci")] | length)}) \
          | map(select(.ci > 1))'
```

Nine SHAs are reported with two `ci` runs each, including `7c6433c`.

```console
$ gh api 'repos/jimoto-no-llm/rustdsh/actions/runs?head_sha=a6f5d377093b4992407706a99bd01a9731ae33f0&per_page=100' \
    --jq '.workflow_runs[] | [.name, .event, .status, .conclusion] | @tsv' | sort
```

`ci`, `dashboard` and `docs` each report one `push` run `cancelled` and one
`pull_request` run `completed`.

### Parity (PR #521)

Re-run at `caaf1b41` with the binary built by
`cargo test --locked --test task_outcomes_cli`:

```console
$ cat /tmp/request.json
{"operation":"schema","state":{"schema":1,"tasks":[]}}
$ ./target/debug/rdsh task-outcomes schema --input-file /tmp/request.json
$ node --input-type=module -e 'import { outcomeSchema, milestoneSchema } from \
    "./dashboard/task-outcomes.mjs"; process.stdout.write(JSON.stringify({ \
    outcome: outcomeSchema, milestone: milestoneSchema }));'
```

`JSON.stringify` of the binary's `outcome` and the JS `outcomeSchema`, and of
the binary's `milestone_contract` and the JS `milestoneSchema`, are
byte-identical.

```console
cargo test --locked --test task_outcomes_cli          # 12 #[test]; re-run: 12 passed
node --test dashboard/test/task-outcomes.test.mjs   # JS side, not re-run
```

The nine apply/validate cases were checked by the ad-hoc differential driver
(`not recorded`) and are `not re-run`.
