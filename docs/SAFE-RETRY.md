# Retry within the original operation scope

The retry coordinator in `dashboard/retry.mjs` handles a bounded transport
operation. It requires a code-owned authorizer and executor; task JSON cannot
provide scripts or expand permissions. It does not run an agent loop, boot a
profile, grant tool permissions or implement an OS sandbox.

## Public CLI integration

```sh
node dashboard/cli.mjs adapters --cli dsh --project /workspace/project \
  --executable /absolute/path/to/original-dsh --retry \
  --retry-attempts 3 --retry-total-ms 10000
node dashboard/cli.mjs retry-history list --project /workspace/project
node dashboard/cli.mjs retry-history inspect --project /workspace/project \
  --operation-id op_00000000-0000-0000-0000-000000000000
```

Use the returned operation ID. A Node CLI entrypoint needs both the absolute
Node path in `--executable` and the absolute entrypoint in `--entrypoint`.
The selected executable/entrypoint content and canonical cwd form a SHA-256
scope digest. Each attempt checks the original digest again. This pins selected
files; it does not attest the entire runtime dependency tree or eliminate an
OS-level check/use race. The launch environment is captured once for this probe.

Only `adapters --cli dsh` accepts `--retry`. It retries the original CLI's
`--version` query. It sends no prompt, starts no ACP profile and invokes no
provider API. Version matching remains a configuration observation, not protocol
verification or proof of authentication. Normal adapter probing and session
controls retain their existing behavior.

`--operation-id` can identify the same operation in a repeated CLI invocation.
An existing ID returns history without executing, authorizing or reconciling
again. The adapter report is then `null`, and the command exits nonzero because
stored success is not a fresh version observation. A changed kind or scope is
rejected. Use a new operation ID for an explicitly requested fresh probe.

## Effects and failure categories

| Kind                                     | Effect                         | Automatic retry after dispatch                     |
| ---------------------------------------- | ------------------------------ | -------------------------------------------------- |
| `cli_version_probe`, `cli_usage_read`    | Read-only                      | Typed transient failures within the original scope |
| `acp_prompt`                             | May write through native tools | Authoritative reconciliation required              |
| `external_send`, `git_commit`, `payment` | External write                 | Authoritative reconciliation required              |

The effect catalog is immutable. Write kinds deliberately have no assumed
idempotency. These write kinds are library contracts exercised by harmless
fixtures; they are not enabled as public prompt, send, commit or payment retry
commands. The existing ACP adapter still forwards one prompt per explicit send.

Executors classify known transport outcomes with `RetryFailure`: `rate_limited`,
`unavailable` or `timeout` may be transient. `auth_denied`, `permanent` and
unclassified errors stop. Arbitrary peer error text, including strings that look
like a rate-limit message, never becomes permission to retry and is not stored.
The version integration classifies bounded child-process errors, not model or
provider failures.

The default budget is three attempts and 10,000 ms, with exponential delays
starting at 200 ms and capped at 2,000 ms. Configuration is bounded to twenty
attempts and 600,000 ms total. A trusted `retry_after_ms` is a minimum cooldown;
if it exceeds the delay or elapsed budget, the coordinator stops rather than
shortening it. Authorization, preparation, dispatch, reconciliation, persistence
and waiting consume the sequence's elapsed budget. Initial scope fingerprinting
occurs before that sequence begins.

The coordinator checks the exact original scope before preparation, immediately
before dispatch, after backoff and before reconciliation. Preparation must be
read-only. Authorization failure never renews credentials or adds permission.
Each callback receives an AbortSignal. A deadline stops new callbacks and
attempts and ignores a late response. Trusted executors must honor cancellation;
JavaScript cannot forcibly undo or stop an arbitrary external side effect. An
in-flight write that exceeds its deadline therefore retains unknown certainty.

## Reconcile before another write

A transient error after a write may mean the operation already succeeded.
The coordinator first calls its authorized, read-only reconciliation callback.
The receipt must contain exactly:

```json
{
  "operation_id": "op_00000000-0000-0000-0000-000000000000",
  "scope_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "outcome": "applied",
  "source": "authoritative_operation_status",
  "evidence_id": "opaque-receipt-id",
  "observed_at": "2026-10-06T00:00:00.000Z"
}
```

The operation ID and scope must match. `applied` completes the retry sequence
without another write. A definitive `not_applied` may permit a bounded retry.
`unknown`, missing evidence, mismatched IDs, a denied lookup or an unavailable
lookup stops with uncertainty. Absence from an eventually consistent list is
not a definitive `not_applied` result. The executor/reconciler must use the same
operation ID against the authoritative external state and verify that source;
the receipt's source label alone cannot authenticate a callback or service.

The full receipt is hashed; its body and evidence ID are not persisted. This is
not an exactly-once guarantee or a provider-specific payment implementation.
Git fixtures verify an actual disposable commit against its operation ID after
deliberately losing the response. External-send fixtures use an isolated local
transaction file and never contact a delivery service.

## History and user decisions

Each project stores private `retries/op_<uuid>.json` records with the original
scope, fixed budget, attempt count, elapsed/wait time, next retry timestamp,
failure category and reconciliation digest. The last history event explains why
the sequence stopped.

| Reason                                                                           | Required decision                                                                   |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `authentication_required`                                                        | Resolve authentication through an explicit request; no automatic credential renewal |
| `permanent_failure`                                                              | Correct the rejected configuration or operation before a new request                |
| `reconciliation_unavailable`, `reconciliation_unverified`                        | Inspect authoritative external state before deciding whether to repeat a write      |
| `scope_not_authorized`, `reconciliation_authority_rejected`                      | Reassess the original permission; retry confers none                                |
| `attempt_budget_exhausted`, `elapsed_budget_exhausted`, `delay_budget_exhausted` | Review outcome and original budget before a new operation                           |

`completed` with `response_observed` means the trusted executor returned. It
does not prove semantic task acceptance. `reconciled_applied` means its trusted
lookup confirmed that operation, not that all work in the surrounding task is
complete. Authentication/permanent errors after dispatch still leave certainty
unknown when their external effect cannot be established.

Every intent is flushed before execution. Atomic replacement preserves the last
readable record on a failed write; an exclusive per-operation lock prevents
concurrent dispatch of the same ID. Records are bounded to 128 KiB and 300
events. Read-only inspection maps interrupted, nonterminal records to `unknown`.
Existing locks are never automatically removed or stolen. Corrupt, foreign or
unknown-schema records are rejected without overwrite. No prompt, environment,
credential, raw result or peer error text enters this history. File flushing
does not establish power-loss durability. Recovery never replays a write.
