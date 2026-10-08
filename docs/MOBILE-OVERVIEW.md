# Project and task overview

The project dashboard opens with **いまの状況**: project/task context, current
evidence and its time, last result, pending decisions and stop availability.
Metrics, task rows, reply application details and progress reports are folded.
The bottom navigation keeps overview, decisions, details and stop guidance
within reach without changing the project or submitting an answer.

## Evidence and missing states

Task `doing`/`done` values are reports. They never prove native execution or
acceptance. Without a registered reply target, the execution state stays
`実行状態は未取得`, and the overview distinguishes absent execution observations
from the project's last reported update time.

For existing [reply consumers](ANSWER-APPLICATION.md), the view summarizes the
latest public observation per consumer: connection confirmed, target process
ended, or unknown. This is a view of reply targets; it does not inventory all
processes or prove that the task has finished. On failed refresh or SSE loss,
the displayed current state becomes unconfirmed until a successful refresh.

The last result can be a correlated input response, an uncertain/invalidated
reply, or a project progress report. Native input completion is labelled as an
ACP result. Project progress reports are labelled as declarations, with
acceptance separate. Saved replies and notification delivery are not input
results. An unknown newer input cannot inherit an earlier input's success.

Pending decisions exclude answered, cancelled and expired questions. Selecting
a task includes only questions explicitly bound to that task. Unbound questions
are counted separately and remain available in the full project question list;
they are never silently assigned to the selected task.

## Context and detail navigation

Choose a task in **確認する範囲** or open its ID in the task list. The selection
is stored per project in the current tab's session storage. Live updates and
opening/closing details keep the selection. A task that disappears from a
snapshot retains its selected ID with an explicit missing-task label.

After browser authentication, `#task-<id>` selects that task on reload; the
credential fragment alone is removed from the URL. Other task/question anchors
are retained. This selection is display context, never authentication or control
authority. Detailed tables, metrics and questions retain their stated project
scope, and answering still uses the exact question's revision contract.

Question drafts survive unrelated updates and detail navigation. A changed
revision requires fresh review even if its content fingerprint has returned to
an earlier value. Previous choices/reviews cannot approve that newer revision.

## Stop controls

Project mode has no live controller for externally attached ACP adapters. Its
stop guidance therefore says that stopping from this screen is unsupported and
points to the original CLI. It never reconstructs stop authority from recorded
PID/run metadata, and the guidance navigation issues no stop request.

The managed Harness entry uses its existing [owned process scope](SCOPED-STOP.md).
Selecting stop first displays the exact live run/owner and its impact on owned
descendants. Cancel/Esc sends no request. Confirmation rechecks the run, owner
and running state; a changed or unobservable target requires review again.
The existing authenticated stop API and staged ownership checks remain the
enforcement mechanism. Stopping and verified empty descendants remain distinct.

## Validation boundary

[Recorded technical verification](evidence/mobile-overview.md) includes actual
browser captures and native fixture observations. Responsive iframe widths are
layout checks, not physical-phone or Tailscale validation.

Issue #42's participant scenario remains open: without prior explanation, ask a
participant to identify the project, state/evidence time, last result, whether
they must decide, and the stop location. Record time, mistakes and missing
information for missing-state, no-decision and multiple-decision cases. Repeat
detail opening and task selection, and check stop cancellation separately.
The approximately 30-second target has not been tested with a human participant
and is not a product performance guarantee.
