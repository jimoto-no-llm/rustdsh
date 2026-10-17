# rustdsh project conventions

The canonical repository is `jimoto-no-llm/rustdsh`; new repository, API,
installer and badge links use that owner. Keep historical evidence intact.

## Release work

- Follow `docs/RELEASING.md` and the published `docs/releases/v0.2.0.md` format:
  Japanese summary, update/compatibility notes, Unix and Windows installation,
  generated PR/author list and Full Changelog.
- Create version notes from `docs/releases/TEMPLATE.md`. Keep `Cargo.toml`,
  `Cargo.lock`, the dated CHANGELOG entry and `vX.Y.Z` tag consistent.
- Release cadence: semver — an important addition takes a minor (e.g. `v0.7.0`)
  and a fix-only release takes a patch (e.g. `v0.6.1`); every release empties `[Unreleased]`.
- Before tagging, run `python3 scripts/prepare-release.py vX.Y.Z` and
  `python3 -m unittest discover -s tests -p 'test_release_*.py'`, followed by
  the verification matrix in `CONTRIBUTING.md`.
- Use annotated tags. Never move or delete published tags or overwrite release
  assets. Candidates use exact-tag installer URLs and never replace `latest`.
- Preserve all five platform archives, their SHA256 sidecars, both installers
  and the `.deb`/`.rpm` native packages. Publication belongs to the final CD
  job after upload verification.
- Publication is not finished until the digests are pinned: merge the pull
  request the `pin-release-digests` workflow opens, or run
  `python3 scripts/pin-release-digests.py vX.Y.Z`. Installers and the automatic
  updater only resolve releases pinned in `release-digests.tsv` and
  `release-digests-windows.tsv`, and `latest` moves forward only.
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

## Working agreements

- Pull requests keep the four-line body (概要 / 変更 / 検証 / 注意点) and stay
  green: `cargo fmt --check`, clippy with zero warnings, the tests the change
  touches, and `tests/regress.sh` for behavior changes.
- Required checks, review rules and the administrator bypass are documented in
  [docs/PROJECT-SETUP.md](docs/PROJECT-SETUP.md). Never merge a pull request with
  unresolved review threads: read the head commit against each thread, reply with
  the evidence, and resolve it — do not bypass it with `--admin`.
- Keep the security page at zero open alerts. Dependabot, CodeQL and secret
  scanning are the sources; every npm manifest directory belongs in
  `.github/dependabot.yml`, and an alert is only dismissed with a recorded
  reason (see `docs/PROJECT-SETUP.md`).
- The Web UI update notice is dismissed per update event. A dismissed notice for
  an already applied update must not come back; only a new `at`/`to` notifies
  again. Its state lives in `~/.local/share/rdsh/` (`update-state.json`,
  `update-notice-close.json`).
- Parallel work uses one `git worktree` per pull request, `TMPDIR=/var/tmp` and a
  per-worktree `CARGO_TARGET_DIR`. Never commit or revert another agent's
  uncommitted files, and push branches that change `.github/workflows/` over SSH
  (`git@github.com:jimoto-no-llm/rustdsh.git`).
- The marketing and evidence docs follow their own format rules; runtime behavior
  changes belong in `docs/` next to the feature they describe, not in AGENTS.md.

## Branch and PR maintenance

- Reuse the existing topic branch and PR for related work; combine trivial lint
  edits instead of creating one branch and PR per substitution.
- Before removing branches, fetch the current refs and inspect every open PR and
  worktree. Never remove active, open-PR, unmerged, `release/`, or `archive/` branches.
  Bundle existing refs before pruning stale remote-tracking references, and compare
  live remote heads rather than treating cached refs as GitHub branches.
- `scripts/prune-merged-branches.py` reports candidates by default. Applying a
  plan requires an external backup directory and verifies a Git bundle first.
- Preserve issue labels, assignments and unresolved acceptance requirements;
  merged code alone does not prove that an entire feature issue is complete.
