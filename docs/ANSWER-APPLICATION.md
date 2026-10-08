# Human reply application acknowledgements

A saved answer, a delivered webhook, a consumer read and a native input result
are separate facts. Optional consumer-bound question cards make those facts
visible without changing the six MCP tools or consuming the original feedback.
This implements [issue #41](https://github.com/sahenjp/rustdsh/issues/41).

## Bind an existing native session

The supported consumer wraps the original DSH ACP profile client. It forwards
human answers as input to that exact session; it does not implement an agent
loop, grant permissions, change a model, or start a replacement session.

First obtain a confirmed run using the session ledger. `session-ledger start`
creates its native session and stops its owned process without sending a prompt.
An explicit consumer invocation resumes that recorded session:

```sh
rdsh-dashboard reply-consumer serve --project /path/to/project \
  --run-id run_<recorded-uuid> --executable /path/to/original-dsh
```

When invoking DSH through Node, also pass `--entrypoint /path/to/dsh/lib/bin.js`.
Use the same executable, entrypoint, repository context and native HOME scope
as the recorded attachment. The dashboard must already be running. `serve`
polls at two-second checkpoints; `once` reads one batch and exits. Both stop
their own ACP process on exit and print public IDs/results, never credentials
or answer text. They send inputs only when current bound human replies exist.
Native inputs can use the provider configured for that existing session.
The original adapter's 64-KiB input limit and timeouts still apply; question
conditions are never silently shortened to fit.

The consumer prints its `consumer_id`, `run_id` and native `session_id`. A
question publisher uses all three explicitly:

```json
{
  "id": "Q1",
  "question": "How should we handle the failing test?",
  "decision": {
    "kind": "consultation",
    "consumer_id": "consumer_<printed-id>",
    "target": {
      "task_id": "T1",
      "run_id": "run_<printed-uuid>",
      "session_id": "<printed-native-id>",
      "revision": "test-fix-v1"
    }
  }
}
```

Send this through `dashboard_ask_question`. If the run has no task binding,
omit `task_id`; a supplied task must match. Unknown consumers or different
run/session targets are rejected. Adding or changing a consumer is part of the
[question revision](QUESTION-CONTRACTS.md), so an old answer cannot answer the
new card. Restoring earlier content still creates a new revision; matching
content alone never makes an earlier answer current again. Existing unbound
questions keep their field shapes and saved-only
semantics; project MCP credentials cannot report application results.

An existing live attachment can use `ReplyConsumer.open({ project, attached })`
from `dashboard/reply-consumer.mjs`, then `read()` or `poll()`. `read()` alone
has no acknowledgement or application side effects. The owner remains
responsible for `attached.adapter.stop()`; opening a consumer does not acquire
authority over another process.

## Recorded stages and evidence

| Stage                 | Evidence                                                                                 | Does it confirm application?                           |
| --------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Saved                 | Atomic state write containing answer and stable `reply_command_id`                       | No                                                     |
| Notification delivery | Signed webhook attempt received an HTTP success                                          | No                                                     |
| Target read           | Separate consumer credential acknowledges the exact command                              | No                                                     |
| Started               | One durable claim binds an attempt, owner and preallocated native command                | Input may be in flight                                 |
| Succeeded             | Run history has the matching native command, input hash, owner and ACP completion result | Confirms this input's ACP completion                   |
| Failed                | Matching ACP result is refusal, cancellation or input limit                              | Confirms that input processing stopped for that reason |
| Unknown               | Claim/result acknowledgement is missing or target cannot be reconciled                   | Never replay automatically                             |
| Unapplied             | Target ended before any application claim                                                | Original answer remains available                      |

The input hash covers the exact answer envelope passed to `adapter.send`,
including reply ID, consumer, run/session, question revision, the complete
versioned decision (target, conditions and declared cost), and answer. Native
history records its digest, not the prompt or provider credentials. An unrelated
native input with the same command ID cannot confirm this reply.

Success describes the original CLI's correlated input processing result. It
does not prove a requested file change, publication, purchase, or task acceptance.
Those effects still require their existing permissions and
[acceptance evidence](ACCEPTANCE-EVIDENCE.md). The read acknowledgement comes
from the session's transport consumer; webhook or cursor reads cannot prove
that the native agent has processed the input.

## Reconnect without duplicate inputs

The server serializes a claim in the same `state.json` as the answer before the
consumer sends any input. The first successful claim returns `claimed: true`.
Every repeated claim, including the same attempt after response loss, returns
`claimed: false`. A lost claim response therefore causes zero sends. This is an
at-most-once dispatch policy: uncertainty can leave an answer unapplied.

The preallocated `cmd_...` ID is also the native run-history command ID. After
a missing application acknowledgement, `reconcile` can recover an already
recorded native result, including its original timestamp, without another send.
If the native result is missing, an explicit same-session reconnect still
leaves that reply unknown and blocked. A native error after possible effects
is unknown, rather than proof that nothing happened.

Answers saved before a consumer stops remain readable with an old cursor.
`once`/`serve` explicitly resume the same run and native session and renew the
consumer credential. A reply with no prior claim can then be applied; one with
a prior claim cannot be resent. Lost or unsupported sessions are errors: there
is no fallback to `session/new`, another run, or another HOME scope.

Revision changes, expiry and cancellation block a new claim. They cannot retract
input already sent to a native session. Any later result remains attached to
the old reply and is displayed as invalidated for the current card.

For inspection without launching a process:

```sh
rdsh-dashboard reply-consumer inspect --project /path/to/project
rdsh-dashboard reply-consumer inspect --project /path/to/project \
  --command-id reply_<uuid>
```

File inspection conservatively leaves live target observations unknown. The
live dashboard observes the recorded process identity and current registered
owner; after a restart it never reconstructs kernel handles or connection
authority from saved IDs. Missing heartbeat/owner evidence is unverified.

## Authentication and persistence

`POST /api/replies/register` requires the local administrator credential and a
confirmed ledger run/session with an observed live ACP scope owner. It returns
a separate random consumer token. That token exists only in server/client
memory, rotates on registration and is bound to one consumer/run/session.
Existing private runtime files retain their existing administrator/MCP keys;
the new consumer token is never stored in dashboard state or CLI output.

`GET /api/replies/read` and `POST /api/replies/ack` require the separate token.
Acknowledgement phases are `read`, `begin`, `unknown` and `reconcile`; a caller
cannot submit a fabricated `succeeded` result. The server derives final results
from native history. Browser, project MCP and administrator credentials cannot
substitute for a consumer acknowledgement. Existing host/origin checks apply.

`answer_applications` is optional schema-1 metadata inside `state.json`.
Answer creation and its application command share one atomic replacement.
Acknowledgements retain the immutable feedback and do not create extra MCP
events. Wrong bindings, unknown schemas, missing records and corrupt input
digests are rejected while preserving the original file. Consumer and command
limits are 5,000 and 20,000; full histories fail closed instead of dropping
unresolved commands. The UI shows the newest 20 commands; all remain in state.

Webhook attempt observations are bounded to the newest 1,000 records in
`events.json`, without callback URLs or signing secrets in the public projection.
No record means no delivery evidence. Old records and failed delivery attempts
never turn a saved answer into a read or successful application.

This uses the existing atomic state replacement contract and fsynced native
history. Process stop/restart and response-loss recovery are tested; whole-machine
power-loss transactions across both files are not claimed. Uninstrumented Dot
or other CLI consumers remain unverified until they implement a supported
binding/ack channel. Live provider execution and remote Dot/Tailscale application
were not exercised by the credential-free fixtures.

See [verification and real screenshots](evidence/answer-application.md).
