import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { ProjectStore, publicState } from "../state.mjs";
import { executeTool, feedbackSince, tools } from "../mcp.mjs";
import { startDashboard } from "../server.mjs";
import { draftReviewState } from "../question-cards-ui.mjs";

function approval(max = 5, action = "publish-fixture", revision = "target-v1") {
  return {
    kind: "approval",
    target: {
      task_id: "T1",
      run_id: "run-fixture-1",
      session_id: "native-fixture-1",
      action_id: action,
      revision,
    },
    choices: [
      {
        id: "proceed",
        label: "この条件で進める",
        detail: "対象の版と上限額を確認",
      },
      { id: "hold", label: "保留する" },
    ],
    recommended_choice: "hold",
    recommendation_reason: "公開対象を確認してから進めるため",
    diff: "fixture.mdのみ公開対象に加える",
    impact: "公開された文書を他の利用者が閲覧できます",
    conditions: "T1・run-fixture-1・target-v1に限定。mergeや課金は別判断",
    cost: {
      currency: "USD",
      max,
      description: "申告された上限。費用の実測ではありません",
    },
  };
}
const ask = (decision = approval(), extra = {}) => ({
  id: "Q1",
  question: "この版の文書を公開しますか？",
  decision,
  ...extra,
});
function answer(card, extra = {}) {
  return {
    id: "Q1",
    answer: "この条件で進める",
    expected_revision: card.revision,
    contract_fingerprint: card.fingerprint,
    choice_id: "proceed",
    ...extra,
  };
}
async function setup(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-question-contract-"),
  );
  const project = {
    id: "question-fixture",
    root,
    name: "質問カードQA",
    directory: path.join(root, "state"),
  };
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("rdsh-question-contract-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = await ProjectStore.open(project);
  return {
    root,
    project,
    store,
    file: path.join(project.directory, "state.json"),
    card: () => store.value.question_contracts.cards.Q1,
  };
}

test("restoring an older snapshot never revalidates that older revision's answer", async (t) => {
  const f = await setup(t);
  await f.store.mutate("question", ask());
  const first = structuredClone(f.card());
  await f.store.mutate("answer", answer(first));
  const original = structuredClone(f.store.value.feedback[0]);
  await f.store.mutate(
    "question",
    ask(approval(12, "different-action", "target-v2"), {
      action: "revise",
      expected_revision: 1,
    }),
  );
  await f.store.mutate(
    "question",
    ask(approval(), { action: "revise", expected_revision: 2 }),
  );
  assert.equal(f.card().fingerprint, first.fingerprint);
  const draft = {
    fingerprint: first.fingerprint,
    revision: first.revision,
    reviewed: first.fingerprint,
    reviewedRevision: first.revision,
  };
  assert.deepEqual(draftReviewState(draft, f.card()), {
    changedDraft: true,
    reviewRequired: true,
  });
  assert.equal(
    draftReviewState({ ...draft, reviewedRevision: 3 }, f.card())
      .reviewRequired,
    false,
  );
  assert.equal(draftReviewState(draft, first).changedDraft, false);
  await f.store.mutate(
    "answer",
    answer(f.card(), { answer: "最新版の対象は保留", choice_id: "hold" }),
  );
  const messages = feedbackSince(f.store.value, 0).messages;
  assert.equal(messages[0].contract_validity, "invalidated");
  assert.equal(messages[0].invalidation_reason, "question_contract_changed");
  assert.equal(messages[1].contract_validity, "current");
  assert.equal(messages[1].contract_revision, 3);
  assert.deepEqual(f.store.value.feedback[0], original);
  const reopened = await ProjectStore.open(f.project);
  assert.equal(
    publicState(reopened.value).feedback[0].contract_validity,
    "invalidated",
  );
});

test("legacy consultations retain their field shapes and a default action grants no typed approval", async (t) => {
  const f = await setup(t);
  await f.store.mutate("question", {
    id: "legacy",
    question: "何を先に試す？",
    default_action: "先にテストする",
  });
  assert.equal(f.store.value.schema, 1);
  assert.equal(f.store.value.question_contracts, undefined);
  assert.deepEqual(Object.keys(f.store.value.questions[0]), [
    "id",
    "question",
    "urgency",
    "default_action",
    "created_at",
    "answer",
  ]);
  await assert.rejects(
    f.store.mutate("answer", {
      id: "legacy",
      answer: "はい",
      contract_fingerprint: "forged",
      expected_revision: 1,
    }),
    /Legacy consultation/,
  );
  assert.equal(f.store.value.questions[0].answer, null);
  await f.store.mutate("answer", { id: "legacy", answer: "テストを先に" });
  assert.deepEqual(Object.keys(feedbackSince(f.store.value).messages[0]), [
    "sequence",
    "type",
    "question_id",
    "question",
    "answer",
    "created_at",
  ]);
  assert.equal(tools.length, 6);
});

