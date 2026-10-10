import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { identity } from "../dashboard/state.mjs";
import {
  SessionLedger,
  attachRecordedSession,
} from "../dashboard/session-ledger.mjs";
import { ModelRouting } from "../dashboard/model-routing.mjs";
import { requestedSelection } from "../dashboard/model-selection.mjs";
import { prepareModelAttachment } from "../dashboard/model-runtime.mjs";
import {
  modelRuntimeHash,
  modelSourceHash,
  guardedModelSource,
} from "../dashboard/model-runtime-source.mjs";

if (!process.env.RDSH_TEST_LLM_PACKAGE)
  throw new Error(
    "Set RDSH_TEST_LLM_PACKAGE to the isolated native test dependency package.json",
  );
const exec = promisify(execFile);
const fixture = fileURLToPath(
  new URL("./fixtures/model-dispatch.mjs", import.meta.url),
);
const require = createRequire(path.resolve(process.env.RDSH_TEST_LLM_PACKAGE));
const nativeFile = require.resolve("@deepseek-ai/dsh-llm");
const nativeSource = await fs.readFile(nativeFile, "utf8");
assert.equal(modelSourceHash(nativeSource), modelRuntimeHash);
const first = {
  provider: "fixture-provider",
  model: "model-A",
  effort: "high",
};

