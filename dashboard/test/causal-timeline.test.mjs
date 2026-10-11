import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identity, ProjectStore } from "../state.mjs";
import { RunHistory } from "../run-history.mjs";
import { queueRevision } from "../instruction-queue.mjs";
import { readCausalTimeline, timelineProjection } from "../causal-timeline.mjs";
import { startDashboard } from "../server.mjs";
import { AcceptanceStore } from "../acceptance.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-timeline-"));
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const project = await identity(cwd);
  project.directory = path.join(root, "state");
  const store = await ProjectStore.open(project);
  await store.mutate("task", {
    id: "work",
    title: "Fixture task",
    status: "done",
  });
  const run = "run_" + randomUUID(),
    session = "native-fixture";
  const consumer = await store.mutateReply("register", {
    run_id: run,
    cli_session_id: session,
    task_id: "work",
  });
  const id = "input_" + randomUUID();
  await store.mutateReply(
    "instruction_submit",
    {
      command_id: id,
      consumer_id: consumer.consumer_id,
      run_id: run,
      session_id: session,
      text: "private instruction <script>fixture</script>",
      mode: "next_turn",
      expected_queue_revision: queueRevision(store.value),
    },
    { actor: "human", available: false },
  );
  const history = await RunHistory.open(project);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-timeline-"));
    await fs.rm(root, { recursive: true });
  });
  async function intent() {
    const context = { consumer, available: true, owner_id: history.owner_id };
    await store.mutateReply("ack", { command_id: id, phase: "read" }, context);
    const nativeId = "cmd_" + randomUUID();
    await store.mutateReply(
      "ack",
      {
        command_id: id,
        phase: "begin",
        attempt_id: "attempt_" + randomUUID(),
        native_command_id: nativeId,
      },
      context,
    );
    return nativeId;
  }
  async function receipt(nativeId, commandId = id) {
    // Synthetic private ledger fixture; tests do not claim an actual provider.
    if (!(await history.read()).runs.has(run)) {
      await history.register(run, session);
      await history.scopeIntent(run);
      await history.bindScope(run, {
        owner_id: history.owner_id,
        kind: process.platform === "win32" ? "windows_job" : "linux_cgroup_v2",
        kernel_id: "timeline_fixture",
        root_identity: null,
        root_pid: process.pid,
      });
    }
    await history.recordCommand(
      run,
      "send",
      nativeId,
      (
        store.value.instructions.commands[commandId] ||
        store.value.answer_applications.commands[commandId]
      ).input_hash,
    );
    await history.commandPhase(nativeId, "dispatched");
    await history.commandPhase(
      nativeId,
      "acknowledged",
      "prompt_result_received",
    );
  }
  const detail = async () => {
    const report = await readCausalTimeline(project, store.value);
    return (
      await readCausalTimeline(project, store.value, {
        trace_id: report.traces[0].trace_id,
      })
    ).traces[0];
  };
  return {
    root,
    project,
    store,
    consumer,
    history,
    id,
    intent,
    receipt,
    detail,
  };
}

test("saved/read/begin remain separate and cannot manufacture native execution success", async (t) => {
  const f = await fixture(t);
  const saved = await f.detail();
  assert.equal(
    saved.nodes.filter((node) => node.stage === "instruction").length,
    1,
  );
  assert.ok(saved.issues.some((issue) => issue.code === "receipt_unknown"));
  await f.intent();
  const started = await f.detail();
  assert.equal(
    started.nodes.find((node) => node.stage === "execution").status,
    "unknown",
  );
  assert.ok(
    started.issues.some((issue) => issue.code === "native_result_unconfirmed"),
  );
  assert.ok(
    !started.links.some(
      (link) => link.basis === "verified_native_owner_session_input_hash",
    ),
  );
});

