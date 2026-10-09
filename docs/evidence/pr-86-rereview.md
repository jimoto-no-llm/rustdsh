# PR #86 re-review evidence

## Current scope

This update integrates the PR branch at `bc9a6568e2382722e5299e764187296f48ddbe59`
with current `main` at `c73183a964ec4c3c0637f4e2beeb860b5a0c908a`. It keeps the
low-end host guide in both READMEs, documents the saved default-profile setting,
adds low-priority systemd guidance, expands isolated release and CLI regressions,
and makes Windows job-membership reporting consistent when kernel observations
race.

## Reviewer requests

- The release sync path checks the downloaded asset against its published
  `.sha256` sidecar before replacing the installed binary. Missing, empty, or
  mismatched sidecars leave the current binary in place; `tests/regress.sh`
  exercises these cases. The READMEs now state that checksum behavior.
- A profile-less `rdsh boot` uses `RDSH_DEFAULT_PROFILE`, then the saved
  `general.default_profile`, then an existing local `tui` profile, and otherwise
  exits with guidance. Explicit profile names continue to be passed through.
  The README examples and regression cases now describe and cover this order.

## Verification status

The updated regression suite covers saved-profile precedence, explicit profile
delegation, Node compile-cache opt-out and passthrough behavior, zstd header and
CLI paths, release checksum failures, and bounded test-side filesystem writes.
Markdown lint passed for both READMEs and this evidence note. The dashboard
process-scope test file passed all 8 tests, and `bash -n tests/regress.sh` passed.
The Rust toolchain is unavailable in this Windows worktree, so the Linux release
build, Rust tests, and full CLI regression run still need to pass in CI before
the PR is considered ready. The existing `REQUEST_CHANGES` review remains for
the reviewer to reassess; no review state is cleared by this evidence note.
