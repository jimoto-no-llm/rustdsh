# Native model dispatch evidence

Issue: [#20](https://github.com/jimoto-no-llm/rustdsh/issues/20).
The original DSH LLM service is published version 0.2.0-rc.2, compiled SHA256
`9132c8a8053ee82b9fb1ded4f98c85cf557f288a15a85c552c6b1fb319ead120`.
Both installed and separately downloaded public code match this fingerprint.
Tests use its real Cordis service, model capability/default resolution, middleware
waterfall and adapter dispatch. The registered provider is an isolated synthetic
adapter; no real profile, credentials, provider API, billing or model invocation
is used or attested.

The baseline accepts a changed `fixture-provider/model-B/high` request despite
a recorded `model-A/high` requirement. The preloaded native boundary blocks that
same call before its adapter runs. It also blocks another provider, changed effort,
late middleware drift, unknown effort and another/undeclared session. An exact
run/session/context/revision/from/to permit admits model B and retains the original
request and permission provenance. Native default effort resolves before comparison;
unsupported effort invokes no alternative provider/model. Successful chunks retain
their content and order, while a native provider failure remains failed.

An owned ACP wire fixture uses that same real native LLM service. The public tracked
resume loads and confirms the guard in its owned process, then a prompt whose ACP
configuration matches is still refused after its final tuple drifts. Its adapter
dispatch trace remains empty. Installed native source is byte-identical after tests.

Additional store/HTTP tests cover older records, durable enforcement and downgrade
refusal, control changes while awaiting admission, surviving writer locks, missing
terminal outcomes, redacted views and human/MCP authorization separation.

## Observed before/after

These excerpts come from [the recorded native results](observations.json):

```diff
- dispatches: [{"provider":"fixture-provider","model":"model-B","effort":"high"}]
- error: null
+ dispatches: []
+ error.code: "RDSH_MODEL_GUARD_DENIED"
+ error.message: "Native model guard: native_route_mismatch"
```

The native baseline is the unpreloaded published service. The guard is loaded
for the changed request, which reaches no provider adapter. After the exact
operator permit, the same model-B tuple dispatches successfully. Only synthetic
provider I/O is involved; this is native request proof, not a remote model test.

## Real browser captures

The before PNG uses the actual `dashboard/ui.html` and `dashboard/app.mjs` from
main `2bf6e22142b9f54e2b226bf4a80318fbe83f4f6e` against the same isolated current
HTTP backend. It compares the old frontend with the new frontend, rather than
claiming the entire previous backend was replayed. The new screenshots use
unmodified current page code and real ledger requests, including automatic
five-second refresh from matched to stopped to operator-permitted. Expanding
change history survives a subsequent native call and refresh. No fake image,
CSS injection, secret, real conversation or production state is used.

- [Before: existing desktop frontend](before-desktop.png)
- [Matching native request](matched-desktop.png)
- [Mismatched native request stopped](stopped-desktop.png)
- [Explicitly permitted change and retained history](permitted-desktop.png)
- [390px mobile view](permitted-mobile.png)
- [Actual recorded flow](guard-flow.gif)

The 390×844 viewport has no horizontal overflow. The expanded panel is captured
at the same 390px width with 1150px viewport height so fixed navigation does not
obscure the evidence. Browser page errors: zero.

## Validation scope

The production runtime and HTTP source at `a3b32ba08b53832c459358a791509033d474757a`
passed the complete dashboard suite on Windows (200/200, skip 0) and Linux
(195/200, with five Windows-only tests skipped). Native service tests passed
14/14 with zero skips on both systems. The final UI-only change preserves expanded
history; its actual-browser regression passed after that change.

Rust input files are unchanged from the fully checked candidate
`f31f95c5551ee8657ab800bcf5cea2573bc529e0`: fmt, release Clippy with zero warnings,
release tests 103, examples 7, fence 2, CLI regressions 53 and plugin/security
checks 27 all passed. The existing browser suite also passed on Linux: native
serve/setup/project MCP/restart flows and nine update-banner flows. Its first
attempt lacked the pinned Playwright browser; installing that exact test browser
and rerunning the browser suite succeeded. Production services were not restarted.

The test helpers isolate HOME, DSH_HOME, provider and temporary project state.
The [native test](../../../tests/model-runtime-native.test.mjs) exercises the
published native package; [the browser runner](../../../tests/e2e/model-routing.mjs)
captures actual HTML/HTTP behavior and times the same native service.

The earlier [configuration-only evidence](../model-routing.md) remains historical.

## Measured overhead

Windows Node v24.18.0, 100 sequential calls per case, a synthetic provider and
zero network; Node boot is excluded. These are local dispatch timings, not real
model inference or billed-call latency. Durable admission/outcome writes are
included in guarded calls.

| Case                       | Median ms |  p95 ms |  Total ms |
| -------------------------- | --------: | ------: | --------: |
| Unpreloaded native service |    0.0080 |  0.0349 |    2.0948 |
| Scoped dispatch guard      |   18.7185 | 21.1219 | 1878.2146 |
