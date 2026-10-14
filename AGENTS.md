# rustdsh project conventions

The canonical repository is `jimoto-no-llm/rustdsh`; new repository, API,
installer and badge links use that owner. Keep historical evidence intact.

## Release work

- Follow `docs/RELEASING.md` and the published `docs/releases/v0.2.0.md` format:
  Japanese summary, update/compatibility notes, Unix and Windows installation,
  generated PR/author list and Full Changelog.
- Create version notes from `docs/releases/TEMPLATE.md`. Keep `Cargo.toml`,
  `Cargo.lock`, the dated CHANGELOG entry and `vX.Y.Z` tag consistent.
- Before tagging, run `python3 scripts/prepare-release.py vX.Y.Z` and
  `python3 -m unittest discover -s tests -p 'test_release_*.py'`, followed by
  the verification matrix in `CONTRIBUTING.md`.
- Use annotated tags. Never move or delete published tags or overwrite release
  assets. Candidates use exact-tag installer URLs and never replace `latest`.
- Preserve all five platform archives, their SHA256 sidecars, and both installers.
  Publication belongs to the final CD job after upload verification.
- A project settings change does not itself request a new version release.

## Development

- Set up a checkout with `sh scripts/dev-setup.sh`; verify with
  `sh scripts/check.sh` (`quick` / `full` modes) before opening a PR.
- Branch from a fresh `origin/main`, one topic per branch and one writer per
  worktree. Run `sh scripts/check-conflicts.sh --open-prs` before pushing and
  coordinate when another open PR touches the same files.
- Keep changes local to the feature: new modules and test files rather than
  growing `src/main.rs` or shared test files; no drive-by reformatting.
- Resolve lockfile conflicts by taking `main`'s file and regenerating it.
  Details: `docs/DEVELOPMENT.md`.

## Repository configuration

- Managed labels live in `.github/labels.yml`; the labels workflow syncs changes
  on `main`. `scripts/sync-labels.sh` also supports manual sync via `gh`.
- `P0`–`P3` express priority; component/type labels describe the work. Preserve
  existing labels and issue assignments when adding definitions.
- Keep release changes focused and preserve unrelated working-tree edits.