test("stable IDs survive reload and only exact native owner/session/input receipts open the link", async (t) => {
  const f = await fixture(t),
    nativeId = await f.intent();
  await f.receipt(nativeId);
  const before = await f.detail();
  assert.equal(
    before.nodes.find((node) => node.stage === "execution").status,
    "succeeded",
  );
  assert.equal(
    before.links.filter(
      (link) => link.basis === "verified_native_owner_session_input_hash",
    ).length,
    1,
  );
  const reopened = await ProjectStore.open(f.project);
  const after = await readCausalTimeline(f.project, reopened.value, {
    trace_id: before.trace_id,
  });
  assert.deepEqual(
    after.traces[0].nodes.map((node) => node.id),
    before.nodes.map((node) => node.id),
  );
  const changed = structuredClone(reopened.value);
  changed.instructions.commands[f.id].input_hash = "f".repeat(64);
  const wrong = (
    await readCausalTimeline(f.project, changed, { trace_id: before.trace_id })
  ).traces[0];
  assert.equal(
    wrong.nodes.find((node) => node.stage === "execution").status,
    "unknown",
  );
  assert.ok(
    !wrong.links.some(
      (link) => link.basis === "verified_native_owner_session_input_hash",
    ),
  );
  assert.ok(
    before.issues.some(
      (issue) => issue.code === "cross_stage_causality_unknown",
    ),
  );
});

test("truncated or corrupt native journal preserves unknown intervals and never replays", async (t) => {
  const f = await fixture(t),
    nativeId = await f.intent();
  await f.receipt(nativeId);
  const original = await fs.readFile(f.history.file);
  await fs.appendFile(f.history.file, '{"partial":');
  const partial = await f.detail();
  assert.ok(
    partial.issues.some((issue) => issue.code === "native_history_unavailable"),
  );
  assert.ok(
    !partial.links.some(
      (link) => link.basis === "verified_native_owner_session_input_hash",
    ),
  );
  await fs.writeFile(
    f.history.file,
    Buffer.concat([original, Buffer.from('{"invalid":true}\n')]),
  );
  const broken = await f.detail();
  assert.equal(broken.replayed_commands, 0);
  assert.equal(
    broken.nodes.find((node) => node.stage === "execution").status,
    "unknown",
  );
  assert.equal(
    await fs.readFile(f.history.file, "utf8"),
    Buffer.concat([original, Buffer.from('{"invalid":true}\n')]).toString(),
  );
});

test("partial passes and same-task tests cannot create an instruction/test/question causal edge", async (t) => {
  const f = await fixture(t),
    source = {
      conditions: [
        {
          verified_full_check: false,
          evidence: [
            {
              evidence_id: "evi_" + randomUUID(),
              task_id: "work",
              criterion_id: "check",
              scope: "partial",
              source: "local_runner",
              status: "pass",
              phase: "finished",
              eligible_pass: true,
              started_at: new Date().toISOString(),
              finished_at: new Date().toISOString(),
            },
          ],
        },
      ],
      verification: { all_declared_full_checks_pass: false },
    };
  const trace = timelineProjection(f.store.value, f.consumer, {
    acceptance: source,
  });
  assert.equal(
    trace.nodes.find((node) => node.stage === "test").status,
    "unverified",
  );
  assert.ok(
    trace.issues.some((issue) => issue.code === "current_full_test_unknown"),
  );
  assert.ok(
    !trace.links.some(
      (link) =>
        trace.nodes.find((node) => node.id === link.to)?.stage === "test",
    ),
  );
});

