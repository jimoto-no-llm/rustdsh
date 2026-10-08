# MCP exposure: recorded fixture evidence

Measured with the original DSH 0.2.0-rc.2 ToolRuntime/MCP client and actual MCP
SDK 2.0.0 over loopback HTTP. The candidate adds the optional exposure bundle;
the baseline mounts the original client directly. Both use 1,000 fixed tools,
80 exact queries and a controlled 250 ms initial tool-list delay. No real model,
external MCP server, credential or billing API was used.

Raw Windows evidence: [windows.json](windows.json), Node 22.23.3, win32/x64.
The nine runtime/benchmark driver files have combined SHA-256
`e2a68170836c7eab66a825da841b7d83aa2a0d6da299cd062cccd1f32dcf92cc`.
Each individual file hash is recorded in the artifact. This hash excludes
documentation and does not stand in for the Git commit or the full test suite.

| Windows measurement | Original client | Deferred bundle |
| --- | ---: | ---: |
| First declared MCP tools | 1,000 | 0 (3 helpers) |
| First schema JSON tokens | 59,002 | 239 |
| First assembly JSON tokens | 59,048 | 372 |
| First schema JSON bytes | 265,891 | 1,186 |
| Activation wall time | 331.879 ms | 2.967 ms |
| First prompt wall time | 336.766 ms | 13.191 ms |
| Prompt before tool-list release | false | true |
| Assembly median, 5 samples after discovery | 2.565 ms | 125.176 ms |
| Schema JSON tokens after 80 loads | 59,002 | 4,959 |
| Assembly median after 80 loads, 5 samples | 2.236 ms | 159.984 ms |
| Actual MCP wire calls correct | 80/80 | 80/80 |
| Wrong wire calls | 0 | 0 |
| Search/load helper calls per case | 0 | 2 |
| Search + load median | n/a | 368.980 ms |

Token counts use offline `js-tiktoken 1.0.21` / `cl100k_base` on the original
post-waterfall schema and full assembly JSON. They are not provider billing
counts or evidence of model selection quality. Startup timings are one
controlled sample per variant; assembly timings exclude tokenization. The
candidate first-prompt timing includes proof instrumentation waiting for the
real client to send its pending `tools/list` request. The candidate also makes
one startup-probe search outside the 80-case loop.

The tradeoff is explicit: dramatically smaller declarations and background
startup, but higher local CPU cost. The public `get(name, scope)` checks preserve
definition ownership/scoped shadows and currently repeat the original resolver
for each visible name. Candidate discovery adds 160 helper calls. Its loaded
declarations grow as the branch uses more tools; this is not an unlimited cache
or proof of a faster model round trip.

## Actual output difference

[before-after.json](before-after.json) contains observed first declarations,
counts and the first actual wire request/result from both benchmark variants.
The baseline first declares `mcp__fixed__read_0000` through
`mcp__fixed__read_0004`; the deferred variant declares `rdsh_mcp_load`,
`rdsh_mcp_search` and `rdsh_mcp_status`. Both later send the same raw request
`read_0007` with `key: "case-000"` and return
`{"value":"FIXTURE:read_0007:case-000"}`. These are fixed fixture outputs,
not a generated transcript.

## Contract validation and limits

Windows: **18 passed, failed/cancelled/skipped 0**. Tests include original Cordis
activation/disposal, real MCP tool-list withdrawal/normalization, direct vs
background startup, hidden metadata/call refusal, exact/pattern precedence,
current permissions/restrictions, canonical declaration order, complete prompt
ownership, bounded receipt loads and cancelled/invalid-output rejection.

Native receipts are serialized through original Session APIs and restored from
actual JSON on disk; forks before/after a load and another project are checked.
PTC receipt tests use original `run_code` nested dispatch with a fixed callback
provider. They are not a real sandbox/model benchmark. Production durability
still depends on the original configured session persistence backend.

The actual mandatory preload is exercised in a separate process: it refuses
this bundle before registration, retains `rdsh_inspect` and does not expose
`run_code`. Consequently this is an optional original-DSH integration candidate;
guarded-launcher adoption and Issue #76 completion are not claimed.
