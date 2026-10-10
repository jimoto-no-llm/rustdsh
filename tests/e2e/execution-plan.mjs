// Real project HTTP server and browser; isolated tasks and local check commands.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identity, ProjectStore } from "../../dashboard/state.mjs";
import { ExecutionPlans } from "../../dashboard/execution-plan.mjs";
import { AcceptanceStore } from "../../dashboard/acceptance.mjs";
import { startDashboard } from "../../dashboard/server.mjs";
const { chromium } = await import(
  process.env.RDSH_PLAYWRIGHT_MODULE || "playwright"
);
const repo = path.resolve(import.meta.dirname, "../.."),
  exec = promisify(execFile),
  output = path.resolve(
    process.env.RDSH_PLAN_E2E_OUTPUT ||
      path.join(repo, "target/e2e/execution-plan"),
  );
const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-plan-browser-")),
  cwd = path.join(root, "project");
await fs.mkdir(cwd);
await fs.mkdir(output, { recursive: true });
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|LANG|LC_ALL)$/i.test(k),
  ),
);
Object.assign(env, {
  HOME: root,
  USERPROFILE: root,
  DSH_HOME: path.join(root, "dsh"),
  RDSH_DASHBOARD_HOME: path.join(root, "dashboard"),
  GIT_CEILING_DIRECTORIES: root,
});
const report = {
  result: "FAIL",
  scope:
    "actual project HTTP+browser+current-source acceptance checks; native engine/provider admission is tested separately; no model/profile/credentials/Tailscale",
  page_errors: [],
  flows: [],
  measurements: {},
  screenshots: [],
};
let browser, server;
const contexts = [];
try {
  await fs.writeFile(
    path.join(cwd, "check.mjs"),
    "console.log('isolated full check');\n",
  );
  await exec("git", ["-C", cwd, "init", "-b", "browser-plan-qa"], { env });
  await exec("git", ["-C", cwd, "add", "--", "check.mjs"], { env });
  await exec(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Browser Plan",
      "-c",
      "user.email=plan@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Fixture",
    ],
    { env },
  );
  const project = await identity(cwd);
  project.directory = path.join(root, "dashboard", "projects", project.id);
  const store = await ProjectStore.open(project),
    plans = ExecutionPlans.open(project),
    acceptance = await AcceptanceStore.open(project);
  const ids = [
    "prepare",
    "implement",
    ...Array.from(
      { length: 118 },
      (_, i) => "task-" + String(i + 1).padStart(3, "0"),
    ),
  ];
  for (const id of ids)
    await store.mutate("task", {
      id,
      title: "検証用タスク " + id,
      status: "todo",
    });
  const definition = {
    plan_id: "release-plan",
    run_id: "browser-run",
    nodes: ids.map((id) => ({
      task_id: id,
      parent_task_id: null,
      depends_on: id === "implement" ? ["prepare"] : [],
    })),
    limits: {
      max_concurrent: 2,
      max_depth: 2,
      max_starts: 120,
      stop_at: new Date(Date.now() + 3600000).toISOString(),
      stop_on_failure: true,
    },
  };
  await plans.define(definition);
  await plans.enforce("release-plan", {
    binding: "confirmed",
    run_id: "browser-run",
    cli: "dsh",
    cli_version: "0.2.0-rc.2",
    cli_session_id: "browser-native-fixture",
    cwd,
  });
  await plans.define({
    ...definition,
    plan_id: "invalid-draft",
    nodes: [
      {
        task_id: "prepare",
        depends_on: ["implement", "missing-node"],
        parent_task_id: null,
      },
      { task_id: "implement", depends_on: ["prepare"], parent_task_id: null },
    ],
  });
  const portProbe = net.createServer();
  await new Promise((r) => portProbe.listen(0, "127.0.0.1", r));
  const port = portProbe.address().port;
  await new Promise((r) => portProbe.close(r));
  server = await startDashboard({ project, tailscale: false, port });
  const info = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RDSH_CHROME_PATH
      ? { executablePath: process.env.RDSH_CHROME_PATH }
      : {}),
  });
  const makePage = async (viewport) => {
    const ctx = await browser.newContext({ viewport, locale: "ja-JP" });
    contexts.push(ctx);
    const page = await ctx.newPage();
    page.on("pageerror", (error) => report.page_errors.push(error.message));
    return page;
  };
  const capture = async (page, name, locator = null) => {
    const file = path.join(output, name + ".png");
    if (locator) await locator.screenshot({ path: file });
    else await page.screenshot({ path: file });
    report.screenshots.push(name + ".png");
  };
  if (
    process.env.RDSH_PLAN_BASELINE_INDEX &&
    process.env.RDSH_PLAN_BASELINE_APP
  ) {
    const before = await makePage({ width: 1280, height: 900 });
    await before.route("**/*", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: await fs.readFile(process.env.RDSH_PLAN_BASELINE_INDEX),
        });
      if (pathname === "/app.mjs")
        return route.fulfill({
          contentType: "text/javascript",
          body: await fs.readFile(process.env.RDSH_PLAN_BASELINE_APP),
        });
      await route.continue();
    });
    await before.goto(info.browser_url);
    await before.locator("#tasks-detail").evaluate((el) => {
      el.open = true;
    });
    await before.locator("#tasks-heading").scrollIntoViewIfNeeded();
    await before.waitForFunction(
      () => document.querySelectorAll("#tasks tr").length === 120,
    );
    await capture(before, "before-main-task-table");
    report.baseline =
      "actual previous main HTML/app modules over the same isolated current backend; frontend comparison only";
  }
  const page = await makePage({ width: 1280, height: 900 });
  await page.goto(info.browser_url);
  const panel = page.locator("#execution-plans");
  await page.waitForFunction(
    () => document.querySelectorAll("#execution-plans details").length === 2,
  );
  assert.equal(
    await panel.locator("details article").count(),
    0,
    "graph is not rendered before expansion",
  );
  await panel.scrollIntoViewIfNeeded();
  await capture(page, "after-collapsed");
  const active = panel
      .locator("article.card")
      .filter({ has: page.locator("h3", { hasText: /^release-plan$/ }) }),
    graph = active.locator("details");
  const started = performance.now();
  await active
    .getByRole("button", { name: /全件チェックを待っている/ })
    .click();
  await page.waitForFunction(
    () => document.activeElement?.id === "plan-release-plan-prepare",
  );
  report.measurements.blocker_navigation_ms = performance.now() - started;
  assert.equal(await graph.locator("article").count(), 50);
  await capture(page, "after-dependency-wait");
  await graph.getByRole("button", { name: "次の50件" }).click();
  assert.equal(await graph.locator("article").count(), 50);
  await graph.getByRole("button", { name: "次の50件" }).click();
  assert.equal(await graph.locator("article").count(), 20);
  await capture(page, "after-last-page");
  report.measurements.total_nodes = 120;
  report.measurements.maximum_rendered_rows = 50;
  await store.mutate("task", {
    id: "prepare",
    title: "検証用タスク prepare",
    status: "done",
  });
  await acceptance.define("prepare", [
    { id: "check", description: "全件チェックを実行", inputs: ["check.mjs"] },
  ]);
  await acceptance.perform({
    task_id: "prepare",
    criterion_id: "check",
    argv: [process.execPath, "check.mjs"],
    scope: "full",
    timeout_ms: 5000,
  });
  const changed = performance.now();
  await page.waitForFunction(
    () =>
      !document
        .querySelector("#execution-plans")
        .textContent.includes(
          "implement: 完了報告と現在のコードの全件チェックを待っている",
        ),
    undefined,
    { timeout: 12000 },
  );
  report.measurements.independent_plan_refresh_ms = performance.now() - changed;
  assert.equal(await graph.evaluate((el) => el.open), true);
  assert.equal(
    await graph.locator("article").count(),
    20,
    "expanded page survives plan refresh",
  );
  await graph.getByRole("button", { name: "前の50件" }).click();
  await graph.getByRole("button", { name: "前の50件" }).click();
  assert.match(
    await graph.locator("#plan-release-plan-implement").textContent(),
    /実行候補/,
  );
  await graph.locator("#plan-release-plan-prepare").scrollIntoViewIfNeeded();
  await capture(page, "after-verified-prerequisite");
  const invalid = panel
    .locator("article.card")
    .filter({ has: page.locator("h3", { hasText: /^invalid-draft$/ }) });
  await invalid.getByRole("button", { name: /依存関係が循環/ }).click();
  assert.equal(
    await invalid.locator("details").evaluate((el) => el.open),
    true,
  );
  await invalid
    .getByRole("button", { name: /待機先が計画にない/ })
    .first()
    .click();
  assert.match(
    await invalid.textContent(),
    /待機先 missing-node は計画にありません/,
  );
  report.flows.push(
    "cycle/unknown-node blockers and dependency buttons navigate to exact node or missing-node explanation",
  );
  await active
    .getByRole("button", { name: "新しい子タスクの受付を停止する" })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector("#execution-plans")
      .textContent.includes("新しい子タスクの受付を停止済み"),
  );
  assert.equal(
    (await plans.inspect("release-plan")).plans[0].stop_reason,
    "operator_stopped",
  );
  await active.locator("h3").scrollIntoViewIfNeeded();
  await capture(page, "after-stop");
  const mobile = await makePage({ width: 390, height: 844 });
  await mobile.goto(info.browser_url);
  await mobile.waitForFunction(
    () => document.querySelectorAll("#execution-plans details").length === 2,
  );
  await mobile.locator("#execution-plans").scrollIntoViewIfNeeded();
  assert.ok(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await capture(mobile, "after-mobile");
  report.flows.push(
    "real full local acceptance changes dependent task from waiting to candidate; graph page and expanded state survive independent refresh",
    "120-node graph stays collapsed until requested and renders at most 50 rows per page",
    "browser stop persists server state without cancelling native children",
    "390px mobile viewport has no horizontal overflow",
  );
  assert.deepEqual(report.page_errors, []);
  report.result = "PASS";
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser?.close();
  await server?.close();
  await fs.writeFile(
    path.join(output, "runtime-observations.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("rdsh-plan-browser-"));
  await fs.rm(root, { recursive: true });
}
console.log(
  JSON.stringify({ result: report.result, flows: report.flows, output }),
);
