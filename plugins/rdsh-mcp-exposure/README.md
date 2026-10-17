# Optional MCP exposure bundle

For an authorized original DSH **0.2.0-rc.2 or 0.2.1-alpha.3** composition, register MCP tools
through the existing MCP client and control which declarations the model sees.
The original client owns transports, namespaces, instructions, resources,
reconnection and disposal; the original ToolRuntime owns execution, validation,
approvals, scope restrictions and PTC. This bundle uses public Cordis
`Context.extend`, `register`, `get`, `schemas`, guards and prompt waterfalls.

The four DSH peers must all be exact `0.2.0-rc.2` or all exact `0.2.1-alpha.3`; mixed, unknown and future releases fail before registration or connection. Cordis peers are exact `4.0.4` or `4.0.5-alpha.2`. The owned configuration schema uses Schemastery `3.18.5-alpha.2`, also checked with the original rc.2 MCP schema.

## Updating an older configuration

The rc.2 release retains `native`, `ptc` and `both`. Harness `0.2.1-alpha.3` accepts `tools.config.mode: native` or `ptc`; the former `both` value is rejected. Keep `native` for native declarations. Choose `ptc` for the generated SDK and `run_code`, or use the original scoped `tools.presentAs()` API when a composition selects a different presentation for an agent. PTC execution with an Agent also requires the original `workingDirectory` service, in addition to `ptcRuntime`. The shipped Web profile provides these services; this bundle supplies neither service and never changes tool presentation itself.

