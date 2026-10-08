# Run recovery evidence

Issue: [#34](https://github.com/sahenjp/rustdsh/issues/34).
Captured on 2026-10-06 JST from prerequisite diagnostics
[#123](https://github.com/sahenjp/rustdsh/pull/123), base commit
`4ac7e95577ca92e886779d35e39749de5c8db0bb`.

[Windows observations](run-recovery-local.json) use the fixture ACP peer and
real Windows process creation/exit observations. [Linux observations](run-recovery-local-linux.json)
use the explicitly selected original DSH in the existing WSL distribution, with
isolated native home and a temporary Git project. Both capture an owned live
root, confirmed stop, read-only inspection from a new client, and explicit resume
of the same persisted native session ID. No provider credentials or model prompt
are used in these local observations.

The command comparison in each record evaluates the exact baseline CLI
entrypoint source with the currently installed common dependencies:
it rejects `run-history`. The new entrypoint reads the persisted run and reports
the observed root exit independently of the native session ID.

`dashboard/test/fixtures/run-history-crash.mjs` is actually killed before/after
intent persistence and before/after acknowledgement persistence. A harmless
fixture counter stands in for an external side effect. Two independent recovery
clients preserve committed IDs and leave the counter and journal unchanged.
Separate hard-exit fixtures leave a torn suffix and a stale writer lock; both
allow read-only restoration and refuse silent overwrite or lock theft.

Tests cover live/exited/reused/unobservable process identities, native Windows
and Linux observations, distinct browser connectivity, invalid-transition audit,
native request/ack IDs, duplicate stop, blocked duplicate resume and cleanup even
when history persistence is unavailable. Mock prompt/cancel tests never invoke
a provider. Presence of an ACP result is not semantic instruction application.

Validation: dashboard tests pass 64/64 on Windows and WSL Linux. Rust release
tests pass 62/62 and regression checks pass 41/41. Formatting, release Clippy
with warnings denied and the release build pass. No dependency changed.

Real model operation, provider authentication, descendant termination, physical
phone access, macOS process identity and power-loss durability remain unverified.
The reported `running` state is a recorded in-flight prompt, never inferred from
PID liveness alone. This change does not publish a new run-control web UI.