test("explicit command and evidence IDs link execution, acceptance and question while preserving unknown results", async (t) => {
  const f = await fixture(t),
    acceptance = await AcceptanceStore.open(f.project);
  await f.intent();
  await acceptance.define("work", [
    { id: "check", description: "local fixture", inputs: ["check.mjs"] },
  ]);
  await assert.rejects(
    acceptance.perform({
      task_id: "work",
      criterion_id: "check",
      reported: { status: "pass", reason: "fixture report" },
      causal_source_command_ids: ["input_missing"],
    }),
    (error) =>
      error.code === "causal_source_command_unavailable_or_task_mismatch",
  );
  assert.equal(
    (await acceptance.inspect("work")).conditions[0].evidence.length,
    0,
  );
  const result = await acceptance.perform({
    task_id: "work",
    criterion_id: "check",
    reported: { status: "pass", reason: "fixture report" },
    causal_source_command_ids: [f.id],
  });
  await f.store.mutate("question", {
    id: "question-with-evidence",
    question: "Which result should be reviewed?",
    decision: {
      kind: "consultation",
      consumer_id: f.consumer.consumer_id,
      target: {
        task_id: "work",
        run_id: f.consumer.run_id,
        session_id: f.consumer.session_id,
        revision: "review-v1",
      },
      causal_source_evidence_ids: [result.evidence_id],
    },
  });
  const trace = await f.detail(),
    execution = trace.nodes.find((node) => node.stage === "execution"),
    check = trace.nodes.find((node) => node.stage === "test"),
    question = trace.nodes.find(
      (node) => node.kind === "current_question",
    ),
    executionCheck = trace.links.find(
      (link) =>
        link.basis === "declared_acceptance_source_command_id" &&
        link.to === check.id,
    ),
    checkQuestion = trace.links.find(
      (link) =>
        link.basis === "declared_question_source_evidence_id" &&
        link.to === question.id,
    );
  assert.equal(execution.status, "unknown");
  assert.equal(check.status, "unverified");
  assert.equal(executionCheck.from, execution.id);
  assert.equal(executionCheck.reference_id, f.id);
  assert.equal(checkQuestion.from, check.id);
  assert.equal(checkQuestion.reference_id, result.evidence_id);
  assert.ok(
    trace.issues.some((issue) => issue.code === "native_result_unconfirmed"),
  );
  assert.ok(
    !trace.issues.some(
      (issue) => issue.code === "cross_stage_causality_unknown",
    ),
  );
});

test("missing instruction and out-of-order read evidence stay unknown rather than becoming inferred edges", async (t) => {
  const f = await fixture(t);
  await f.intent();
  const changed = structuredClone(f.store.value);
  changed.instructions.commands[f.id].read_at = "2000-01-01T00:00:00.000Z";
  let trace = timelineProjection(changed, f.consumer);
  assert.ok(trace.issues.some((issue) => issue.code === "out_of_order"));
  delete changed.instructions.requests[f.id];
  trace = timelineProjection(changed, f.consumer);
  assert.ok(
    trace.issues.some((issue) => issue.code === "input_binding_unconfirmed"),
  );
  assert.equal(trace.links.length, 0);
});

test("legacy progress reports have stable own IDs and remain outside native causal chains", async (t) => {
  const f = await fixture(t);
  await f.store.mutate("event", {
    title: "reported complete",
    detail: "same words as instruction",
  });
  const trace = timelineProjection(f.store.value, null);
  assert.equal(trace.nodes[0].status, "reported");
  assert.equal(trace.links.length, 0);
  assert.ok(trace.issues.some((issue) => issue.code === "unlinked_sources"));
  assert.deepEqual(
    trace.nodes.map((node) => node.id),
    timelineProjection(f.store.value, null).nodes.map((node) => node.id),
  );
});

