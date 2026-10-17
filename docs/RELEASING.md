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

## Release cadence

Ship small: a change that lands on `main` goes out on its own instead of waiting
for a milestone, and the version follows semantic versioning, so the bump is
chosen from what users can do after the release.

| Bump | When | Typical changes |
| --- | --- | --- |
| **patch** `vX.Y.(Z+1)` | The default. Nothing new for users to learn. | Bug fixes, documentation, dependency updates, internal improvements, small UX adjustments. |
| **minor** `vX.(Y+1).0` | An important addition users notice. | A new command or feature, a new distribution channel, a change to a default users can see, security hardening users recognise. |
| **major** `v(X+1).0.0` | A breaking change. | While the project is `0.x` there is no `1.0.0` yet, so a breaking change takes a minor bump exactly as the existing `0.x` releases do; the CHANGELOG entry and the release notes must still say so. |

When in doubt, ask whether a user would recognise the change as a new feature:
if yes, it is a minor. Leave one line in the release notes saying why that
version was chosen; `docs/releases/vX.Y.Z.md` starts from the automatic
decision, so keep or correct that line.

Every release empties `[Unreleased]`: promote the whole section into the dated
`## [X.Y.Z] - YYYY-MM-DD` entry, then start appending to a fresh, empty
`[Unreleased]` right away. An entry left behind never reaches that release's
notes.

[.github/workflows/release-cadence.yml](../.github/workflows/release-cadence.yml)
runs daily and, once `[Unreleased]` has content, pushes `release/vX.Y.Z-prep`
with the version bump, the CHANGELOG promotion and a notes skeleton, then opens
the preparation pull request (or, while Actions cannot create pull requests, an
issue naming the branch and the next step). It never tags. The bump is decided
the same way as this table: a `### Added` section in `[Unreleased]`, or a
merged pull request labelled `feature`, `enhancement` or `breaking` since the
previous tag, is a minor; anything else is a patch. The decision and its reason
are recorded in the preparation pull request.

**Tag on the exact SHA whose required checks are green.** Create the annotated
`vX.Y.Z` tag only after the preparation pull request is merged and that commit's
required checks have passed; never tag a branch tip that changed after the checks
ran, and never move or delete a published tag. The generated
`docs/releases/vX.Y.Z.md` is a skeleton: review its summary and compatibility
notes, and start the next `[Unreleased]` entry as soon as the release is out.

## Prepare and verify

1. Create a release preparation PR against `main`. Update `Cargo.toml`, refresh
   `Cargo.lock` with `cargo check`, then verify with `cargo check --locked`.
   Move released changes out of `Unreleased`, and date the new CHANGELOG entry.
2. Copy `docs/releases/TEMPLATE.md` to the version's filename and fill in every
   placeholder. Keep Japanese user-facing notes, platform limits and installation
   commands accurate. For candidates, replace `/releases/latest/download/` with
   `/releases/download/vX.Y.Z-rc.N/` and pass `--version=vX.Y.Z-rc.N` to the
   Unix installer or `-Version vX.Y.Z-rc.N` to the Windows installer. Downloading
   a candidate's installer alone does not select its binary: both installers
   otherwise fetch `latest`. Keep the selectors on the actual commands in code
   blocks or inline code, rather than only in explanatory prose. Candidate examples:

   ```sh
   curl -fsSL https://github.com/jimoto-no-llm/rustdsh/releases/download/vX.Y.Z-rc.N/install.sh | bash -s -- --from-release --version=vX.Y.Z-rc.N
   ```

   Download `install.ps1` from the same candidate release, then run:

   ```powershell
   ./install.ps1 -FromRelease -Version vX.Y.Z-rc.N
   ```

3. Run the metadata and packaging checks (Python 3.11+):

   ```sh
   python3 scripts/prepare-release.py vX.Y.Z
   python3 -m unittest discover -s tests -p 'test_release_*.py'
   ```

   On a machine with podman or docker, also install the built artifacts inside
   clean containers. This is the check that keeps a fresh-machine install
   working on older glibc distros and musl hosts, so run it before tagging:

   ```sh
   tests/install-isolated.sh --source local --require-musl
   ```

   The same harness with `--source published --installer published` checks the
   installer users actually download; `.github/workflows/install-live.yml` runs
   it weekly. A failure there means the published channel is broken and needs a
   new release, not a tag move.

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

   Tag push starts the release workflow and the normal `ci.yml` push workflow.
   The release workflow verifies that the tag resolves to the exact pushed SHA,
   that SHA is an ancestor of `main`, and the `ci.yml` run triggered by that
   exact tag push completed successfully. It waits up to 15 minutes for that
   run, then requires every required check on the tagged commit to be present
   and successful. Missing, queued, in-progress, failed, or cancelled CI blocks
   release builds and publication. `publish` waits for both this validation and
   all release matrix builds. Never tag an unreviewed commit.
   If the tag-push CI needs longer than the wait window, re-run only the failed
   `cd` jobs once it finishes; the staged artifacts are reused:

   ```sh
   gh run rerun <cd-run-id> --failed
   ```

