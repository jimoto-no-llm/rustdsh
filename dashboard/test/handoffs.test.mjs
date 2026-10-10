import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHandoff,
  handoffFreshness,
  handoffResource,
  isHandoffPacket,
} from "../handoffs.mjs";

const at = "2026-10-10T02:00:00.000Z";

function fixture() {
  const state = {
    revision: 12,
    tasks: [
      {
        id: "T-1",
        title: "Implement the parser",
        status: "doing",
        milestone: "M2",
        blocker: "Wait for format decision",
        updated_at: at,
      },
    ],
    questions: [],
    question_contracts: {
      cards: {
        "decision-1": {
          status: "answered",
          revision: 2,
          updated_at: at,
          snapshot: {
            decision: {
              target: { task_id: "T-1", revision: "parser-v2" },
              conditions: "Keep the current output format",
            },
          },
        },
      },
    },
    feedback: [
      {
        sequence: 1,
        type: "question_answered",
        question_id: "decision-1",
        question: "Keep the current output format?",
        answer: "Yes, keep it",
        choice_id: "keep",
        target: { task_id: "T-1", revision: "parser-v2" },
        contract_fingerprint: "decision-fingerprint",
        contract_validity: "current",
        created_at: at,
      },
      {
        sequence: 2,
        type: "question_answered",
        question_id: "unbound",
        question: "Project-level question",
        answer: "Do not attach this to T-1",
        created_at: at,
      },
    ],
    events: [
      {
        sequence: 3,
        type: "artifact",
        title: "Build output",
        detail: "Recorded as reference only",
        artifact: "artifacts/build.txt",
        created_at: at,
        observation: {},
      },
    ],
  };
  const acceptance = {
    task_id: "T-1",
    source_revision: 4,
    observed_at: at,
    reported_task_status: "doing",
    acceptance_defined: true,
    conditions: [
      {
        criterion: { id: "parser-test", description: "Parser tests pass" },
        status: "not-run",
        verified_full_check: false,
        current_target: {
          observed_at: at,
          head_sha: "a".repeat(40),
          branch: "codex/parser",
          inputs_hash: "b".repeat(64),
          worktree_hash: "c".repeat(64),
          environment_hash: "d".repeat(64),
          status: "current",
          reason: "all_inputs_match",
        },
        evidence: [],
      },
    ],
    verification: {
      status: "unverified",
      all_declared_full_checks_pass: false,
      human_review: "not_assessed",
      production_adoption: "not_assessed",
    },
    replayed_tests: 0,
    permission_expanded: false,
  };
  return { state, acceptance };
}

test("handoff contains seven source-linked sections and leaves unperformed checks unknown", () => {
  const { state, acceptance } = fixture();
  const packet = buildHandoff(state, "T-1", acceptance, new Date(at));
  assert.equal(isHandoffPacket(packet), true);
  assert.deepEqual(Object.keys(packet.sections), [
    "purpose",
    "remaining",
    "constraints",
    "decisions",
    "deliverables",
    "verification",
    "next_step",
  ]);
  assert.equal(packet.sections.purpose.items[0].reported_task_title, "Implement the parser");
  assert.equal(packet.sections.constraints.items[0].text, "Wait for format decision");
  assert.equal(packet.sections.constraints.items[1].question_id, "decision-1");
  assert.equal(packet.sections.decisions.items.length, 1);
  assert.equal(packet.sections.decisions.items[0].answer, "Yes, keep it");
  assert.equal(
    packet.sections.decisions.items[0].contract_validity,
    "current",
  );
  assert.equal(packet.sections.decisions.items[0].execution_authorized, false);
  assert.equal(
    packet.sections.decisions.items[0].source.uri,
    "dashboard://feedback",
  );
  assert.equal(packet.sections.deliverables.items[0].contents, "not_opened");
  assert.equal(packet.sections.verification.items[0].status, "not-run");
  assert.equal(packet.sections.verification.items[0].verified_full_check, false);
  assert.equal(packet.sections.remaining.items[1].type, "acceptance_check");
  assert.equal(
    packet.sections.remaining.items[1].result_status,
    "not-run",
  );
  assert.equal(packet.sections.next_step.items[0].status, "unknown");
  assert.equal(packet.sections.verification.human_review, "not_assessed");
  assert.ok(packet.source_refs.every((source) => source.uri && source.captured_at));
  assert.equal(
    JSON.stringify(packet).includes("private_record_directory"),
    false,
  );
  assert.equal(handoffFreshness(packet, state, acceptance).status, "current");
});

test("handoff freshness names changed, removed, and newly available sources", () => {
  const { state, acceptance } = fixture();
  const packet = buildHandoff(state, "T-1", acceptance, new Date(at));
  const changedState = structuredClone(state);
  changedState.revision++;
  changedState.tasks[0].status = "done";
  changedState.tasks[0].updated_at = "2026-10-10T02:10:00.000Z";
  changedState.events = [];
  changedState.feedback[0].answer = "Actually, revise it";
  changedState.feedback[0].contract_validity = "invalidated";
  changedState.feedback[0].invalidation_reason = "question_contract_changed";
  changedState.question_contracts.cards["decision-1"].revision = 3;
  changedState.question_contracts.cards[
    "decision-1"
  ].snapshot.decision.conditions = "Review the output format again";
  const changedAcceptance = structuredClone(acceptance);
  changedAcceptance.conditions[0].status = "pass";
  changedAcceptance.conditions[0].verified_full_check = true;
  const freshness = handoffFreshness(packet, changedState, changedAcceptance);
  assert.equal(freshness.status, "stale");
  assert.equal(freshness.created_at, at);
  assert.equal(freshness.state_revision_changed, true);
  assert.ok(freshness.stale_references.some((item) => item.id === "task:T-1"));
  assert.ok(
    freshness.stale_references.some((item) => item.id === "event:3"),
  );
  assert.ok(
    freshness.stale_references.some((item) => item.id === "answer:1"),
  );
  assert.ok(
    freshness.stale_references.some((item) =>
      item.id.startsWith("decision-card:decision-1"),
    ),
  );
  assert.ok(
    freshness.stale_references.some((item) =>
      item.id.startsWith("acceptance:T-1:parser-test"),
    ),
  );

  const addedState = structuredClone(state);
  addedState.events.push({
    sequence: 4,
    type: "artifact",
    title: "New output",
    artifact: "new-output.txt",
    created_at: "2026-10-10T02:20:00.000Z",
    observation: {},
  });
  const added = handoffFreshness(packet, addedState, acceptance);
  assert.ok(added.new_references.some((item) => item.id === "event:4"));
});

test("missing task and acceptance data stay unknown instead of reporting success", () => {
  const state = { revision: 0, tasks: [], questions: [], feedback: [], events: [] };
  const packet = buildHandoff(state, "missing", null, new Date(at));
  assert.equal(packet.sections.purpose.status, "unknown");
  assert.equal(packet.sections.remaining.items[0].reason, "task_not_found");
  assert.equal(packet.sections.verification.status, "unverified");
  assert.equal(
    packet.sections.verification.items[0].reason,
    "acceptance_criteria_not_defined",
  );
  assert.equal(packet.sections.next_step.items[0].status, "unknown");
  assert.equal(handoffResource(null).status, "unknown");
});
