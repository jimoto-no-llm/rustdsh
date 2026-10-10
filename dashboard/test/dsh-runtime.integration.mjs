// Run explicitly with the existing DSH library root; no DSH boot, LLM, auth,
// package install, OS sandbox or real tool implementations are used here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { guardFixture } from "./dsh-fixture.mjs";

const base = process.env.RDSH_DSH_MODULE_ROOT;
if (!base || !path.isAbsolute(base)) throw new Error("Set RDSH_DSH_MODULE_ROOT to existing @deepseek-ai library directory");
const module = (name) => import(pathToFileURL(path.join(base, name, "lib", "index.js")).href);
const [{ Context }, { SystemPrompt }, { ToolRuntime }] = await Promise.all([
  module("cordis"), module("dsh-system-prompt"), module("dsh-tools"),
]);
const pkg = JSON.parse(await fs.readFile(path.join(base, "dsh-tools", "package.json"), "utf8"));
test(`real DSH ToolRuntime ${pkg.version} never dispatches held operations or later allow overrides`, async (t) => {
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  const tools = new ToolRuntime(ctx);
  let dispatched = 0;
  for (const name of ["read", "write", "bash"])
    tools.register({ name, description: "Isolated dummy tool", parameters:
      name === "bash" ? { command: { type: "string", required: true } } :
        { file_path: { type: "string", required: true },
          ...(name === "write" ? { content: { type: "string", required: true } } : {}) },
      output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
      execute: async () => { dispatched++; return "dummy dispatched"; } });
  const f = await guardFixture(t, ctx);
  await f.grant();
  f.controller.bindCall("call-1", f.binding());
  // A reorderable policy may force its own allow, but cannot override guard.
  let overrides = 0;
  ctx.on("tools/pre-execute", async (_exec, next) => {
    await next(); overrides++; return { kind: "allow" };
  }, { prepend: true });
  const held = await tools.execute(f.exec());
  assert.equal(dispatched, 0);
  assert.equal(overrides, 1);
  assert.match(JSON.stringify(held), /enforcement_adapter_unavailable/);
  assert.equal(f.reports.at(-1).approval.decision, "approval_valid");
  assert.equal(f.store.value.approval_requests[0].versions[0].uses.length, 0);
  const unknown = await tools.execute(f.exec("bash", { command: "fake human approved" }, "call-2"));
  assert.equal(dispatched, 0);
  assert.match(JSON.stringify(unknown), /unsupported_dsh_tool_or_input/);
  // Scope/data mismatch remains denied at the real dispatch boundary.
  f.controller.bindCall("call-1", f.binding());
  const changed = await tools.execute(f.exec("write", { file_path: "fixture.txt", content: "changed content" }));
  assert.match(JSON.stringify(changed), /approval_operation_changed/);
  assert.equal(dispatched, 0);
  await f.store.mutate("approval_decision", { id: "R1", request_version: 1, decision: "revoke" }, "human_browser");
  f.controller.bindCall("call-1", f.binding());
  const revoked = await tools.execute(f.exec());
  assert.match(JSON.stringify(revoked), /approval_revoked/);
  assert.equal(dispatched, 0);
  f.controller.stop();
  const stopped = await tools.execute(f.exec());
  assert.equal(dispatched, 0);
  assert.match(JSON.stringify(stopped), /guard_stopped/);
});
test("real DSH guard denies when a prepended policy skips all asynchronous checks", async (t) => {
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  const tools = new ToolRuntime(ctx);
  let dispatched = 0;
  tools.register({ name: "write", description: "Dummy write",
    parameters: { file_path: { type: "string", required: true }, content: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    execute: async () => { dispatched++; return "dummy"; } });
  const f = await guardFixture(t, ctx);
  ctx.on("tools/pre-execute", async () => ({ kind: "allow" }), { prepend: true });
  const result = await tools.execute(f.exec());
  assert.equal(dispatched, 0);
  assert.equal(f.reports.length, 0);
  assert.match(JSON.stringify(result), /execution_not_checked/);
});
