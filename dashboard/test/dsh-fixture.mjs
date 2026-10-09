import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectStore } from "../state.mjs";
import { attachDshGuard } from "../dsh-guard.mjs";

export async function guardFixture(t, ctx) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-dsh-guard-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repo");
  await fs.mkdir(root);
  const repository = await fs.realpath(root);
  const project = { id: "dsh-guard-test", name: "Guard fixture", root: repository,
    directory: path.join(temp, "state") };
  const store = await ProjectStore.open(project);
  await store.mutate("task", { id: "T1", title: "Protected fixture", status: "todo" });
  await store.mutate("contract", { task_id: "T1", expected_version: 0,
    purpose: "Guard actual tool dispatch", repository, allowed_scope: "Fixture directory",
    write_roots: [repository], forbidden_actions: ["No real tool execution"],
    completion_conditions: ["No dummy tool dispatched"], change_reason: "Initial scope",
    operation_policy: { schema: 1, read_roots: [repository], executables: [], network_origins: [] },
  }, "local_administrator");
  const task = { task_id: "T1", contract_version: 1, repository, run_id: "run-1", worker_role: "implementation" };
  const operation = { schema: "rdsh.operation.v1", tool_name: "file.write",
    tool_input: { cwd: repository, path: "fixture.txt", content: "dummy-sensitive-body" } };
  await store.mutate("approval_request", {
    id: "R1", expected_version: 0, task_id: task.task_id, contract_version: 1,
    repository, run_id: "run-1", command_id: "call-1", operation,
    limits: { max_cost_usd: 0, max_attempts: 1 },
    expires_at: new Date(Date.now() + 60000).toISOString(), source_ref: "fixture:request" });
  const reports = [];
  const controller = attachDshGuard(ctx, { task, readState: () => store.value,
    recordCheck: async (report) => {
      reports.push(report);
      await fs.writeFile(path.join(project.directory, "guard-checks.json"), JSON.stringify(reports));
    } });
  const grant = () => store.mutate("approval_decision", { id: "R1", request_version: 1, decision: "grant" }, "human_browser");
  const binding = (sources = []) => ({ approval: { id: "R1", request_version: 1, attempt: 1, cost_usd: 0 }, sources });
  const exec = (name = "write", args = { file_path: "fixture.txt", content: "dummy-sensitive-body" }, callId = "call-1") =>
    ({ name, arguments: args, callId, signal: new AbortController().signal });
  return { temp, repository, store, project, task, reports, controller, grant, binding, exec };
}
