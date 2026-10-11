# Releasing

## Release contract

The canonical repository is [jimoto-no-llm/rustdsh](https://github.com/jimoto-no-llm/rustdsh).
Use Semantic Versioning and **annotated** tags: `vX.Y.Z` for stable versions,
`vX.Y.Z-rc.N` (or `alpha.N` / `beta.N`) for candidates. The tag, `Cargo.toml`,
the `rdsh` entry in `Cargo.lock`, and the dated CHANGELOG entry must agree.
The private dashboard package has its own version and is not a release binary.

Published [v0.2.0](releases/v0.2.0.md) defines the format for future releases:

1. `## X.Y.Z — short summary` and a concise list of changes.
2. `## 更新前に確認`: supported platforms, runtime requirements, compatibility,
   migration and restart instructions. Explicitly state when no migration is needed.
3. `Install/update:`: Unix command and Windows `install.ps1 -FromRelease` instructions.
4. GitHub-generated `What's Changed`: merged PR links and author credits,
   optional `New Contributors`, and `Full Changelog` comparison.
5. A link to the repository CHANGELOG.

Author the first three parts in `docs/releases/vX.Y.Z.md` using
[TEMPLATE.md](releases/TEMPLATE.md). The workflow appends the generated parts
using [.github/release.yml](../.github/release.yml). Keep a single PR list as
in v0.2.0; do not drop contributors or manually copy a previous version's PRs.
The script replaces any existing generated tail, so reruns do not duplicate it.
Generation failure stops publication.

## Prepare and verify

1. Create a release preparation PR against `main`. Update `Cargo.toml`, refresh
   `Cargo.lock` with `cargo check`, then verify with `cargo check --locked`.
   Move released changes out of `Unreleased`, and date the new CHANGELOG entry.
2. Copy `docs/releases/TEMPLATE.md` to the version's filename and fill in every
   placeholder. Keep Japanese user-facing notes, platform limits and installation
   commands accurate. For candidates, replace `/releases/latest/download/` with
   `/releases/download/vX.Y.Z-rc.N/`.
3. Run the metadata and packaging checks (Python 3.11+):

   ```sh
   python3 scripts/prepare-release.py vX.Y.Z
   python3 -m unittest discover -s tests -p 'test_release_*.py'
   ```

4. Run the [full verification matrix](../CONTRIBUTING.md), including Rust fmt,
   clippy, release tests, regression checks, dashboard tests and browser E2E.
   Merge the reviewed preparation PR only after the required checks pass. Wait
   for all required checks on the exact resulting `main` commit to complete
   successfully before tagging it; the release workflow rechecks that commit's
   main ancestry and CI status before it starts the platform builds.
5. Preview the exact release body with an authenticated `gh` CLI:

   ```sh
   python3 scripts/prepare-release.py vX.Y.Z --repo jimoto-no-llm/rustdsh --previous-tag vPREVIOUS --output /tmp/rdsh-release-notes.md
   ```

   This generates a local file; it does not create a tag or publish a release.
   Check the PR range, author credits, comparison URL and installation commands.
   To select a comparison base, first record `<!-- previous-tag: vPREVIOUS -->`
   in the authored part of the version's notes. Preview and automated publication
   both read it. `--previous-tag` may confirm the recorded value, but cannot
   override it. Without the comment, omit this flag and GitHub selects the base.
6. From the verified release commit, create and push an annotated tag:

   ```sh
   git tag -a vX.Y.Z -m "rustdsh vX.Y.Z: short summary"
   git push origin vX.Y.Z
   ```

   Tag push starts the `cd` workflow automatically. Its validation job must pass
   before builds start, and publication waits for every build and asset check.
   Never tag an unreviewed or untested commit.

## Build and publish

The `cd` workflow first refuses malformed or lightweight tags, mismatched
versions, missing CHANGELOG entries, incomplete release notes, commits outside
`main`, and commits whose latest required checks are missing, pending or failed.
It builds five targets with `cargo build --locked --release` only after those
checks pass. The exact required check names live in `scripts/release_ci.py`; CI
workflow job-name changes must update that list and its tests:

| Platform | Archive |
| --- | --- |
| Linux x86_64 (glibc) | `rdsh-linux-x64.tar.gz` |
| Linux x86_64 (musl) | `rdsh-linux-x64-musl.tar.gz` |
| macOS arm64 | `rdsh-macos-arm64.tar.gz` |
| macOS x86_64 | `rdsh-macos-x64.tar.gz` |
| Windows x86_64 | `rdsh-windows-x64.zip` |

Each archive has its own `.sha256` sidecar. `install.sh` and `install.ps1`
are added once, for **12 release assets** total. Builds stage Actions artifacts;
only the final job has permission to write a release. It validates the complete
local set, creates or reuses a draft, uploads once, downloads the actual uploaded
assets and validates them again. Incomplete or corrupt assets stop publication.

Stable versions publish as `latest`. Candidates publish with `prerelease=true`
and `latest=false`, preserving the current stable installer channel. The workflow
refuses to overwrite a published release. Draft retries compare existing assets
with the verified local set, reuse identical files and upload only missing files.
Any differing or unexpected asset stops the retry before upload; no asset is
deleted or overwritten. A rebuilt archive may differ even at the same tag, so
rerun only failed jobs while the original staged artifacts remain available
(seven days) rather than rebuilding the successful jobs. Concurrent
runs for the same tag are serialized and never cancel an upload in progress.

After publication, confirm the body, 12 assets and correct channel in GitHub.
Download and verify the actual published assets:

```sh
gh release download vX.Y.Z --repo jimoto-no-llm/rustdsh --dir /tmp/rdsh-vX.Y.Z-assets
python3 scripts/verify-release-assets.py /tmp/rdsh-vX.Y.Z-assets
```

Test README installation commands in a clean environment. Announcements use the
published notes. Failed builds leave staged artifacts; failed uploads or verification
leave a draft. Never manually publish an incomplete draft.

## Hotfixes and tag protection

Branch from the published tag, apply the fix through a reviewed PR, bump the patch
version, update the CHANGELOG and notes, and create a **new** annotated tag.
When the release range differs from the previous release, preview using the correct
`previous-tag` comment in the release notes. Preview and publication then use the
same range even when a newer release already exists.

Never move or delete a published tag. The repository's `Protect release tags`
ruleset blocks updates and deletion of `v*` tags; it allows creating new tags.
The source configuration is [.github/tag-ruleset.json](../.github/tag-ruleset.json).
Do not repush an existing tag to rerun CD: retry failed jobs in Actions, or publish
a corrected patch version if the release is already public.
