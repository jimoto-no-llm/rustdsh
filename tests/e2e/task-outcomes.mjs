// Real project server, criterion execution and browser; isolated fixture only.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startDashboard } from "../../dashboard/server.mjs";
import { createOutcomeProject } from "../../dashboard/test/fixtures/task-outcomes-project.mjs";

const { chromium } = await import(
  process.env.RDSH_PLAYWRIGHT_MODULE || "playwright"
);
const repo = path.resolve(import.meta.dirname, "../..");
const output = path.resolve(
  process.env.RDSH_OUTCOMES_OUTPUT ||
    path.join(repo, "target/e2e/task-outcomes"),
);
await fs.mkdir(output, { recursive: true });
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "rdsh-outcomes-browser-"),
);
const f = await createOutcomeProject(directory);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.RDSH_CHROME_PATH
    ? { executablePath: process.env.RDSH_CHROME_PATH }
    : {}),
});
const contexts = [],
  servers = [],
  errors = [];
const manifest = {
  scope:
    "real local project server and Chromium; fixture checks only; no models, provider authentication, Tailscale or production adoption",
  node: process.version,
  source_files: {},
  captures: {},
  flows: [],
  page_errors: errors,
};
const exec = promisify(execFile);
manifest.head = (
  await exec("git", ["-C", repo, "rev-parse", "HEAD"], { windowsHide: true })
).stdout.trim();
for (const file of [
  "dashboard/app.mjs",
  "dashboard/ui.html",
  "dashboard/state.mjs",
  "dashboard/mcp.mjs",
  "dashboard/server.mjs",
  "dashboard/task-outcomes.mjs",
  "dashboard/task-outcomes-view.mjs",
  "dashboard/task-outcomes-ui.mjs",
])
  manifest.source_files[file] = createHash("sha256")
    .update(await fs.readFile(path.join(repo, file)))
    .digest("hex");