test("question revision, answer event and native application keep their exact IDs after revision", async (t) => {
  const f = await fixture(t);
  const firstNative = await f.intent();
  await f.receipt(firstNative);
  const proof = (await f.detail()).nodes.find(
    (node) => node.stage === "execution",
  ).raw.proof;
  const context = {
    consumer: f.consumer,
    available: true,
    owner_id: f.history.owner_id,
    proof,
  };
  await f.store.mutateReply(
    "ack",
    { command_id: f.id, phase: "reconcile" },
    context,
  );
  await f.store.mutate("question", {
    id: "question-1",
    question: "Choose the next edit",
    decision: {
      kind: "consultation",
      consumer_id: f.consumer.consumer_id,
      target: {
        task_id: "work",
        run_id: f.consumer.run_id,
        session_id: f.consumer.session_id,
        revision: "input-v1",
      },
    },
  });
  const card = f.store.value.question_contracts.cards["question-1"];
  await f.store.mutate("answer", {
    id: "question-1",
    answer: "edit the tests",
    expected_revision: card.revision,
    contract_fingerprint: card.fingerprint,
  });
  const replyId = f.store.value.feedback.at(-1).reply_command_id;
  await f.store.mutateReply(
    "ack",
    { command_id: replyId, phase: "read" },
    context,
  );
  const replyNative = "cmd_" + randomUUID();
  await f.store.mutateReply(
    "ack",
    {
      command_id: replyId,
      phase: "begin",
      attempt_id: "attempt_" + randomUUID(),
      native_command_id: replyNative,
    },
    context,
  );
  await f.receipt(replyNative, replyId);
  const trace = await f.detail();
  assert.equal(
    trace.nodes.find((node) => node.stage === "application").status,
    "succeeded",
  );
  assert.equal(
    trace.links.filter(
      (link) => link.basis === "exact_question_revision_and_feedback",
    ).length,
    1,
  );
  assert.equal(
    trace.links.filter((link) => link.basis === "exact_answer_event_id").length,
    1,
  );
  const answerId = trace.nodes.find((node) => node.kind === "answer").id;
  await f.store.mutate("question", {
    id: "question-1",
    action: "revise",
    expected_revision: 1,
    question: "Choose again",
    decision: {
      ...card.snapshot.decision,
      target: { ...card.snapshot.decision.target, revision: "input-v2" },
    },
  });
  const revised = await f.detail();
  assert.equal(
    revised.nodes.find((node) => node.kind === "answer").id,
    answerId,
  );
  assert.equal(
    revised.nodes.find((node) => node.kind === "answer").status,
    "invalidated",
  );
  assert.ok(
    revised.issues.some((issue) => issue.code === "invalidated_answer"),
  );
});

test("real local acceptance is current evidence, then stale, without leaking private command or log", async (t) => {
  const f = await fixture(t),
    exec = promisify(execFile),
    cwd = f.project.root;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|LANG|LC_ALL)$/i.test(
        key,
      ),
    ),
  );
  Object.assign(env, {
    HOME: f.root,
    USERPROFILE: f.root,
    GIT_CEILING_DIRECTORIES: f.root,
  });
  await fs.writeFile(
    path.join(cwd, "check.mjs"),
    "console.log('private-log-token-fixture');\n",
  );
  await exec("git", ["-C", cwd, "init", "-b", "timeline-qa"], { env });
  await exec("git", ["-C", cwd, "add", "--", "check.mjs"], { env });
  await exec(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Timeline Fixture",
      "-c",
      "user.email=timeline@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Fixture input",
    ],
    { env },
  );
  const acceptance = await AcceptanceStore.open(f.project);
  await acceptance.define("work", [
    { id: "check", description: "local fixture check", inputs: ["check.mjs"] },
  ]);
  const result = await acceptance.perform({
    task_id: "work",
    criterion_id: "check",
    argv: [process.execPath, "check.mjs"],
  });
  assert.equal(result.status, "pass");
  const first = await f.detail();
  assert.equal(
    first.nodes.find((node) => node.stage === "test").status,
    "current_full_pass",
  );
  assert.ok(!JSON.stringify(first).includes("private-log-token-fixture"));
  assert.ok(!JSON.stringify(first).includes("private_argv_file"));
  assert.ok(
    !first.links.some(
      (link) =>
        first.nodes.find((node) => node.id === link.to)?.stage === "test",
    ),
  );
  await fs.appendFile(
    path.join(cwd, "check.mjs"),
    "// related source changed\n",
  );
  const stale = await f.detail();
  assert.equal(
    stale.nodes.find((node) => node.stage === "test").status,
    "unverified",
  );
  assert.ok(
    stale.issues.some((issue) => issue.code === "current_full_test_unknown"),
  );
});

