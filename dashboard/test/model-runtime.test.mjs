import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { identity, ProjectStore } from "../state.mjs";
import { SessionLedger } from "../session-ledger.mjs";
import { ModelRouting } from "../model-routing.mjs";
import { requestedSelection } from "../model-selection.mjs";
import { nativeModelBoundary } from "../model-runtime.mjs";
import { modelRoutingViews } from "../model-routing-view.mjs";
import { startDashboard } from "../server.mjs";
const selected = {
  provider: "fixture-provider",
  model: "model-A",
  effort: "high",
};
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-model-store-"));
  const project = await identity(root);
  project.directory = path.join(root, "state", project.id);
  const ledger = await SessionLedger.open(project);
  const pending = await ledger.record({ cwd: root });
  const record = await ledger.confirm(
    pending.run_id,
    "native-session",
    "0.2.0-rc.2",
  );
  const routing = ModelRouting.open(ledger.project);
  await routing.bind(record, requestedSelection(selected));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-model-store-"));
    await fs.rm(root, { recursive: true });
  });
  return { root, project: ledger.project, record, routing };
}
test("legacy configuration-only records are distinct, enforcement is durable and cannot be downgraded by an older marker", async (t) => {
  const f = await setup(t);
  assert.equal(
    (await f.routing.inspect(f.record)).native_dispatch_required,
    false,
  );
  await f.routing.enforceNative(f.record);
  await f.routing.enforceNative(f.record);
  const view = await f.routing.inspect(f.record);
  assert.equal(view.native_dispatch_required, true);
  assert.equal(
    view.events.filter((e) => e.type === "native_enforcement_required").length,
    1,
  );
  const file = f.routing.file(f.record) + ".required";
  const marker = JSON.parse(await fs.readFile(file));
  delete marker.native_dispatch_required;
  marker.schema = 1;
  await fs.writeFile(file, JSON.stringify(marker));
  await assert.rejects(
    f.routing.inspect(f.record),
    (e) => e.code === "native_requirement_unconfirmed",
  );
});
test("a caller changing mutable controls during admission is stopped and chunks of an unchanged call retain their identity", async (t) => {
  const f = await setup(t);
  await f.routing.enforceNative(f.record);
  const options = {
    provider: selected.provider,
    model: selected.model,
    reasoningEffort: "high",
    sessionId: "native-session",
  };
  const admit = f.routing.admitNativeCall.bind(f.routing);
  const racing = Object.create(f.routing);
  racing.admitNativeCall = async (...args) => {
    const result = await admit(...args);
    options.model = "model-B";
    return result;
  };
  let dispatched = 0;
  const chunks = [
    { type: "text-delta", text: "private-fixture-content" },
    { type: "finish", reason: { kind: "stop" } },
  ];
  const dispatch = async function* () {
    dispatched++;
    yield* chunks;
  };
  const collect = async (stream) => {
    const output = [];
    for await (const chunk of stream) output.push(chunk);
    return output;
  };
  await assert.rejects(
    collect(
      nativeModelBoundary(racing, f.record).stream(options, dispatch, {}),
    ),
    (e) => e.code === "RDSH_MODEL_GUARD_DENIED",
  );
  assert.equal(dispatched, 0);
  options.model = "model-A";
  const returned = await collect(
    nativeModelBoundary(f.routing, f.record).stream(options, dispatch, {}),
  );
  assert.equal(dispatched, 1);
  assert.equal(returned[0], chunks[0]);
  assert.equal(returned[1], chunks[1]);
  assert.doesNotMatch(
    JSON.stringify(await f.routing.inspect(f.record)),
    /private-fixture-content/,
  );
});
test("a lost outcome stays pending and a surviving writer lock prevents any new native dispatch", async (t) => {
  const f = await setup(t);
  await f.routing.enforceNative(f.record);
  const receipt = await f.routing.admitNativeCall(f.record, {
    selection: selected,
    session_matched: true,
    effort_resolved: true,
  });
  assert.equal(receipt.allowed, true);
  await fs.writeFile(f.routing.file(f.record) + ".lock", "another-writer");
  let dispatched = false;
  const stream = nativeModelBoundary(f.routing, f.record).stream(
    {
      provider: selected.provider,
      model: selected.model,
      reasoningEffort: "high",
      sessionId: "native-session",
    },
    async function* () {
      dispatched = true;
    },
    {},
  );
  await assert.rejects(
    async () => {
      for await (const chunk of stream) assert.fail(chunk);
    },
    (e) => e.code === "RDSH_MODEL_GUARD_AUDIT_FAILED",
  );
  assert.equal(dispatched, false);
  assert.equal(
    (await f.routing.inspect(f.record)).native_calls.at(-1).outcome,
    "pending",
  );
  assert.equal(
    await fs.readFile(f.routing.file(f.record) + ".lock", "utf8"),
    "another-writer",
  );
});

