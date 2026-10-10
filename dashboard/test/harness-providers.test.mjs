import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHarness } from "../harness.mjs";
import { RunHistory } from "../run-history.mjs";
import {
  resolveHarnessProvider,
  UnsupportedHarnessProviderError,
} from "../harness-providers.mjs";

const fixture = fileURLToPath(
  new URL("./fixtures/owned-tree.mjs", import.meta.url),
);
const wslSmokeSkip = process.platform !== "win32"
  ? "requires a Windows host"
  : process.env.RDSH_TEST_WSL_PROVIDER === "1"
    ? false
    : "set RDSH_TEST_WSL_PROVIDER=1 on a configured Windows+WSL host";

test("the supported Windows+WSL provider keeps the current profile and scoped lifecycle", () => {
  const provider = resolveHarnessProvider({
    provider: "windows-wsl",
    platform: "win32",
    providerEnv: { RDSH_WSL_DISTRO: "WorkDistro", RDSH_WSL_NODE: "/opt/node/bin/node" },
  });
  assert.equal(provider.id, "windows-wsl");
  assert.deepEqual(provider.status.capabilities, {
    execution: "wsl",
    connection: "loopback",
    readiness: "dsh-web-url",
    health: "owned-process-scope",
    stop: "verified-owned-descendants",
    remote: false,
  });
  assert.deepEqual(provider.launchOptions({
    port: 3081,
    frontPort: 38081,
    options: {},
  }), {
    command: [
      "/root/.local/bin/rdsh-env", "dsh", "--profile", "web", "--host",
      "127.0.0.1", "--port", "3081", "--no-open", "--trusted-host",
      "127.0.0.1:38081", "localhost:38081",
    ],
    cwd: "/root",
    env: undefined,
    wsl: "WorkDistro",
    wslNode: "/opt/node/bin/node",
  });
  for (const method of ["start", "waitUntilReady", "health", "stop"])
    assert.equal(typeof provider[method], "function");
});

test("unsupported providers and platforms fail with a reason and no fallback", () => {
  for (const [provider, platform, env, reason] of [
    ["windows-wsl", "linux", {}, /requires Windows and WSL/],
    ["linux-native", "linux", {}, /no verified launch, readiness, health, and scoped-stop adapter/],
    ["remote", "win32", {}, /no verified launch, readiness, health, and scoped-stop adapter/],
    ["typo", "win32", {}, /provider name is unknown/],
  ]) {
    assert.throws(
      () => resolveHarnessProvider({ provider, platform, providerEnv: env }),
      (error) => {
        assert(error instanceof UnsupportedHarnessProviderError);
        assert.equal(error.code, "harness_provider_unavailable");
        assert.equal(error.provider, provider);
        assert.match(error.message, reason);
        assert.match(error.message, /no fallback was attempted/);
        return true;
      },
    );
  }
  assert.throws(
    () => resolveHarnessProvider({
      platform: "win32",
      providerEnv: { RDSH_HARNESS_PROVIDER: "remote" },
    }),
    (error) => error.provider === "remote" && /no fallback was attempted/.test(error.message),
  );
});