test("a mismatched question recipient stays visible as unlinked rather than joining another session", async (t) => {
  const f = await fixture(t);
  await f.store.mutate("question", {
    id: "mismatched",
    question: "An observed question",
    decision: {
      kind: "consultation",
      consumer_id: f.consumer.consumer_id,
      target: {
        task_id: "work",
        run_id: f.consumer.run_id,
        session_id: f.consumer.session_id,
        revision: "input-v1",
      },
    },
  });
  const state = structuredClone(f.store.value);
  state.question_contracts.cards.mismatched.snapshot.decision.target.session_id =
    "other-session";
  const report = await readCausalTimeline(f.project, state);
  assert.equal(report.total, 2);
  const linked = await readCausalTimeline(f.project, state, {
    trace_id: report.traces.find((trace) => trace.context).trace_id,
  });
  assert.ok(!linked.traces[0].nodes.some((node) => node.stage === "question"));
  const unlinked = await readCausalTimeline(f.project, state, {
    trace_id: report.traces.find((trace) => !trace.context).trace_id,
  });
  assert.ok(
    unlinked.traces[0].nodes.some((node) => node.source_id === "mismatched"),
  );
  assert.equal(unlinked.traces[0].links.length, 0);
});

test("summary pages are bounded and stable without duplicating consumers or leaking raw records", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 21; index++)
    await f.store.mutateReply("register", {
      run_id: "run_" + randomUUID(),
      cli_session_id: "page-" + index,
      task_id: "work",
    });
  const ids = [];
  let after = 0;
  do {
    const report = await readCausalTimeline(f.project, f.store.value, {
      after,
      limit: 10,
    });
    assert.ok(report.traces.length <= 10);
    assert.equal(report.total, 22);
    for (const trace of report.traces) {
      ids.push(trace.trace_id);
      assert.equal(trace.nodes, undefined);
      assert.equal(trace.links, undefined);
    }
    after = report.next;
  } while (after !== null);
  assert.equal(ids.length, 22);
  assert.equal(new Set(ids).size, 22);
  const again = await readCausalTimeline(f.project, f.store.value, {
    after: 10,
  });
  assert.deepEqual(
    again.traces.map((trace) => trace.trace_id),
    ids.slice(10, 20),
  );
});

test("HTTP summary hides raw records, human detail is scoped, and MCP cannot read this route", async (t) => {
  const f = await fixture(t);
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const server = await startDashboard({
    project: f.project,
    port,
    tailscale: false,
  });
  try {
    const runtime = JSON.parse(
      await fs.readFile(path.join(f.project.directory, "runtime.json"), "utf8"),
    );
    const headers = {
      "x-rdsh-browser-token": new URL(runtime.browser_url).hash.slice(5),
    };
    const request = async (query = "", extra = headers) =>
      fetch(`http://127.0.0.1:${port}/api/timeline` + query, {
        headers: extra,
      });
    assert.equal((await request("", {})).status, 401);
    assert.equal(
      (await request("", { authorization: "Bearer " + runtime.mcp_token }))
        .status,
      401,
    );
    const result = await request();
    assert.equal(result.status, 200);
    const report = await result.json();
    assert.ok(!JSON.stringify(report).includes("private instruction"));
    assert.equal(report.traces[0].nodes, undefined);
    const detail = await request("?trace_id=" + report.traces[0].trace_id);
    assert.ok(
      JSON.stringify(await detail.json()).includes("private instruction"),
    );
    assert.equal((await request("?after=-1")).status, 400);
    assert.equal((await request("?limit=21")).status, 400);
    assert.equal((await request("?trace_id=../state.json")).status, 400);
    assert.equal((await request("?trace_id=tl_" + "f".repeat(32))).status, 404);
    assert.equal((await request("?unexpected=1")).status, 400);
    const saved = await ProjectStore.open(f.project);
    assert.deepEqual(saved.value, f.store.value);
  } finally {
    await server.close();
  }
});