async function open(server) {
  servers.push(server);
  const runtime = JSON.parse(
    await fs.readFile(path.join(f.project.directory, "runtime.json"), "utf8"),
  );
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "ja-JP",
  });
  contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const started = performance.now();
  await page.goto(runtime.browser_url);
  await page.locator("#task-goal").waitFor({ state: "attached" });
  await page.locator("#tasks-detail").evaluate((element) => {
    element.open = true;
  });
  return { page, runtime, first_task_ready_ms: performance.now() - started };
}
async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const panel = page.locator("#tasks-detail");
  const viewport = page.viewportSize();
  const bounds = await panel.boundingBox();
  // Leave room for the real fixed action bar below this full-panel capture.
  // The actual phone viewport is tested separately and restored afterwards.
  const captureViewport = {
    width: viewport.width,
    height: Math.max(viewport.height, Math.ceil(bounds.height) + 400),
  };
  try {
    await page.setViewportSize(captureViewport);
    await panel.screenshot({ path: path.join(output, name + ".png") });
    manifest.captures[name] = {
      selector: "#tasks-detail",
      viewport: captureViewport,
      interaction_viewport: viewport,
    };
  } finally {
    await page.setViewportSize(viewport);
  }
}
async function inspect(page, selector, expected) {
  const element = page.locator(selector);
  await element.locator("button").click();
  await element
    .locator(".outcome-checks > p")
    .first()
    .filter({ hasText: expected })
    .waitFor();
}
try {
  if (process.env.RDSH_OUTCOMES_BASELINE) {
    const baseline = await import(
      pathToFileURL(process.env.RDSH_OUTCOMES_BASELINE)
    );
    const old = await baseline.startDashboard({
      project: f.project,
      port: 0,
      tailscale: false,
    });
    const before = await open(old);
    manifest.before_first_task_ready_ms = before.first_task_ready_ms;
    await capture(before.page, "before");
    await before.page.setViewportSize({ width: 390, height: 844 });
    await capture(before.page, "before-mobile");
    await before.page.close();
    await old.close();
    servers.pop();
    manifest.baseline =
      "origin/main d705ed7; same fixture task and acceptance definitions";
  }
  const dashboard = await startDashboard({
    project: f.project,
    port: 0,
    tailscale: false,
  });
  const { page, runtime, first_task_ready_ms } = await open(dashboard);
  manifest.after_first_task_ready_ms = first_task_ready_ms;
  manifest.chromium = browser.version();
  const task = page.locator("#task-goal");
  for (const value of [
    "必要な値と出力を提供する",
    "実装担当",
    "修正を提出しました",
    "受入条件を確認する",
    "レビューを待っています",
    "done（作業の申告）",
  ])
    assert.ok((await task.innerText()).includes(value), value);
  await capture(page, "after-unchecked");
  await inspect(page, "#task-goal", "未充足");
  await inspect(page, "#task-milestones > article", "0 / 2");
  assert.equal(await task.locator(".outcome-checks li").count(), 2);
  assert.equal(
    await task.getByText("確認時点で検証済み", { exact: true }).count(),
    0,
  );
  await capture(page, "after-unverified");
  manifest.flows.push(
    "done remains unverified; all purpose/owner/outcome/next step/blocker fields reachable",
  );
  await f.run("value");
  await inspect(page, "#task-milestones > article", "1 / 2");
  await capture(page, "after-partial");
  await f.run("shape");
  await inspect(page, "#task-milestones > article", "2 / 2");
  await inspect(page, "#task-goal", "全検査");
  await capture(page, "after");
  manifest.flows.push(
    "only current observed full checks satisfy fixed criteria; 0/2 -> 1/2 -> 2/2",
  );
  const upsert = async (input) => {
    const response = await fetch(dashboard.localUrl + "api/update/task", {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.mcp_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200, await response.text());
  };
  for (const id of ["split-a", "split-b"])
    await upsert({
      id,
      title: "分割した作業 " + id,
      status: "done",
      milestone: "M1",
      outcome: {
        purpose: "受入対象を分担する",
        owner: "分担者",
        latest_outcome: "作業の一部を完了",
        next_step: "親の受入条件を確認",
        acceptance_task_id: "goal",
      },
    });
  await page.locator("#task-split-b").waitFor();
  await inspect(page, "#task-milestones > article", "2 / 2");
  assert.equal(await page.locator("#task-milestones li").count(), 2);
  manifest.flows.push(
    "adding two split tasks preserves the fixed criterion numerator and denominator",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await capture(page, "after-mobile");
  for (const [name, selector] of [
    ["after-mobile-viewport", "#task-goal"],
    ["after-mobile-milestone", "#task-milestones"],
  ]) {
    await page
      .locator(selector)
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: path.join(output, name + ".png") });
    manifest.captures[name] = {
      selector: "viewport",
      viewport: page.viewportSize(),
      focus: selector,
    };
  }
  manifest.mobile = { width: 390, height: 844, horizontal_overflow: false };
  await fs.writeFile(
    path.join(f.root, "module.mjs"),
    "export const answer = 2;\n",
  );
  await inspect(page, "#task-goal", "未充足");
  assert.equal(
    await task
      .getByText("対象が変わったため再検証が必要", { exact: true })
      .count(),
    2,
  );
  await inspect(page, "#task-milestones > article", "0 / 2");
  await capture(page, "after-stale");
  manifest.flows.push(
    "related code change invalidates earlier passes without changing reported done",
  );
  let reached;
  const intercepted = new Promise((resolve) => {
    reached = resolve;
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/task-outcomes?task_id=goal", async (route) => {
    const response = await route.fetch();
    reached();
    await held;
    await route.fulfill({ response });
  });
  await task.locator("button").click();
  await intercepted;
  await upsert({
    id: "goal",
    title: "受入対象の成果",
    status: "done",
    milestone: "M1",
    outcome: { next_step: "現在の条件で再検証する" },
  });
  await task.getByText("現在の条件で再検証する", { exact: true }).waitFor();
  release();
  await page.unrouteAll({ behavior: "wait" });
  assert.ok((await task.innerText()).includes("現在の検証結果は未取得です"));
  assert.equal(await task.locator("button").isDisabled(), false);
  manifest.flows.push(
    "late response from a previous state revision is ignored and recheck remains usable",
  );
  manifest.render_benchmark = await page.evaluate(async () => {
    const { createTaskOutcomesPanel } = await import("/task-outcomes-ui.mjs");
    const node = (tag, text, className) => {
      const result = document.createElement(tag);
      if (text !== undefined) result.textContent = text;
      if (className) result.className = className;
      return result;
    };
    const host = node("section");
    const tasks = node("div", undefined, "outcome-grid"),
      milestones = node("div", undefined, "outcome-grid");
    host.append(tasks, milestones);
    document.querySelector("main").append(host);
    const results = [];
    try {
      for (const count of [40, 200]) {
        const samples = [];
        const state = {
          revision: 0,
          tasks: Array.from({ length: count }, (_, i) => ({
            id: `bench-${i}`,
            title: "測定用タスク",
            status: "done",
            milestone: "",
            blocker: "",
            updated_at: "2026-10-09T00:00:00.000Z",
          })),
          task_outcomes: {
            schema: 1,
            milestones: [],
            tasks: Array.from({ length: count }, (_, i) => ({
              task_id: `bench-${i}`,
              purpose: "測定用の目的",
              owner: "測定担当",
              latest_outcome: "測定用の成果",
              next_step: "受入条件を確認する",
            })),
          },
        };
        for (let i = 0; i < 6; i++) {
          const render = createTaskOutcomesPanel(tasks, milestones, {
            node,
            api: () => {
              throw Error("No checks in render benchmark");
            },
          });
          const start = performance.now();
          render(state);
          void host.offsetHeight;
          if (i) samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        results.push({
          tasks: count,
          samples: 5,
          median_ms: samples[2],
          max_ms: samples[4],
          includes_dom_and_layout: true,
          checks_executed: 0,
        });
      }
    } finally {
      host.remove();
    }
    return results;
  });
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, "browser-observations.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      tests: manifest.flows.length,
      mobile_overflow: false,
      page_errors: errors.length,
      output,
    }),
  );
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  for (const server of servers.reverse()) await server.close();
  assert.equal(
    path.dirname(path.resolve(directory)),
    path.resolve(os.tmpdir()),
  );
  assert.ok(path.basename(directory).startsWith("rdsh-outcomes-browser-"));
  await fs.rm(directory, { recursive: true });
}
