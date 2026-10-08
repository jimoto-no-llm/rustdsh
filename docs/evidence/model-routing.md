# Model routing evidence

Issue: [#20](https://github.com/sahenjp/rustdsh/issues/20), CLI assertions and evidence.
The baseline entrypoint from `5a7235e740ed9eadee60032fe0f051be5a643632`, evaluated
with the current common dependencies, rejects `routing inspect`. The new command
separates an explicit request from an observed native session configuration.

[Windows observations](model-routing-local.json) use actual Node children with
the pinned ACP wire fixture in a disposable native Git project. Separate CLI
clients bind, probe and inspect. An initially matching route is then changed in
the fixture: a tracked prompt is refused before a dispatch intent. An exact
operator authorization records the old/new tuple and source. One subsequent
fixture prompt is sent; no native config setter is called. The trace reports
local fixture effects rather than a live model or provider invocation.

[WSL Linux observations](model-routing-local-linux.json) use the explicit
installed original DSH and an empty selected home. Native new/resume and owned
root exits succeed, and the native default provider/model/effort are observed.
The deliberately different QA request remains mismatched in both probe and
attempted tracked send; no send intent is added and no prompt is submitted by
the client. Native configured values do not establish an actual DeepSeek model
invocation or successful authentication.

Tests cover complete/partial environment overrides, saved-role and declared
parent inheritance, exact native selection, malformed/absent options, provider
default ambiguity, mismatches, wrong/expired permits, immutable initial requests,
scope/revision checks, config drift at the final send boundary, missing/corrupt
policy, durable requirement markers and surviving locks. A checkpoint cannot
start a summary conversation by dropping the original run's model assertion.

Validation: dashboard tests pass 108/108 on Windows and WSL Linux; Rust release
tests pass 62/62, regression checks 41/41, with fmt, release Clippy warnings denied,
release build, `npm ci` and Markdown validation passing.

No UI changed. Native provider requests, actual billing/model execution, child
role enforcement, operator identity attestation, global DSH restrictions and OS
sandboxing remain unverified. The approval source identifies an explicit local
CLI declaration; it does not manufacture a signed P0 approval. This PR deliberately
keeps issue #20 open for UI and request-level execution evidence, and preserves
the task schema and six-tool MCP inventory.
