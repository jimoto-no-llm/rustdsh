# Versioned question cards

The project dashboard supports ordinary consultations and explicit approval
requests through `dashboard_ask_question`. Every answer remains a human reply;
this feature does not issue an execution permission, start an agent, merge,
publish, or charge money. Permission decisions belong to the approval ledger
(#30); consumer read/application acknowledgements belong to #41.

## Compatibility and creation

Legacy `{id, question, urgency?, default_action?}` calls retain their existing
question and feedback field shapes. `default_action` is informational and does
not turn a consultation into an approval request. The state schema remains 1
and both MCP transports still expose six tools. Optional `question_contracts`
metadata has its own schema 1 and is written atomically with questions/answers
in the same project state file. Unsupported or inconsistent metadata prevents
startup without overwriting the file.

Add `decision` for a typed card:

```json
{
  "id": "Q1",
  "question": "Publish this document revision?",
  "urgency": "high",
  "decision": {
    "kind": "approval",
    "target": {
      "task_id": "T1",
      "run_id": "run-fixture-1",
      "session_id": "native-fixture-1",
      "action_id": "publish-document",
      "revision": "document-v1"
    },
    "choices": [
      { "id": "proceed", "label": "Proceed under these conditions" },
      { "id": "hold", "label": "Keep on hold" }
    ],
    "recommended_choice": "hold",
    "recommendation_reason": "The target document still needs review.",
    "diff": "Only fixture.md is added to the published documents.",
    "impact": "Other people will be able to read the document.",
    "conditions": "Only this task, run and document revision are in scope.",
    "cost": {
      "currency": "USD",
      "max": 5,
      "description": "Declared ceiling; no billing measurement is implied."
    },
    "expires_at": "2026-12-01T00:00:00Z"
  }
}
```

Consultations use `kind: "consultation"` and may omit target, choices, cost and
other context. Approval requests require a versioned action, at least two
choices, diff, impact, conditions and an explicit USD cost object. `max: null`
means unknown, never zero. A recommendation requires its reason and an existing
choice; the browser never preselects it. Free text remains available.

Targets and costs are declarations from the question publisher. They are not
observations of a native session, a provider invoice or a permitted budget.
Publishers must revise the card whenever its real target or conditions change.
This feature cannot detect an external action change that was never reported.

## Revision, answers and invalidation

Read `question_contracts.cards[id]` with `dashboard_get_state`. Its monotonic
`revision` and content `fingerprint` cover the complete displayed question,
urgency, reference action and normalized decision context.

- Create: omit `action`, or use `action: "create"` with a typed decision.
- Revise: send the full new question/decision, `action: "revise"` and the current
  `expected_revision`. Reusing a legacy question ID remains unsupported.
- Cancel: send `{id, action: "cancel", expected_revision, cancel_reason}`.

A changed question creates a new open revision. Previous snapshots and any
saved answers stay in the revision history; the original feedback records and
sequence cursors are retained. Public feedback adds `contract_validity` and
`invalidation_reason`. An old answer cannot become a reply to a new revision,
and `execution_authorized` is always false. A limit of 1000 older revisions
requires a new question ID instead of deleting retained history.

Only the existing human browser credential may submit `/api/update/answer`.
Typed replies require `expected_revision`, `contract_fingerprint`, an optional
`choice_id` and nonempty `answer`. The UI sends these automatically. Stale
revisions/fingerprints, expiry and cancellation reject the reply with HTTP 409.
An already answered question retains its existing HTTP 400 duplicate-reply
rejection; its saved feedback must still be checked for current validity.
MCP/admin credentials cannot forge human replies. The human-only
`/api/decision/cancel` endpoint retains host/origin and credential checks.

Saving an answer is distinct from delivering, reading or applying it. Neither
the webhook result nor a feedback read claims application. Clients must check
the current validity again before using a retained typed answer; immutable
feedback alone cannot convey a later cancellation or target change.

## Browser behavior

The card shows kind, choices, recommendation reason, task/run/session/action and
target revision, diff, impact, conditions and cost together. A revision names
changed fields, shows the previous target and old/new cost when applicable,
and requires a new review before submitting a preserved draft. Previous radio
selection is cleared. Unrelated SSE updates retain text, radio selection,
focus and textarea selection. Older HTTP snapshots cannot roll the displayed
project revision backwards. Periodic state reads refresh expiry even without
an SSE event; the server always checks the deadline at submission.

Expired and cancelled cards remain visible with disabled answer controls.
Saved replies are labeled as saved; older replies stay visible as invalidated
history. Responsive cards keep their content visible in a narrow viewport.
See the [actual captures and validation](evidence/question-contracts.md).
