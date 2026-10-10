import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectStore } from "../state.mjs";
import { evaluateOperation } from "../policy.mjs";
import { checkContract } from "../contracts.mjs";
import { checkWorkerStart } from "../enforcement.mjs";

export async function policyFixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-policy-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repo"), outside = path.join(temp, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const src = path.join(root, "src");
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, "input.txt"), "fixture");
  const project = { id: "policy-test", name: "Policy test", root: await fs.realpath(root), directory: path.join(temp, "state") };
  const store = await ProjectStore.open(project);
  await store.mutate("task", { id: "T1", title: "Policy test", status: "todo" });
  const contract = {
    task_id: "T1", expected_version: 0, purpose: "Isolated policy checks",
    repository: project.root, allowed_scope: "src and selected command/origin",
    write_roots: [src], forbidden_actions: ["No publication"],
    completion_conditions: ["Tests pass"], change_reason: "Initial policy",
    operation_policy: {
      schema: 1, read_roots: [src],
      executables: [{ file: process.execPath, args: ["--version"] }],
      network_origins: ["https://fixture.example"],
    },
  };
  await store.mutate("contract", contract, "local_administrator");
  const operation = (tool, input) => ({
    task_id: "T1", contract_version: 1, repository: project.root,
    operation: { schema: "rdsh.operation.v1", tool_name: tool, tool_input: { cwd: project.root, ...input } },
  });
  return { temp, root: project.root, src, outside, project, store, contract, operation };
}

test("structured policy distinguishes file, cwd, arguments and origins without executing tools", async (t) => {
  const { store, operation, outside } = await policyFixture(t);
  const matrix = [
    [operation("file.read", { path: "src/input.txt" }), "within_policy", "structured_attributes_within_policy"],
    [operation("file.read", { path: "input.txt" }), "block", "read_outside_policy"],
    [operation("file.read", { path: "src/input.txt", cwd: outside }), "block", "cwd_outside_contract"],
    [operation("file.write", { path: "src/new.txt", content: "same text" }), "within_policy", "structured_attributes_within_policy"],
    [operation("file.write", { path: "new.txt", content: "same text" }), "block", "write_outside_contract"],
    [operation("process.exec", { executable: process.execPath, args: ["--version"] }), "within_policy", "structured_attributes_within_policy"],
    [operation("process.exec", { executable: process.execPath, args: ["--eval", "same text"] }), "block", "executable_or_arguments_outside_policy"],
    [operation("process.exec", { executable: path.join(store.value.project.root, "src", "input.txt"), args: ["--version"] }), "block", "executable_or_arguments_outside_policy"],
    [operation("network.request", { url: "https://fixture.example/path?token=dummy-secret", method: "POST", body: "dummy-secret" }), "within_policy", "structured_attributes_within_policy"],
    [operation("network.request", { url: "https://other.example/path", method: "POST", body: "dummy-secret" }), "block", "network_origin_outside_policy"],
    [operation("file.write", { path: "../outside/file", content: "same text" }), "unparsed", "unsupported_or_unresolved_operation"],
    [operation("unknown.tool", { command: "same text" }), "unparsed", "unsupported_or_unresolved_operation"],
    [operation("process.exec", { executable: process.execPath, args: ["--version"], env: { SECRET: "dummy-secret" } }), "unparsed", "unsupported_or_unresolved_operation"],
    [operation("process.exec", { executable: path.join(outside, process.platform === "win32" ? "pwsh.exe" : "bash"), args: ["-c", "same text"] }), "unparsed", "unsupported_or_unresolved_operation"],
  ];
  for (const [input, expected, reason] of matrix) {
    const result = await evaluateOperation(store.value, input);
    assert.equal(result.decision, expected, JSON.stringify(input));
    assert.equal(result.reason, reason);
    assert.equal(result.execution, "hold");
    assert.equal(result.layers.enforcement, "not_applied");
    assert.equal(result.layers.pattern, "not_evaluated");
    assert.ok(!JSON.stringify(result).includes("dummy-secret"));
  }
});

test("deleted saved roots and executables are blocked as policy changes instead of unparsed caller input", async (t) => {
  const { store, operation, project, src, contract } = await policyFixture(t);
  const executable = path.join(project.root, "fixture-executable");
  await fs.writeFile(executable, "not executed");
  await store.mutate("contract", { ...contract, expected_version: 1, write_roots: [project.root],
    operation_policy: { ...contract.operation_policy, executables: [{ file: executable, args: [] }] },
  }, "local_administrator");
  await fs.rm(src, { recursive: true, force: true });
  const read = await evaluateOperation(store.value, { ...operation("file.read", { path: "src/input.txt" }), contract_version: 2 });
  assert.equal(read.decision, "block");
  assert.equal(read.reason, "read_root_changed");
  const worker = { task_id: "T1", contract_version: 2, repository: project.root, run_id: "fixture-run", worker_role: "implementation" };
  assert.equal((await checkWorkerStart(store.value, worker)).reason, "read_root_changed");
  await fs.mkdir(src);
  await fs.rm(executable);
  assert.equal((await checkWorkerStart(store.value, worker)).reason, "executable_changed_or_unavailable");
  const exec = await evaluateOperation(store.value, {
    ...operation("process.exec", { executable, args: [] }), contract_version: 2,
  });
  assert.equal(exec.decision, "block");
  assert.equal(exec.reason, "executable_changed_or_unavailable");
  await fs.mkdir(executable);
  const replaced = await evaluateOperation(store.value, {
    ...operation("process.exec", { executable, args: [] }), contract_version: 2,
  });
  assert.equal(replaced.decision, "block");
  assert.equal(replaced.reason, "executable_changed_or_unavailable");
  await store.mutate("contract", { ...contract, expected_version: 2 }, "local_administrator");
  await fs.rmdir(src);
  const write = await checkContract(store.value, { task_id: "T1", contract_version: 3, repository: project.root,
    cwd: project.root, write_paths: [] });
  assert.equal(write.decision, "block");
  assert.equal(write.reason, "write_root_changed");
});

test("policy audit survives restart and contains no raw arguments, request body or URL query", async (t) => {
  const { store, operation, project } = await policyFixture(t);
  await store.mutate("policy", operation("network.request", {
    url: "https://fixture.example/path?token=dummy-secret", method: "POST", body: "dummy-secret",
  }));
  const result = store.value.policy_checks.at(-1);
  assert.equal(result.decision, "within_policy");
  assert.match(result.operation_digest, /^[a-f0-9]{64}$/);
  const disk = await fs.readFile(path.join(project.directory, "state.json"), "utf8");
  assert.ok(!disk.includes("dummy-secret"));
  assert.deepEqual((await ProjectStore.open(project)).value.policy_checks, store.value.policy_checks);
  assert.equal(store.value.changes.at(-1).data.summary, "操作構造を照合");
  await store.mutate("policy", null);
  assert.equal(store.value.policy_checks.at(-1).decision, "unparsed");
});

test("symlink and retargeted read roots fail structural policy", async (t) => {
  const { store, operation, src, outside } = await policyFixture(t);
  const link = path.join(src, "escape");
  await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await evaluateOperation(store.value, operation("file.read", { path: path.join(link, "input.txt") }))).decision, "block");
  await fs.unlink(link);
  await fs.unlink(path.join(src, "input.txt"));
  await fs.rmdir(src);
  await fs.symlink(outside, src, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await evaluateOperation(store.value, operation("file.read", { path: "src/input.txt" }))).decision, "block");
  await fs.unlink(src);
});
