# Ordered inputs to a recorded native target

This is the ordering foundation for issue #19. It extends the existing
[human answer application](ANSWER-APPLICATION.md) command/ack path; it does not
replace the original agent loop or change native sessions.
The [source output comparison](evidence/input-queue-ordering.json) calls the
baseline and current begin-decision functions against the same valid durable
fixture. The earlier version grants a later begin; this version returns known
waiting. That decision-only comparison makes zero native requests; the actual
ACP effect tests described below are separate.

## Durable order and begin claims

Each bound answer already has an immutable reply command ID, a durable feedback
sequence, an exact consumer/run/native-session binding and a preallocated native
command ID for its one permitted effect. Reading with a cursor is observation,
not authority to skip earlier commands.

Before a new `begin` claim is committed, the server checks the current durable
commands for that exact consumer. A current earlier saved/read input blocks a
later input. Any started or unknown input blocks another begin, even if its
question was later revised or cancelled. Such an edit cannot establish whether
the original native effect occurred.

The check runs within the existing serialized state mutation. Competing callers
cannot each use a stale snapshot to claim two effects. Terminal native success
or failure releases the ordering barrier; invalidated saved/read inputs may be
skipped because they never obtained permission to send.

| Earlier command                               | Later `begin` result                       | Native send  |
| --------------------------------------------- | ------------------------------------------ | ------------ |
| Current saved/read                            | `claimed: false`, `earlier_input_pending`  | None         |
| Started                                       | `claimed: false`, `target_input_active`    | None         |
| Unknown, including a revised question         | `claimed: false`, `earlier_result_unknown` | None         |
| Succeeded/failed with correlated native proof | Normal one-time claim remains possible     | At most once |

The response includes `waiting_for` with the blocking reply ID. The consumer
reports `phase: queued` and preserves its cursor rather than treating known
waiting as a failed or unknown native attempt. The durable command remains
saved/read; a duplicate begin still never grants another send.

## Reconcile effects after a question edit

If a previously issued input's question has changed, the consumer can still
reconcile its original native command against the existing exact run/session,
owner, input hash and native result. A confirmed old result releases the queue
barrier without replaying that input or answering the newer question. If no
such result exists, the input remains unknown and later inputs stay blocked.

This distinguishes current question validity from evidence about an already
issued effect. Neither a question edit nor an optimistic cursor is evidence
of completion, failure or permission to execute again.

## Verified scope and remaining work

Actual owned ACP fixtures check out-of-order application, old-cursor duplicate
requests, active and unknown barriers, invalidation without bypass, and an old
native result reconciled after revision. The first scenario produces two prompt
requests and two effects in order, with no effect from an early/duplicate later
apply. A second scenario reconciles the already-issued first input without
replay, then permits the second input once; the revised question stays unanswered.

This change covers existing bound reply inputs for an exact registered target.
Explicit next-turn/steer/interrupt selection, a general PC/phone/management-agent
instruction submission interface and human review of conflicting instructions
are subsequent parts of #19. The current adapter still exposes only its
verified operations; this change adds no steer call, interruption request,
execution permission or cross-run alias assumption. The PR references #19
without closing the full issue.
