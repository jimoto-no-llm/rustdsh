# Performance change and security review — 2026-10-08

## Delivered behavior

Native search reuses one approved root directory descriptor and stops retaining
matches once each ordered worker chunk reaches the global output limit.
Dense fixture median fell from 197.774ms to 4.607ms; peak RSS fell from
132848KiB to 4344KiB. Nonmatching and deep fixtures also improved. Search
stdout/stderr matched v0.2.0 under default, one-CPU, and two-CPU affinity,
including 64 compatibility cases per setting. See
[raw samples and reproduction](search-performance/README.md).

The same-user native CLI was additionally hardened while integrating fixes
and a read-only search review from the user's existing Muse Spark session:

| Boundary | Previous behavior | Candidate behavior |
| --- | --- | --- |
| Explicit log selection | `logs --file` could print an arbitrary outside file | Resolved selection must stay under the logs root; Unix opens through no-follow directory handles |
| Log open after validation | Path-based read could follow a replacement link or wait on a FIFO | Unix descriptor checks reject changed links, nonregular files, and multiply linked files |
| Session discovery | Project traversal and planted project/session links could include outside entries | Project is one path component; project/session directory links and linked size entries are skipped |
| Session token sizing | Linked `.zstd` entries contributed outside frame sizes | Planted linked entries are skipped |
| Token cache publication | Predictable `.tmp` path could truncate a link target | Random exclusive temporary inode, Unix 0600 creation, then atomic replacement |
| Web search request | Configured base prefix could inject whitespace/CRLF into the raw request | Invalid separators and malformed authorities are rejected before connecting; query remains encoded |
| Web search transport | TCP connect/write could wait without the response deadline | Connect and write use the remaining 15-second request budget; response cap remains 2MiB |
| Setup provider link | New page received an opener reference | Existing button supplies `noopener` |

Ordinary logs, tail/grep, relative DSH_HOME/latest selection, and configured
web search retain their output. Three dummy outside-log disclosures now fail
with no secret in stdout. See the actual
[before/after output diff](search-performance/cli-output-diff.json) and
[real setup captures and click observations](setup-link-security/README.md).

## Verification

Local Linux x86_64 verification on the final source:

- `cargo fmt --check`; release Clippy for all targets with warnings denied.
- `cargo test --release`: 78 unit tests, 11 CLI boundary tests, 11 native E2E tests, and three settings tests; seven Cargo-example tests also passed.
- `tests/regress.sh`: all 53 checks, isolated HOME and a delegation stub.
- Plugin/security/kernel-boundary Node suites: 36 passes, no skipped tests;
  includes dummy credential access, network, environment, host writes, and
  mandatory-tool rejection checks.
- Audited ToolRuntime integration: allowed inspection dispatches through the
  kernel sandbox; forbidden, late-rewritten, and scoped shadow tools fail.
  Release-asset tests: six passes. Separate approval-integrity integration:
  four passes against the already prepared isolated patched upstream fixture.

The last integration fixture is not a claim that upstream DSH has released
that approval fix. The rdsh runtime boundary continues denying the original
bash tool entirely. This change does not alter the mandatory preload,
runtime-hash pin, explicitly shared-file snapshot, seccomp policy, or
permission display. Real-model README-only exploitation was not re-run or
established by these performance measurements.

The new `tests/log_session_boundaries.rs` is discovered automatically by
Cargo on CI. It covers ordinary and relative-home logs, traversal, outside
symlinks, hardlinks, FIFO rejection with bounded cleanup, project links,
linked token frames, a planted predictable cache temp link, and Unix 0600.
The new search/root tests deterministically cover ordered-prefix retention,
zero-limit reads, and replacing the approved root pathname.

[Validation manifest](search-performance/validation.json) records source and
binary hashes and review scores: correctness 3/3, style 3/3, tests 3/3.
No blocking finding remained in the changed scope; the limits below remain
part of that conclusion.

## Scope and remaining boundaries

These results do not establish that the entire project is free of every
vulnerability. GitHub CI must still validate the pushed commit on its Linux,
macOS, and Windows runners; their authoritative results belong to the PR.
Dashboard server/UI code is unchanged relative to integrated main `98abc67`; a tracked, absolute dependency symlink was removed.

