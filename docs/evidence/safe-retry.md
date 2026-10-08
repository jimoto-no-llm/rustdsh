# Retry evidence

Issue: [#37](https://github.com/sahenjp/rustdsh/issues/37).
The comparison uses the baseline CLI entrypoint from commit
`739d93a` with the same currently installed dashboard dependencies.
It rejects `--retry`; the new entrypoint performs the bounded original CLI
version query and exposes a persisted operation record.

[Windows observations](safe-retry-local.json) use a real Node subprocess running
the isolated version fixture. [Linux observations](safe-retry-local-linux.json)
use the explicit original DSH in the existing WSL distribution. Both inspect
the record from a separate CLI process and verify unchanged stored bytes.
A repeated request with the same operation ID returns historical status without
a fresh adapter report or any new attempt. Isolated homes contain no provider
credentials. No profile boot, prompt, model request or external delivery occurs.

The automated transport fixtures exercise transient recovery, exponential
backoff, attempt/elapsed/cooldown exhaustion, authentication refusal, permanent
errors, unclassified peer errors and permission revocation. A deadline consumed
by durable persistence blocks preparation/reconciliation callbacks; an in-flight
deadline aborts cooperatively and cannot authorize a late retry.

After an external-send fixture applies its local transaction, it deliberately
loses the response. Reconciliation confirms the original operation ID and stops
at one write. A separate disposable Git repository performs one actual commit,
deliberately loses the response and verifies that commit before allowing any
next action. Neither fixture duplicates its operation. Authoritative final
non-application allows a bounded retry; missing, mismatched or eventually
consistent evidence stops with unknown certainty. These fixtures do not prove
delivery-service or payment-provider integration.

Stored records exclude peer secrets and evidence bodies. Corrupt records,
operation-ID collisions and surviving locks preserve existing bytes. A new
client reads incomplete work as unknown and does not silently resume it.
The library authorizer and typed failure/reconciliation callbacks remain part
of the trusted integration; this is not an OS sandbox or arbitrary-code policy.

Validation: dashboard tests pass 76/76 on Windows and WSL Linux. The stale-lock
uncertainty regression from the base PR also passes separately on both systems.
Rust release tests pass 62/62 and regression checks pass 41/41. Formatting,
release Clippy with warnings denied and the release build pass. No dependency
changed. Real provider authentication, model work, delivery/payment services,
OS containment, phone operation and power-loss durability remain unverified.