## Build and publish

The `cd` workflow first refuses malformed or lightweight tags, tags outside
`main`, tags whose exact-SHA tag-push CI is missing or unsuccessful, mismatched
versions, missing CHANGELOG entries and incomplete release notes. It also
requires every required check on the tagged commit to be successful, then builds
its five matrix targets with `cargo build --locked --release` only after those
gates pass; the `packages` job rebuilds the x86_64 glibc target once more for
nfpm.
After the exact-tag CI wait, the gate queries the pinned `ci.yml` and `codeql.yml`
workflows, using only push runs for the exact SHA on `main` or the release tag. It selects
by GitHub's per-workflow `run_number`, then verifies `run_attempt` and the latest
execution of each required job within that run. A failed-jobs-only rerun can
retain earlier successful jobs; a newer queued job cannot reuse an older result.
Missing or malformed identity/attempt metadata, incomplete API pages, skipped
jobs and changing run snapshots all fail closed. Nullable check start times and
workflow display names are not ordering or identity evidence.

Tag pushes also trigger `ci.yml`. The earlier wait requires that exact tag-push
run to appear and succeed before this gate can accept main/tag push evidence.
If it is still missing or running after 15 minutes, validation refuses publication;
wait for it to finish, then rerun the failed CD validation job. After all job
reads, the gate re-lists the workflow runs and re-reads the selected run to detect
a newer run or attempt. This is a
checked snapshot, not an atomic lock against a later rerun after validation.
Validation uses `actions: read` and `contents: read`; only the final publication
job receives `contents: write`. The dependency chain keeps its shape: `publish`
still runs last, now after both `release` and `packages`.

