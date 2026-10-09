// Real HTTP/browser and published native LLM; only provider I/O is synthetic.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { identity, ProjectStore } from "../../dashboard/state.mjs";
import { SessionLedger } from "../../dashboard/session-ledger.mjs";
import { ModelRouting } from "../../dashboard/model-routing.mjs";
import {
  requestedSelection,
  nativeSelection,
} from "../../dashboard/model-selection.mjs";
import { prepareModelAttachment } from "../../dashboard/model-runtime.mjs";
import { modelRuntimeHash } from "../../dashboard/model-runtime-source.mjs";
import { startDashboard } from "../../dashboard/server.mjs";
const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../..", import.meta.url));
const base = process.env.RDSH_MODEL_BASE;
assert.match(base || "", /^[0-9a-f]{40}$/);
const output = path.resolve(
  process.env.RDSH_MODEL_OUTPUT ||
    path.join(repo, "docs/evidence/model-dispatch"),
);
await fs.mkdir(output, { recursive: true });
const baselineHtml = (
  await exec("git", ["show", `${base}:dashboard/ui.html`], { cwd: repo })
).stdout;
const baselineApp = (
  await exec("git", ["show", `${base}:dashboard/app.mjs`], { cwd: repo })
).stdout;
const fixture = fileURLToPath(
  new URL("../fixtures/model-dispatch.mjs", import.meta.url),
);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-model-browser-"));
const cwd = path.join(root, "project");
await fs.mkdir(cwd);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|RDSH_TEST_LLM_PACKAGE)$/i.test(
      key,
    ),
  ),
);
Object.assign(env, {
  HOME: root,
  USERPROFILE: root,
  DSH_HOME: path.join(root, "dsh"),
});
await exec("git", ["-C", cwd, "init", "-b", "model-browser-qa"], { env });
await exec(
  "git",
  [
    "-C",
    cwd,
    "-c",
    "user.name=Model Browser QA",
    "-c",
    "user.email=model@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "Fixture",
  ],
  { env },
);
const project = await identity(cwd);
project.directory = path.join(root, "state", project.id);
const ledger = await SessionLedger.open(project);
await ProjectStore.open(ledger.project);
const routing = ModelRouting.open(ledger.project);
const first = {
  provider: "fixture-provider",
  model: "model-A",
  effort: "high",
};
const attachments = [];
const recordRun = async (request, task_id) => {
  const pending = await ledger.record({
    cwd,
    command: [process.execPath, fixture],
    env,
    task_id,
  });
  const record = await ledger.confirm(
    pending.run_id,
    "fixture-native-session",
    "0.2.0-rc.2",
  );
  await routing.bind(record, requestedSelection(request));
  await routing.enforceNative(record);
  const attachment = await prepareModelAttachment(ledger.project, record, env);
  attachments.push(attachment);
  return { record, attachment };
};
const invoke = async (run, scenario, guarded = true, count = 1) => {
  const task = exec(process.execPath, [fixture], {
    cwd,
    env: {
      ...(guarded ? run.attachment.env : env),
      RDSH_TEST_MODEL_SCENARIO: scenario,
      RDSH_TEST_MODEL_ITERATIONS: String(count),
    },
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
  const pid = task.child.pid;
  const { stdout } = await task;
  if (guarded) await run.attachment.ready({ child: { pid }, stopped: false });
  return JSON.parse(stdout);
};
const observe = async (run, value) =>
  routing.observe(run.record, {
    routing: () =>
      nativeSelection(
        [
          {
            id: "model",
            type: "select",
            currentValue: JSON.stringify([value.provider, value.model]),
            options: [{ value: JSON.stringify([value.provider, value.model]) }],
          },
          {
            id: "reasoning_effort",
            type: "select",
            currentValue: value.effort || "",
            options: [{ value: value.effort || "" }],
          },
        ],
        "acp_session_resume",
        "0.2.0-rc.2",
      ),
  });
const socket = net.createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const server = await startDashboard({
  project: ledger.project,
  port,
  tailscale: false,
});
const { chromium } = await import(
  process.env.RDSH_PLAYWRIGHT_MODULE || "playwright"
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.RDSH_CHROME_PATH
    ? { executablePath: process.env.RDSH_CHROME_PATH }
    : {}),
});
const contexts = [];
const report = {
  baseline_frontend_commit: base,
  native_source_sha256: modelRuntimeHash,
  node: process.version,
  platform: process.platform,
  provider: "synthetic only",
  actual_model_execution_verified: false,
  observations: [],
  page_errors: [],
};
let videoPath;
try {
  const run = await recordRun(first, "モデル契約の照合 QA");
  await observe(run, first);
  const before = await invoke(run, "mismatch", false);
  const matched = await invoke(run, "default-effort");
  assert.deepEqual(before.dispatches, [{ ...first, model: "model-B" }]);
  assert.deepEqual(matched.dispatches, [first]);
  report.observations.push(
    { case: "baseline", result: before },
    { case: "matched", result: matched },
  );
  const baseline = await browser.newContext({
    viewport: { width: 1100, height: 850 },
  });
  contexts.push(baseline);
  await baseline.route("**/app.mjs", (route) =>
    route.fulfill({ contentType: "text/javascript", body: baselineApp }),
  );
  await baseline.route(server.localUrl, (route) =>
    route.fulfill({ contentType: "text/html", body: baselineHtml }),
  );
  const oldPage = await baseline.newPage();
  await oldPage.goto(server.browserUrl);
  await oldPage
    .locator("#connection")
    .filter({ hasText: "接続済み" })
    .waitFor();
  assert.equal(await oldPage.locator("#model-routing").count(), 0);
  await oldPage.screenshot({ path: path.join(output, "before-desktop.png") });
  const context = await browser.newContext({
    viewport: { width: 1100, height: 850 },
    locale: "ja-JP",
    recordVideo: {
      dir: path.join(root, "video"),
      size: { width: 1100, height: 850 },
    },
  });
  contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.page_errors.push(error.message));
  await page.goto(server.browserUrl);
  const panel = page.locator("#model-routing");
  await panel
    .getByText("呼出し要求を照合 · adapterの完了を観測", { exact: true })
    .waitFor();
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: path.join(output, "matched-desktop.png") });
  const stopped = await invoke(run, "mismatch");
  assert.deepEqual(stopped.dispatches, []);
  assert.equal(stopped.error.code, "RDSH_MODEL_GUARD_DENIED");
  await panel.getByText("ガードが送信を停止", { exact: true }).waitFor();
  await panel.screenshot({ path: path.join(output, "stopped-desktop.png") });
  const view = await routing.inspect(run.record);
  const target = { ...first, model: "model-B" };
  await routing.allowChange(run.record, target, {
    authorization_id: "human-model-change-qa",
    source: "explicit_operator_cli",
    run_id: run.record.run_id,
    session_id: run.record.cli_session_id,
    context_hash: view.context_hash,
    request_revision: view.revision,
    from: first,
    to: target,
    issued_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
  await observe(run, target);
  const permitted = await invoke(run, "mismatch");
  assert.deepEqual(permitted.dispatches, [target]);
  await panel
    .getByText("呼出し要求を照合 · adapterの完了を観測", { exact: true })
    .waitFor();
  await panel.getByText(/変更許可 human-model-change-qa/).waitFor();
  const history = panel.locator("details");
  await history.locator("summary").click();
  await history.getByText(/model-A.*model-B/).waitFor();
  await page.setViewportSize({ width: 1100, height: 1050 });
  await panel.screenshot({ path: path.join(output, "permitted-desktop.png") });
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "ja-JP",
  });
  contexts.push(mobile);
  const phone = await mobile.newPage();
  await phone.goto(server.browserUrl);
  await phone
    .locator("#model-routing")
    .getByText(/変更許可 human-model-change-qa/)
    .waitFor();
  assert.ok(
    await phone.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await phone.setViewportSize({ width: 390, height: 1150 });
  await phone.locator("#model-routing details summary").click();
  await phone
    .locator("#model-routing")
    .screenshot({ path: path.join(output, "permitted-mobile.png") });
  report.observations.push(
    { case: "stopped", result: stopped },
    { case: "permitted", result: permitted },
  );
  await context.close();
  videoPath = await page.video().path();
  const benchmarkRun = await recordRun(first, "ベンチマーク QA");
  const plain = await invoke(benchmarkRun, "match", false, 100);
  const guarded = await invoke(benchmarkRun, "match", true, 100);
  assert.equal(plain.dispatches.length, 100);
  assert.equal(guarded.dispatches.length, 100);
  report.benchmark = {
    calls_each: 100,
    baseline_ms: plain.timings_ms,
    guarded_ms: guarded.timings_ms,
    scope:
      "sequential local native adapter calls; excludes Node boot; synthetic provider, zero network",
  };
  assert.deepEqual(report.page_errors, []);
  report.result = "PASS";
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  await server.close();
  for (const attachment of attachments) await attachment.close();
  if (videoPath)
    await exec(
      process.env.RDSH_FFMPEG || "ffmpeg",
      [
        "-y",
        "-i",
        videoPath,
        "-vf",
        "fps=3,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
        "-loop",
        "0",
        path.join(output, "guard-flow.gif"),
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("rdsh-model-browser-"));
  await fs.rm(root, { recursive: true });
  await fs.writeFile(
    path.join(output, "observations.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(
  JSON.stringify({
    result: report.result,
    cases: report.observations.map((o) => o.case),
    benchmark: report.benchmark,
    output,
  }),
);