test("typed choices, fixed target and a human answer persist atomically without creating execution authority", async (t) => {
  const f = await setup(t);
  await executeTool(
    { mutate: (...args) => f.store.mutate(...args) },
    "dashboard_ask_question",
    ask(),
  );
  const before = structuredClone(f.card());
  assert.equal(before.answer, null);
  assert.equal(before.status, "open");
  await f.store.mutate("answer", answer(before));
  const original = feedbackSince(f.store.value).messages[0];
  assert.equal(original.execution_authorized, false);
  assert.equal(original.contract_validity, "current");
  assert.equal(original.target.session_id, "native-fixture-1");
  assert.equal(original.choice_id, "proceed");
  const reopened = await ProjectStore.open(f.project);
  assert.deepEqual(reopened.value, f.store.value);
  assert.equal(
    publicState(reopened.value).question_contracts.cards.Q1
      .execution_authorized,
    false,
  );
  assert.deepEqual(
    feedbackSince(reopened.value).messages,
    feedbackSince(reopened.value).messages,
  );
  assert.equal(feedbackSince(reopened.value, 1).messages.length, 0);
});

test("changing an action and cost invalidates old answers and stale browser requests while retaining immutable feedback and revision history", async (t) => {
  const f = await setup(t);
  await f.store.mutate("question", ask());
  const old = structuredClone(f.card());
  await f.store.mutate("answer", answer(old));
  const raw = structuredClone(f.store.value.feedback[0]);
  await f.store.mutate(
    "question",
    ask(approval(12, "publish-another-fixture", "target-v2"), {
      action: "revise",
      expected_revision: 1,
    }),
  );
  assert.equal(f.card().revision, 2);
  assert.equal(f.store.value.questions[0].answer, null);
  assert.deepEqual(f.store.value.feedback[0], raw);
  assert.equal(f.card().history[0].answer.text, raw.answer);
  const view = publicState(f.store.value);
  assert.deepEqual(view.question_contracts.cards.Q1.changed_fields, [
    "対象・版",
    "費用上限",
  ]);
  assert.equal(view.feedback[0].contract_validity, "invalidated");
  assert.equal(
    view.feedback[0].invalidation_reason,
    "question_contract_changed",
  );
  assert.equal(view.feedback[0].execution_authorized, false);
  const bytes = await fs.readFile(f.file);
  await assert.rejects(
    f.store.mutate("answer", answer(old)),
    (failure) => failure.status === 409,
  );
  await assert.rejects(
    f.store.mutate(
      "answer",
      answer(f.card(), { contract_fingerprint: old.fingerprint }),
    ),
    (failure) => failure.status === 409,
  );
  await assert.rejects(
    f.store.mutate(
      "question",
      ask(approval(20), { action: "revise", expected_revision: 1 }),
    ),
    (failure) => failure.status === 409,
  );
  assert.deepEqual(await fs.readFile(f.file), bytes);
  await f.store.mutate(
    "answer",
    answer(f.card(), { choice_id: "hold", answer: "今回は保留" }),
  );
  assert.equal(
    feedbackSince(f.store.value).messages[1].contract_validity,
    "current",
  );
  assert.equal(
    feedbackSince(f.store.value).messages[1].target.revision,
    "target-v2",
  );
  assert.equal(
    feedbackSince(f.store.value).messages[0].contract_validity,
    "invalidated",
  );
  await ProjectStore.open(f.project);
});

test("unanswered, expired and cancelled questions never become automatic approval and cancellation invalidates a saved answer", async (t) => {
  const f = await setup(t);
  await f.store.mutate(
    "question",
    ask({ ...approval(), expires_at: "2000-01-01T00:00:00Z" }),
  );
  assert.equal(
    publicState(f.store.value).question_contracts.cards.Q1.status,
    "expired",
  );
  await assert.rejects(
    f.store.mutate("answer", answer(f.card())),
    (failure) => failure.status === 409,
  );
  assert.equal(f.store.value.feedback.length, 0);
  await f.store.mutate(
    "question",
    ask(approval(), { action: "revise", expected_revision: 1 }),
  );
  await f.store.mutate("answer", answer(f.card()));
  await f.store.mutate("question", {
    id: "Q1",
    action: "cancel",
    expected_revision: 2,
    cancel_reason: "対象操作を取り下げた",
  });
  assert.equal(
    feedbackSince(f.store.value).messages[0].invalidation_reason,
    "cancelled",
  );
  assert.equal(
    feedbackSince(f.store.value).messages[0].execution_authorized,
    false,
  );
  assert.equal(f.card().answer.text, "この条件で進める");
  await f.store.mutate("question", {
    id: "Q1",
    action: "cancel",
    expected_revision: 2,
    cancel_reason: "対象操作を取り下げた",
  });
  await ProjectStore.open(f.project);
});