GitHub documents the stable run number and increasing attempt number in its
[variables reference](https://docs.github.com/en/actions/reference/workflows-and-actions/variables).
The [workflow jobs API](https://docs.github.com/en/rest/actions/workflow-jobs)
provides all job executions, including previous attempts. The required workflow
files and job names live in `scripts/release_ci.py`; workflow/job-name changes
must update that mapping and its tests:

| Platform | Asset |
| --- | --- |
| Linux x86_64 (glibc) | `rdsh-linux-x64.tar.gz` |
| Linux x86_64 (musl) | `rdsh-linux-x64-musl.tar.gz` |
| macOS arm64 | `rdsh-macos-arm64.tar.gz` |
| macOS x86_64 | `rdsh-macos-x64.tar.gz` |
| Windows x86_64 | `rdsh-windows-x64.zip` |
| Linux x86_64 (`.deb`) | `rdsh_<version>_amd64.deb` |
| Linux x86_64 (`.rpm`) | `rdsh-<version>-1.x86_64.rpm` |

Each archive has its own `.sha256` sidecar, but neither installer trusts it:
both verify the archive against the reviewed digest ledgers described below.
`install.sh` and `install.ps1` are added once, and the `packages` job adds
one `.deb` and one `.rpm` with the same kind of sidecar, for **16 release
assets** total. The packages are built from `packaging/nfpm.yaml` by a pinned
nfpm (`go install github.com/goreleaser/nfpm/v2/cmd/nfpm@v2.48.0`) on the same
x86_64 glibc build as the Linux archive, and they stay out of both digest
ledgers: `install.sh` and `install.ps1` read the archives only. Builds stage
Actions artifacts; only the final job has permission to write a release. It
validates the complete local set, creates or reuses a draft, uploads once,
downloads the actual uploaded assets and validates them again. Incomplete or
corrupt assets stop publication.

Stable versions publish as `latest`. Candidates publish with `prerelease=true`
and `latest=false`, preserving the current stable installer channel. The workflow
refuses to overwrite a published release. Draft retries compare existing assets
with the verified local set, reuse identical files and upload only missing files.
Any differing or unexpected asset stops the retry before upload; no asset is
deleted or overwritten. A rebuilt archive may differ even at the same tag, so
rerun only failed jobs while the original staged artifacts remain available
(seven days) rather than rebuilding the successful jobs. Concurrent
runs for the same tag are serialized and never cancel an upload in progress.

Release archives are pinned in two ledgers, both fetched from the fixed
canonical `raw.githubusercontent.com/jimoto-no-llm/rustdsh/main` URL:

| Ledger | Pins | Reader |
| --- | --- | --- |
| `release-digests.tsv` | the four Unix `.tar.gz` archives | `install.sh --from-release`, `sync-dsh.sh` |
| `release-digests-windows.tsv` | `rdsh-windows-x64.zip` | `install.ps1 -FromRelease` |

The split is a compatibility rule, not a preference: the published v0.3.3
`install.sh` and every `sync-dsh.sh` copy in users' checkouts refuse
`release-digests.tsv` as a whole as soon as one row names an asset outside the
four Unix archives. Adding the Windows pin there breaks `--from-release` and the
automatic updater for installs users already have, so that file stays Unix-only
and the Windows pin lives in its own ledger. Neither installer trusts a checksum
served by `RDSH_RELEASE_BASE`; the only override is the test-only
`RDSH_RELEASE_DIGESTS`, which a `file://` release base may use and a remote base
never does (`install.ps1` gates it the same way). `install.ps1` refuses its
whole ledger when `latest` does not pin the Windows archive, and the Unix
ledger's `latest` completeness rule stays the four Unix archives.

After verifying a published release, update both `latest` rows and add each
archive's GitHub-reported SHA-256 in a reviewed follow-up PR before announcing
or directing users to install that release. Keep older rows for explicit
`--version` installs. Do not derive pins from release `.sha256` sidecars.

The same tag publishes the crate to crates.io. The `publish-crate` CD job runs
after the release is published, requires `vX.Y.Z` to match the `Cargo.toml`
version, refuses a crate outside the 10 MB crates.io limit, and skips a version
the registry already has. It fails closed while `CARGO_REGISTRY_TOKEN` is unset;
create the token on crates.io, store it once with
`gh secret set CARGO_REGISTRY_TOKEN`, and re-run the failed job instead of
recreating the tag. Verify the upload with:

```sh
python3 scripts/crate-release.py check --tag vX.Y.Z
cargo info rdsh          # registry metadata for the published version
```

After publication, confirm the body, 16 assets and correct channel in GitHub.
Download and verify the actual published assets:

```sh
gh release download vX.Y.Z --repo jimoto-no-llm/rustdsh --dir /tmp/rdsh-vX.Y.Z-assets
python3 scripts/verify-release-assets.py /tmp/rdsh-vX.Y.Z-assets
```

For the installer registries, pin the published digests in one reviewed commit:

```sh
python3 scripts/pin-release-digests.py vX.Y.Z          # --dry-run to preview
python3 -m unittest discover -s tests -p 'test_release_digest_pin.py'
git diff release-digests.tsv release-digests-windows.tsv  # latest rows + 5 archives
```

The script reads GitHub's own asset digests (`gh release view --json assets`
does not expose them), writes the four Unix archives to `release-digests.tsv`
and `rdsh-windows-x64.zip` to `release-digests-windows.tsv`, updates both
`latest` rows, keeps older rows for explicit `--version` installs, and refuses
prerelease tags unless explicitly enabled, missing archives or values that are not a SHA-256. Pinning an
older release only backfills its rows: each `latest` row moves forward only, so
re-pinning a past version never moves the install and automatic-update channel
backwards. Raw list:

```sh
gh api repos/jimoto-no-llm/rustdsh/releases/tags/vX.Y.Z \
  --jq '.assets[]|"\(.name) \(.digest)"'
```

After publication, the `pin-release-digests` workflow runs this script on `main`
and opens the `chore/pin-<tag>-digests` PR automatically: review both ledgers and
merge it. Prereleases are skipped, and a release that is already pinned opens no
PR.

候補版の公開後は、全5アーカイブのGitHub asset digestが揃ってから明示的に登録します。
自動workflowは引き続きstableのみを扱います。

```sh
python3 scripts/pin-release-digests.py vX.Y.Z-rc.N --allow-prerelease --dry-run
python3 scripts/pin-release-digests.py vX.Y.Z-rc.N --allow-prerelease
git diff release-digests.tsv release-digests-windows.tsv
```

候補行を追加しても両台帳の`latest`は既存のstableを保持し、その後のstable登録でも
候補行を残します。完全なstableの`latest`がない台帳への候補だけの初回登録は拒否します。
登録内容をレビューしてmainへ統合するまで、明示tagの候補導入も取得前に安全に拒否されます。

Review both updated ledgers before announcing the new stable channel. Their
`latest` rows must name the release GitHub marks Latest.

The package-manager manifests in `packaging/` pin the same release, so refresh
them in the same follow-up and review the regenerated files:

```sh
python3 scripts/update-packaging-manifests.py --version vX.Y.Z
python3 -m unittest discover -s tests -p 'test_release_packaging_manifests.py'
```

[docs/PACKAGE-MANAGERS.md](PACKAGE-MANAGERS.md) describes the Homebrew, Scoop
and winget channels and what each manifest pins.

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
