# Package managers (Homebrew, Scoop, winget)

rdsh ships prebuilt archives for macOS and Windows, so users on those hosts can
let a package manager own the installed binary instead of running `install.sh`
or `install.ps1`. The manifests live in `packaging/` and always pin one exact
release: version, download URL and SHA-256, taken from the published assets.

These channels are for advanced users. The one-line installers stay the default
route:

```sh
curl -fsSL https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/install.sh | bash -s -- --from-release
```

## What is in the repository

| File | Channel | Pinned asset |
| --- | --- | --- |
| [packaging/homebrew/rdsh.rb](../packaging/homebrew/rdsh.rb) | Homebrew (macOS) | `rdsh-macos-arm64.tar.gz`, `rdsh-macos-x64.tar.gz` |
| [packaging/scoop/rdsh.json](../packaging/scoop/rdsh.json) | Scoop (Windows) | `rdsh-windows-x64.zip` |
| [packaging/winget/jimoto-no-llm.rdsh.yaml](../packaging/winget/jimoto-no-llm.rdsh.yaml) | winget (Windows) | `rdsh-windows-x64.zip` |

Every file is generated. Do not edit the version or the SHA-256 values by hand;
see [Updating the manifests](#updating-the-manifests).

## Homebrew

The formula installs the matching macOS archive (Apple Silicon or Intel) and
puts `rdsh` on `PATH` with `bin.install "rdsh"`:

```sh
brew install --formula ./packaging/homebrew/rdsh.rb
```

The formula is macOS-only (`depends_on :macos`); Linux users keep the one-line
installer or build from source.

This repository does not publish a Homebrew tap. If you mirror the formula into
one, the tap route is the usual form:

```sh
brew install <owner>/<tap>/rdsh
```

The formula declares `version` explicitly because its two URLs are selected by
architecture, which Homebrew cannot infer from a single URL.

## Scoop

```powershell
scoop install https://raw.githubusercontent.com/jimoto-no-llm/rustdsh/main/packaging/scoop/rdsh.json
```

The manifest declares `"bin": "rdsh.exe"` so the shim lands next to the other
Scoop apps. It also carries `checkver` (the GitHub release tag) and
`autoupdate`, which re-downloads the archive and verifies it against the
published `rdsh-windows-x64.zip.sha256` sidecar. `scoop update rdsh` therefore
picks up a new release without a manifest edit; `scoop checkver rdsh` reports
when one exists.

## winget

winget reads the three manifests in `packaging/winget/` directly:

```powershell
winget install --manifest .\packaging\winget
```

The installer entry uses `InstallerType: zip` with
`NestedInstallerType: portable` and maps `rdsh.exe` to the `rdsh` command, so
nothing is written outside the winget package location. The submitted package
identifier is `jimoto-no-llm.rdsh`, and `Publisher` matches that prefix so the
`microsoft/winget-pkgs` folder layout is unambiguous.

Submission to `microsoft/winget-pkgs` is a manual, user-owned step; this
repository does not submit it:

1. Copy the three files into `manifests/j/jimoto-no-llm/rdsh/<version>/` (keep
   the file names; they must match the package identifier).
2. Run `winget validate --manifest .\manifests\j\jimoto-no-llm\rdsh\<version>`
   and `winget install --manifest ...` on a Windows host (winget 1.6 or newer).
3. Open a pull request against `microsoft/winget-pkgs` titled
   "New package: jimoto-no-llm.rdsh version <version>".

### What was verified without those tools

The maintainers' hosts have no `brew`, `scoop` or `winget`, so the manifests are
verified by other means:

| Channel | Verification |
| --- | --- |
| Homebrew | `ruby -c` on the formula (Ruby 3 in a container), then the URL and SHA-256 of both archives checked with `curl` and `sha256sum` |
| Scoop | JSON validated against the upstream `ScoopInstaller/Scoop` schema, then the URL and hash checked |
| winget | YAML validated against the official `microsoft/winget-cli` 1.6.0 JSON schemas, then the URL and hash checked |

`tests/test_release_packaging_manifests.py` additionally proves that the
committed files are exactly what the generator renders and that every pinned
URL and digest agrees with `release-digests.tsv` and
`release-digests-windows.tsv`.

## Updating the manifests

Each manifest is bound to one release, so a new tag leaves them stale until they
are regenerated. The generator reads the pinned digest registries and the
CHANGELOG date, and never downloads anything:

```sh
python3 scripts/pin-release-digests.py vX.Y.Z          # first, if not pinned yet
python3 scripts/update-packaging-manifests.py --version vX.Y.Z
python3 scripts/update-packaging-manifests.py --check  # 0 when nothing is stale
```

Without `--version` the generator uses the `latest` row of
`release-digests.tsv`, and `--check` without `--version` verifies the version
the committed manifests already pin, so a freshly pinned release does not turn
the check red before the manifests are deliberately bumped.

## Related documents

- [docs/RELEASING.md](RELEASING.md) — the release procedure this step follows.
- [docs/AUTO-UPDATE.md](AUTO-UPDATE.md) — the built-in updater, which is
  independent of these channels.
