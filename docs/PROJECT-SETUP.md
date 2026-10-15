# Project settings

The canonical repository is [jimoto-no-llm/rustdsh](https://github.com/jimoto-no-llm/rustdsh).
Repository metadata and intended required checks are recorded in
[.github/project-settings.json](../.github/project-settings.json).
GitHub administrative settings are applied separately from merging configuration
files; changing the JSON file alone does not change repository settings.

## Discovery and maintenance

- The repository description describes native fast commands, guarded agent tools
  and the local dashboard. Topics cover Rust, DSH, DeepSeek, CLI, dashboard,
  performance and agent tooling. The homepage points to the README.
- Merged PR branches are automatically deleted; local checkouts are unaffected.
- Parallel work uses one isolated worktree per topic, each with a deterministic
  port and a conflict check that never touches a working tree. See
  [PARALLEL-DEV.md](PARALLEL-DEV.md) and `scripts/parallel-dev.sh`.
- Automatic merge is available after the required checks and other-person review
  succeed. It does not bypass branch protection.
- [Managed labels](../.github/labels.yml) define type/component labels and
  `P0` (critical), `P1` (high), `P2` (normal), `P3` (backlog) priority labels.
  Existing labels and issue assignments are preserved.
- The labels workflow syncs the definitions when they change on `main`.
  For manual sync, use an authenticated `gh` CLI and Python with PyYAML:

  ```sh
  sh scripts/sync-labels.sh
  ```

  `REPO=owner/repo` overrides the destination. Sync is repeatable and stops
  on errors rather than interpreting any failed create as an existing label.

## Main and release tags

`main` requires one approving review, dismisses stale approvals when commits are
pushed, and requires conversations to be resolved before merge. Force pushes and
deletion stay disabled, and the administrator bypass remains available for
recovery.

Two switches are deliberately **off**, because each one made approved pull
requests unmergeable instead of safer:

- **last-push approval** — when the reviewer also merged `main` into the branch
  ("Update branch"), they became the last pusher, so their own approval stopped
  counting and the pull request stayed `REVIEW_REQUIRED` even with two approvals
  on the head commit (issue #534).
- **up-to-date branches (`strict`)** — every merge into `main` turned approved
  pull requests `BEHIND`, and the "Update branch" push that fixed it dismissed the
  approval again, so the same pull request bounced between states.

Required checks (GitHub Actions app, nine names):

`Rust lint`, `release-policy`, `plugin-security`, `security-boundaries`,
`update-banner-windows`, `test (ubuntu-latest, true)`, `test (macos-latest, true)`,
`test (windows-latest, false)`, `browser-e2e`.

Only checks that run on every PR are required. Docs, CodeQL and dashboard
workflows have path filters; requiring their individual jobs globally would leave
unrelated PRs waiting forever. Their results still need review when those areas
change, and the CD gate re-checks the wider `REQUIRED_CHECKS` list before
publishing (including `Analyze (rust)`, `Analyze (javascript)`, `msrv` and
`Isolated install`).

A pull request with green required checks, an approval and no unresolved review
threads merges without help. When a contributor's pull request is blocked only by
the review requirement, an administrator reviews the diff and merges it with
`--admin`. Pushing to a branch dismisses its approval, so merge soon after
approving rather than merging `main` into an approved branch.

The [release tag ruleset](../.github/tag-ruleset.json) applies to `refs/tags/v*`.
It blocks updates and deletion without bypass actors, while allowing new tags.
It does not add or move existing tags. Release publication follows
[RELEASING.md](RELEASING.md) and the v0.2.0 format.

## Installer ledgers

`install.sh`, `install.ps1` and the automatic updater only trust the digests
pinned on `main`: `release-digests.tsv` for the four Unix archives and
`release-digests-windows.tsv` for the Windows zip. A published release that is
not pinned there cannot be installed or auto-updated — v0.3.3 stayed invisible
until its digests were pinned. After every publication either merge the pull
request that the `pin-release-digests` workflow opens, or run:

```sh
python3 scripts/pin-release-digests.py vX.Y.Z
python3 -m unittest discover -s tests -p 'test_release_digest_pin.py'
```

Both ledgers carry a `latest` row. Pinning an older release only backfills its
rows; the channel moves forward only, so installs and updates never resolve an
older release by accident.

## Security settings

Dependabot vulnerability alerts, automated security updates, secret scanning,
secret scanning push protection and private vulnerability reporting are enabled
in GitHub, so external users can report through [SECURITY.md](../SECURITY.md)
without opening a public issue. The CodeQL workflow
([.github/workflows/codeql.yml](../.github/workflows/codeql.yml)) scans Rust and
JavaScript on pushes to `main` and on pull requests that touch the code paths it
watches.

Keep the alert counts at zero:

- **Every npm manifest directory belongs in**
  [.github/dependabot.yml](../.github/dependabot.yml). A lockfile outside that list
  still raises alerts but never gets an update pull request; the headless runtime
  lockfile is why two alerts sat unpinned until they were cleared by hand.
- Transitive advisories that an upstream package pins exactly are cleared with an
  `overrides` entry in the consuming manifest plus a regenerated lockfile, not by
  dismissing the alert.
- Dismissing an alert needs a recorded reason and a follow-up issue; "no fixed
  version is published upstream" is the only routine case.
- Never bypass secret-scanning push protection in a workflow, and treat a
  CodeQL alert in tests the same as one in product code.

## Verify the live settings

```sh
gh api repos/jimoto-no-llm/rustdsh --jq '{description,homepage,topics,delete_branch_on_merge,security_and_analysis}'
gh api repos/jimoto-no-llm/rustdsh/branches/main/protection --jq \
  '{checks:.required_status_checks.contexts, strict:.required_status_checks.strict,
    reviews:.required_pull_request_reviews, conversation:.required_conversation_resolution.enabled}'
gh api 'repos/jimoto-no-llm/rustdsh/dependabot/alerts?state=open' --jq 'length'
gh api 'repos/jimoto-no-llm/rustdsh/code-scanning/alerts?state=open' --jq 'length'
gh api repos/jimoto-no-llm/rustdsh/rulesets
gh label list --repo jimoto-no-llm/rustdsh --limit 100
gh release view --repo jimoto-no-llm/rustdsh --json tagName,isDraft,isPrerelease,assets
```

Expected: nine required checks, `strict` and `require_last_push_approval` false,
one approval with stale dismissals, conversation resolution on, both alert counts
zero, and a published `latest` release with twelve assets.

Use GitHub's repository settings to edit administrative values, then update their
source configuration in a reviewed PR. When adding required check names, confirm
they exist on the new PR commit before enforcing them. Preserve existing review
requirements and do not use path-filtered jobs as global required checks.
