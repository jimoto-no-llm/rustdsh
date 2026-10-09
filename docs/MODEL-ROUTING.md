# Run model assertions and observed routing

`rdsh-dashboard routing` records the requested provider/model/effort independently
from a native ACP session's configured selection. It strengthens the existing
DSH routing path: it does not implement model selection, provider fallback,
agent loops or profile boot. Enable the native dispatch boundary to also compare
each adapter request after DSH resolves its defaults. The human dashboard displays
the requested route, actual request tuple, stopped requests and exact change permits.
Provider-side execution attestation remains unavailable.

## Bind an explicit request

Start a native session with the existing session-ledger CLI, then use its exact
confirmed run ID. The start command attaches and stops the owned ACP root without
sending a prompt. Save this JSON outside the project:

```json
{ "provider": "example-provider", "model": "example-model", "effort": "high" }
```

```sh
node dashboard/cli.mjs routing bind --project /absolute/project \
  --run-id run_<uuid> --route-file /outside/request.json
node dashboard/cli.mjs routing probe --project /absolute/project \
  --run-id run_<uuid> --executable /absolute/original-dsh
node dashboard/cli.mjs routing inspect --project /absolute/project \
  --run-id run_<uuid>
```

When using Node explicitly as the executable, also supply the original `bin.js`
with `--entrypoint`. Probe uses the recorded launch, home, branch, cwd and native
session ID. It resumes through the original ACP implementation, observes the
configuration and stops only its owned root. It sends no model prompt and makes
no config-option mutations. Failed comparison returns exit 1 with JSON evidence.

`inspect` is a read-only historical view. It does not reconnect, refresh a native
selection or infer execution from old values. The requested selection is immutable;
separate runs keep separate declarations even when their display labels match.

## Existing role precedence

Alternatively, a request JSON may contain `role` and a complete `parent` request:

```json
{
  "role": "worker",
  "parent": {
    "provider": "example-provider",
    "model": "example-model",
    "effort": "high"
  }
}
```