test("verified stop permits a clean managed-Harness restart with a distinct run", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-provider-restart-"));
  const project = { id: "provider-restart", directory: path.join(root, "state") };
  const handles = [];
  t.after(async () => {
    for (const handle of handles)
      if (!(await handle.inspect()).scope?.confirmed)
        await handle.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const launch = (port, trace) => startHarness(port, 38081, {
    project,
    cwd: root,
    command: [process.execPath, fixture, "root", "cooperative", trace, String(port)],
    stopTimeout: 1000,
  });

  const first = await launch(3081, path.join(root, "first.jsonl"));
  handles.push(first);
  assert.equal((await first.inspect()).provider.id, "provided-command");
  assert.equal((await first.stop()).confirmed, true);

  const second = await launch(3081, path.join(root, "second.jsonl"));
  handles.push(second);
  assert.notEqual(second.run_id, first.run_id);
  assert.equal((await second.inspect()).provider.id, "provided-command");
  assert.equal((await second.stop()).confirmed, true);
});

test(
  "a failed managed launch preserves the last confirmed state without claiming readiness",
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "rdsh-provider-failed-start-"),
    );
    const project = {
      id: "provider-failed-start",
      directory: path.join(root, "state"),
    };
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await assert.rejects(
      startHarness(3081, 38081, {
        project,
        cwd: root,
        command: [path.join(root, "missing-harness-executable")],
        startupTimeout: 1000,
      }),
    );
    const history = await RunHistory.open(project);
    const journal = await fs.readFile(history.file, "utf8");
    const firstEvent = journal.trim().split("\n")[0];
    const runId = JSON.parse(firstEvent).run_id;
    const run = await history.inspect(runId);
    assert.ok(["unknown", "disconnected"].includes(run.recorded_state));
    if (run.recorded_state === "disconnected") {
      assert.equal(run.reason, "owned_exit_confirmed");
      assert.equal(run.process_observation.status, "exit_confirmed");
    } else {
      assert.equal(run.reason, "operation_unconfirmed");
      assert.equal(run.process_observation.status, "unknown");
    }
  },
);

test("live Windows+WSL provider starts, becomes ready, stops by owned scope, and restarts", {
  skip: wslSmokeSkip,
}, async (t) => {
  const tempRoot = path.resolve(os.tmpdir());
  const root = path.resolve(
    await fs.mkdtemp(path.join(tempRoot, "rdsh-live-wsl-provider-")),
  );
  assert(root.startsWith(tempRoot + path.sep));
  const project = { id: "live-wsl-provider", directory: path.join(root, "state") };
  const parallelProject = {
    id: "live-wsl-provider-parallel",
    directory: path.join(root, "parallel-state"),
  };
  const handles = [];
  t.after(async () => {
    for (const handle of handles) {
      const state = await handle.inspect().catch(() => null);
      if (!state?.scope?.confirmed) await handle.stop().catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  const reservedPorts = new Set();
  const freePort = async () => {
    while (true) {
      const probe = net.createServer();
      await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", resolve);
      });
      const port = probe.address().port;
      await new Promise((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve())),
      );
      if (!reservedPorts.has(port)) {
        reservedPorts.add(port);
        return port;
      }
    }
  };
  const port = await freePort();
  const frontPort = await freePort();
  const parallelPort = await freePort();
  const parallelFrontPort = await freePort();
  const providerEnv = {
    RDSH_WSL_DISTRO: process.env.RDSH_WSL_DISTRO || "FlashNext",
    RDSH_WSL_HARNESS_BIN: process.env.RDSH_WSL_HARNESS_BIN || "/root/.local/bin/rdsh-env",
    RDSH_WSL_NODE: process.env.RDSH_WSL_NODE,
  };
  const launch = (
    targetPort = port,
    targetFrontPort = frontPort,
    targetProject = project,
  ) =>
    startHarness(targetPort, targetFrontPort, {
      project: targetProject,
      provider: "windows-wsl",
      providerEnv,
      startupTimeout: 45_000,
      stopTimeout: 5_000,
    });

  const first = await launch();
  handles.push(first);
  assert.equal((await first.inspect()).provider.id, "windows-wsl");
  assert.equal(first.url.hostname, "127.0.0.1");
  assert.equal(first.url.port, String(port));

  const parallel = await launch(parallelPort, parallelFrontPort, parallelProject);
  handles.push(parallel);
  assert.equal(parallel.url.port, String(parallelPort));
  assert.equal((await first.stop()).confirmed, true);
  assert.equal((await parallel.inspect()).scope.status, "running");
  assert.equal((await parallel.stop()).confirmed, true);

  const second = await launch();
  handles.push(second);
  assert.notEqual(second.run_id, first.run_id);
  assert.equal((await second.inspect()).provider.id, "windows-wsl");
  assert.equal(second.url.port, String(port));
  assert.equal((await second.stop()).confirmed, true);
});
