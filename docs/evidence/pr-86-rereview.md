# Low-end host re-review

## Current scope

Reviewed source `18d0445fa58604fa1ea07a817fe393eb612c0aba` integrates main
`98abc67d7e5c5d3f2a5321d9a56adb6a83ff93e2` and contributor head
`0e37d5eb1ad736a3d4ddb2a54d7a3a0d37863caa`.
The profile, compile-cache and session-size Rust implementations are already
present in that main commit; this final PR adds the operational guidance,
low-priority systemd synchronization and their isolated regression checks.
It also removes main's tracked host-specific `dashboard/node_modules` symlink.

The profile order is environment, saved default, existing local `tui`, then a
guided error. Explicit profile names are forwarded unchanged. The compile cache
respects an existing user value, passthrough and the opt-out. Version metadata
delegation checks the actual child environment. Unsupported agent runtimes
are refused before any compile-cache side effect, retaining main's enforcement.

## Verification

An isolated Linux release build passed formatting and release Clippy on all
targets with warnings denied, 88 Rust tests (74 unit, 11 native E2E, 3 settings),
7 benchmark-example tests, 31 Node security tests with zero skips, 6 Python
release-artifact tests and 83 CLI regression checks. The CLI suite ran from
outside the repository and kept HOME, DSH_HOME and temporary paths isolated.

The regressions cover profile precedence, default-cache and explicit-cache
environment values, passthrough, opt-out, zstd frame-size handling, the absence
of the zstd CLI, and rejection of unsupported agent runtimes. Fixture
credentials and executables are synthetic. No model or paid API was run.

Existing timing figures in the README belong to their stated historical
measurement; this run verifies behavior and makes no new speed claim.

## Addressed owner feedback

Current main verifies the matching published SHA-256 checksum before executing
or replacing the downloaded release candidate. Missing, empty or mismatched
checksums abort. The fresh security regression checks those cases, and both
language guides now describe the actual checksum verification and profile order.
This closes the technical findings previously reported by the owner. The owner's
existing `REQUEST_CHANGES` review still requires their own re-review; another
reviewer's approval cannot dismiss it.
