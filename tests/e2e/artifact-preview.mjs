import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { identity } from "../../dashboard/state.mjs";
import { startDashboard } from "../../dashboard/server.mjs";

const { chromium } = await import(process.env.RDSH_PLAYWRIGHT_MODULE || "playwright");
const repo = path.resolve(import.meta.dirname, "../..");
const output = path.resolve(
  process.env.RDSH_PREVIEW_OUTPUT || path.join(repo, "target/e2e/artifact-preview"),
);
const baseline = process.env.RDSH_PREVIEW_BASELINE_APP;
const label = baseline ? "before" : "after";
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-preview-browser-"));
const previousHome = process.env.RDSH_DASHBOARD_HOME;
let dashboard;
let browser;
const report = {
  result: "FAIL",
  label,
  scope: "actual app/report buttons and authenticated HTTP; controlled Blob decoding; no provider or Tailscale",
  scenarios: [],
  pageErrors: [],
};
try {
  process.env.RDSH_DASHBOARD_HOME = path.join(temporary, "state");
  const root = path.join(temporary, "project");
  await fs.mkdir(root);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(root, "a.txt"), "password=synthetic-a\n" + "A obsolete text\n".repeat(9000));
  await fs.writeFile(path.join(root, "b.txt"), "B text remains current");
  await fs.writeFile(path.join(root, "b.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const project = await identity(root);
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  dashboard = await startDashboard({ project, port, tailscale: false });
  for (const artifact of ["a.txt", "b.txt", "b.png"])
    await dashboard.store.mutate("event", { type: "artifact", title: artifact, artifact });
  browser = await chromium.launch({ headless: true,
    ...(process.env.RDSH_CHROME_PATH ? { executablePath: process.env.RDSH_CHROME_PATH } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 },
    recordVideo: { dir: output, size: { width: 1280, height: 900 } },
  });
  await context.addInitScript(() => {
    const text = Blob.prototype.text;
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    window.previewProbe = { armed: false, pending: false, urls: [], revoked: [] };
    Blob.prototype.text = async function () {
      const value = await text.call(this);
      if (!window.previewProbe.armed) return value;
      window.previewProbe.armed = false;
      return new Promise((resolve) => {
        window.previewProbe.release = () => resolve(value);
        window.previewProbe.pending = true;
      });
    };
    URL.createObjectURL = function (blob) {
      const url = create.call(this, blob);
      window.previewProbe.urls.push(url);
      return url;
    };
    URL.revokeObjectURL = function (url) {
      window.previewProbe.revoked.push(url);
      return revoke.call(this, url);
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  if (baseline) await page.route("**/app.mjs", (route) => route.fulfill({
    contentType: "text/javascript", path: baseline,
  }));
  await page.goto(dashboard.browserUrl);
  await page.locator("#events button").first().waitFor({ state: "attached" });
  assert.equal(new URL(page.url()).origin, new URL(dashboard.localUrl).origin);
  assert.ok(await page.title());
  const open = async (artifact) => {
    await page.locator("#events").evaluate((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement)
        if (parent.tagName === "DETAILS") parent.open = true;
    });
    await page.locator("#events article").filter({ has: page.locator("code", { hasText: artifact }) })
      .getByRole("button", { name: "プレビュー", exact: true }).click();
  };
  const snapshot = () => page.locator("#artifact-preview").evaluate((dialog) => ({
    open: dialog.open,
    content: [...dialog.querySelector("#artifact-preview-content").children].map((element) => ({
      tag: element.tagName,
      text: element.textContent.slice(0, 100),
      length: element.textContent.length,
      src: element.getAttribute("src"),
    })),
    status: dialog.querySelector("#artifact-preview-status").textContent,
  }));
  const close = async () => {
    await page.locator("#artifact-preview").evaluate((dialog) => {
      window.previewProbe.closed = false;
      dialog.addEventListener("close", () => { window.previewProbe.closed = true; }, { once: true });
    });
    await page.locator("#artifact-preview-close").click();
    await page.waitForFunction(() => window.previewProbe.closed);
  };
  const release = async () => {
    await page.evaluate(async () => {
      window.previewProbe.release();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
  };
  for (const next of ["b.txt", "b.png", null]) {
    await page.evaluate(() => { window.previewProbe.armed = true; window.previewProbe.pending = false; });
    await open("a.txt");
    await page.waitForFunction(() => window.previewProbe.pending);
    await close();
    if (next) {
      await open(next);
      await page.locator(next.endsWith("png") ? "#artifact-preview-content img" : "#artifact-preview-content pre").waitFor();
      if (next.endsWith("png")) await page.waitForFunction(() => document.querySelector("#artifact-preview-content img").naturalWidth === 1);
    }
    const expected = await snapshot();
    await release();
    const actual = await snapshot();
    report.scenarios.push({ next, expected, actual, passed: JSON.stringify(expected) === JSON.stringify(actual) });
    if (next) {
      await page.screenshot({ path: path.join(output, `${label}-${next}.png`) });
      await close();
    }
  }
  await page.evaluate(() => { window.previewProbe.armed = true; window.previewProbe.pending = false; });
  await open("a.txt");
  await page.waitForFunction(() => window.previewProbe.pending);
  await dashboard.store.mutate("event", { type: "note", title: "Updated during decoding" });
  await page.locator("#events strong", { hasText: "Updated during decoding" }).waitFor({ state: "attached" });
  await release();
  const freshness = await snapshot();
  report.scenarios.push({ freshness: true, passed: freshness.status.includes("取得後に状態が更新されました"), status: freshness.status });
  await close();
  const urls = await page.evaluate(() => ({ created: window.previewProbe.urls, revoked: window.previewProbe.revoked }));
  assert.equal(urls.created.length, 1);
  assert.deepEqual(urls.revoked, urls.created);
  await context.close();
  assert.deepEqual(report.pageErrors, []);
  assert.ok(report.scenarios.every((scenario) => scenario.passed), "stale decoding must not modify another preview or a closed dialog");
  report.result = "PASS";
} finally {
  await browser?.close();
  await dashboard?.close();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, `${label}.json`), JSON.stringify(report, null, 2) + "\n");
  await fs.rm(temporary, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.RDSH_DASHBOARD_HOME;
  else process.env.RDSH_DASHBOARD_HOME = previousHome;
}
console.log(JSON.stringify(report));
