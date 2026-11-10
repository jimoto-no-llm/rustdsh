import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { startDashboard } from "../server.mjs";

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-close-storage-"));
  const project = {
    id: "1234567890abcdef",
    name: "shutdown test",
    root,
    directory: path.join(root, "state"),
  };
  const dashboard = await startDashboard({ project, port: 0, tailscale: false, ...options });
  t.after(async () => {
    await dashboard.close().catch(() => {});
    dashboard.server.closeAllConnections();
    await new Promise((resolve) => dashboard.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { dashboard, project };
}

test("storage failure still closes workers, sockets, and the owned server lock", async (t) => {
  let workerCloses = 0;
  const { dashboard, project } = await fixture(t, {
    instructionQueueWorker: {
      async close() {
        workerCloses++;
        throw new Error("worker cleanup failed");
      },
    },
  });
  const socket = net.connect(dashboard.port, "127.0.0.1");
  t.after(() => socket.destroy());
  await once(socket, "connect");
  const disconnected = once(socket, "close");
  const failure = Object.assign(new Error("device state disk full"), { code: "ENOSPC" });
  const rename = fs.rename;
  const injected = t.mock.method(fs, "rename", async (source, target) => {
    if (target === path.join(project.directory, "devices.json")) throw failure;
    return rename(source, target);
  });

  const closing = dashboard.close();
  assert.strictEqual(dashboard.close(), closing);
  await assert.rejects(closing, (error) => error === failure);
  assert.equal(workerCloses, 1);
  assert.equal(dashboard.server.listening, false);
  await disconnected;
  await assert.rejects(fs.stat(path.join(project.directory, "server.lock")), { code: "ENOENT" });

  injected.mock.restore();
  const restarted = await startDashboard({ project, port: dashboard.port, tailscale: false });
  await restarted.close();
});

test("shutdown retains its lock until an already queued mutation finishes", async (t) => {
  const { dashboard, project } = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const mutate = dashboard.store.mutate.bind(dashboard.store);
  t.mock.method(dashboard.store, "mutate", async (...args) => {
    entered.resolve();
    await release.promise;
    return mutate(...args);
  });
  const pending = dashboard.mutate("task", { id: "T1", title: "pending", status: "todo" });
  await entered.promise;
  let completed = false;
  const closing = dashboard.close().then(() => { completed = true; });
  try {
    await new Promise(setImmediate);
    assert.equal(completed, false);
    assert.equal((await fs.stat(path.join(project.directory, "server.lock"))).isFile(), true);
  } finally {
    release.resolve();
    await Promise.all([pending, closing]);
  }
  const state = JSON.parse(await fs.readFile(path.join(project.directory, "state.json"), "utf8"));
  assert.equal(state.tasks[0].title, "pending");
  assert.equal(dashboard.server.listening, false);
  await assert.rejects(fs.stat(path.join(project.directory, "server.lock")), { code: "ENOENT" });
});