async function setup(t, selection = first, entrypoint = fixture) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-model-native-"));
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|LANG|LC_ALL|RDSH_TEST_LLM_PACKAGE)$/i.test(
        key,
      ),
    ),
  );
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    DSH_HOME: path.join(root, "dsh"),
    RDSH_DASHBOARD_HOME: path.join(root, "dashboard"),
  });
  await exec("git", ["-C", cwd, "init", "-b", "model-qa"], { env });
  await exec(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Model QA",
      "-c",
      "user.email=model@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "Fixture",
    ],
    { env },
  );
  const project = await identity(cwd);
  project.directory = path.join(root, "dashboard", "projects", project.id);
  const ledger = await SessionLedger.open(project);
  const unconfirmed = await ledger.record({
    command: [process.execPath, entrypoint],
    cwd,
    env,
  });
  const record = await ledger.confirm(
    unconfirmed.run_id,
    "fixture-native-session",
    "0.2.0-rc.2",
  );
  const routing = ModelRouting.open(ledger.project);
  await routing.bind(record, requestedSelection(selection));
  await routing.enforceNative(record);
  const attachment = await prepareModelAttachment(ledger.project, record, env);
  t.after(async () => {
    await attachment.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-model-native-"));
    await fs.rm(root, { recursive: true });
    assert.equal(await fs.readFile(nativeFile, "utf8"), nativeSource);
  });
  const invoke = async (scenario, guarded = true) => {
    const task = exec(process.execPath, [fixture], {
      cwd,
      env: {
        ...(guarded ? attachment.env : env),
        RDSH_TEST_MODEL_SCENARIO: scenario,
      },
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    const pid = task.child.pid;
    const { stdout, stderr } = await task;
    assert.equal(stderr, "");
    if (guarded) await attachment.ready({ child: { pid }, stopped: false });
    return JSON.parse(stdout);
  };
  return { routing, record, invoke, attachment, root, ledger, env, cwd };
}
test("baseline native dispatch accepts a changed tuple; the scoped native boundary blocks it without touching installed source", async (t) => {
  const f = await setup(t);
  const before = await f.invoke("mismatch", false);
  assert.deepEqual(before.dispatches, [{ ...first, model: "model-B" }]);
  const after = await f.invoke("mismatch");
  assert.deepEqual(after.dispatches, []);
  assert.equal(after.error.code, "RDSH_MODEL_GUARD_DENIED");
  const view = await f.routing.inspect(f.record);
  assert.deepEqual(view.requested, first);
  assert.equal(view.native_calls.at(-1).reason, "native_route_mismatch");
});
test("actual native model defaults are resolved before admission and native chunks remain unchanged", async (t) => {
  const f = await setup(t);
  const result = await f.invoke("default-effort");
  assert.deepEqual(result.dispatches, [first]);
  assert.equal(result.error, null);
  assert.deepEqual(result.chunks, [
    { type: "text-delta" },
    { type: "finish", outcome: "stop" },
  ]);
  const view = await f.routing.inspect(f.record);
  assert.equal(view.native_calls.at(-1).outcome, "succeeded");
  assert.equal(view.native_calls.at(-1).dispatch_started, true);
  assert.equal(view.actual_model_execution_verified, false);
  assert.doesNotMatch(
    JSON.stringify(view),
    /fixture-input-not-for-history|fixture-output-not-for-history/,
  );
});
for (const [scenario, reason] of [
  ["provider", "native_route_mismatch"],
  ["effort", "native_route_mismatch"],
  ["late-mutation", "native_route_mismatch"],
  ["child", "native_session_mismatch"],
  ["unbound", "native_session_mismatch"],
  ["unknown-effort", "native_effort_unavailable"],
])
  test(`native ${scenario} is denied before entering the provider adapter`, async (t) => {
    const f = await setup(t);
    const result = await f.invoke(scenario);
    assert.deepEqual(result.dispatches, []);
    assert.equal(result.error.code, "RDSH_MODEL_GUARD_DENIED");
    assert.equal(
      (await f.routing.inspect(f.record)).native_calls.at(-1).reason,
      reason,
    );
  });
test("only a run/session/revision/from/to-bound permit allows fallback and retains the initial request", async (t) => {
  const f = await setup(t);
  const before = await f.routing.inspect(f.record);
  const target = { ...first, model: "model-B" };
  const authorization = {
    authorization_id: "operator-native-fallback",
    source: "explicit_operator_cli",
    run_id: f.record.run_id,
    session_id: f.record.cli_session_id,
    context_hash: before.context_hash,
    from: first,
    to: target,
    request_revision: before.revision,
    issued_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  await assert.rejects(
    f.routing.allowChange(f.record, target, {
      ...authorization,
      session_id: "other-session",
    }),
    (error) => error.code === "route_authorization_scope_or_time_mismatch",
  );
  await f.routing.allowChange(f.record, target, authorization);
  const result = await f.invoke("mismatch");
  assert.deepEqual(result.dispatches, [target]);
  const view = await f.routing.inspect(f.record);
  assert.deepEqual(view.requested, first);
  assert.deepEqual(view.active_route, target);
  assert.equal(
    view.native_calls.at(-1).authorization_id,
    authorization.authorization_id,
  );
  assert.deepEqual(
    view.events.find((event) => event.type === "change_authorized")
      .authorization,
    authorization,
  );
});
test("native unsupported effort never invokes another model or provider", async (t) => {
  const f = await setup(t);
  const result = await f.invoke("unsupported");
  assert.deepEqual(result.dispatches, []);
  assert.deepEqual(result.chunks, [{ type: "finish", outcome: "error" }]);
  assert.equal((await f.routing.inspect(f.record)).native_calls.length, 0);
});
test("a provider failure remains a failure and no automatic fallback is added", async (t) => {
  const f = await setup(t);
  const result = await f.invoke("provider-failure");
  assert.deepEqual(result.dispatches, [first]);
  assert.equal(result.chunks.at(-1).outcome, "error");
  assert.equal(
    (await f.routing.inspect(f.record)).native_calls.at(-1).outcome,
    "failed",
  );
});
test("source drift and ambiguous compiled boundaries are refused", () => {
  assert.throws(
    () => guardedModelSource(nativeSource + "\n"),
    /unaudited LLM runtime/,
  );
  assert.ok(
    guardedModelSource(nativeSource).includes(
      "rdsh.model-dispatch-boundary.v1",
    ),
  );
});
test("an expired fallback permit stops a later native request instead of reverting or choosing another route", async (t) => {
  const f = await setup(t);
  const view = await f.routing.inspect(f.record);
  const target = { ...first, model: "model-B" };
  const expires = Date.now() + 1000;
  await f.routing.allowChange(f.record, target, {
    authorization_id: "expiring-native-fallback",
    source: "explicit_operator_cli",
    run_id: f.record.run_id,
    session_id: f.record.cli_session_id,
    context_hash: view.context_hash,
    request_revision: view.revision,
    from: first,
    to: target,
    issued_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(expires).toISOString(),
  });
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, expires - Date.now()) + 20),
  );
  const result = await f.invoke("mismatch");
  assert.deepEqual(result.dispatches, []);
  const after = await f.routing.inspect(f.record);
  assert.equal(after.native_calls.at(-1).reason, "route_authorization_expired");
  assert.deepEqual(after.active_route, target);
});
test("tracked ACP resume loads the native guard in the owned process, then catches drift after a matching configuration", async (t) => {
  const entrypoint = fileURLToPath(
    new URL("./fixtures/model-native-acp.mjs", import.meta.url),
  );
  const f = await setup(t, first, entrypoint);
  const trace = path.join(f.root, "dispatch.json");
  const attached = await attachRecordedSession({
    ledger: f.ledger,
    run_id: f.record.run_id,
    command: [process.execPath, entrypoint],
    env: {
      ...f.env,
      RDSH_TEST_MODEL_SCENARIO: "mismatch",
      RDSH_TEST_DISPATCH_TRACE: trace,
    },
    requestTimeout: 5000,
    stopTimeout: 1500,
  });
  t.after(() => attached.adapter.stop());
  await assert.rejects(
    attached.adapter.send(f.record.cli_session_id, "fixture tracked prompt"),
  );
  assert.deepEqual(JSON.parse(await fs.readFile(trace, "utf8")), []);
  const view = await f.routing.inspect(f.record);
  assert.equal(view.comparison.matches, true);
  assert.equal(view.native_calls.at(-1).reason, "native_route_mismatch");
  await attached.adapter.stop();
  assert.equal(
    (await fs.readdir(f.ledger.project.directory)).filter((name) =>
      name.startsWith(".model-guard-"),
    ).length,
    1,
  );
});
