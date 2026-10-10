import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { ObservedCliStore } from "../observed-cli.mjs";
import { identity } from "../state.mjs";
import { startDashboard } from "../server.mjs";
import { observedCliStatus } from "../observed-cli.mjs";

const originalIdentity = {
  platform: process.platform === "win32" ? "win32" : "linux",
  pid: 42424,
  birth: "123456",
  scope: "a".repeat(64),
};

test("observed CLI status rejects PID reuse, owner changes, and uncertain identity", () => {
  const record = {
    identity: originalIdentity,
    owner_fingerprint: "b".repeat(64),
  };
  const same = {
    status: "observed",
    identity: { ...originalIdentity },
    owner_fingerprint: "b".repeat(64),
  };
  assert.equal(observedCliStatus(record, same), "alive");
  assert.equal(
    observedCliStatus(record, {
      ...same,
      identity: { ...originalIdentity, birth: "123457" },
    }),
    "pid_reused",
  );
  assert.equal(
    observedCliStatus(record, { ...same, owner_fingerprint: "c".repeat(64) }),
    "owner_mismatch",
  );
  assert.equal(
    observedCliStatus(record, {
      status: "gone",
      platform: originalIdentity.platform,
      scope: originalIdentity.scope,
    }),
    "gone",
  );
  assert.equal(observedCliStatus(record, { status: "unknown" }), "unknown");
  assert.equal(
    observedCliStatus(record, { ...same, owner_fingerprint: undefined }),
    "unknown",
  );
});

test("project-wide registrations persist without task metadata or exposing identity fingerprints", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-observed-cli-store-test-"),
  );
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("rdsh-observed-cli-store-test-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const project = { id: "project-fixture", directory };
  const observation = {
    status: "observed",
    identity: { ...originalIdentity },
    owner_fingerprint: "d".repeat(64),
  };
  const store = await ObservedCliStore.open(project, {
    observe: async () => observation,
  });
  const record = await store.register(
    { pid: originalIdentity.pid, cli_kind: "dsh" },
    { tasks: [] },
  );
  assert.equal(record.task_id, null);

  const reopened = await ObservedCliStore.open(project, {
    observe: async () => observation,
  });
  const listed = await reopened.inspect({ tasks: [] });
  assert.equal(listed.processes.length, 1);
  assert.equal(listed.processes[0].status, "alive");
  assert.equal(listed.processes[0].task_present, true);
  assert.equal(Object.hasOwn(listed.processes[0], "identity"), false);
  assert.equal(Object.hasOwn(listed.processes[0], "owner_fingerprint"), false);
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("owner-only read-only CLI registration persists, rechecks identity, and never stops the process", async (t) => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-observed-cli-test-"),
  );
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(temporary, "state");
  await fs.mkdir(path.join(temporary, "project"));
  const project = await identity(path.join(temporary, "project"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  let dashboard;

  t.after(async () => {
    await dashboard?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill();
      await ended;
    }
    if (previousHome === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = previousHome;
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("rdsh-observed-cli-test-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });

  async function start() {
    dashboard = await startDashboard({
      project,
      port: await freePort(),
      tailscale: false,
      observeExternalCli: async (pid) => ({
        status: "observed",
        identity: { ...originalIdentity, pid },
        owner_fingerprint: "e".repeat(64),
      }),
    });
    return dashboard;
  }
  function browserHeaders(instance) {
    const key = new URL(instance.browserUrl).hash.slice("#key=".length);
    return { "x-rdsh-browser-token": key };
  }

  let instance = await start();
  await instance.mutate("task", {
    id: "T1",
    title: "Manual CLI task",
    status: "doing",
  });
  const runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  assert.equal(
    (await fetch(instance.localUrl + "api/observed-cli")).status,
    401,
  );
  assert.equal(
    (
      await fetch(instance.localUrl + "api/observed-cli", {
        headers: { authorization: `Bearer ${runtime.token}` },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(instance.localUrl + "api/observed-cli", {
        headers: { authorization: `Bearer ${runtime.mcp_token}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(instance.localUrl + "observed-cli-ui.mjs", {
        headers: browserHeaders(instance),
      })
    ).status,
    200,
  );

  const registration = await fetch(instance.localUrl + "api/observed-cli", {
    method: "POST",
    headers: {
      ...browserHeaders(instance),
      "content-type": "application/json",
    },
    body: JSON.stringify({ pid: child.pid, cli_kind: "other", task_id: "T1" }),
  });
  assert.equal(registration.status, 201);
  const { process: record } = await registration.json();
  assert.equal(record.pid, child.pid);
  assert.equal(record.status, undefined);
  assert.equal(Object.hasOwn(record, "identity"), false);
  assert.equal(Object.hasOwn(record, "owner_fingerprint"), false);
  const registrationFile = path.join(project.directory, "observed-cli.json");
  const persisted = JSON.parse(await fs.readFile(registrationFile, "utf8"));
  assert.equal(persisted.processes[0].identity.birth.length > 0, true);
  assert.match(persisted.processes[0].owner_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(persisted.processes[0], "owner"), false);
  assert.equal(Object.hasOwn(persisted.processes[0], "uid"), false);
  assert.equal(Object.hasOwn(persisted.processes[0], "sid"), false);

  let status = await fetch(instance.localUrl + "api/observed-cli", {
    headers: browserHeaders(instance),
  });
  assert.equal(status.status, 200);
  let listed = await status.json();
  assert.equal(listed.processes[0].status, "alive");
  assert.equal(listed.processes[0].task_id, "T1");
  assert.equal(Object.hasOwn(listed.processes[0], "identity"), false);
  assert.equal(Object.hasOwn(listed.processes[0], "owner_fingerprint"), false);

  await instance.close();
  instance = await start();
  status = await fetch(instance.localUrl + "api/observed-cli", {
    headers: browserHeaders(instance),
  });
  listed = await status.json();
  assert.equal(listed.processes.length, 1);
  assert.equal(listed.processes[0].status, "alive");
  assert.equal(child.exitCode, null);

  const removed = await fetch(
    instance.localUrl + `api/observed-cli/${record.id}`,
    { method: "DELETE", headers: browserHeaders(instance) },
  );
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { removed: true, revision: 2 });
  assert.equal(child.exitCode, null);

  await instance.close();
  instance = await start();
  status = await fetch(instance.localUrl + "api/observed-cli", {
    headers: browserHeaders(instance),
  });
  assert.deepEqual((await status.json()).processes, []);
  assert.equal(child.exitCode, null);
});
