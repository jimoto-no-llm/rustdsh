# Round 1 evidence — Rust化 / performance / parallel development

Date: 2026-10-15. All numbers below were produced by commands run in this round;
each claim names the command that produced it.

## Pull requests opened or rescued

Ten PRs are OPEN, MERGEABLE and (where the base allows) armed for auto-merge:

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

`scripts/check-pr-conflicts.sh` reported `CONFLICTING: 40  MERGEABLE: 21` early in
the round and `MERGEABLE` rose as the rebases landed. Rebase conflicts were
resolved additively (both sides kept) in `CHANGELOG.md`, `src/main.rs`,
`src/auth.rs` and `src/file_security.rs`; every resolution was re-verified with
`cargo test` before pushing.

## Performance testing (PR #517)

`examples/benchmark_regression.rs` (1362 lines, 14 unit tests) measures the real
binary in an isolated HOME/DSH_HOME/XDG. Measured on macOS aarch64, `--n 15`:

| Case | median ms | p95 ms |
| ---- | --------- | ------ |
| `version_startup` | 7.85 | 8.74 |
| `tokens_1mib` | 7.51 | 9.94 |
| `tokens_10mib` | 9.63 | 10.67 |
| `search_tree_200_files` | 9.89 | 11.33 |

Peak RSS for `--version`: 2.6 MiB. The CI assert script was run against a real
report (4 cases correct, exit 0) and against a missing file (correctly failed).

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

## CI throughput (PR #519)

The queue held 53 queued and 7 running runs. The cause was measured, not
guessed: every workflow triggered on both `push` and `pull_request` but keyed
its concurrency group on `github.ref`, and a branch push (`refs/heads/<branch>`)
never shares a group with its pull request (`refs/pull/<n>/merge`). The same
commit therefore ran the full matrix twice — `chore/parallel-dev-tooling` at
`7c6433c` had two `ci` runs for one SHA.

Keying the group on the branch (`github.event.pull_request.head.ref ||
github.ref_name`) fixed it. Verified empirically: after the change the push runs
for `ci/dedupe-event-runs` were reported `cancelled` while only the
`pull_request` runs continued.

## Rust migration (PR #521)

`dashboard/task-outcomes.mjs` logic was ported to `src/task_outcomes.rs` and
exposed as `rdsh task-outcomes <apply|validate|schema>`. Parity was verified
independently by importing the real JS module and diffing it against the real
binary:

- `outcomeSchema` and `milestoneSchema`: byte-identical `JSON.stringify` text.
- 9/9 apply/validate cases agreed on the resulting `state.task_outcomes` payload
  and on the error text, including the already-stored and milestone-contract
  merge paths.

`applyTaskOutcomes` mutates state in place, so parity is asserted on the mutated
state. `serde_json` gained `preserve_order` because 15 cases otherwise differed
only in key order; the full suite (328 tests) was re-run with no regressions.

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
