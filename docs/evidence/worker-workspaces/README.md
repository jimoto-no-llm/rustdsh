# Worker workspaces: CLI evidence

Fixed source: `355ff3a8ad2b02b85dc68618a4ac30707438fcd3`.
Baseline: exact CLI bytes from main `17cabfc659a7fdccbeae7a29d1b7ca8440909a92`.
Evidence added after validation does not change the source or tests.

[Before/after output](before-after.txt) records the previous unsupported command,
actual allocation, conflicts, expiry and release. [Full CLI observations](cli-observations.json)
contain 14 successful observations in a disposable Git repository without remotes.
Paths are replaced with `<fixture>`. The one-second lease uses actual wall-clock
time; its dirty checkout and branch survive expiry and explicit release.
Unrelated source files written by a human remain unchanged.

| Validation | Observed result |
| --- | --- |
| Windows dashboard, full suite | 208 pass, 0 failure or skip |
| Linux dashboard, full suite | 203 pass, 5 Windows-only skips, 0 failure |
| Windows worker tests, targeted | 13 pass, 0 failure |
| Linux fmt / release Clippy | Pass / zero warnings |
| Linux Rust release / examples | 103 / 7 pass |
| Linux fence / CLI / security boundaries | 2 / 53 / 11 pass |
| Existing browser flows on Linux | 8 pass, no page or console errors |

[Validation](validation.json) binds the source blobs, actual suite totals,
browser reports and log hashes. The CLI fixture also checks separate branches,
read-only reviewer declarations, observed out-of-scope reviewer edits,
preexisting human edits, shared lockfile changes and expired scope retention.
The full suite covers committed changes, corrupt/locked registries, conflicting
allocators, stale commits/revisions and unavailable checkouts.

This feature declares scopes and scans Git changes. Native DSH tool policy and
the execution sandbox provide runtime enforcement. It does not start workers
or publish/integrate changes. Integration is tracked separately in issue #22.
No dashboard UI or HTTP route changed; the behavior evidence is actual CLI output.
