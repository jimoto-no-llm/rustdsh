# v0.4.0 preparation: updater integrity verification

PR [#428](https://github.com/jimoto-no-llm/rustdsh/pull/428) was reconciled with
current `main`, retaining the pinned release-digest registry and the refusal to
trust a checksum supplied alongside an untrusted archive.

## Findings and repairs

- The regression fixture assigned the Linux archive's digest to every platform.
  macOS archives can differ even when their fixture payload is the same. Each
  archive now has a distinct platform marker and its own calculated digest.
- The rustup fixture admitted system Cargo through `/usr/bin`, which bypassed
  the installer branch it was intended to test on Fedora. Its PATH now contains
  explicit utility links and only the Cargo stub created by the fixture.
- Inherited original-DSH overrides could launch a developer's installed runtime
  during regression tests. The suite now starts with its own original stub;
  individual legacy override fixtures still take precedence.

The previous Windows supervisor cleanup failure was checked against the merged
`main` fix, which waits for monitor exit before releasing owned resources. No
additional cleanup retry or PID-based kill was added.

The remaining PR review identified a separate downgrade risk: the registry's
`latest` row is updated after release publication and can lag an explicitly
installed version. Automatic synchronization now compares the stable target
against the installed rdsh SemVer before downloading an archive. Numeric core
components use `BigInt`; same-core prereleases can advance to stable, and build
metadata has no precedence. An unreadable or unrecognized installed version
refuses automatic replacement. An explicit `RDSH_SYNC_VERSION=vX.Y.Z` continues
to select an intentional pinned rollback.

The comparison runs the installed `--version` with a two-second subprocess
timeout and a 4 KiB output bound. It adds no SemVer package and uses the Node
runtime already required by DSH synchronization.

## Before and after

With distinct archive bytes and the old shared digest, selecting the macOS ARM
asset produced `CHECKSUM MISMATCH`. After calculating each digest independently,
the selected asset produced `checksum ok` and `rdsh updated OK via release binary`.
Bad, missing, and malformed pins continue to refuse an update and preserve the
installed executable.

The new downgrade fixtures failed in four cases before the change: installed
`10.0.0`, `9.10.0-rc.1`, `9.9.10`, and an unrecognized version were overwritten
by registry target `v9.9.9`. They now preserve the executable and notice state
without requesting an archive. Same-core stable/prerelease/build-metadata,
older-to-newer, and explicitly pinned rollback controls still install.

## Local verification (Fedora, 2026-10-14)

- Rust formatting and clippy (`--all-targets`, warnings denied): passed.
- Rust release tests: 183 passed.
- Linux shell regression: 61 passed.
- Emulated Darwin/ARM asset selection: 61 passed, after reproducing the mismatch.
- Updater integrity suite: all 18 checks passed, including downgrade controls.
- Process ownership and security boundary Node tests: 22 passed.
- Shell syntax checks for the updater and all changed shell fixtures: passed.

The Darwin shim changes asset selection while executing a host-compatible test
payload; it is not a native macOS runtime test. Native macOS and Windows results
must be checked in CI for the pushed revision. This work does not publish a tag,
release, or asset.