**The current guarded `rdsh` launcher rejects this bundle before registration
or connection.** It reserves its audited Native tool set. This optional bundle
does not change that audit, enable `run_code`, install a profile or replace an
agent loop. It is an integration candidate for [Issue #76](https://github.com/jimoto-no-llm/rustdsh/issues/76),
not proof of adoption in the guarded launcher.

## Exposure rules

| Exposure | Native declaration and call | Existing PTC SDK and nested call |
| --- | --- | --- |
| `direct` | Declared immediately; ordinary guards apply | Declared; ordinary guards apply |
| `deferred` (default) | Declare and allow after successful load on this branch | Declare after load; an already known name can be called through original bindings |
| `ptc-only` | Never declared; direct calls refused | Declared and callable through an existing PTC runtime |
| `hidden` | Never registered or callable | Never registered, searched, bound or callable |

The policy applies to the original MCP definitions owned by this bundle. A
different plugin's scoped shadow remains owned and authorized by that plugin.
Loading metadata does not grant permission. Every call still traverses the
original ToolRuntime's current restrictions, guards and approval pipeline.
Native deployments stay Native. A `ptc-only` rule requires an already mounted
original PTC runtime; this bundle does not supply one.

Rules use the original **public qualified name**, such as `mcp__docs__read`.
Lossy raw names keep DSH's original hash suffix; use the name returned by search,
never reconstruct a wire name. Exact matches beat all patterns regardless of
position. Among patterns, the first match wins; only `*` is a wildcard.
Duplicate exact rules, foreign namespaces and unknown policy fields are errors.

```js
import * as mcpExposure from './plugins/rdsh-mcp-exposure/index.js';

// ctx already has the original tools, systemPrompt and sessions services.
await ctx.plugin(mcpExposure, {
  servers: [{
    connection: {
      transport: 'streamable-http', serverName: 'docs',
      url: 'http://127.0.0.1:3000/mcp',
      failOnStartupError: true,
    },
    exposure: 'deferred',
    source: 'operator.mcp.docs',
    toolExposure: [
      { match: 'mcp__docs__read', exposure: 'direct' },
      { match: 'mcp__docs__*', exposure: 'deferred' },
      { match: 'mcp__docs__delete', exposure: 'hidden' },
    ],
  }],
  maxSearchResults: 20,
  maxLoadedTools: 512,
});
```

Do not also mount an independent MCP client with the same server namespace.
`cordis.patch.yml` is an editable example for an existing loader that can
already resolve the local package; installing these test dependencies alone
does not make the package available to a separate DSH installation. No real
profile or credential configuration is changed by this repository.

## Discovery and startup

`rdsh_mcp_search` accepts `query`, `server`, `limit`, `offset` and `revision`.
It searches only currently visible names/descriptions, ranks name matches above
description matches, and returns effective exposure plus the configuration
label, rule index, match and rule kind. Results contain metadata, not full
schemas. A paged request requires the first page's revision; changed discovery
returns `stale` instead of mixing generations. Names and schemas of hidden
tools are not retained in the parent registry or returned by helpers.

`rdsh_mcp_load` accepts up to 64 unique public `names` and an optional revision.
It returns complete input/output schemas and original TypeScript/Python SDK
declarations. Success makes deferred declarations available on this branch;
`not_found`, `stale`, `limit`, failed, denied and cancelled calls do not.
The bounded branch index defaults to 512 loaded names (maximum 4096).

`rdsh_mcp_status` returns exposure sources, currently visible/loaded counts and
initial startup state. **`settled` means the original client's startup promise
settled, not that the connection is healthy.** The original client can tolerate
startup errors unless `failOnStartupError: true` is configured. Endpoint,
command, environment values and credential headers are omitted from helpers
and receipts; use a non-secret `source` label.

A server with any configured `direct` rule retains the original awaited
startup. Other servers start under the same original client's supervision in
the background: first prompt assembly does not wait for their tool list.
Search/load wait for original initial discovery and honour caller cancellation.
A fully hidden server does not connect. Later disconnection/reconnect behavior
remains the original client's responsibility. Declaration filtering preserves
the original SystemPrompt order and surviving unrelated positions, including
an explicit `toolOrder`; existing complete prompts and SDK budget transforms
remain owned by their providers.

Original `run_code` bindings are snapshotted at program submission. If a server
was still discovering when a program started, search/load may finish within
that program but a newly discovered function requires the **next** submission.
This bundle does not rewrite private bindings or retry model programs.

## Branch persistence

Successful native loads use ordinary `tool/result.meta.rdshMcpLoad`; successful
nested loads use the original `tool/ptc-dispatch` result. Receipts contain only
qualified names, schema/route hashes and a hash of the original session's
project cwd. No new session-event type or independent state file is introduced.
The original session persistence backend must be enabled for durable restart;
in-memory SessionStore alone does not write sessions to disk.

Resume and fork reconstruct the loaded set from their actual inherited event
prefix. A fork before a load, a sibling and another project do not inherit it.
Every use revalidates current definition identity, original scope visibility,
schema/route hash and exposure. Withdrawal/schema changes invalidate old loads;
PTC-only/hidden changes and current permissions can still reject execution.
Successful receipts are metadata, not a lasting authorization grant. The exact
current endpoint/stdio command participates in a private hash; credentials do
not appear in the receipt. Path spelling is compared conservatively, so moving
or renaming a project can require rediscovery.

## Display language

Owned configuration, version, namespace, discovery and guarded-launcher errors follow `general.language` (`en`, `zh-CN`, `ja`) in `$DSH_HOME/rdsh.json`. Unspecified or `auto` values use the first nonempty `RDSH_LANG`, `LC_ALL`, `LC_MESSAGES`, `LANG`, then the Node locale. Codes, configuration keys, public tool names, enum values, MCP payloads and raw upstream errors remain unchanged.

## Verification and measurements

```sh
npm ci --prefix plugins/rdsh-mcp-exposure --ignore-scripts --no-audit --no-fund
npm test --prefix plugins/rdsh-mcp-exposure
node plugins/rdsh-mcp-exposure/benchmark.mjs --output /new/path/measurement.json
```

The current compatibility target is the original Harness `0.2.1-alpha.3`, tested through its shipped Web profile in both native and PTC presentations with a private loopback MCP server and zero model requests. Those load checks do not authorize use in the guarded rdsh launcher.

The tests exercise actual original Cordis lifecycle, ToolRuntime, SystemPrompt,
session fork/restore, SDK rendering and the real MCP SDK/client over loopback
HTTP. PTC unit tests use a fixed callback provider and working-directory fixture with the original `run_code`
dispatcher; they do not benchmark a real sandbox/model. A child process using
the repository's actual mandatory preload proves guarded Native activation is
refused before helper registration and `run_code` remains absent.

The benchmark compares the unmodified original native MCP client with this
bundle using the same 1,000 fixed tools, 80 exact queries and controlled 250 ms
tool-list delay. Tokens are **offline `cl100k_base` counts of post-waterfall
schema/assembly JSON**, not provider billing. First-prompt timing includes proof
instrumentation waiting until the actual `tools/list` request starts. Five
assembly samples exclude tokenization. Discovery adds two helper calls per case
plus one startup-probe search; its CPU cost and schema growth after 80 loads are
reported explicitly. No real model, external MCP server, credentials or paid
API is used. [Recorded output and measurements](../../docs/evidence/mcp-exposure/README.md).

The exact rc.2 matrix was also loaded through its original Web profile in `native`, `ptc` and `both`, with a private loopback MCP server. These checks exercise registration, hidden-tool exclusion and prompt/SDK presentation with no tool execution or model request. The alpha.3 matrix separately exercises `native` and `ptc`; it does not re-enable `both`.
