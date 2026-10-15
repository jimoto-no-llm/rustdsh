# Reported cost ledger

Issue #44 adds optional `cost_ledger.schema: 1` metadata to project state. The
project schema stays 1. The six existing MCP tools remain the only tools; report
ledger inputs through `dashboard_update_metrics`, authenticated
`POST /api/update/metrics`, or the explicit `cost-ledger` CLI. Browser credentials
can read costs but cannot report them. Reporting neither starts a native CLI nor
makes a model call.

## Declare the period and population

Declare an immutable `cost_scope` before reporting. `project_id` must match the
current project. UTC start is inclusive and UTC end is exclusive. Each target
identifies one worker/session/provider/model stream; run/provider/model may be
`null` when unreported. Declare every expected target, including workers with no
usage yet. Duplicate worker/session/provider/model identities are rejected.

`membership_complete` is an explicit reporter declaration, not independent
discovery of all workers. `false` always makes totals partial, even if every
registered target has a known amount. A known amount for one worker never implies
zero spend for another. Changing a scope ID's period, population or identity is a
conflict; create a separate scope for a different period or population. Scopes
are never summed together, including overlapping periods.

```json
{
  "scope_id": "workers-oct-06",
  "project_id": "YOUR_PROJECT_ID",
  "period_start": "2026-10-06T00:00:00Z",
  "period_end": "2026-10-07T00:00:00Z",
  "membership_complete": true,
  "targets": [
    {
      "target_id": "worker-a-session",
      "worker_id": "worker-a",
      "session_id": "ORIGINAL_NATIVE_SESSION_ID",
      "run_id": null,
      "provider": "REPORTED_PROVIDER",
      "model": "REPORTED_MODEL"
    }
  ]
}
```

Identifiers are stable caller-assigned ASCII identifiers of at most 160
characters. Session/provider/model values are reported identity links, not
verified native attachment evidence. Reporting cannot rebind the session ledger.

## Report an observation

Every report requires all fields below. A report belongs to its scope's exact
period and one declared target. `target_id: null` is permitted only for an
unallocated project invoice. Such an invoice is shown separately from worker
invoice details, never added to them or distributed to workers.

```json
{
  "event_id": "native-usage-observation-17",
  "scope_id": "workers-oct-06",
  "target_id": "worker-a-session",
  "source_kind": "provider_usage",
  "source_ref": "provider statement / native meter observation 17",
  "observed_at": "2026-10-06T03:00:00Z",
  "mode": "cumulative",
  "sequence": 17,
  "currency": "USD",
  "amount": "0.123456789",
  "certainty": "reported",
  "tokens": { "input": 1000, "cached_input": 200, "output": null },
  "basis": "Provider-reported amount for this session and declared UTC period."
}
```

| Source           | Known amount certainty | Meaning                                                  |
| ---------------- | ---------------------- | -------------------------------------------------------- |
| `provider_usage` | `reported`             | Externally reported provider amount/usage                |
| `cli_report`     | `reported`             | Externally reported CLI amount/usage                     |
| `api_estimate`   | `estimated`            | External API conversion with explicit calculation basis  |
| `invoice_actual` | `confirmed`            | Reporter-labelled invoice amount for the declared period |

`confirmed` means the reporter says its source is an invoice; the dashboard does
not authenticate with a provider or verify that invoice. The UI says
**報告元で確定**. `source_ref` and `basis` are required text references, displayed
as data without fetching URLs or opening files. Include provider rate/version,
billable usage and currency conversion basis when reporting an API estimate.
No provider/CLI amount, estimate or invoice overwrites another source or corrects
its difference. There is no combined total across sources or currencies.

Amounts are nonnegative decimal **strings**, with at most 16 integer digits and
9 fractional digits. Integer-scaled arithmetic preserves exact decimal sums.
`null` amount requires `certainty: "unknown"`; it never becomes zero. Currency
must be an explicit three-letter uppercase code. The server does not exchange
currencies or look up current prices. Refund/credit entries with negative amounts
are not supported by this spend-only ledger.

