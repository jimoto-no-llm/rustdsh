# Projects management

How `rustdsh` tracks work: issues are the source of truth,
[ROADMAP.md](ROADMAP.md) states direction, milestones state order.
GitHub Projects (board) is an optional view over the same data.

## Sources of truth

- Backlog: [issue #74](https://github.com/jimoto-no-llm/rustdsh/issues/74)
  plus feature issues filed from `docs/proposals/`.
- Priority: `P0` critical / `P1` high / `P2` normal / `P3` backlog.
  Component/type labels (`bug`, `enhancement`, `performance`, `docs`,
  `dashboard`, `installer`, `security`, `ci`, `release`) describe the work.
  Definitions live in [.github/labels.yml](../.github/labels.yml).
- Order: milestones `v0.3.0` (Now), `v0.4.0` (Next), none (Later).
  `ROADMAP.md` changes only at minor releases.
- Admin settings: [PROJECT-SETUP.md](PROJECT-SETUP.md) and
  [issue #11](https://github.com/jimoto-no-llm/rustdsh/issues/11).

## Board (Projects v2)

Live board: [rustdsh roadmap](https://github.com/orgs/jimoto-no-llm/projects/1)
(org project #1, private). One board, grouped by status:

- Columns: `Todo` / `In Progress` / `Done` (built-in Status field).
- Slice by priority via the `Labels` field (`P0`-`P3`),
  by release via the `Milestone` field (`roadmap`, `v0.3.0`, `v0.4.0`).
- Seeded with #74 (backlog index), 6 `P0` and 14 `P1` issues, all `Todo`.
- Done means merged to `main` and closed by the PR, not just reviewed.

The board is a view only. Priority and milestone live on the issue itself
so the work survives even if the board is rebuilt.

## Triage rules

1. Every new issue needs one priority (`P0`-`P3`) and one area label.
   No priority means it stays in `Inbox`.
2. `P0`-`P1` need a milestone (`v0.3.0` or `v0.4.0`); `P2`-`P3` do not.
3. Use the issue forms (bug / feature / performance / docs) with
   `rdsh --version`, `rdsh doctor`, OS/shell, repro steps.
4. Weekly: empty `Inbox`, close stale `needs-repro` (>30 days, one ping),
   promote at most 3 items into `P1 Next`.
5. Keep PRs small and single-topic per `CONTRIBUTING.md`.

## Milestones

- [`roadmap`](https://github.com/jimoto-no-llm/rustdsh/milestone/1):
  triage bucket, 45 open at last check.
- [`v0.3.0`](https://github.com/jimoto-no-llm/rustdsh/milestone/2):
  Now (delegation parity, installers, dashboard hardening).
- [`v0.4.0`](https://github.com/jimoto-no-llm/rustdsh/milestone/3):
  Next (routing experiments, doctor checks, release automation).

```sh
# labels (managed file is the source of truth)
sh scripts/sync-labels.sh

# add an issue to the board
gh project item-add 1 --owner jimoto-no-llm \
  --url https://github.com/jimoto-no-llm/rustdsh/issues/<number>
```

Board and milestone edits need a maintainer; merging this doc alone
changes nothing remote and does not release a new version.
