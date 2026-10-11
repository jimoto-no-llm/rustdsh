import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { startDashboard } from "../server.mjs";

const fixture = fileURLToPath(
  new URL("./fixtures/owned-tree.mjs", import.meta.url),
);

test("concurrent close shares one attempt and retries an unconfirmed stop", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-close-"));
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(root, "state");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  let harness;
  const dashboard = await startDashboard({
    kind: "harness",
    port,
    tailscale: false,
    observeHarness: (value) => {
      harness = value;
    },
    harnessOptions: {
      cwd: root,
      command: [
        process.execPath,
        fixture,
        "root",
        "cooperative",
        path.join(root, "tree.jsonl"),
      ],
      stopTimeout: 400,
    },
  });
  const actualStop = harness.stop;
  let finishUnconfirmed;
  const unconfirmed = new Promise((resolve) => {
    finishUnconfirmed = resolve;
  });
  let stopCalls = 0;
  harness.stop = () => {
    stopCalls++;
    return unconfirmed;
  };
  t.after(async () => {
    finishUnconfirmed({ confirmed: false });
    harness.stop = actualStop;
    await dashboard.close().catch(() => {});
    await dashboard.close().catch(() => {});
    dashboard.server.closeAllConnections();
    if (previousHome === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  const first = dashboard.close();
  const second = dashboard.close();
  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(stopCalls, 1);

  finishUnconfirmed({ confirmed: false });
  await assert.rejects(first, /dashboard remains available/);
  assert.equal(stopCalls, 1);
  assert.equal(dashboard.server.listening, true);
  const runtime = JSON.parse(
    await fs.readFile(path.join(dashboard.directory, "runtime.json"), "utf8"),
  );
  const response = await fetch(dashboard.localUrl + "_rdsh/api/managed-process", {
    headers: { authorization: `Bearer ${runtime.token}` },
  });
  assert.equal(response.status, 200);

  harness.stop = (...args) => {
    stopCalls++;
    return actualStop(...args);
  };
  const retry = dashboard.close();
  assert.strictEqual(retry, dashboard.close());
  await retry;
  assert.equal(stopCalls, 2);
});