test("incomplete approvals, duplicate choices, forged fields and corrupt persisted metadata preserve the last readable state", async (t) => {
  const f = await setup(t);
  await f.store.mutate("question", { id: "legacy", question: "既存の相談" });
  const bytes = await fs.readFile(f.file);
  for (const decision of [
    { kind: "approval" },
    { ...approval(), target: { revision: "v1" } },
    { ...approval(), cost: { currency: "USD", max: -1 } },
    { ...approval(), recommended_choice: "missing" },
    {
      ...approval(),
      choices: [
        { id: "same", label: "A" },
        { id: "same", label: "B" },
      ],
    },
    { ...approval(), execution_authorized: true },
  ]) {
    await assert.rejects(f.store.mutate("question", ask(decision)));
    assert.deepEqual(await fs.readFile(f.file), bytes);
  }
  await assert.rejects(
    f.store.mutate("question", ask(approval(), { id: "__proto__" })),
  );
  await f.store.mutate("question", ask());
  const state = structuredClone(f.store.value);
  state.question_contracts.cards.Q1.snapshot.decision.cost.max = 999;
  const corrupt = JSON.stringify(state);
  await fs.writeFile(f.file, corrupt);
  await assert.rejects(ProjectStore.open(f.project), /corrupt/);
  assert.equal(await fs.readFile(f.file, "utf8"), corrupt);
  state.question_contracts.schema = 2;
  await fs.writeFile(f.file, JSON.stringify(state));
  await assert.rejects(ProjectStore.open(f.project), /Unsupported/);
});

test("authenticated human HTTP answers bind the seen revision; MCP/admin cannot forge an answer or a human cancellation", async (t) => {
  const f = await setup(t);
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const dashboard = await startDashboard({
    project: f.project,
    port,
    tailscale: false,
  });
  t.after(() => dashboard.close());
  const runtime = JSON.parse(
    await fs.readFile(path.join(f.project.directory, "runtime.json"), "utf8"),
  );
  const human = {
    "x-rdsh-browser-token": new URL(runtime.browser_url).hash.slice(5),
  };
  const agent = { authorization: `Bearer ${runtime.mcp_token}` };
  const admin = { authorization: `Bearer ${runtime.token}` };
  const post = (
    route,
    body,
    credential = human,
    origin = new URL(dashboard.localUrl).origin,
  ) =>
    fetch(dashboard.localUrl + "api/" + route, {
      method: "POST",
      headers: { ...credential, origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await post("update/question", ask(), agent)).status, 200);
  const old = structuredClone(
    dashboard.store.value.question_contracts.cards.Q1,
  );
  assert.equal((await post("update/answer", answer(old), agent)).status, 401);
  assert.equal((await post("update/answer", answer(old), admin)).status, 403);
  assert.equal(
    (
      await post(
        "update/question",
        ask(approval(10, "new-action", "v2"), {
          action: "revise",
          expected_revision: 1,
        }),
        agent,
      )
    ).status,
    200,
  );
  assert.equal((await post("update/answer", answer(old))).status, 409);
  const fresh = dashboard.store.value.question_contracts.cards.Q1;
  assert.equal(
    (await post("update/answer", answer(fresh), human, "https://evil.example"))
      .status,
    403,
  );
  const results = await Promise.all([
    post("update/answer", answer(fresh)),
    post("update/answer", answer(fresh)),
  ]);
  assert.deepEqual(
    results.map((response) => response.status).sort(),
    [200, 400],
  );
  assert.equal(dashboard.store.value.feedback.length, 1);
  const cancellation = {
    id: "Q1",
    expected_revision: 2,
    cancel_reason: "人間が取消しました",
  };
  assert.equal(
    (await post("decision/cancel", cancellation, agent)).status,
    401,
  );
  assert.equal(
    (await post("decision/cancel", cancellation, admin)).status,
    403,
  );
  assert.equal((await post("decision/cancel", cancellation)).status, 200);
  assert.equal(
    (
      await (
        await fetch(dashboard.localUrl + "api/state", { headers: human })
      ).json()
    ).feedback[0].contract_validity,
    "invalidated",
  );
});
