import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectStore, publicState } from "../state.mjs";

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-state-integrity-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repo");
  await fs.mkdir(root);
  const project = {
    id: "integrity-test",
    name: "Integrity test",
    root: await fs.realpath(root),
    directory: path.join(temp, "state"),
  };
  const store = await ProjectStore.open(project);
  await store.mutate("task", { id: "T1", title: "before", status: "todo" });
  return { temp, project, store };
}

test("state edits and removed seals fail closed after the first signed write", async (t) => {
  const { project, store } = await fixture(t);
  const file = path.join(project.directory, "state.json");
  const disk = JSON.parse(await fs.readFile(file, "utf8"));
  assert.match(disk.state_auth.mac, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(publicState(store.value), "state_auth"), false);

  disk.tasks[0].title = "after "; // same byte length as the original
  await fs.writeFile(file, JSON.stringify(disk));
  await assert.rejects(ProjectStore.open(project), /integrity check failed/);

  delete disk.state_auth;
  await fs.writeFile(file, JSON.stringify(disk));
  await assert.rejects(ProjectStore.open(project), /integrity seal is missing/);
});

test("a missing integrity key cannot authenticate a previously signed state", async (t) => {
  const { project } = await fixture(t);
  await fs.rm(path.join(project.directory, "state-integrity.key"));
  await assert.rejects(ProjectStore.open(project), /integrity key is missing/);
});

test("legacy state migration retries after the signed-state rename fails", async (t) => {
  const { project } = await fixture(t);
  const stateFile = path.join(project.directory, "state.json");
  const legacy = JSON.parse(await fs.readFile(stateFile, "utf8"));
  delete legacy.state_auth;
  const legacyBytes = JSON.stringify(legacy);
  await fs.writeFile(stateFile, legacyBytes);
  await fs.rm(path.join(project.directory, "state-integrity.key"));
  await fs.rm(path.join(project.directory, "state-integrity.enabled"));

  const originalRename = fs.rename;
  const renameMock = t.mock.method(fs, "rename", async (source, target) => {
    if (path.resolve(String(target)) === path.resolve(stateFile)) {
      throw Object.assign(new Error("simulated disk full"), { code: "ENOSPC" });
    }
    return originalRename(source, target);
  });
  await assert.rejects(ProjectStore.open(project), (error) => {
    assert.equal(error.code, "ENOSPC");
    return true;
  });
  renameMock.mock.restore();

  assert.equal(await fs.readFile(stateFile, "utf8"), legacyBytes);
  await fs.access(path.join(project.directory, "state-integrity.key"));
  await fs.access(path.join(project.directory, "state-integrity.pending"));
  await assert.rejects(
    fs.access(path.join(project.directory, "state-integrity.enabled")),
    { code: "ENOENT" },
  );

  const recovered = await ProjectStore.open(project);
  assert.equal(recovered.value.tasks[0].title, "before");
  assert.match(recovered.value.state_auth.mac, /^[a-f0-9]{64}$/);
  await fs.access(path.join(project.directory, "state-integrity.enabled"));
  await assert.rejects(
    fs.access(path.join(project.directory, "state-integrity.pending")),
    { code: "ENOENT" },
  );
});

test("integrity key permissions are owner-only on POSIX", async (t) => {
  const { project } = await fixture(t);
  if (process.platform === "win32") {
    t.skip("Windows ACLs inherit from the local dashboard state directory");
    return;
  }
  const stat = await fs.stat(path.join(project.directory, "state-integrity.key"));
  assert.equal(stat.mode & 0o077, 0);
});