test("permission expiring while admission is persisted blocks before the adapter factory and records the actual reason", async (t) => {
  const f = await setup(t);
  await f.routing.enforceNative(f.record);
  const current = await f.routing.inspect(f.record);
  const target = { ...selected, model: "model-B" };
  await f.routing.allowChange(f.record, target, {
    authorization_id: "short-lived-change",
    source: "explicit_operator_cli",
    run_id: f.record.run_id,
    session_id: f.record.cli_session_id,
    context_hash: current.context_hash,
    request_revision: current.revision,
    from: selected,
    to: target,
    issued_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 2000).toISOString(),
  });
  const delayed = Object.create(f.routing);
  delayed.admitNativeCall = async (...args) => {
    const receipt = await f.routing.admitNativeCall(...args);
    assert.equal(receipt.allowed, true);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, Date.parse(receipt.authorization_expires_at) - Date.now()) +
          25,
      ),
    );
    return receipt;
  };
  let entered = false;
  await assert.rejects(
    async () => {
      for await (const chunk of nativeModelBoundary(delayed, f.record).stream(
        {
          provider: target.provider,
          model: target.model,
          reasoningEffort: target.effort,
          sessionId: f.record.cli_session_id,
        },
        () => {
          entered = true;
          assert.fail("expired permission entered the adapter factory");
        },
        {},
      ))
        assert.fail(chunk);
    },
    (error) => error.code === "RDSH_MODEL_GUARD_DENIED",
  );
  assert.equal(entered, false);
  const last = (await f.routing.inspect(f.record)).native_calls.at(-1);
  assert.equal(last.dispatch_started, false);
  assert.equal(last.outcome, "blocked");
  assert.equal(last.reason, "route_authorization_expired");
});
test("the human HTTP view rejects unauthenticated and MCP producers, publishes no paths, and cannot authorize a route change", async (t) => {
  const f = await setup(t);
  await ProjectStore.open(f.project);
  const server = await startDashboard({
    project: f.project,
    port: 0,
    tailscale: false,
  });
  t.after(() => server.close());
  const runtime = JSON.parse(
    await fs.readFile(path.join(f.project.directory, "runtime.json")),
  );
  const endpoint = server.localUrl + "api/model-routing";
  for (const headers of [{}, { authorization: `Bearer ${runtime.mcp_token}` }])
    assert.equal((await fetch(endpoint, { headers })).status, 401);
  const headers = {
    "x-rdsh-browser-token": new URL(runtime.browser_url).hash.slice(5),
  };
  const response = await fetch(endpoint, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.runs[0].requested, selected);
  assert.equal(body.runs[0].actual_model_execution_verified, false);
  assert.ok(!JSON.stringify(body).includes(f.root));
  assert.equal(
    (await fetch(endpoint, { method: "POST", headers })).status,
    404,
  );
  const changes = [
    { ...selected, model: "model-B" },
    { ...selected, model: "model-C" },
  ];
  for (const [index, target] of changes.entries()) {
    const current = await f.routing.inspect(f.record);
    await f.routing.allowChange(f.record, target, {
      authorization_id: `human-change-${index}`,
      source: "explicit_operator_cli",
      run_id: f.record.run_id,
      session_id: f.record.cli_session_id,
      context_hash: current.context_hash,
      request_revision: current.revision,
      from: current.active_route,
      to: target,
      issued_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
  }
  const changed = (await (await fetch(endpoint, { headers })).json()).runs[0];
  assert.deepEqual(changed.requested, selected);
  assert.deepEqual(changed.active_route, changes[1]);
  assert.deepEqual(
    changed.change_history.map(({ from, to, source }) => ({
      from,
      to,
      source,
    })),
    [
      { from: selected, to: changes[0], source: "explicit_operator_cli" },
      { from: changes[0], to: changes[1], source: "explicit_operator_cli" },
    ],
  );
  assert.ok(changed.change_history.every((change) => change.applied_at));
  assert.ok(!JSON.stringify(changed).includes(f.root));
  assert.deepEqual((await modelRoutingViews(f.project))[0].requested, selected);
});
