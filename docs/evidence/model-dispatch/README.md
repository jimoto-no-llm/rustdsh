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

Browser captures and measured call overhead are recorded alongside this file.
The earlier [configuration-only evidence](../model-routing.md) remains historical.
