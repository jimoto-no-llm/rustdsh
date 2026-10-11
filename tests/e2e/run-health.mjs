import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const testFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(testFile), "../..");
const sourceRoot = path.resolve(
  process.env.RDSH_RUN_HEALTH_SOURCE || repoRoot,
);
const captureOnly = process.env.RDSH_RUN_HEALTH_CAPTURE_ONLY === "1";
const outputDir = path.resolve(
  process.env.RDSH_RUN_HEALTH_OUTPUT || path.join(repoRoot, "target/e2e/run-health"),
);
const previousHome = process.env.RDSH_DASHBOARD_HOME;
const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-health-e2e-"));
let dashboard;
let browser;

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

try {
  process.env.RDSH_DASHBOARD_HOME = path.join(temporaryHome, "dashboard-home");
  const { startDashboard } = await import(
    pathToFileURL(path.join(sourceRoot, "dashboard/server.mjs")).href
  );
  const fakeHarness =
    "process.stdout.write('dsh web: http://127.0.0.1:3081/?fixture=local-only\\n'); setInterval(() => {}, 1000);";
  dashboard = await startDashboard({
    kind: "harness",
    port: await unusedPort(),
    tailscale: false,
    harnessOptions: {
      cwd: temporaryHome,
      command: [process.execPath, "-e", fakeHarness],
      stopTimeout: 500,
    },
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  await page.goto(dashboard.browserUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#managed-status").waitFor({ state: "visible" });
  if (!captureOnly) {
    await page.locator("#managed-health .run-health-summary").waitFor();
    await page.locator("#managed-health details summary").click();
    await page.waitForTimeout(600);
    const summary = await page.locator("#managed-health").innerText();
    assert.match(summary, /実行中/);
    assert.match(summary, /自動停止はありません/);
    assert.match(summary, /Harness task heartbeat/);
    assert.match(summary, /API待ち/);
    await page.route("**/managed-process*", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
    );
    await page.waitForTimeout(1_500);
    const disconnectedStatus = await page.locator("#managed-status").innerText();
    const disconnectedHealth = await page.locator("#managed-health").innerText();
    assert.match(disconnectedStatus, /監視に接続できません/);
    assert.match(disconnectedHealth, /現在状態は未確認/);
    assert.match(disconnectedHealth, /自動停止は行いません/);
    await page.unroute("**/managed-process*");
    await page.waitForFunction(() =>
      document.querySelector("#managed-status")?.innerText.includes("実行中"),
    );
    const recovered = await page.locator("#managed-health").innerText();
    assert.match(recovered, /実行中/);
    await page.locator("#managed-health details summary").click();
    await page.waitForTimeout(600);
  }
  await fs.mkdir(outputDir, { recursive: true });
  const screenshot = path.join(outputDir, captureOnly ? "before.png" : "after.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await fs.writeFile(
    path.join(outputDir, captureOnly ? "before.json" : "after.json"),
    JSON.stringify(
      {
        source_commit: process.env.RDSH_RUN_HEALTH_SOURCE_COMMIT || null,
        fixture: "local managed process; no DSH provider, model, credentials, or network access",
        capture_only: captureOnly,
        screenshot: path.basename(screenshot),
        verified_diagnostics: !captureOnly,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser?.close();
  await dashboard?.close();
  await fs.rm(temporaryHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.RDSH_DASHBOARD_HOME;
  else process.env.RDSH_DASHBOARD_HOME = previousHome;
}
