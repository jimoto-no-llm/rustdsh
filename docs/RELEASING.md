# Releasing

## Versioning

Semantic Versioning. Tags look like `v0.1.2` and drive the `cd` workflow.

## Checklist

1. Update version: `Cargo.toml`, `Cargo.lock` (`cargo build` refreshes it).
2. Update `CHANGELOG.md` and create `docs/releases/vX.Y.Z.md` with release notes,
   including changes to supported platforms or agent behavior.
3. Verify green: `cargo fmt --check`, `cargo clippy --all-targets` (zero warnings),
   `cargo test`, `tests/regress.sh`, dashboard `npm ci && npm test`.
4. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. The `cd` workflow builds 5 targets and uploads to a draft release:
   `rdsh-linux-x64.tar.gz`, `rdsh-linux-x64-musl.tar.gz`, `rdsh-macos-arm64.tar.gz`,
   `rdsh-macos-x64.tar.gz`, `rdsh-windows-x64.zip`, plus `install.sh` /
   `install.ps1` (Linux job only, to avoid upload races).
6. After all builds succeed, the publish job verifies every expected asset and
   checksum, applies the release notes, and publishes the release as latest.
   Confirm the one-liners from README install from the new release.
7. Announce using the published notes. Failed build or verification leaves
   the release in draft; never publish a partial set of assets.

## Hotfix

Branch from the tag, cherry-pick the fix, bump patch version, re-tag.
Never move a published tag.

## Pre-releases

Use `vX.Y.Z-rc.N` tags for release candidates. Installers pull `latest`,
so point testers at the exact asset URL.
