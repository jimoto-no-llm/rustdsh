# Restart-fixture observation review

PR [#428](https://github.com/jimoto-no-llm/rustdsh/pull/428), revision
`119661e9550b61f480af0f29b7ee4ca92493b5ef`, passed the previously failing macOS
digest fixture but failed the Windows fault simulator's `restart` scenario with
`fixture_process_identity_unavailable`.

## Finding and change

The supervisor descriptor can contain no process identity when the read-only
observation is unavailable. The restart simulator then made just one fallback
observation and killed its owned worker even when that observation was unknown.
The recovery proof requires a captured identity; after termination it cannot be
reconstructed safely. The Windows observer has a five-second timeout, but the CI
report does not identify the underlying reason for the unavailable observation.

The simulator now tries at most three observations while its fixed mock peer is
paused before acknowledgement. It accepts only a valid identity for the same PID,
stops observing on a reported absence, and retains failure if no identity is
available. It waits for the pending observation before interpreting worker exit.
Unexpected observation errors still terminate the captured worker and fail the
scenario. This does not change production observer timeouts or exit proofs, and
no numeric PID is used as signal authority.

## Verification and limits

The focused tests cover an unknown observation followed by a valid identity,
permanent unknown, a different PID, and observed absence. All five fault-simulator
tests passed on Linux, including the six offline control-plane scenarios and
replay. The fixtures do not contact a model provider or use real credentials.

Native Windows CI must verify the pushed revision. This bounded retry addresses
one fixture's missing observation; it does not establish that every intermittent
Windows dashboard timeout in issue #209 is resolved.

Diff review: correctness 3/3, style 3/3, tests 2/3 until native Windows validation.
No blocking source finding remains in this change; Windows acceptance is pending.
