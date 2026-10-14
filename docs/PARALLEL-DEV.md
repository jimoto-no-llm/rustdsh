# Parallel development with worktrees

Several agents and developers work on `rustdsh` at the same time. Sharing one
checkout for that is how a backlog of `CONFLICTING` pull requests happens: two
branches get edited from the same working directory, a rebase overwrites
someone else's uncommitted file, and a PR that looked green is suddenly
`BEHIND` and untested.

`scripts/parallel-dev.sh` gives every topic its own checkout, branch and port.
The tool is a thin wrapper over `git worktree`; it adds the two things Git does
not: a deterministic port per topic and a conflict check that never touches a
working tree. For the dashboard's own worker leases, see
[WORKER-WORKSPACES.md](WORKER-WORKSPACES.md) — that is a different, runtime
mechanism.

## Safety rules

- **One worktree per topic.** A new topic gets a new slug and a new worktree.
  Do not reuse a slug for unrelated work; the port and the branch are derived
  from it.
- **Never two writers on one branch.** Before you start, run `status` and make
  sure no other worktree holds the branch you are about to edit.
- **Never rebase a branch someone else has open.** Push a fix commit, or
  coordinate first. A forced push invalidates their review.
- **`remove` only deletes what it resolved.** The command resolves the target
  path first and refuses anything that is not `<parent>/.worktrees/rustdsh-<slug>`.
- **Uncommitted work is sacred.** `remove` refuses a dirty worktree. `--force`
  is for a worktree you have consciously decided to throw away.

## Where things live

Paths are relative to the parent of the repository. For a checkout at
`~/ghq/github.com/owner/rustdsh` that parent is `~/ghq/github.com/owner`, so
worktrees land in the sibling directory `~/ghq/github.com/owner/.worktrees/`.

```text
<parent>/
  rustdsh/                        the canonical checkout
  .worktrees/
    .git/                         bare mirror: `new` fetches here
    .worktrees.git/               local object store, borrowed on first clone
    rustdsh-<slug>/               one worktree per topic
```

A worktree is a full repository with its own index, so parallel topics never
fight over `git add`. It shares the object database with the mirror, which is
why creating one is fast.

## Ports

Each slug maps to a port in `49000-49999`:

```sh
scripts/parallel-dev.sh port dashboard-fix     # 49703
scripts/parallel-dev.sh port dashboard-fix     # 49703, always
RDSH_PARALLEL_PORT_BASE=51000 scripts/parallel-dev.sh port dashboard-fix
# 51703
```

The port is the first four bytes of `sha256("rustdsh-parallel/<slug>")` modulo
1000, plus the base. It is stable across machines and runs, so a dashboard URL
or a `--port` flag can be written down once and reused.

Set `RDSH_PARALLEL_PORT_BASE` when the default range collides with something
already running, or when two different projects share a machine and would
otherwise pick overlapping ports. The override shifts the whole range; it does
not change which slug gets which offset.

## Command reference

### `new <slug>`

Create a worktree at `<parent>/.worktrees/rustdsh-<slug>` on a new branch
`parallel/<slug>`, based on the latest `origin/main`. The remote is fetched
first; the mirror and the object store are created on the first run. The slug
uses lowercase letters, digits and single dashes.

```sh
scripts/parallel-dev.sh new dashboard-fix
```

```text
creating local object store <parent>/.worktrees/.worktrees.git from <repo>
creating shared mirror <parent>/.worktrees/.git
fetching origin in <parent>/.worktrees/.git
created <parent>/.worktrees/rustdsh-dashboard-fix
branch  parallel/dashboard-fix (from origin/main at 5c86c568)
port    49703
next    cd <parent>/.worktrees/rustdsh-dashboard-fix
```

The command refuses a slug that already has a worktree or a local branch. Use
`RDSH_PARALLEL_BASE_REF=origin/release` to base the worktree on something other
than `origin/main`.

### `list`

Show every managed worktree with its branch, HEAD sha and port.

```sh
scripts/parallel-dev.sh list
```

```text
WORKTREE                     BRANCH                     HEAD       PORT
rustdsh-dashboard-fix        parallel/dashboard-fix     ca98c52f   49703
rustdsh-installer-fix        parallel/installer-fix     5c86c568   49533
```

