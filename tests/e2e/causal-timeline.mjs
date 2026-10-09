// Real HTTP/browser and local QA; native receipts are explicit stored fixtures.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identity, ProjectStore } from "../../dashboard/state.mjs";
import { startDashboard } from "../../dashboard/server.mjs";
import { RunHistory } from "../../dashboard/run-history.mjs";
import { AcceptanceStore } from "../../dashboard/acceptance.mjs";
import { queueRevision } from "../../dashboard/instruction-queue.mjs";
import { readCausalTimeline } from "../../dashboard/causal-timeline.mjs";

const { chromium } = await import(
  process.env.RDSH_PLAYWRIGHT_MODULE || "playwright"
);
const exec = promisify(execFile);
const output = path.resolve(
  process.env.RDSH_TIMELINE_E2E_OUTPUT || "target/e2e/causal-timeline",
);
await fs.mkdir(output, { recursive: true });
const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-timeline-browser-"));
const cwd = path.join(root, "project");
await fs.mkdir(cwd);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|LANG|LC_ALL)$/i.test(
      key,
    ),
  ),
);
Object.assign(env, {
  HOME: root,
  USERPROFILE: root,
  GIT_CEILING_DIRECTORIES: root,
});
let server, browser;
try {
  await fs.writeFile(
    path.join(cwd, "check.mjs"),
    "console.log('fixture-private-check-log');\n",
  );
  await exec("git", ["-C", cwd, "init", "-b", "timeline-browser"], { env });
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
  const project = await identity(cwd);
  project.directory = path.join(root, "dashboard");
  const initial = await ProjectStore.open(project);
  await initial.mutate("task", {
    id: "work",
    title: "Timeline fixture",
    status: "done",
  });
  const runId = "run_" + randomUUID(),
    sessionId = "native-timeline-fixture";
  const consumer = await initial.mutateReply("register", {
    run_id: runId,
    cli_session_id: sessionId,
    task_id: "work",
  });
  const inputId = "input_" + randomUUID();
  await initial.mutateReply(
    "instruction_submit",
    {
      command_id: inputId,
      consumer_id: consumer.consumer_id,
      run_id: runId,
      session_id: sessionId,
      text: "Instruction <script>globalThis.timelineInjected=true</script>",
      mode: "next_turn",
      expected_queue_revision: queueRevision(initial.value),
    },
    { actor: "human", available: false },
  );
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  server = await startDashboard({ project, port, tailscale: false });
  const runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RDSH_CHROME_PATH
      ? { executablePath: process.env.RDSH_CHROME_PATH }
      : {}),
  });
  const screenshots = [],
    errors = [],
    flows = [],
    projections = [],
    measurements = {};
  const observe = async (label) => {
    const report = await readCausalTimeline(project, server.store.value);
    const detail = await readCausalTimeline(project, server.store.value, {
      trace_id: report.traces[0].trace_id,
    });
    const trace = detail.traces[0];
    projections.push({
      label,
      state_revision: detail.state_revision,
      history_revision: detail.history_revision,
      trace_id: trace.trace_id,
      stages: trace.stages,
      nodes: trace.nodes.map(({ id, stage, source_id, status }) => ({
        id,
        stage,
        source_id,
        status,
      })),
      links: trace.links,
      issues: trace.issues,
      replayed_commands: trace.replayed_commands,
    });
  };
  const screenshot = async (page, name) => {
    await page.screenshot({ path: path.join(output, name) });
    screenshots.push(name);
  };
  if (
    process.env.RDSH_TIMELINE_BASELINE_HTML &&
    process.env.RDSH_TIMELINE_BASELINE_APP
  ) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.route(`http://127.0.0.1:${port}/`, (route) =>
      route.fulfill({
        contentType: "text/html",
        path: process.env.RDSH_TIMELINE_BASELINE_HTML,
      }),
    );
    await page.route(`http://127.0.0.1:${port}/app.mjs`, (route) =>
      route.fulfill({
        contentType: "text/javascript",
        path: process.env.RDSH_TIMELINE_BASELINE_APP,
      }),
    );
    await page.goto(runtime.browser_url);
    await page.locator("#project-overview").waitFor();
    await page.locator("#tasks-detail").evaluate((element) => {
      element.open = true;
    });
    await page.locator("#tasks-heading").scrollIntoViewIfNeeded();
    await screenshot(page, "before-main-task-table.png");
    await context.close();
  }
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  let detailRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("api/timeline?trace_id=")) detailRequests++;
  });
  await page.goto(runtime.browser_url);
  const panel = page.locator("#causal-timeline");
  await panel
    .getByRole("button", { name: "未確認区間と原記録を調べる" })
    .first()
    .waitFor();
  await panel.scrollIntoViewIfNeeded();
  assert.equal(detailRequests, 0);
  assert.equal(await panel.locator("pre").count(), 0);
  await screenshot(page, "after-summary.png");
  await observe("saved_instruction_without_receipt");
  const clicked = performance.now();
  await panel
    .getByRole("button", { name: "未確認区間と原記録を調べる" })
    .first()
    .click();
  await panel.getByText("指示", { exact: true }).waitFor();
  measurements.problem_detail_ms = performance.now() - clicked;
  await panel.getByText("原記録を開く", { exact: true }).first().click();
  assert.equal(
    await page.evaluate(() => globalThis.timelineInjected),
    undefined,
  );
  assert.ok((await panel.innerText()).includes("<script>"));
  await screenshot(page, "after-missing-receipt.png");
  flows.push(
    "summary requests no raw detail; problem entry opens stable source IDs and renders producer text without executing scripts",
  );
  const store = server.store,
    history = await RunHistory.open(project);
  await history.register(runId, sessionId);
  await history.scopeIntent(runId);
  await history.bindScope(runId, {
    owner_id: history.owner_id,
    kind: process.platform === "win32" ? "windows_job" : "linux_cgroup_v2",
    kernel_id: "timeline_fixture",
    root_identity: null,
    root_pid: process.pid,
  });
  const ackContext = { consumer, available: true, owner_id: history.owner_id };
  const begin = async (commandId) => {
    await store.mutateReply(
      "ack",
      { command_id: commandId, phase: "read" },
      ackContext,
    );
    const nativeId = "cmd_" + randomUUID();
    await store.mutateReply(
      "ack",
      {
        command_id: commandId,
        phase: "begin",
        attempt_id: "attempt_" + randomUUID(),
        native_command_id: nativeId,
      },
      ackContext,
    );
    return nativeId;
  };
  const finish = async (commandId, nativeId) => {
    const command =
      store.value.instructions.commands[commandId] ||
      store.value.answer_applications.commands[commandId];
    await history.recordCommand(runId, "send", nativeId, command.input_hash);
    await history.commandPhase(nativeId, "dispatched");
    await history.commandPhase(
      nativeId,
      "acknowledged",
      "prompt_result_received",
    );
    const summary = await readCausalTimeline(project, store.value);
    const trace = (
      await readCausalTimeline(project, store.value, {
        trace_id: summary.traces[0].trace_id,
      })
    ).traces[0];
    const proof = trace.nodes.find(
      (node) => node.kind === "native_input" && node.source_id === nativeId,
    ).raw.proof;
    await store.mutateReply(
      "ack",
      { command_id: commandId, phase: "reconcile" },
      { ...ackContext, proof },
    );
  };
  const nativeId = await begin(inputId);
  await panel
    .getByRole("button", { name: "未確認区間と原記録を調べる" })
    .first()
    .click();
  await panel
    .getByText("native commandのIDだけでは実行成功を確定できません。", {
      exact: true,
    })
    .waitFor();
  await screenshot(page, "after-intent.png");
  assert.ok(
    (await panel.locator("[data-timeline-counts]").innerText()).includes(
      "入力実行 1記録（1未確認）",
    ),
  );
  await observe("receipt_and_durable_intent_without_native_result");
  await finish(inputId, nativeId);
  await store.mutate("question", {
    id: "question-1",
    question: "Which test should change?",
    decision: {
      kind: "consultation",
      consumer_id: consumer.consumer_id,
      target: {
        task_id: "work",
        run_id: runId,
        session_id: sessionId,
        revision: "input-v1",
      },
    },
  });
  const card = store.value.question_contracts.cards["question-1"];
  await store.mutate("answer", {
    id: "question-1",
    answer: "the local check",
    expected_revision: card.revision,
    contract_fingerprint: card.fingerprint,
  });
  const replyId = store.value.feedback.at(-1).reply_command_id;
  await finish(replyId, await begin(replyId));
  const acceptance = await AcceptanceStore.open(project);
  await acceptance.define("work", [
    { id: "check", description: "local fixture", inputs: ["check.mjs"] },
  ]);
  const result = await acceptance.perform({
    task_id: "work",
    criterion_id: "check",
    argv: [process.execPath, "check.mjs"],
  });
  assert.equal(result.status, "pass");
  await panel
    .getByRole("button", { name: "未確認区間と原記録を調べる" })
    .first()
    .click();
  await panel.getByText("現行の全体試験成功", { exact: true }).waitFor();
  assert.equal(
    await panel.getByText("ACP入力結果あり", { exact: true }).count(),
    2,
  );
  assert.ok(!(await panel.innerText()).includes("fixture-private-check-log"));
  const counts = await panel.locator("[data-timeline-counts]").innerText();
  for (const label of [
    "指示",
    "受領",
    "入力実行",
    "試験",
    "質問",
    "回答",
    "回答適用",
  ])
    assert.ok(!counts.includes(label + " 未確認"), counts);
  await observe("exact_native_receipts_and_current_local_qa");
  await screenshot(page, "after-correlated-records.png");
  await panel
    .getByText("確認できたID相関", { exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot(page, "after-exact-links.png");
  flows.push(
    "begin cannot imply execution; exact synthetic journal receipts link instruction and answer processing; actual local full QA stays a separate task association",
  );
  const beforeReport = await readCausalTimeline(project, store.value);
  const stableIds = (
    await readCausalTimeline(project, store.value, {
      trace_id: beforeReport.traces[0].trace_id,
    })
  ).traces[0].nodes.map((node) => node.id);
  await page.reload();
  await panel
    .getByRole("button", { name: "未確認区間と原記録を調べる" })
    .first()
    .waitFor();
  const afterReport = await readCausalTimeline(project, store.value, {
    trace_id: beforeReport.traces[0].trace_id,
  });
  assert.deepEqual(
    afterReport.traces[0].nodes.map((node) => node.id),
    stableIds,
  );
  await fs.appendFile(path.join(cwd, "check.mjs"), "// source changed\n");
  await panel
    .getByRole("button", { name: "未確認区間と原記録を調べる" })
    .first()
    .click();
  await panel
    .getByText("現在のコードに対する全体試験の成功は未確認です。", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await panel.getByText("現行の全体試験成功", { exact: true }).count(),
    0,
  );
  await screenshot(page, "after-stale-check.png");
  await observe("source_change_stales_local_qa");
  await panel.getByText("原記録を開く", { exact: true }).first().click();
  const openedId = await panel
    .locator("details[open]")
    .first()
    .getAttribute("data-timeline-raw");
  await store.mutate("task", {
    id: "work",
    title: "Updated fixture task",
    status: "done",
  });
  await page.waitForFunction(
    (revision) =>
      document.querySelector("#causal-timeline [data-timeline-revision]")
        ?.dataset.timelineRevision === String(revision),
    store.value.revision,
  );
  await panel.getByText("ACP入力結果あり", { exact: true }).first().waitFor();
  assert.equal(
    await panel
      .locator(`details[data-timeline-raw="${openedId}"]`)
      .evaluate((element) => element.open),
    true,
  );
  flows.push(
    "IDs survive reload; actual QA input changes stale the earlier pass without replay; opened source record survives refresh",
  );
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(runtime.browser_url);
  await mobilePage
    .locator("#causal-timeline")
    .getByRole("button", { name: "未確認区間と原記録を調べる" })
    .first()
    .waitFor();
  await mobilePage.locator("#causal-timeline").scrollIntoViewIfNeeded();
  assert.ok(
    await mobilePage.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await screenshot(mobilePage, "after-mobile.png");
  await mobile.close();
  assert.deepEqual(errors, []);
  const report = {
    result: "PASS",
    scope:
      "actual isolated project HTTP/browser/domain writes and local acceptance; native input receipts are explicit stored fixtures, no actual provider/model/profile/credentials",
    source_head: process.env.RDSH_QA_SOURCE_HEAD || null,
    screenshots,
    flows,
    projections,
    page_errors: errors,
    measurements,
    baseline: screenshots.includes("before-main-task-table.png")
      ? "previous main frontend bytes over same current isolated backend; frontend comparison only"
      : null,
  };
  await fs.writeFile(
    path.join(output, "runtime-observations.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify({ result: "PASS", output, flows }));
  await context.close();
} finally {
  await browser?.close();
  await server?.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("rdsh-timeline-browser-"));
  await fs.rm(root, { recursive: true });
}