The reader interprets the pinned
[DSH role routing](https://github.com/sahenjp/deepseek-harness/blob/f97c0438fb1608bbc4c08c88a27344249795ea22/scripts/oh-my-dsh/routes.ts)
and [headless role overlay](https://github.com/sahenjp/deepseek-harness/blob/f97c0438fb1608bbc4c08c88a27344249795ea22/scripts/oh-my-dsh/headless.patch.yml).
The declared parent is operator input, not an observed parent model invocation.
It reads only the selected run home's `oh-my-dsh/routes.json`, never credentials
or general provider settings. It does not write that file or change child options.

For scout/worker/reviewer/architect, complete `OMDSH_<ROLE>_PROVIDER` and `_MODEL`
values override saved role routing. A partial or empty provider/model environment
suppresses saved routing and follows native parent inheritance; a warning records
that case. An effort-only environment value does not override a saved role.
Without a role override the parent request is inherited. When a role keeps the
same provider/model, unspecified effort inherits the parent; a different route
leaves provider-default effort unverified. Explicit effort should be supplied
when a definite reasoning-level comparison is required.

## Observation and prompt guard

The version-pinned DSH ACP response has a `model` select option whose opaque
value is JSON `[provider,model]`, and a `reasoning_effort` option. The parser checks
current values against advertised choices and records only the selected IDs,
source, version and timestamp. Titles, descriptions, arbitrary metadata and
credential values are excluded. Configuration updates refresh the local snapshot.
This uses the standard [ACP configuration channel](https://agentclientprotocol.com/protocol/v1/session-config-options).

Missing options, ambiguous/malformed selectors and unavailable effort remain
`unknown`. Empty native effort is the provider-default selector, represented by
null. A requested provider-default whose concrete effort cannot be resolved
stays unknown rather than being claimed equal to an arbitrary effort.

When a declared run is attached through `attachRecordedSession`, each tracked
prompt first persists the native observation and checks the active assertion.
A mismatch, unavailable selection, corrupt/missing policy, surviving lock or
expired authorization blocks before a send intent or prompt frame. The adapter
checks the assertion again at its final send boundary, including native updates
received after an earlier check. DSH owns selection admission and turn pinning;
the client does not rewrite those rules.

`matches_native_configuration` means the selected native configuration matches
the request. `actual_model_execution_verified` always remains false here:
configuration is not provider-side proof of which model handled a billable call.
No prompt, output text or fallback command is generated by probing or inspection.

## Require native request checks

After binding the request, explicitly enable the native guard for that run:

```sh
node dashboard/cli.mjs routing enforce --project /absolute/project \
  --run-id run_<uuid>
```

Stop the existing attachment and resume it through the tracked client. Enabling
the requirement does not retrofit an already running process: that process cannot
send further tracked prompts until it is reattached with the native guard.
Reattaching retains the original launch, cwd, home and native session ID.

The client adds a scoped Node preload to the original DSH process. It preserves
existing `NODE_OPTIONS`, including the independent tool and budget guards.
The preload verifies the published `@deepseek-ai/dsh-llm` 0.2.0-rc.2 compiled
source SHA256, then adds a final in-memory dispatch boundary after DSH's exact
adapter selection, default resolution and native input projections. It does not
write installed DSH files, profiles or role routes. Unknown versions, source
drift or missing guard readiness stop attachment; no model prompt is sent.
Node 24 is covered by the Windows and Linux native tests.

Every resolved call must use the declared native session and the current exact
provider/model/effort tuple. An unresolved provider-default effort blocks, as do
undeclared child sessions, changes after admission, expired permits and unavailable
audit storage. Child runs need their own declaration and tracked attachment.
Admission is durable before dispatch; the native request and chunks are passed
through without rewriting prompts, controls, replay state or signals. Model guard
errors escape the native adapter failure conversion, preventing automatic retry
or fallback. Ordinary provider failures retain DSH's existing behavior.

Each call records its selected tuple, permission ID, policy revision and terminal
outcome. A checked call without a durable terminal receipt stays pending; it does
not become a successful execution or a reason to replay. Authorization expiry
blocks new calls without retroactively cancelling an already admitted stream.
The `actual_model_execution_verified` field remains false: native dispatch facts
cannot attest which model the remote provider actually ran or charged for.

Older configuration-only records keep their original semantics and are labeled
as such. `enforce` upgrades the requirement durably; restoring an older marker
cannot silently downgrade an upgraded policy. An older client refuses schema 2.

The human-only `GET /api/model-routing` view excludes launch/home paths, prompt
and response text, credentials and native error messages. It has no route-change
endpoint and cannot be accessed with the six-tool MCP producer credential. The
visible page refreshes this historical view every five seconds; an HTTP failure
shows unavailable rather than retaining a current-looking success.

## Explicitly permitted changes

Use DSH's existing routing controls to change its selection. The assertion keeps
blocking a changed native route until a matching operator authorization is recorded.
`routing allow-change` authorizes the assertion's new target; it does not perform
the native route change. There is no automatic fallback or repeated switch.

An authorization JSON must contain exactly:

| Field                                  | Required scope                                              |
| -------------------------------------- | ----------------------------------------------------------- |
| `authorization_id`                     | A unique local identifier                                   |
| `source`                               | `explicit_operator_cli`                                     |
| `run_id`, `session_id`, `context_hash` | The exact declared run and context from inspect             |
| `from`, `to`                           | Complete old and new provider/model/effort objects          |
| `request_revision`                     | The current inspect revision                                |
| `issued_at`, `expires_at`              | UTC ISO timestamps, currently valid, at most 24 hours apart |

```sh
node dashboard/cli.mjs routing allow-change --project /absolute/project \
  --run-id run_<uuid> --route-file /outside/new-request.json \
  --authorization-file /outside/explicit-authorization.json
```

Wrong scope, stale revision, expired dates and reused authorization IDs are
rejected. The original request stays visible beside the active route, observed
before/after configuration and authorization source. Tool/OS permissions, native
ID, launch, cwd and home are unaffected. Expiry blocks further tracked prompts;
it does not silently switch back to the original model. This local CLI provenance
is not a cryptographic identity or the separate P0 approval ledger.

## Durability and limits

Private project state holds `model-routing/run_<uuid>.json` and an independent
`.required` marker flushed before the policy. A lost policy or interrupted bind
therefore cannot silently disable a known assertion. Immutable request hashes,
checksummed metadata, bounded history and exclusive writer locks preserve source
and change records. Surviving locks and corrupt data are preserved without repair
or automatic replay. Each policy is limited to 512 KiB and 500 events.

Checkpoint formal resume retains the same guarded run. Summary-based creation of
a new conversation from a declared run is unavailable until a separate new-run
model declaration can be made explicitly; it cannot drop the assertion or widen
an old run's fallback permission into a different native ID.

This is a client assertion within the existing single-owner state model, not OS
containment or a global restriction on original DSH clients. It does not attest
provider internals, child role executions, concurrent independent clients or an
operator rewriting all private state. An unguarded original client remains outside
this run contract. See [native request and browser evidence](evidence/model-dispatch/README.md)
and the earlier [configuration-only evidence](evidence/model-routing.md).
