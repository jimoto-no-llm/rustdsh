# History backup evidence (#46)

Baseline: `d9c3bc50a764c0fa830033ba7298f15dbcce73ee` (PR #155).
All records, source prose and projects here are disposable local fixtures.
No user project, credential profile, original agent session or paid provider call
was exported or restored. The dashboard HTML/CSS is unchanged; this feature is a
local control CLI plus authenticated state-resource history.

## Actual before/after output

[output-diff.json](output-diff.json) runs the same `backup inspect --archive-file`
command against an archived baseline dashboard and this implementation. Node
22.23.3 previously exits 1 on the unsupported option; the new CLI exits 0 and
reports the real selected archive's five related record types and content holds.
The old error's path is a temporary fixture checkout, not a user code path.

[archive.json](archive.json) is the actual exported schema-1 archive: one task,
question, answer, decision revision and evidence reference. Only three explicitly
reviewed, public replacement texts were included. The original dummy provider
key, bearer text, credential URL and private-code fixture never appear. Evidence
is a reference with unverified freshness; no code/log/image assets are included.
Its SHA-256 is validated by `backup inspect`, and re-export after restoration is
byte-identical to this file.

[runtime-observations.json](runtime-observations.json) records actual local CLI
preview → export → inspect → empty-target restore → history → re-export.
Source administrator/MCP/browser credentials each receive HTTP 401 at the target.
An ID collision and damaged checksum leave the target state bytes unchanged.
Restored data remains historical-only; the active task/question/feedback arrays
are empty and imported approval decisions grant no execution permission.

The eight automated scenarios additionally cover older decision revisions,
date/ID scopes and dependency closure, pinned content review, forged/resealed
authority and relationships, real saved event subscriptions staying absent at
the target, concurrent restore serialization, question/acceptance-ID conflicts,
private exclusive files, invalid/oversized JSON, symlink refusal on Linux,
recursive immutability, and full validation when the history collection changes.

## State-update overhead

[commit-benchmark.json](commit-benchmark.json) compares alternating old/new
`ProjectStore.mutate("metrics")` calls with identical synthetic history bytes on
Windows / Node 22.23.3. Four warmups per store are omitted; 20 samples each include
clone, validation and the state-file write. The baseline accepts the history as
an unknown field; the new implementation validates it once and retains a frozen
collection on ordinary updates.

| Fixture                   | History bytes | Old median | New median |
| ------------------------- | ------------: | ---------: | ---------: |
| No imported history       |             0 |   1.064 ms |   1.065 ms |
| 512 reviewed task records |       657,737 |   5.897 ms |   4.776 ms |

These are fixture measurements on this machine, not a throughput/billing claim
or a guarantee at the 8 MiB retention limit. Import/open/replacement performs full
schema, checksum, prose and reference validation; ordinary commits still check
conflicting IDs. Actual QA CLI startup + HTTP + write took about 300 ms for
export and 296 ms for the one-record-type-per-kind restore.

## Validation scope

Windows Node 22.23.3 (two test-file workers) and Linux Node 24.21.0 each passed
all 177 dashboard tests after the immutable-history implementation. The final
eight backup scenarios, including replacement of the collection, were rerun on
both platforms. Rust release tests passed 62/62, regress 41/41, formatting/clippy
passed with no warnings, and the root-configured Markdown checks passed.

Linux used a delegated `systemd-run --wait --pipe` service. An earlier direct-file
stdout variant cancelled pending test promises and is not counted as a pass.
An initially interrupted shell run likewise had no complete suite result; the
final suite footers, not partial output, establish the numbers above.
The targeted backup scenarios use local HTTP and disposable state directories;
subscription proof uses a signed fixture callback, not a real Dot/cloud account.
Real code/assets, session resumption, credential migration, full execution-state
restore and automatic publication are outside this history-export contract.
