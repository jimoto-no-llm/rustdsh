# MCP exposure: recorded fixture evidence

Measured with original DSH 0.2.0-rc.2 ToolRuntime/MCP client and actual MCP SDK
2.0.0 over loopback HTTP. The candidate adds the optional exposure bundle; the
baseline mounts the original client directly. Both use 1,000 fixed tools, 80
exact queries and a controlled 250 ms delay beginning at the actual first
`tools/list` request. No real model, external MCP server, credential or billing
API was used.

Raw evidence: [windows.json](windows.json) (Node 22.23.3, win32/x64) and
[linux.json](linux.json) (Node 24.21.0, linux/x64). The same nine runtime/benchmark
driver files have combined SHA-256
`ba8f1a1d6c91b068270e0c2bf7c96018d752100c494caae78bea9a99ffb11cf3` on both platforms.
Individual hashes are recorded in each artifact and match their Git bytes.
This fingerprint excludes documentation and does not stand in for the commit
or the full test suite. OS/Node versions differ; compare each variant within its
own environment rather than treating the timing columns as identical machines.

| Measurement (identical counts on both OS) | Original client | Deferred bundle |
| --- | ---: | ---: |
| First declared MCP tools | 1,000 | 0 (3 helpers) |
| First schema JSON tokens | 59,002 | 239 |
| First assembly JSON tokens | 59,048 | 372 |
| First schema JSON bytes | 265,891 | 1,186 |
| Prompt before tool-list release | false | true |
| Schema JSON tokens after 80 loads | 59,002 | 4,959 |
| Actual MCP wire calls correct | 80/80 | 80/80 |
| Wrong wire calls | 0 | 0 |
| Search/load helper calls per case | 0 | 2 |

| Environment | First prompt wall time, original → bundle | Assembly median after discovery, original → bundle (5 samples) | Assembly median after 80 loads, original → bundle (5 samples) | Search + load median (80 cases) |
| --- | ---: | ---: | ---: | ---: |
| Windows / Node 22.23.3 | 411.827 → 15.498 ms | 2.685 → 131.586 ms | 2.388 → 182.446 ms | 347.636 ms |
| Linux / Node 24.21.0 | 437.650 → 11.959 ms | 3.975 → 122.024 ms | 1.846 → 131.621 ms | 260.529 ms |

Tokens are offline `js-tiktoken 1.0.21` / `cl100k_base` counts of the original
post-waterfall schema and full assembly JSON. They are not provider billing or
evidence of model selection quality. Startup timings are one controlled sample
per variant; assembly timings exclude tokenization. The candidate first prompt
includes proof instrumentation waiting for the real client to send its pending
tool-list request. One startup-probe search is outside the 80-case loop.

The tradeoff is explicit: smaller declarations and background startup, but
higher local CPU cost. Public `get(name, scope)` checks preserve definition
ownership/scoped shadows and currently repeat the original resolver for each
visible name. Discovery adds 160 helper calls. Loaded declarations grow as the
branch uses more tools; this is not an unlimited cache or proof of a faster
model round trip.

## Actual output difference

[before-after.json](before-after.json) records observed first declarations,
counts and the first actual wire request/result. The baseline first declares
`mcp__fixed__read_0000` through `mcp__fixed__read_0004`; the deferred variant
declares `rdsh_mcp_load`, `rdsh_mcp_search` and `rdsh_mcp_status`. Both later send
the same raw request `read_0007` with `key: "case-000"` and return
`{"value":"FIXTURE:read_0007:case-000"}`. These are fixed fixture outputs,
not a generated transcript.

## Contract validation and limits

Windows and Linux: **18 passed each, failed/cancelled/skipped 0**. Tests exercise
actual Cordis activation/disposal, real MCP tool-list withdrawal/normalization,
direct/background startup, hidden metadata/call refusal, exact/pattern precedence,
current permissions/restrictions, canonical declaration order, complete prompt
ownership, bounded loads and cancelled/invalid-output rejection.

Native receipts are serialized through original Session APIs and restored from
actual JSON on disk; forks before/after a load and another project are checked.
PTC receipt tests use original `run_code` nested dispatch with a fixed callback
provider, not a real sandbox/model benchmark. Production durability depends on
the original configured session persistence backend.

Unchanged Rust/launcher sources passed fmt, release Clippy (warnings 0), Rust
103 tests, examples 7, model-fixture fence 2 and regress 53. Linux security
boundaries/tool isolation passed 15 tests plus the actual kernel-backed guarded
dispatcher probe. Windows plugin/settings/banner/model-fence checks passed 33.

The actual mandatory preload is also exercised on both OS in a separate child:
it refuses this bundle before registration, retains `rdsh_inspect` and keeps
`run_code` absent. This is an optional original-DSH integration candidate;
guarded-launcher adoption and Issue #76 completion are not claimed.