The model execution boundary has no host session/log/cache access: only the
human's explicit shared files are snapshotted read-only, and the kernel
adapter denies networking and host writes. Native inspection commands run
as the human's account; the model cannot invoke them outside that adapter.
The native session directory enumeration and token decompression still use
paths after entry checks. Concurrent replacement by a process that can write
the same user's DSH_HOME is not made race-proof by these planted-link checks.
The non-Unix log opener retains the existing native-file implementation
after canonical confinement; Unix handle guarantees must not be attributed
to it. Unsupported agent-isolation platforms continue failing closed.

Remote SearXNG endpoints remain supported when selected through the human's
existing environment/configuration and enabled extra. Search queries/results
cannot select or redirect that endpoint. A loopback-only restriction was
reviewed and discarded because it would break documented remote settings
without strengthening the model's already denied networking. No additional
remote opt-in flag or silent credential import was introduced. OS DNS
resolution can still exceed the socket deadline; the new timeout guarantee
applies to TCP connect, write, and response reads, not the system resolver.

The existing Muse Spark session implemented the native inspection hardening
and its first ten tests, reviewed the two search files, and reviewed the
subsequent integration fixes without further edits. Codex removed a redundant
path-based chmod after cache rename, fixed relative-home log selection,
isolated the test environment, bounded FIFO-test cleanup, and added the
eleventh regression. No credentials or session transcript are included in
this report.

## Independent PR re-review

Re-reviewed `be16d68efa511bdaeb52e6b81dbd2321cd12a413`, integrating contributor
head `c968b8f8b4da812ed26bb29cabc0143a9fec1a12` and current main
`98abc67d7e5c5d3f2a5321d9a56adb6a83ff93e2`. The merge retains main's
schema-2 cache and incomplete/stale token flags, no-follow log confinement,
and the contributor's loopback fixture without reverse-DNS startup.

Addressed the additional `logs --file` review: bare filenames remain relative
to the logs root; separator-containing relative paths retain their existing
working-directory meaning, with the same canonical-root and Unix handle
checks afterward. Four valid selection forms retain exact stdout while an
absolute outside dummy file is refused. The actual
[main/candidate output diff](search-performance/rereview-log-compat.json)
records source commits and binary hashes. The corresponding cross-platform
regression covers bare names, `dsh/logs/app.log` and `./dsh/logs/app.log`.

An isolated release build of this re-review source passed 103 Rust tests,
7 benchmark-example tests, 36 Node security tests (zero skips), 53 CLI checks,
20 settings checks, 21 context checks and 6 release-artifact tests. Formatting
and all-target release Clippy with warnings denied passed. These are separate
from the contributor's audited dispatcher, approval and browser evidence above.

Independent three-sample medians on a Ryzen 9 7950X3D WSL host measured the
dense fixture at 128.802ms before and 4.794ms after, with peak RSS
132352/3328KiB. The baseline release binary's native sources match main
`98abc67`; absolute values depend on the host and warm filesystem cache.
The 12 timing-fixture outputs and all 192 compatibility cases matched under
default, one-CPU and two-CPU affinity. Full independent raw samples:
[default](search-performance/rereview-default.json),
[one CPU](search-performance/rereview-one-cpu.json),
[two CPUs](search-performance/rereview-two-cpu.json).
No real models, secrets, paid APIs or production updates were used.

## Integration with concurrent main changes

Main `98abc67` was merged into this branch before final validation. Cache schema
2 and inexact/partial-session handling remain intact. A rejected linked compressed
entry now marks the remaining token sum inexact instead of claiming a complete
count. The positive native log fixture now lives inside its approved logs root;
outside refusals remain covered by the dedicated boundary suite.

A tracked `dashboard/node_modules` symlink referred to a developer’s absolute
local checkout, which made dependency installation nonportable. It was removed;
dependencies remain ignored and are installed through the locked package file.
The shell web-search fixture now binds port zero, publishes its actual port,
and records startup/client errors instead of hiding them. Its HTTPServer
subclass avoids reverse DNS during bind; the exact embedded fixture also passed
with reverse resolution deliberately disabled after a macOS startup failure.

The existing [browser E2E runner](../../tests/e2e/README.md) passed with the final
local binary: setup persistence, authenticated native tokens/prune/sessions,
and project MCP questions/browser answers/SSE drafts/restart key revocation.
It used isolated directories, loopback only, no model or Tailscale, desktop/mobile
viewports, and reported no page or console errors. See
[the actual browser result](search-performance/browser-final.json).

The GitHub open CodeQL-alert API returned an empty list. Dependabot alerts
are disabled, so that API could not establish dependency safety; a fresh
production `npm audit` for the locked dashboard tree reported zero known
vulnerabilities. These advisory results do not prove absence of unknown bugs.
