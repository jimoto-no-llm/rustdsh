import assert from "node:assert/strict";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "playwright";
import { identity } from "../../dashboard/state.mjs";
import { startDashboard } from "../../dashboard/server.mjs";
import { WorkerWorkspaces } from "../../dashboard/workers.mjs";

const exec = promisify(execFile);
const run = async (command, args, options = {}) =>
  exec(command, args, { windowsHide: true, shell: false, ...options });
const git = async (cwd, ...args) =>
  (await run("git", ["-C", cwd, ...args])).stdout.trim();
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-review-ui-"));
const projectRoot = path.join(root, "project");
const output = path.resolve("../../target/e2e-review-evidence");
await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
await fs.mkdir(output, { recursive: true });
const previousHome = process.env.RDSH_DASHBOARD_HOME;
process.env.RDSH_DASHBOARD_HOME = path.join(root, "state");
let dashboard;
let client;
let browser;
let page;
let workers;
const workerIds = [];
const report = {
  result: "FAIL",
  scope: "local project Git fixture, MCP report tool, authenticated dashboard UI, no provider or sandbox claim",
  flows: [],
  errors: [],
  browser_responses: [],
  screenshots: [],
};
try {
  await git(projectRoot, "init", "-b", "review-fixture");
  await git(projectRoot, "config", "user.name", "Review UI Fixture");
  await git(projectRoot, "config", "user.email", "review-ui@example.invalid");
  await git(projectRoot, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(projectRoot, "src/reviewed.txt"), "base\n");
  await git(projectRoot, "add", ".");
  await git(projectRoot, "commit", "-m", "base target");
  const baseSha = await git(projectRoot, "rev-parse", "HEAD");
  await fs.writeFile(path.join(projectRoot, "src/reviewed.txt"), "review target\n");
  await git(projectRoot, "add", ".");
  await git(projectRoot, "commit", "-m", "review target");
  const headSha = await git(projectRoot, "rev-parse", "HEAD");
  const project = await identity(projectRoot);
  workers = await WorkerWorkspaces.open(project);
  const prepare = async (worker_id, role, write_paths) => {
    const request = {
      worker_id,
      role,
      read_paths: ["."],
      write_paths,
      modules: ["src"],
      forbidden_paths: [],
      lease_seconds: 600,
    };
    const plan = await workers.plan(request);
    assert.equal(plan.can_prepare, true, JSON.stringify(plan.warnings));
    const prepared = await workers.prepare(request, {
      expectedRevision: plan.revision,
      expectedHead: plan.source.head_sha,
    });
    assert.equal(prepared.provisioning_error, null);
    return prepared.worker.worker_id;
  };
  const implementationWorker = await prepare("implementation", "edit", ["src"]);
  const reviewerWorker = await prepare("reviewer", "review", []);
  workerIds.push(implementationWorker, reviewerWorker);
  dashboard = await startDashboard({
    project,
    port: await freePort(),
    tailscale: false,
  });
  const runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  client = new Client({ name: "review-evidence-e2e", version: "1.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(runtime.local_url + "mcp"), {
      requestInit: {
        headers: { authorization: `Bearer ${runtime.mcp_token}` },
      },
    }),
  );
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, result.content[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  await call("dashboard_upsert_task", {
    id: "review-task",
    title: "Review exact target",
    status: "doing",
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.RDSH_CHROME_PATH
      ? { executablePath: process.env.RDSH_CHROME_PATH }
      : {}),
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/") || url.pathname.endsWith(".mjs"))
      report.browser_responses.push({ path: url.pathname, status: response.status() });
  });
  await page.goto(runtime.browser_url);
  report.browser_state = await page.evaluate(async () => {
    const token = sessionStorage.getItem("rdsh_project_browser_token") || "";
    const response = await fetch("/api/state", {
      headers: { "x-rdsh-browser-token": token },
    });
    const state = await response.json();
    return {
      status: response.status,
      token_present: token.length > 0,
      task_count: state.tasks?.length ?? null,
      review_count: state.review_evidence?.reports?.length ?? null,
      review_status: state.review_evidence?.reports?.[0]?.review_status ?? null,
    };
  });
  const panel = page.locator("#review-evidence-detail");
  await panel.evaluate((element) => (element.open = true));
  assert.equal(report.browser_state.status, 200);
  assert.equal(report.browser_state.review_count, 0);
  await panel.getByText("独立レビューの記録はありません。", { exact: true }).waitFor();
  await panel.scrollIntoViewIfNeeded();
  const beforeScreenshot = path.join(output, "review-evidence-before.png");
  await panel.screenshot({ path: beforeScreenshot });
  report.screenshots.push(path.basename(beforeScreenshot));

  const recorded = await call("dashboard_record_review", {
    review_id: "review-ui-flow-1",
    task_id: "review-task",
    implementation_worker_id: implementationWorker,
    reviewer_worker_id: reviewerWorker,
    base_sha: baseSha,
    head_sha: headSha,
    availability: "complete",
    findings: [],
    unverified: [],
    evidence_refs: [
      { label: "fixture check", reference: "synthetic://review-fixture/pass" },
    ],
  });
  assert.equal(recorded.report.review_status, "clear");
  const fetched = await call("dashboard_get_review_evidence", {
    task_id: "review-task",
  });
  assert.equal(fetched.reports[0].target.head_sha, headSha);
  await page.reload();
  await panel.evaluate((element) => (element.open = true));
  await panel
    .getByText("申告上指摘なし・対象版一致", { exact: false })
    .waitFor({ timeout: 5000 })
    .catch(() => {
      throw new Error(
        `Review panel did not render; browser state: ${JSON.stringify(report.browser_state)}; responses: ${JSON.stringify(report.browser_responses)}`,
      );
    });
  await panel.getByText(headSha, { exact: false }).waitFor();
  await panel.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const freshScreenshot = path.join(output, "review-evidence-current.png");
  await panel.screenshot({ path: freshScreenshot });
  report.screenshots.push(path.basename(freshScreenshot));
  report.flows.push("empty state -> MCP report submission -> current exact-head report in browser");

  await fs.writeFile(path.join(projectRoot, "src/reviewed.txt"), "changed after review\n");
  await git(projectRoot, "add", ".");
  await git(projectRoot, "commit", "-m", "change after review");
  const stale = await call("dashboard_get_review_evidence", { task_id: "review-task" });
  assert.equal(stale.reports[0].review_status, "stale");
  assert.equal(stale.reports[0].freshness_reason, "source_head_changed_after_review");
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 1200 });
  const stalePanel = page.locator("#review-evidence-detail");
  await stalePanel.evaluate((element) => (element.open = true));
  await stalePanel.getByText("対象変更後の古いレビュー", { exact: false }).waitFor();
  await stalePanel.scrollIntoViewIfNeeded();
  const staleScreenshot = path.join(output, "review-evidence-stale.png");
  await stalePanel.screenshot({ path: staleScreenshot });
  report.screenshots.push(path.basename(staleScreenshot));
  report.flows.push("committed source change -> exact review becomes stale in MCP and browser");

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(report.errors, []);
  report.result = "PASS";
} catch (error) {
  report.errors.push(error.stack || error.message);
  throw error;
} finally {
  await page?.close();
  await browser?.close();
  await client?.close();
  await dashboard?.close();
  for (const workerId of workerIds)
    await git(projectRoot, "worktree", "remove", "--", workers.slot(workerId));
  await fs.writeFile(path.join(output, "review-evidence-results.json"), JSON.stringify(report, null, 2) + "\n");
  assert.ok(path.basename(root).startsWith("rdsh-review-ui-"));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (previousHome) process.env.RDSH_DASHBOARD_HOME = previousHome;
  else delete process.env.RDSH_DASHBOARD_HOME;
}
console.log(JSON.stringify({ result: report.result, flows: report.flows, output }, null, 2));