### `status`

For every managed worktree: branch, ahead/behind the remote base, dirty state,
and whether the branch would conflict with it.

```sh
scripts/parallel-dev.sh status
```

```text
WORKTREE                   BRANCH                 HEAD       AHEAD/BEHIND  DIRTY     VS origin/main
rustdsh-dashboard-fix      parallel/dashboard-fix ca98c52f   +1/-0         dirty     clean
rustdsh-installer-fix      parallel/installer-fix 5c86c568   +0/-0         clean     clean
```

`AHEAD/BEHIND` counts commits: `+1/-0` means one commit that is not in
`origin/main` and no commits of `origin/main` that are missing from the branch.
The last column comes from `git merge-tree --write-tree`, which performs the
merge in memory and never reads or writes a working tree. `clean` means the
merge would succeed, `conflicts` means it would not, and `unknown` means the
ref for the comparison was missing.

### `remove <slug>`

Remove the worktree and its branch.

```sh
scripts/parallel-dev.sh remove dashboard-fix
```

The command refuses when the worktree has uncommitted changes:

```text
error: <parent>/.worktrees/rustdsh-dashboard-fix has uncommitted changes:
?? scratch-dirty.txt
error: commit, stash or discard them, or re-run with --force
```

```sh
scripts/parallel-dev.sh remove dashboard-fix --force   # discard the changes too
```

It also refuses a path that does not resolve to `<parent>/.worktrees/rustdsh-<slug>`.

### `port <slug>`

Print the port, and nothing else, so it composes:

```sh
PORT="$(scripts/parallel-dev.sh port dashboard-fix)"
(cd .worktrees/rustdsh-dashboard-fix/dashboard && npm start -- --port "$PORT")
```

## Recommended flow

1. **Start from a fresh `main`.**
   `git -C ../rustdsh pull --ff-only` before `new`, so the parent checkout is
   not the thing that drifts.
2. **Create the worktree.**
   `scripts/parallel-dev.sh new my-topic`
3. **Work there.**
   `cd ../.worktrees/rustdsh-my-topic`
4. **Run the full matrix before opening the PR.** The matrix lives in
   [CONTRIBUTING.md](../CONTRIBUTING.md); the short version is:

   ```sh
   cargo fmt --check
   cargo clippy --all-targets -- -D warnings
   cargo test --release
   sh tests/regress.sh
   (cd dashboard && npm ci && npm test)   # only if you touched dashboard/
   ```

5. **Open the PR** against `main`, with the four-line body
   (overview / changes / verification / caveats) from
   [CONTRIBUTING.md](../CONTRIBUTING.md).
6. **Remove the worktree once it is merged.**
   `scripts/parallel-dev.sh remove my-topic`

## Keeping a branch current

Both strategies are legitimate; pick by what the branch is.

| Situation | Use | Why |
| --- | --- | --- |
| Private branch, no review yet | `git rebase origin/main` | Linear history, no merge commits, easy to read |
| Branch with an open PR under review | `git merge origin/main` | A push is additive; reviewers keep their line comments |
| Branch someone else also has checked out | coordinate first | A rebase forces everyone else to reset |

Rebase, the common case:

```sh
cd ../.worktrees/rustdsh-my-topic
git fetch origin main
git rebase origin/main
# resolve any conflict, then:
git rebase --continue
git push --force-with-lease
```

`--force-with-lease` refuses to overwrite a remote branch that moved since your
last fetch. Never use a plain `--force` here.

Merge, when the PR is already under review:

```sh
cd ../.worktrees/rustdsh-my-topic
git fetch origin main
git merge origin/main
git push
```

The repository has `merge.conflictstyle=zdiff3` and `rerere` enabled in the
canonical checkout, and `scripts/dev-setup.sh` from the development-environment
work sets those up locally. `zdiff3` shows the common ancestor in the conflict
markers, which is usually enough to resolve a conflict without re-reading both
files.

## Resolving conflicts

Start by seeing which worktrees are affected, without touching anything:

```sh
scripts/parallel-dev.sh status
```

`conflicts` in the last column means the branch would not merge. Resolve it in
the worktree:

```sh
cd ../.worktrees/rustdsh-my-topic
git fetch origin main
git rebase origin/main
git status                      # the unmerged paths
"$EDITOR" path/to/conflicted-file
git add path/to/conflicted-file
git rebase --continue
```

If the rebase goes wrong, `git rebase --abort` returns the branch to where it
started. Nothing about this touches the canonical checkout or another worktree.

**A `BEHIND` PR still needs verification after rebasing.** GitHub recomputes
mergeability, but a conflict-free merge is not a tested merge. Re-run the full
[CONTRIBUTING.md](../CONTRIBUTING.md) matrix on the rebased commit before you
ask for another review:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --release
sh tests/regress.sh
```

PRs whose mergeability must be checked in bulk:

```sh
scripts/check-pr-conflicts.sh
```

```text
PR  MERGEABLE   AHEAD/BEHIND TITLE
----------------------------------
512 CONFLICTING +1/-6        feat(installer): Windowsアーカイブをrelease-digests.tsvで検証する
517 MERGEABLE   +1/-126      perf: CLI回帰テストハーネスをCIに追加する
515 MERGEABLE   +1/-6        updateがネイティブ一覧から漏れて誤委譲されるバグ修正

open PRs: 3  CONFLICTING: 1  MERGEABLE: 2
```

`--conflicting-only`, `--mergeable-only` and `--json` narrow the output for
scripts. The command exits `3` when conflicts remain, so it can gate a job:

```sh
scripts/check-pr-conflicts.sh --conflicting-only || echo "rebase needed"
```

## Build caches

Every worktree has its own `target/`, because `target/` lives next to the
source. Ten topics therefore download and compile every dependency ten times.
Two ways to share the work, with different tradeoffs:

```sh
# Option A: one shared target directory (~/.cargo-target/rdsh), set per shell.
export CARGO_TARGET_DIR="$HOME/.cargo-target/rdsh"

# Option B: a compiler cache keyed by content, still one target/ per worktree.
cargo install sccache --locked
export RUSTC_WRAPPER=sccache
```

| | Shared `CARGO_TARGET_DIR` | `sccache` |
| --- | --- | --- |
| Disk | One copy of the artifacts | One `target/` per worktree, cache shared |
| Parallel builds | Serialize on the Cargo lock | Concurrent, cache hits are cheap |
| Debug/release mix | Mixed in one directory | Mixed, keyed by content |
| First build after a switch | Often incremental | Usually a cache hit |

Cargo takes an exclusive lock on the target directory, so concurrent builds
against a shared `CARGO_TARGET_DIR` queue up instead of running in parallel.
That is safe, just slow — for genuinely parallel work prefer `sccache`, and use
a shared target directory when you are the only one building right now. A
per-worktree `target/` is the safe default: no lock contention, no shared
state, at the cost of rebuilding dependencies per topic. Add
`~/.cargo-target` or the worktrees root to your disk accounting either way; a
release build of this project is not small.

## When CI is blocked

- **Checks never start.** The branch is `BEHIND` and the branch protection rule
  requires an up-to-date branch. Rebase on `origin/main`, push, and wait for
  the new run.
- **A required job is skipped.** Docs and dashboard workflows have path
  filters, so an unrelated PR legitimately shows them as skipped. Skipped is
  not failed; the required checks are the Rust ones.
- **The same job fails on `main`.** Check whether `main` is broken before you
  debug your diff. If it is, do not fix it inside a feature PR — a focused fix
  PR unblocks everyone and keeps your diff reviewable.
- **Two PRs break each other.** Both were green alone. Land the smaller one
  first, then rebase the other and re-run the matrix; the conflict is real even
  though Git reported no textual conflict.
- **A flaky test.** Re-run once. If it fails again, it is not flaky — treat it
  as a real failure and report it rather than re-running until it passes.

## See also

- [CONTRIBUTING.md](../CONTRIBUTING.md): the test matrix, the PR body format
  and the architecture rules.
- [PROJECT-SETUP.md](PROJECT-SETUP.md): branch protection, required checks and
  the live settings commands.
- [WORKER-WORKSPACES.md](WORKER-WORKSPACES.md): runtime worker leases, which
  are a different mechanism from these developer worktrees.
