import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  inspectTunnel,
  recordTunnel,
  finishTunnel,
  loopbackBase,
} from "../connection-diagnostics.mjs";
import { startDashboard } from "../server.mjs";
import { identity, writeJson } from "../state.mjs";
import { inspectShare } from "../tailscale.mjs";

const run = promisify(execFile);
async function temporary(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-diagnostics-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { id: "diagnostic-project", directory };
}
async function healthServer(t) {
  const requests = [];
  let ready = 200,
    redirect = false;
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    res.writeHead(
      redirect ? 302 : req.url === "/readyz" ? ready : 200,
      redirect ? { location: "http://127.0.0.1:1/private" } : {},
    );
    res.end("private-health-detail-secret");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/`,
    notReady() {
      ready = 503;
    },
    redirect() {
      redirect = true;
    },
  };
}
test("Tunnel readiness is read-only, scoped to its live generation and distinct from Dot response", async (t) => {
  const project = await temporary(t),
    health = await healthServer(t),
    instance = randomUUID();
  const record = await recordTunnel(project, instance, process.pid);
  assert.ok(
    record.process,
    "This platform must provide process identity for the positive fixture",
  );
  await fs.writeFile(
    path.join(project.directory, record.health_file),
    health.url,
  );
  const ready = await inspectTunnel(project, instance);
  assert.equal(ready.state, "ready");
  assert.equal(ready.readiness, 200);
  assert.deepEqual(health.requests.map((item) => item.path).sort(), [
    "/healthz",
    "/readyz",
  ]);
  assert.ok(health.requests.every((item) => item.authorization === undefined));
  assert.ok(!JSON.stringify(ready).includes("private-health-detail-secret"));
  health.notReady();
  assert.equal((await inspectTunnel(project, instance)).state, "not_ready");
  const count = health.requests.length;
  const stale = await inspectTunnel(project, randomUUID());
  assert.equal(stale.state, "stale_credentials");
  assert.equal(stale.reason, "dashboard_restarted");
  assert.equal(
    health.requests.length,
    count,
    "Never probe a stale generation's health port",
  );
  const reused = await inspectTunnel(project, instance, {
    processReader: async () => ({
      status: "observed",
      identity: {
        ...record.process,
        birth: String(BigInt(record.process.birth) + 1n),
      },
    }),
  });
  assert.equal(reused.state, "stopped");
  assert.equal(reused.reason, "pid_reused");
  assert.equal(health.requests.length, count);
  await finishTunnel(project, record);
  assert.equal(
    (await inspectTunnel(project, instance)).reason,
    "launcher_exited",
  );
});
test("Health diagnostics reject foreign projects, arbitrary URLs, redirects, oversized files and unknown processes", async (t) => {
  const project = await temporary(t),
    health = await healthServer(t),
    instance = randomUUID();
  assert.equal((await inspectTunnel(project, instance)).reason, "not_recorded");
  const record = await recordTunnel(project, instance, process.pid);
  for (const url of [
    "https://example.com/",
    "http://localhost:8080/",
    "http://127.0.0.1:8080/?key=secret",
    "http://user:pass@127.0.0.1:8080/",
    "http://127.0.0.1:8080/private",
    "http://2130706433:8080/",
  ]) {
    assert.throws(() => loopbackBase(url));
    await fs.writeFile(path.join(project.directory, record.health_file), url);
    assert.equal(
      (await inspectTunnel(project, instance)).reason,
      "health_address_unavailable",
    );
  }
  await fs.writeFile(
    path.join(project.directory, record.health_file),
    health.url,
  );
  assert.equal(
    (
      await inspectTunnel(project, instance, {
        processReader: async () => ({ status: "unknown", identity: null }),
      })
    ).state,
    "unconfirmed",
  );
  assert.equal(health.requests.length, 0);
  health.redirect();
  assert.equal((await inspectTunnel(project, instance)).state, "unreachable");
  assert.ok(
    health.requests.every((request) =>
      ["/healthz", "/readyz"].includes(request.path),
    ),
  );
  await writeJson(path.join(project.directory, "tunnel-runtime.json"), {
    ...record,
    project_id: "other-project",
  });
  assert.equal(
    (await inspectTunnel(project, instance)).reason,
    "invalid_metadata",
  );
  await fs.writeFile(
    path.join(project.directory, "tunnel-runtime.json"),
    " ".repeat(8193),
  );
  assert.equal(
    (await inspectTunnel(project, instance)).reason,
    "invalid_metadata",
  );
  await writeJson(path.join(project.directory, "tunnel-runtime.json"), record);
  const newer = await recordTunnel(project, instance, process.pid);
  await finishTunnel(project, record);
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(project.directory, "tunnel-runtime.json")),
    ).owner,
    newer.owner,
  );
});
test("browser success, MCP auth failure, absent Tunnel and stale restart credentials remain independent through the public CLI", async (t) => {
  const directory = (await temporary(t)).directory,
    previous = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(directory, "state");
  let dashboard;
  t.after(async () => {
    await dashboard?.close();
    if (previous === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = previous;
  });
  const project = await identity(directory);
  const reserve = http.createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  dashboard = await startDashboard({ project, port, tailscale: false });
  let runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json")),
  );
  const human = {
    "x-rdsh-browser-token": new URL(dashboard.browserUrl).hash.slice(5),
  };
  assert.equal(
    (await fetch(dashboard.localUrl + "api/state", { headers: human })).status,
    200,
  );
  assert.equal(
    (
      await fetch(dashboard.localUrl + "mcp", {
        method: "POST",
        headers: { authorization: "Bearer private-invalid-key" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(dashboard.localUrl + "api/diagnostics", {
        headers: { authorization: `Bearer ${runtime.mcp_token}` },
      })
    ).status,
    401,
  );
  const read = async () =>
    (
      await fetch(dashboard.localUrl + "api/diagnostics", {
        headers: { authorization: `Bearer ${runtime.token}` },
      })
    ).json();
  const report = await read();
  assert.equal(report.browser.authentication.state, "observed");
  assert.equal(report.dot.authentication.state, "failed");
  assert.equal(report.dot.tunnel.reason, "not_recorded");
  assert.equal(report.dot.discovery.state, "unconfirmed");
  assert.equal(report.end_to_end.state, "unconfirmed");
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
  const printed = (
    await run(process.execPath, [cli, "diagnostics", "--project", directory], {
      timeout: 30000,
    })
  ).stdout;
  assert.equal(JSON.parse(printed).dot.authentication.reason, "unauthorized");
  for (const secret of [
    runtime.token,
    runtime.mcp_token,
    human["x-rdsh-browser-token"],
    "private-invalid-key",
    project.directory,
  ])
    assert.ok(!printed.includes(secret));
  await recordTunnel(project, runtime.instance_id, process.pid);
  const oldMcp = runtime.mcp_token;
  await dashboard.close();
  dashboard = await startDashboard({ project, port, tailscale: false });
  runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json")),
  );
  assert.notEqual(runtime.mcp_token, oldMcp);
  assert.equal(
    (
      await fetch(dashboard.localUrl + "mcp", {
        headers: { authorization: `Bearer ${oldMcp}` },
      })
    ).status,
    401,
  );
  const restarted = await read();
  assert.equal(restarted.dot.tunnel.state, "stale_credentials");
  assert.equal(restarted.dot.authentication.state, "failed");
  assert.equal(restarted.browser.authentication.state, "unconfirmed");
  assert.equal(
    (await fetch(dashboard.localUrl + "api/state", { headers: human })).status,
    401,
  );
  assert.equal((await read()).browser.authentication.state, "failed");
  await dashboard.close();
  dashboard = null;
  await assert.rejects(
    run(process.execPath, [cli, "diagnostics", "--project", directory]),
    (error) =>
      JSON.parse(error.stdout).reason ===
      "dashboard_unreachable_or_runtime_invalid",
  );
});
test("Tailscale diagnostics inspect only status and never repair a missing or conflicting Serve route", async () => {
  const calls = [],
    hostname = "device.test.ts.net",
    port = 38211;
  let config = {};
  const execute = async (_command, args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify(
        args[0] === "status"
          ? {
              BackendState: "Running",
              Self: { Online: true, DNSName: hostname + "." },
            }
          : config,
      ),
    };
  };
  assert.equal(
    (await inspectShare(port, { executable: "fixture", execute })).state,
    "route_missing",
  );
  config = {
    TCP: { [port]: { HTTPS: true } },
    Web: {
      [`${hostname}:${port}`]: {
        Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } },
      },
    },
  };
  assert.equal(
    (await inspectShare(port, { executable: "fixture", execute })).state,
    "ready",
  );
  config.AllowFunnel = { [`${hostname}:${port}`]: true };
  assert.equal(
    (await inspectShare(port, { executable: "fixture", execute })).state,
    "unconfirmed",
  );
  assert.ok(
    calls.every(
      (args) =>
        args.join(" ") === "status --json" ||
        args.join(" ") === "serve status --json",
    ),
  );
});

test("public Tunnel launcher records its actual child and retires only its own health file", async (t) => {
  const directory = (await temporary(t)).directory,
    previous = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(directory, "state");
  let dashboard, child;
  t.after(async () => {
    child?.kill();
    await dashboard?.close();
    if (previous === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = previous;
  });
  const project = await identity(directory),
    reserve = http.createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  dashboard = await startDashboard({ project, port, tailscale: false });
  const runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json")),
  );
  await fs.copyFile(
    fileURLToPath(new URL("fixtures/tunnel-health.cjs", import.meta.url)),
    path.join(directory, "run"),
  );
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
  child = spawn(
    process.execPath,
    [
      cli,
      "tunnel",
      "--project",
      directory,
      "--tunnel-id",
      "tunnel_" + "a".repeat(32),
    ],
    {
      cwd: directory,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RDSH_TUNNEL_CLIENT: process.execPath,
        CONTROL_PLANE_API_KEY: "local-fixture-key-no-network",
      },
    },
  );
  let output = "",
    errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  void completion.catch(() => {});
  let report;
  const deadline = Date.now() + 12000;
  do {
    await delay(50);
    report = await (
      await fetch(dashboard.localUrl + "api/diagnostics", {
        headers: { authorization: `Bearer ${runtime.token}` },
      })
    ).json();
  } while (
    report.dot.tunnel.state !== "ready" &&
    child.exitCode === null &&
    Date.now() < deadline
  );
  assert.equal(report.dot.tunnel.state, "ready", errors);
  assert.equal(report.dot.authentication.state, "observed");
  assert.equal(report.dot.response.state, "unconfirmed");
  assert.equal(report.end_to_end.state, "unconfirmed");
  assert.equal(await completion, 0, errors);
  assert.ok(output.includes("FIXTURE_READY"));
  for (const secret of [
    runtime.token,
    runtime.mcp_token,
    "local-fixture-key-no-network",
  ])
    assert.ok(!(output + errors).includes(secret));
  const record = JSON.parse(
    await fs.readFile(path.join(project.directory, "tunnel-runtime.json")),
  );
  assert.ok((await inspectTunnel(project, runtime.instance_id)).ended_at);
  assert.notEqual(record.process.pid, child.pid);
  await assert.rejects(
    fs.stat(path.join(project.directory, record.health_file)),
    { code: "ENOENT" },
  );
  assert.equal(
    (await inspectTunnel(project, runtime.instance_id)).state,
    "stopped",
  );
});
