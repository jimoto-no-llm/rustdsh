import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import {
  startDashboard,
  acquireDashboardLock,
  removeDashboardLockIfOwned,
} from "../server.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function projectIn(root) {
  return {
    id: "1234567890abcdef",
    name: "lock race test",
    root,
    directory: path.join(root, "state"),
  };
}

test("concurrent stale-lock reclamation admits a single writer", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-lock-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = projectIn(root);
  await fs.mkdir(project.directory, { recursive: true });
  // Dead PID: INT_MAX never exists as a live process.
  await fs.writeFile(path.join(project.directory, "server.lock"), "2147483647");
  const results = await Promise.allSettled([
    startDashboard({ project, port: await freePort(), tailscale: false }),
    startDashboard({ project, port: await freePort(), tailscale: false }),
  ]);
  const winners = results.filter((r) => r.status === "fulfilled");
  const losers = results.filter((r) => r.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.match(String(losers[0].reason?.message ?? losers[0].reason), /already running/);
  // The loser's failure must not delete the winner's fresh lock.
  const lockFile = path.join(project.directory, "server.lock");
  assert((await fs.stat(lockFile)).isFile());
  t.after(() => winners[0].value.close());
  await winners[0].value.close();
  await assert.rejects(() => fs.stat(lockFile), (e) => e.code === "ENOENT");
});

test("lock acquisition serializes stale steals at the file level", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-lock-steal-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockFile = path.join(root, "server.lock");
  await fs.writeFile(lockFile, "2147483647");
  const a = `${process.pid}:${randomUUID()}`;
  const b = `${process.pid}:${randomUUID()}`;
  const results = await Promise.allSettled([
    acquireDashboardLock(lockFile, a),
    acquireDashboardLock(lockFile, b),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const current = await fs.readFile(lockFile, "utf8");
  assert(current === a || current === b);
  // Only the owner may remove the lock.
  const loser = current === a ? b : a;
  assert.equal(await removeDashboardLockIfOwned(lockFile, loser), false);
  assert((await fs.stat(lockFile)).isFile());
  assert.equal(await removeDashboardLockIfOwned(lockFile, current), true);
  await assert.rejects(() => fs.stat(lockFile), (e) => e.code === "ENOENT");
});
