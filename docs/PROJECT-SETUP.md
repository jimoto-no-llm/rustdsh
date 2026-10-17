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

Required checks (GitHub Actions app, ten names):

`Rust lint`, `release-policy`, `crate-package`, `plugin-security`,
`security-boundaries`, `update-banner-windows`, `test (ubuntu-latest, true)`,
`test (macos-latest, true)`, `test (windows-latest, false)`, `browser-e2e`.

`crate-package` runs on every pull request, so it can be required: it packages
the crate and rebuilds it from the packaged file list without contacting the
registry.

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

## crates.io publication

`cd` publishes `rdsh` to crates.io from the same annotated tag that publishes
the GitHub release, in the `publish-crate` job. It runs after the release assets
are up, requires the tag to match the `Cargo.toml` version, and skips a version
the registry already has, so re-running the job is safe.

Two rules keep that job working:

- **The crate stays under the 10 MB crates.io limit.** The `exclude` list in
  [Cargo.toml](../Cargo.toml) drops the media, docs, dashboard and test trees
  because the release archives ship the binary alone; `src/`, `assets/`,
  `security/` and `install.sh` remain because `build.rs` and the `include_str!`
  / `include_bytes!` calls read them at compile time.
  `scripts/crate-release.py check` fails when a required input goes missing or a
  release-only tree creeps back in, and `ci.yml` runs it as `crate-package`.
- **The `CARGO_REGISTRY_TOKEN` secret must exist.** Create the token on the
  crates.io account settings page and store it once with
  `gh secret set CARGO_REGISTRY_TOKEN`. A missing token fails the job with that
  instruction instead of publishing nothing silently; add the secret and re-run
  the failed job rather than recreating the tag.

Verify what the registry has:

```sh
python3 scripts/crate-release.py check --tag vX.Y.Z
cargo info rdsh          # registry metadata for the published version
```

## Coverage

The [Codecov Coverage workflow](../.github/workflows/codecov.yml) runs
`cargo tarpaulin --workspace --out xml` on pushes to `main` and on pull
requests that target it, then uploads `cobertura.xml` with
`codecov/codecov-action`. [codecov.yml](../codecov.yml) follows Codecov's
recommended project and patch statuses (`target: auto`) and the condensed,
diff-first PR comment, posted on every pull request. Neither status is a
required check, so a regression is reported without blocking a merge; adding
`informational: true` makes either status advisory again if it turns out noisy.

The upload needs the repository upload token. Codecov rejects tokenless uploads
to a protected branch with `Token required because branch is protected`, which
is what the first runs on `main` reported; generate the token on the
repository's Codecov settings page and store it as the `CODECOV_TOKEN` secret
(`gh secret set CODECOV_TOKEN`). Fork pull requests have no secret, so a
missing token is reported as a workflow warning instead of a silent skip, and
`fail_ci_if_error` stays false so a Codecov outage cannot fail an otherwise
green run.

Coverage is intentionally not in `required_checks`: it is a new signal, and an
upload outage must not block unrelated pull requests. Promote it there only after
its runs on `main` are stable.

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

## Automation and review bots

- **Copilot code review** reviews pull requests (the registered
  `dynamic/agents/copilot-pull-request-reviewer` workflow is active). Treat its
  comments as review input; the required approving review stays human.
- **Dependabot** opens weekly update pull requests for Cargo, every npm manifest
  listed in [.github/dependabot.yml](../.github/dependabot.yml) and GitHub
  Actions. `dependabot-automerge.yml` enables auto-merge for patch and minor
  updates only: the required approval and every required check still apply, and
  major updates stay manual.
- **CodeQL** and **rust-audit** keep the security page at zero open alerts.
- **labels** syncs [.github/labels.yml](../.github/labels.yml) on `main`;
  **conflicts** labels an open pull request that no longer merges cleanly;
  **pin-release-digests** opens the ledger pull request after a release;
  **codecov** reports coverage without blocking a merge.
- Workflow secrets: `CODECOV_TOKEN` (coverage upload) and
  `CARGO_REGISTRY_TOKEN` (crates.io publication). Everything else uses the
  automatic `GITHUB_TOKEN`; no bot needs a personal access token.

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

Expected: ten required checks, `strict` and `require_last_push_approval` false,
one approval with stale dismissals, conversation resolution on, both alert counts
zero, and a published `latest` release with twelve assets.

Use GitHub's repository settings to edit administrative values, then update their
source configuration in a reviewed PR. When adding required check names, confirm
they exist on the new PR commit before enforcing them. Preserve existing review
requirements and do not use path-filtered jobs as global required checks.
