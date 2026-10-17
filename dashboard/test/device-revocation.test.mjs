import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeviceRegistry } from "../devices.mjs";

test("revocation retry persists after a failed write", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-revoke-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "devices.json");
  const registry = await DeviceRegistry.open(file);
  const issued = await registry.create({ name: "test device" });
  await fs.rename(file, file + ".saved");
  await fs.mkdir(file);

  await assert.rejects(registry.revoke(issued.device.id));
  assert.equal(registry.authenticate(issued.credential), null);
  await fs.rmdir(file);
  await fs.rename(file + ".saved", file);
  const revoked = await registry.revoke(issued.device.id);
  const reopened = await DeviceRegistry.open(file);
  const identity = reopened.authenticate(issued.credential);
  await reopened.flush();

  assert.equal(revoked.status, "revoked");
  assert.equal(identity, null);
  assert.equal(reopened.list()[0].revoked_at, revoked.revoked_at);
});

test("concurrent revocations wait for persistence", { timeout: 5000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-revoke-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "devices.json");
  const registry = await DeviceRegistry.open(file);
  const issued = await registry.create({ name: "test device" });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (...args) => {
    if (args[1] === file) {
      entered.resolve();
      await release.promise;
    }
    return rename(...args);
  });

  const first = registry.revoke(issued.device.id);
  await entered.promise;
  let completed = false;
  const second = registry.revoke(issued.device.id).then((value) => {
    completed = true;
    return value;
  });
  try {
    await new Promise(setImmediate);
    assert.equal(completed, false);
  } finally {
    release.resolve();
    await Promise.all([first, second]);
  }
  const reopened = await DeviceRegistry.open(file);
  assert.equal(reopened.authenticate(issued.credential), null);
});
