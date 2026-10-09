import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectStore } from "../state.mjs";
import { checkWorkerStart } from "../enforcement.mjs";
import { checkContract } from "../contracts.mjs";

test("unsupported workers show distinct requested permissions without starting or widening access", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-enforcement-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repo");
  await fs.mkdir(root);
  const beforeFile = path.join(root, "sentinel.txt");
  await fs.writeFile(beforeFile, "unchanged isolated fixture");
  const outsideFile = path.join(temp, "outside.txt");
  await fs.writeFile(outsideFile, "outside fixture");
  await fs.link(outsideFile, path.join(root, "hardlink-alias.txt"));
  const project = { id: "enforcement-test", root: await fs.realpath(root), name: "Fixture", directory: path.join(temp, "state") };
  const store = await ProjectStore.open(project);
  await store.mutate("task", { id: "T1", title: "Fixture", status: "todo" });
  await store.mutate("contract", { task_id: "T1", expected_version: 0, purpose: "Local test", repository: project.root,
    allowed_scope: "Only fixture", write_roots: [project.root], forbidden_actions: ["No execution"],
    completion_conditions: ["Test passes"], change_reason: "Initial scope",
    operation_policy: { schema: 1, read_roots: [project.root], executables: [{ file: beforeFile, args: [] }], network_origins: ["https://allowed.example"] },
  }, "local_administrator");
  const input = { task_id: "T1", contract_version: 1, repository: project.root, run_id: "fixture-run", worker_role: "review" };
  const beforeState = structuredClone(store.value);
  // A hardlink's canonical path does not reveal its external alias. Reproduce
  // that preflight limitation; the worker gate must still refuse to start.
  assert.equal((await checkContract(store.value, { task_id: "T1", contract_version: 1,
    repository: project.root, cwd: project.root, write_paths: ["hardlink-alias.txt"] })).decision, "within_scope");
  const review = await checkWorkerStart(store.value, input);
  assert.equal(review.decision, "hold");
  assert.equal(review.reason, "enforcement_adapter_unavailable");
  assert.deepEqual(review.requested_permissions.write_roots, []);
  assert.deepEqual(review.requested_permissions.executables, []);
  assert.deepEqual(review.requested_permissions.network_origins, []);
  const implementation = await checkWorkerStart(store.value, { ...input, worker_role: "implementation" });
  assert.deepEqual(implementation.requested_permissions.write_roots, [project.root]);
  assert.deepEqual(implementation.requested_permissions.network_origins, ["https://allowed.example"]);
  assert.ok(implementation.required_enforcement.includes("child_process_inheritance"));
  assert.ok(implementation.required_enforcement.includes("race_safe_access"));
  for (const request of [
    { ...input, capabilities: { filesystem_read: true, network: true, child_process_inheritance: true } },
    { ...input, sandbox: "verified", approval: "granted" },
    { ...input, write_roots: [temp] }, { ...input, worker_role: "admin" },
    { ...input, repository: temp }, { ...input, contract_version: 2 }, null,
  ]) {
    const checked = await checkWorkerStart(store.value, request);
    assert.ok(["unparsed", "block"].includes(checked.decision));
    assert.equal(checked.execution, "not_started");
    assert.equal(checked.effective_permissions, null);
    assert.equal(checked.fallback, "disabled");
  }
  assert.equal(implementation.execution, "not_started");
  assert.equal(implementation.effective_permissions, null);
  assert.equal(implementation.fallback, "disabled");
  assert.deepEqual(store.value, beforeState);
  assert.equal(await fs.readFile(beforeFile, "utf8"), "unchanged isolated fixture");
  assert.equal(await fs.readFile(outsideFile, "utf8"), "outside fixture");
});
