# Budget admission control

[#45](https://github.com/sahenjp/rustdsh/issues/45) adds opt-in soft warnings and
hard admission limits for the verified DSH 0.2.0-rc.2 ACP adapter. New guarded
jobs and model calls are checked at their entry. Existing calls continue. The
original native `llm/stream` waterfall covers conversation, title, compaction
and in-process subagent calls through that same service. Requests, model/provider
selection and response chunks pass through unchanged. The original agent loop,
profile boot, retry machinery and Rust passthrough remain in DSH. A middleware
denial throws before `next()` and ends the attempt.

## Money and reservations

The administrator selects a UTC period, scope, currency and one cost source.
`provider_usage`, `cli_report`, `api_estimate`, `invoice_actual` use the same
vocabulary as the [cost ledger](COST-LEDGER.md); their amounts stay separate.
Cost-ledger observations supply evidence for an explicit opening baseline and
per-call final receipts. The admission ledger records the administrator's
amounts/basis; it does not verify invoices or automatically turn partial cost
cards into enforced limits. Existing expenses outside the guard must be covered
by the opening baseline. Never count a guarded call in both baseline and receipt.
`baseline: null` blocks admission; zero is an explicit operator statement.

Admission checks baseline + settled call amounts + outstanding reservations.
Decimal strings support nine fractional digits. Project/run limits apply
together; a call counts once in each matching scope, and those scope totals must
not be added. Overlapping policies must use the same source/currency/period.
Their largest call reservation is checked against every limit.

At/above hard, new jobs are denied. Calls are also denied when their reservation
would exceed hard. Reserving exactly the remainder permits that call and blocks
the next one. Soft warns without denying. A reservation estimates potential
cost, **not an absolute bill guarantee**. Late usage or a call costing more than
its reservation can expose an overspend. The screen shows executing/unknown
calls, finished calls awaiting usage, held money, the selected source and excess.
DSH token usage never produces an invented dollar price. The hook records only
disjoint uncached input, cache-read, cache-write and output counters when supplied.

A final per-call fee receipt replaces its reservation with the selected source
amount. Unknown amounts keep the hold. Identical receipt IDs are idempotent;
conflicting amounts/IDs, currency, source or timestamps are rejected. Settled
amounts cannot be silently rewritten. A future operator reconciliation mechanism
is needed for corrections. In-flight/unknown calls cannot be settled from an
incomplete observation; missing finish acknowledgements retain their reservation.

## Operator setup

Start the project's local dashboard first. Save a policy JSON with the current
period and the operator's actual opening evidence:

```json
{
  "policy_id": "project-budget",
  "expected_revision": 0,
  "run_id": null,
  "period_start": "2026-10-06T00:00:00Z",
  "period_end": "2026-10-07T00:00:00Z",
  "currency": "USD",
  "source_kind": "provider_usage",
  "baseline": "0",
  "baseline_basis": "Explicit opening spend for this scope and period",
  "soft_limit": "8",
  "hard_limit": "10",
  "call_reservation": "1",
  "paused": false,
  "active": true,
  "reason": "Operator authorizes this guarded execution budget"
}
```

Use the same host/OS as the loopback server:

For a WSL native DSH, run both the project dashboard and control CLI in that WSL
environment with the explicit native Node/entrypoint paths. Windows-to-WSL
launcher shims are outside this guard's verified startup boundary. The native
profile/LLM smoke here was run on Linux; Windows coverage uses the ACP fixture.

```sh
node dashboard/cli.mjs budget policy --project /repo --input-file policy.json
node dashboard/cli.mjs session-ledger start --budget-guard --worker-id worker-1 \
  --project /repo --executable /native/node --entrypoint /installed/dsh/lib/bin.js
node dashboard/cli.mjs reply-consumer serve --budget-guard --worker-id worker-1 \
  --project /repo --run-id RECORDED_RUN_ID \
  --executable /native/node --entrypoint /installed/dsh/lib/bin.js
node dashboard/cli.mjs budget inspect --project /repo
```

`session-ledger start/resume` confirms the original session, then stops its owned
process without a prompt. `reply-consumer once/serve` sends human instructions
through that exact guarded session. The JS attachment API accepts
`budget: { worker_id: "worker-1" }` for callers keeping an attachment alive.
A run-specific policy uses the recorded run ID instead of `null`, together with
the project policy. Worker IDs are labels; they grant no additional permissions.

The caller probes native version, then atomically admits the job. A temporary,
credential-free patch refers to the repository's plugin module and goes through
native `--patch` with the original ACP profile. A per-job producer key is passed
only in the child's environment. Native registration must be observed before a
prompt is permitted. Stop/exit revokes the key and removes the owned patch.
User-installed profiles and ordinary launchers are not modified.

After a call finishes, save a final cost observation using its ID from inspect:

```json
{
  "event_id": "source-observation-001",
  "call_id": "CALL_ID_FROM_INSPECT",
  "amount": "0.42",
  "currency": "USD",
  "source_kind": "provider_usage",
  "source_ref": "Identifiable cost observation without credentials",
  "observed_at": "2026-10-06T01:00:00Z",
  "basis": "Final amount for this finished call from the selected source"
}
```

```sh
node dashboard/cli.mjs budget usage --project /repo --input-file usage.json
```

Observation time must follow the recorded finish and not exceed the server's
clock. It may arrive after period end. Actual provider prices, credentials and
invoice ingestion remain operator integrations; the hook makes no billing call.

## Permissions, restart and coverage

Limits, reservation size, pause, resume and active state require the local
administrator credential, expected revision and reason. Every decision is
durable. Scope, currency, source, period and baseline are immutable within a
policy; a new period needs a new explicit baseline/policy. An old policy cannot
be deactivated with unresolved calls. Increasing a limit is an audited choice.
No automatic model/provider downgrade occurs.

MCP/browser keys can read public state but cannot change policy, issue jobs or
settle fees. Per-job producer keys can register a hook, admit calls and finish
their job's calls; they cannot weaken limits or settle money. Control and producer
routes require loopback. No prompt/messages, API keys or raw model responses are
journaled. The original six project MCP tools remain unchanged.

All admissions/writes use the dashboard's single project update queue. Lost
responses never trigger automatic dispatch retry. Reservations remain after
producer disconnection, process death, missing finish acknowledgement and server
restart. Keys are live only. Restarted servers mark old owners unknown and refuse
their credentials. Reopen the native attachment for a new owned guard; unresolved
money stays held. Stop/cleanup remains available after hard is reached.

Enforcement covers attachments explicitly using `--budget-guard` or the JS option.
Normal DSH starts and Codex/Claude/Kimi are display-only. External processes or
remote services bypassing this native LLM boundary are outside its guarantee.
Version matching alone does not advertise budget support: both the current ACP
connection and native hook registration are required. Adopting the guard into
ordinary launchers remains a separate operator decision.

## Verification

Eight tests cover thresholds, exact amounts, combined scopes, parallel workers,
lost admission, restart holds, permissions, receipt conflicts, real CLI commands
and guarded job launch/cleanup. Their ACP executable is a protocol fixture.

The isolated native smoke takes explicit installed paths, under a delegated
process scope on Linux:

```sh
node dashboard/budget-native-smoke.mjs --entrypoint /installed/dsh/lib/bin.js \
  --modules /installed/dsh/node_modules
```

It creates/removes its own Git project, DSH home, dashboard and ACP process.
It proves original profile-patch registration/native session identity, original
Cordis/LlmRuntime interception, two-worker admission, route retention and late
usage overspend using a local model adapter. Ten latency samples include durable
HTTP admission/finish and native local chunks; they exclude external fee receipts
and real provider latency. This does not prove provider authentication, current
prices or invoice reconciliation. Real captures and outputs are in
[evidence/budget-control](evidence/budget-control/README.md).
