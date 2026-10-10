import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { identity, ProjectStore } from "../../dashboard/state.mjs";
import { startDashboard } from "../../dashboard/server.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "rdsh-project-overview-e2e-"),
);
const previousHome = process.env.RDSH_DASHBOARD_HOME;
process.env.RDSH_DASHBOARD_HOME = path.join(temporary, "state-home");
let primaryDashboard;
let includedDashboard;
let baselineDashboard;
let browser;
let context;
try {
  const projectsRoot = path.join(temporary, "projects");
  await fs.mkdir(projectsRoot);
  const [primary, included, notIncluded] = await Promise.all(
    ["primary", "included", "not-included"].map(async (name) => {
      const root = path.join(projectsRoot, name);
      await fs.mkdir(root);
      return identity(root);
    }),
  );
  const includedStore = await ProjectStore.open(included);
  includedStore.value.tasks = [
    { id: "T1", title: "Active fixture", status: "doing" },
  ];
  await fs.mkdir(included.directory, { recursive: true });
  await fs.writeFile(
    path.join(included.directory, "state.json"),
    JSON.stringify(includedStore.value),
  );
  const notIncludedStore = await ProjectStore.open(notIncluded);
  notIncludedStore.value.tasks = [
    { id: "T2", title: "Hidden fixture", status: "blocked" },
  ];
  await fs.mkdir(notIncluded.directory, { recursive: true });
  await fs.writeFile(
    path.join(notIncluded.directory, "state.json"),
    JSON.stringify(notIncludedStore.value),
  );

  includedDashboard = await startDashboard({
    project: included,
    port: await freePort(),
    tailscale: false,
  });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "ja-JP",
  });
  const screenshotDirectory = process.env.RDSH_PROJECT_OVERVIEW_SCREENSHOT_DIR;
  if (screenshotDirectory)
    await fs.mkdir(screenshotDirectory, { recursive: true });
  baselineDashboard = await startDashboard({
    project: primary,
    port: await freePort(),
    tailscale: false,
  });
  const beforePage = await context.newPage();
  await beforePage.goto(baselineDashboard.browserUrl);
  await beforePage.locator("#overview-state").waitFor();
  if (screenshotDirectory)
    await beforePage.screenshot({
      path: path.join(screenshotDirectory, "before.png"),
      fullPage: false,
    });
  await beforePage.close();
  await baselineDashboard.close();
  baselineDashboard = null;

  primaryDashboard = await startDashboard({
    project: primary,
    overviewProjects: [included],
    port: await freePort(),
    tailscale: false,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(primaryDashboard.browserUrl);
  await page.locator("#cross-project-overview").waitFor();
  await page.locator("#cross-project-rows li").nth(1).waitFor();
  if (screenshotDirectory) {
    await page.evaluate(() => {
      const section = document.querySelector("#cross-project-overview");
      window.scrollTo(0, section.getBoundingClientRect().top + window.scrollY);
    });
    await page.screenshot({
      path: path.join(screenshotDirectory, "after.png"),
      fullPage: false,
    });
  }

  assert.equal(await page.locator("#cross-project-overview").isVisible(), true);
  assert.equal(await page.locator("#cross-project-rows li").count(), 2);
  const includedRow = page
    .locator("#cross-project-rows li")
    .filter({ hasText: "included" });
  await includedRow.getByText("稼働 1 · 待ち 0 · 要確認 0").waitFor();
  assert.equal(await page.getByText("not-included").count(), 0);

  const detailLink = includedRow.getByRole("link");
  const href = await detailLink.getAttribute("href");
  assert.equal(href, includedDashboard.localUrl);
  assert.equal(new URL(href).hash, "");
  assert.ok(
    !href.includes(new URL(includedDashboard.browserUrl).hash.slice(1)),
    "summary links must not pass the owning project's browser credential",
  );
  assert.deepEqual(pageErrors, []);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  console.log(
    JSON.stringify({
      result: "PASS",
      projects: 2,
      unlistedProjectShown: false,
      detailCredentialShared: false,
      mobileOverflow: false,
    }),
  );
} finally {
  await context?.close();
  await browser?.close();
  await primaryDashboard?.close();
  await baselineDashboard?.close();
  await includedDashboard?.close();
  if (previousHome) process.env.RDSH_DASHBOARD_HOME = previousHome;
  else delete process.env.RDSH_DASHBOARD_HOME;
  await fs.rm(temporary, { recursive: true, force: true });
}
