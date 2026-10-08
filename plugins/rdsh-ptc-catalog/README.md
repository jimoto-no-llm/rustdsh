# Scoped PTC tool catalog

This optional Cordis bundle adds tool discovery to an existing, authorized
DSH PTC composition. It supports `@deepseek-ai/dsh-tools@0.2.0-rc.2` and uses
the public registry, original SDK renderers and `system-prompt/assemble`
waterfall. The original `run_code`, runtime provider, scheduler, guards,
approval policies and canonical output validation retain execution ownership.

The guarded rdsh launcher forces Native tools. This bundle refuses activation
there with `RDSH_CATALOG_GUARDED_NATIVE`; it does not enable PTC in that
launcher. Nothing installs the bundle or changes an existing user profile
automatically. MCP connection, OAuth and deferred server loading remain owned
by their existing services; this catalog enumerates only registered tools.

## Configuration

For an original DSH composition that already supplies `tools`, `systemPrompt`
and `ptcRuntime`, add this local package through the existing DSH bundle/profile
mechanism. Its [bundle patch](cordis.patch.yml) supplies these defaults:

```yaml
config:
  inlineTokenBudget: 16384
  inlineTools: []
  maxSearchResults: 20
```

`inlineTools` is an explicit ordered list of exact names whose declarations
may be included after the two discovery helpers. A name outside the calling
scope is never displayed. A declaration that does not fit stays discoverable.
If even the mandatory discovery declarations cannot fit, prompt assembly fails
with `RDSH_CATALOG_BUDGET` and an actionable size, rather than omitting the
discovery API. A scope that restricts or shadows those helpers fails with
`RDSH_CATALOG_SCOPE_UNAVAILABLE`.

The budget counts UTF-8 bytes as a conservative token upper bound for
byte-based tokenizers. It is deliberately conservative, **not measured
DeepSeek token usage**. It covers the complete replacement `tools:sdk` section,
including existing execution instructions and discovery guidance. Other
system-prompt sections, native wire schemas in `both` mode, returned describe
results, and upstream assembly allocations are outside that budget.

Only the two helpers and explicit `inlineTools` influence this SDK text.
Adding an unrelated tool/schema does not rewrite it. The public waterfall
still runs after upstream assembles the full SDK, so this reduces model input
cost without claiming to reduce upstream assembly CPU or memory.

## Discovery from the original PTC program

```ts
const found = await tools.rdsh_catalog_search({
  query: "failed deployment build logs",
  namespace: "mcp/github",
  limit: 3,
});
if (found.status !== "ok" || found.tools.length === 0) return found;
return await tools.rdsh_catalog_describe({
  name: found.tools[0].name,
  revision: found.revision,
});
```

After reading the complete returned schema/declaration, invoke the exact name
inside the original PTC program, for example `await tools[exactName](args)` in
TypeScript. Python uses its original SDK and `getattr(tools, exact_name)(args)`.
The returned declaration is reference text, not executable code to evaluate.

- `rdsh_catalog_search` ranks names and descriptions, supports exact namespace
  prefix boundaries (`.`, `/`, `:`, `__`), and pages an empty query as a thin
  catalog. `offset`, `limit`, and `nextOffset` describe tool pagination;
  namespace summaries and description previews report truncation explicitly.
- `identifier` filters one normalization collision group. Normalization is
  diagnostic only. Calls always use exact original names; no alias is created.
- `rdsh_catalog_describe` returns complete input/output JSON Schemas, a schema
  digest and the declaration from the **original** TypeScript/Python renderer.
  Missing and restricted names return the same `not_found` result, without
  acknowledging a namespace, collision group, schema or existence.
- `revision` identifies the current visible names/descriptions and detects
  changed search pages. A describe result's separate `schemaDigest` identifies
  its input/output schemas. Results are recomputed for each calling scope;
  there is no cross-scope cache or durable tool-state storage.

Scope membership is discovery eligibility. Argument-dependent guards,
approval and current execution policy can still refuse a discovered call.
Search does not simulate a tool body or an approval. Restriction/permission
changes after discovery remain authoritative at original nested dispatch.

## Verification and comparison

From the repository checkout:

```sh
npm ci --prefix plugins/rdsh-ptc-catalog --ignore-scripts --no-audit --no-fund
npm test --prefix plugins/rdsh-ptc-catalog
node plugins/rdsh-ptc-catalog/benchmark.mjs --output /new/path/benchmark.json
```

The benchmark writes a new file exclusively. It compares 1,000 visible tools
and 80 fixed query/execution fixtures against the original full inline SDK.
It records encoded input payload size (`js-tiktoken` / `cl100k_base`), fixture
lookup success, incorrect body calls, outer PTC submissions, nested dispatches,
assembly time and prompt stability. The baseline knows the expected exact
name. Search and describe share one discovery submission; the invocation uses
a second submission. These are fixture/protocol measurements, not model
quality, DeepSeek tokenizer measurements, real provider usage or billed cost.

Tests also execute a fixed program through DSH's original Node provider in a
fresh home/workspace without inherited provider credentials. They verify
complete types, hidden-tool refusal, actual nested events and guard refusal.
That execution fixture uses a full-access policy and makes no confinement
claim. The separate mandatory [guarded-runtime probe](../../tests/guarded-runtime-probe.mjs)
verifies that this bundle cannot lift rdsh's Native/kernel boundary.

GitHub CI runs the catalog tests and benchmark on Linux, macOS and Windows,
and retains the benchmark report as an artifact. Source-specific results and
new/old output are in [PTC catalog evidence](../../docs/evidence/ptc-catalog/README.md).

Upstream contracts: [tools API](https://github.com/deepseek-ai/deepseek-harness/blob/f97c0438fb1608bbc4c08c88a27344249795ea22/docs/tool-catalog.md),
[system-prompt waterfall](https://github.com/deepseek-ai/deepseek-harness/blob/f97c0438fb1608bbc4c08c88a27344249795ea22/docs/subsystems/system-prompt.md),
[PTC provider](https://github.com/deepseek-ai/deepseek-harness/blob/f97c0438fb1608bbc4c08c88a27344249795ea22/docs/subsystems/ptc-runtime.md).
