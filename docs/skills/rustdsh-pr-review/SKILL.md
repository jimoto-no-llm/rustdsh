---
name: rustdsh-pr-review
description: Use when delegating rustdsh (jimoto-no-llm/rustdsh) pull-request reviews to subagents. Provides the read-only review protocol, deterministic fact scripts, and verdict format.
---

# rustdsh-pr-review

Delegate PR review to a subagent with a self-contained prompt. The parent
merges; the child never writes.

This skill lives in the repository (`docs/skills/rustdsh-pr-review/`) so
every operator reviews the same way. A copy may also sit in the harness
skills directory for local use; the repository copy is canonical.

## Delegation template

Give the subagent the read-only protocol, then the assigned PR numbers:

- Repo: `jimoto-no-llm/rustdsh`, local checkout: a clean clone or worktree
  (never commit in a shared tree; use `git worktree add -f -q --detach
  /var/tmp/rev-<n> origin/<headRef>` and remove it afterwards).
- Forbidden: git push, gh pr merge/comment/edit, gh api writes,
  file edits, touching other agents' worktrees or uncommitted files.
- Allowed: gh reads, worktree creation, local builds/tests with
  `TMPDIR=/var/tmp` (`/tmp` fills up; never use it for builds).
- Fact script first: `bash docs/skills/rustdsh-pr-review/scripts/pr-facts.sh <n>`
  (from the repository root) for checks summary, review state, merge state.
- Criteria and verdict format:
  `docs/skills/rustdsh-pr-review/references/review-checklist.md`.

Run independent batches in parallel (`run_in_background: true`).

## After the verdicts

The parent verifies the MERGE verdicts itself (spot-check the diff),
updates the branch with main, waits for required checks, then merges.
Post review findings as PR comments for NEEDS-WORK verdicts.
Never merge a PR with unaddressed security objections or failing
required checks.