`tokens` is `null` or an object with `input`, `cached_input`, `output`, each a
nonnegative safe integer or `null`. Cached input cannot exceed reported input.
Only report the source's billable counters. DSH ACP's current `usage_update.used`
is context occupancy and its adapter `billable_tokens`/`cost` are unavailable;
this feature does not reinterpret context occupancy as paid tokens or spend.

## Idempotency and cumulative reports

- `event_id` is unique across the project. Repeat the same normalized payload
  with the same ID after an HTTP timeout. The original receipt is retained;
  changed data under the same ID is a conflict. No automatic retry is needed to
  record a native side effect because reporting only saves data.
- Each scope/target/source has one stream, one currency and one report mode.
  Never report the same underlying usage to multiple targets or stream IDs.
  The reporter must supply correct period attribution and disjoint identities;
  the dashboard cannot discover duplicated native usage under invented IDs.
- In `event` mode, `sequence` identifies an independent billable item. Unique
  sequences add once. A new event ID with the same sequence and identical
  observation remains a history alias; conflicting data is rejected.
- In `cumulative` mode, `sequence` identifies a meter observation. Only the
  largest sequence contributes. Later observations replace the previous total,
  including unchanged totals; arrival order does not change that result.
  A new event ID re-reporting an identical sequence does not add another cost.
- Cumulative observation times and known counters cannot decrease. Meter resets
  need a separate declared period. A newest observation with unknown amount
  makes that stream's current cost unknown, while retaining older evidence.
- Mixing independent events and cumulative totals for the same source stream is
  rejected to avoid counting a meter and its components twice.

A subtotal with unknown reports or missing targets is **部分集計**. Fully known
totals describe only the declared period/population/source/currency. Unknown
population still means partial. Worker coverage excludes a worker whose selected
events include an unknown amount, even if that worker has a known subtotal.
Token aggregates also record partial coverage separately; the API serializes
aggregate counters as decimal strings to avoid integer overflow.

## CLI and state

```powershell
rdsh-dashboard cost-ledger declare --project C:\Projects\App --input-file scope.json
rdsh-dashboard cost-ledger report --project C:\Projects\App --input-file report.json
rdsh-dashboard cost-ledger inspect --project C:\Projects\App
```

The CLI uses only its matching project's existing literal loopback runtime and
MCP reporting credential. It rejects external URLs and redirects. MCP callers
can instead send `{ "cost_scope": {...} }`, `{ "cost_report": {...} }` or both
inside the existing metrics tool. Legacy numeric metrics retain their original
snapshot semantics and are never migrated, merged into ledger totals or changed
by cost reports. The UI labels them **従来の累計報告（API換算）**.

Persisted state keeps immutable scope declarations, reports and receipt times.
Public state adds source/currency totals, missing targets and each report's
`included` flag. Old cumulative observations and duplicate aliases remain in
history. The UI retains the selected period and open details during updates;
history displays 100 observations at a time without limiting aggregation. The
retention bounds are 100 scopes and 10,000 reports per project. Reaching a bound
rejects new records rather than silently deleting audit evidence. Corrupt ledger
state is rejected on open without rewriting the source file.

## Validation evidence

[Actual output differences, PNG captures, GIF and recorded fixtures](evidence/cost-ledger/README.md)
cover two workers, idempotent reporting, missing costs, distinct sources and a
different unallocated invoice. Automated tests also cover concurrent HTTP
reports, a lost response followed by the same-ID retry, out-of-order cumulative
snapshots, contradictory IDs, source/mode/currency validation, persistence and
browser read-only permissions. These are fixture/reporting proofs, not actual
provider pricing, real invoice verification, physical phone or Tailscale proof.
Hard budget admission control is separate work under issue #45.
