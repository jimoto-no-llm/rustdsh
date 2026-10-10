# Project settings

The canonical repository is [jimoto-no-llm/rustdsh](https://github.com/jimoto-no-llm/rustdsh).
Repository metadata and intended required checks are recorded in
[.github/project-settings.json](../.github/project-settings.json).
GitHub administrative settings are applied separately from merging configuration
files; changing the JSON file alone does not change repository settings.

## Discovery and maintenance

- The repository description describes local Rust tools, an MCP project dashboard
  for Claude Code/Codex, and the DSH launcher. Topics cover Rust, DSH, DeepSeek,
  CLI, dashboard, performance, MCP, Claude Code and Codex. The homepage points to
  the README's getting-started section. Local tools and project MCP need no DSH;
  DSH-only runtime controls remain explicit in the adapter catalog.
- Merged PR branches are automatically deleted; local checkouts are unaffected.
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

`main` keeps the existing requirement for one approving review, dismisses stale
approvals and requires the last push to be approved by someone else. Required
checks use the GitHub Actions app and require the branch to be up to date.
The Rust lint job has a distinct name so docs lint cannot satisfy it.
Conversations must be resolved before merge. Force pushes and deletion remain
disabled. The existing administrator bypass remains available for recovery.

Only checks that run on every PR are required. Docs and dashboard workflows have
path filters; requiring their individual jobs globally would leave unrelated PRs
waiting forever. Their results still need review when those areas change.

The [release tag ruleset](../.github/tag-ruleset.json) applies to `refs/tags/v*`.
It blocks updates and deletion without bypass actors, while allowing new tags.
It does not add or move existing tags. Release publication follows
[RELEASING.md](RELEASING.md) and the v0.2.0 format.

## Security settings

Dependabot vulnerability alerts, automated security updates, secret scanning and
secret scanning push protection are enabled in GitHub. Private vulnerability
reporting is enabled so external users can report without opening a public issue.
CodeQL remains in its existing workflow. Report vulnerabilities through
[SECURITY.md](../SECURITY.md).

## Verify the live settings

```sh
gh api repos/jimoto-no-llm/rustdsh --jq '{description,homepage,topics,delete_branch_on_merge,security_and_analysis}'
gh api repos/jimoto-no-llm/rustdsh/branches/main/protection
gh api repos/jimoto-no-llm/rustdsh/rulesets
gh label list --repo jimoto-no-llm/rustdsh --limit 100
gh release view v0.2.0 --repo jimoto-no-llm/rustdsh
```

Use GitHub's repository settings to edit administrative values, then update their
source configuration in a reviewed PR. When adding required check names, confirm
they exist on the new PR commit before enforcing them. Preserve existing review
requirements and do not use path-filtered jobs as global required checks.
