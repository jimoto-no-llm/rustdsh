import test from "node:test";
import assert from "node:assert/strict";
import {
  publicDecisionReferences,
  recordDecision,
  validateDecisionLog,
} from "../decision-log.mjs";

function fixture() {
  return {
    questions: [
      {
        id: "Q1",
        question: "Which provider should we use?",
        answer: "Use provider A",
        answered_at: "2026-10-01T00:00:00.000Z",
      },
    ],
    tasks: [{ id: "T1", title: "Plan", status: "doing" }],
  };
}

test("decision versions preserve human source and surface stale task references", () => {
  const state = fixture();
  recordDecision(state, {
    id: "D-A",
    subject: "provider policy",
    policy: "Use provider A",
    rationale: "The human selected A",
    question_id: "Q1",
    task_id: "T1",
  });
  state.tasks[0].policy_decision_id = "D-A";
  recordDecision(state, {
    id: "D-B",
    subject: "provider policy",
    policy: "Use provider B",
    rationale: "",
    change_summary: "A no longer meets the requirement",
    question_id: "Q1",
    task_id: "T1",
    supersedes_id: "D-A",
  });
  state.questions[0].answer = "Changed later";
  validateDecisionLog(state);

  assert.deepEqual(
    state.decision_log.records.map((record) => [record.id, record.status]),
    [["D-A", "replaced"], ["D-B", "current"]],
  );
  assert.equal(state.decision_log.records[1].rationale, "");
  assert.equal(state.decision_log.records[1].question.answer, "Use provider A");
  assert.equal(state.tasks[0].policy_decision_id, "D-A");
  assert.deepEqual(publicDecisionReferences(state)[0].decision_reference, {
    id: "D-A",
    status: "replaced",
    policy: "Use provider A",
    replacement_id: "D-B",
    replacement_policy: "Use provider B",
    replacement_status: "current",
    confirmation_required: true,
    reason: "置換済みの決定を参照しています。現行方針を確認してください",
  });
});

test("held and withdrawn decisions need explicit replacement and invalid links are rejected", () => {
  const state = fixture();
  recordDecision(state, {
    id: "D-A",
    subject: "provider policy",
    policy: "Use provider A",
  });
  recordDecision(state, { action: "hold", id: "D-A", reason: "Review pending" });
  recordDecision(state, {
    id: "D-B",
    subject: "provider policy",
    policy: "Use provider B",
    supersedes_id: "D-A",
  });
  validateDecisionLog(state);
  const clone = structuredClone(state);
  assert.throws(
    () =>
      recordDecision(clone, {
        id: "D-C",
        subject: "different policy",
        policy: "Do not cross-link",
        supersedes_id: "D-B",
      }),
    /same subject/,
  );
  assert.throws(
    () =>
      recordDecision(state, {
        id: "D-C",
        subject: "provider policy",
        policy: "Implicit replacement is blocked",
      }),
    /explicitly/,
  );
  assert.equal(state.decision_log.records.at(-1).status, "current");
});
