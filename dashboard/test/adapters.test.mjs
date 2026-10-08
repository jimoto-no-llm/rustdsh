import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adapterCatalog, createCliAdapter, operations } from "../adapters.mjs";
import { smokeAdapter } from "../adapter-smoke.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const fixture = fileURLToPath(
  new URL("./fixtures/acp-cli.mjs", import.meta.url),
);
const run = promisify(execFile);
async function setup(t, mode = "normal", extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-adapter-"));
  const trace = path.join(root, "trace.jsonl");
  const adapter = createCliAdapter({
    command: [process.execPath, fixture],
    cwd: root,
    env: {
      ...process.env,
      RDSH_ADAPTER_FIXTURE_MODE: mode,
      RDSH_ADAPTER_FIXTURE_TRACE: trace,
    },
    requestTimeout: 1500,
    stopTimeout: 150,
    ...extra,
  });
  const events = [];
  adapter.on("event", (event) => events.push(event));
  t.after(async () => {
    await adapter.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    adapter,
    root,
    events,
    trace: async () =>
      (await fs.readFile(trace, "utf8")).trim().split("\n").map(JSON.parse),
  };
}
const error = (code) => (e) =>
  e.code === code && !e.message.includes("fixture-");

test("capability catalog names all six operations and does not claim unimplemented CLIs", async () => {
  for (const row of adapterCatalog()) {
    assert.deepEqual(Object.keys(row.operations), operations);
    if (row.id === "dsh")
      assert.deepEqual(row.verified_versions, ["0.2.0-rc.2"]);
    else {
      assert.deepEqual(row.verified_versions, []);
      const adapter = createCliAdapter({ cli: row.id });
      for (const op of operations)
        assert.equal(adapter.capabilities().operations[op].supported, false);
      await assert.rejects(adapter.start(), error("unsupported"));
      await assert.rejects(adapter.resume("session"), error("unsupported"));
      await assert.rejects(
        adapter.send("session", "text"),
        error("unsupported"),
      );
      await assert.rejects(adapter.interrupt("session"), error("unsupported"));
      assert.throws(() => adapter.usage("session"), error("unsupported"));
      await assert.rejects(adapter.stop(), error("unsupported"));
    }
  }
});

test("start/send/usage use versioned ACP requests and measurements instead of shell input", async (t) => {
  const { adapter, root, events, trace } = await setup(t);
  assert.equal(adapter.capabilities().health, "unverified");
  const start = await adapter.start();
  for (const op of operations)
    assert.equal(adapter.capabilities().operations[op].supported, true);
  assert.equal((await adapter.probe()).health, "compatible");
  assert.equal(start.session_id, "fixture-session");
  assert.equal(adapter.usage(start.session_id).status, "unavailable");
  assert.equal(
    (await adapter.send(start.session_id, 'literal $(echo nope) & " text'))
      .stop_reason,
    "end_turn",
  );
  const usage = adapter.usage(start.session_id);
  assert.equal(usage.status, "observed");
  assert.equal(usage.measurement.context_tokens, 135);
  assert.equal(usage.measurement.context_capacity, 8192);
  assert.equal(usage.measurement.billable_tokens, null);
  assert.equal(usage.measurement.cost, null);
  const wire = await trace();
  assert.deepEqual(
    wire.map((r) => r.method),
    ["initialize", "session/new", "session/prompt"],
  );
  assert.deepEqual(wire[1].params, {
    cwd: await fs.realpath(root),
    mcpServers: [],
  });
  assert.deepEqual(wire[2].params.prompt, [
    { type: "text", text: 'literal $(echo nope) & " text' },
  ]);
  assert(events.every((e) => e.provenance.trust === "untrusted_data"));
  assert.deepEqual(
    events.map((e) => e.sequence),
    events.map((_, i) => i + 1),
  );
  assert.equal((await adapter.stop()).confirmed, true);
  assert.equal(adapter.capabilities().operations.send.supported, false);
});

test("resume attaches the exact session and rejects failed attachment", async (t) => {
  const { adapter, trace } = await setup(t);
  await assert.rejects(adapter.resume("missing"), error("cli_error"));
  assert.throws(() => adapter.usage("missing"), error("session_not_attached"));
  const resumed = await adapter.resume("existing-session");
  assert.equal(resumed.session_id, "existing-session");
  await adapter.send("existing-session", "continue");
  const requests = await trace();
  const resumedRequests = requests.filter((r) => r.method === "session/resume");
  assert.deepEqual(
    resumedRequests.map((r) => r.params.sessionId),
    ["missing", "existing-session"],
  );
  await assert.rejects(
    adapter.resume("existing-session"),
    error("already_attached"),
  );
});

test("missing advertised resume is unsupported without writing a resume request", async (t) => {
  const { adapter, trace } = await setup(t, "missing_resume");
  await adapter.start();
  assert.equal(
    adapter.capabilities().operations.resume.reason,
    "not_advertised",
  );
  await assert.rejects(adapter.resume("existing"), error("unsupported"));
  assert(!(await trace()).some((r) => r.method === "session/resume"));
});

test("simultaneous prompts are refused and interrupt is a request until the cancelled result", async (t) => {
  const { adapter, events } = await setup(t, "busy");
  const { session_id: id } = await adapter.start();
  const turn = adapter.send(id, "wait");
  await assert.rejects(adapter.send(id, "duplicate"), error("busy"));
  assert.equal((await adapter.interrupt(id)).acknowledged, false);
  assert.equal((await turn).stop_reason, "cancelled");
  assert(events.some((e) => e.type === "interrupt_requested"));
  assert(
    events.some(
      (e) => e.type === "prompt_completed" && e.stop_reason === "cancelled",
    ),
  );
});

test("client-side permission and filesystem requests do not gain execution authority", async (t) => {
  for (const mode of ["permission", "filesystem"]) {
    const { adapter, trace } = await setup(t, mode);
    const { session_id: id } = await adapter.start();
    assert.equal((await adapter.send(id, "ask")).stop_reason, "cancelled");
    const response = (await trace()).find((r) => r.id === mode && !r.method);
    if (mode === "permission")
      assert.deepEqual(response.result, { outcome: { outcome: "cancelled" } });
    else assert.equal(response.error.code, -32601);
    await adapter.stop();
  }
});

test("unknown CLI version or malformed version disables capabilities before profile boot", async (t) => {
  for (const mode of ["new_version", "secret_version"]) {
    const { adapter, root } = await setup(t, mode);
    await assert.rejects(adapter.start(), error("unverified_version"));
    assert(
      operations.every(
        (op) => !adapter.capabilities().operations[op].supported,
      ),
    );
    await assert.rejects(fs.stat(path.join(root, "trace.jsonl")), {
      code: "ENOENT",
    });
    assert(
      !JSON.stringify(adapter.capabilities()).includes(
        "fixture-version-secret",
      ),
    );
  }
});

test("a changed executable version revokes capabilities on an already connected adapter", async (t) => {
  const { adapter } = await setup(t);
  const { session_id: id } = await adapter.start();
  adapter.env.RDSH_ADAPTER_FIXTURE_MODE = "new_version";
  assert.equal((await adapter.probe()).health, "unverified_version");
  assert(
    operations.every((op) => !adapter.capabilities().operations[op].supported),
  );
  await assert.rejects(adapter.send(id, "no fallback"), error("unsupported"));
  assert.equal((await adapter.stop()).confirmed, true);
});

test("invalid cwd and missing executable are distinct from compatible CLI", async (t) => {
  const a = await setup(t, "normal", {
    cwd: path.join(os.tmpdir(), "not-existing-rdsh-cwd-987654"),
  });
  assert.equal((await a.adapter.probe()).health, "invalid_cwd");
  const b = await setup(t, "normal", {
    command: [path.join(a.root, "missing-cli")],
  });
  assert.equal((await b.adapter.probe()).health, "cli_unavailable");
});

test("broken JSON, oversized frames, invalid UTF8, wrong protocol and invalid start fail closed", async (t) => {
  for (const mode of [
    "bad_json",
    "oversized",
    "invalid_utf8",
    "wrong_protocol",
    "bad_new",
  ]) {
    const { adapter } = await setup(t, mode);
    await assert.rejects(adapter.start(), error("protocol_mismatch"));
    assert.equal(adapter.capabilities().health, "incompatible");
    assert(
      operations.every(
        (op) => !adapter.capabilities().operations[op].supported,
      ),
    );
    assert.equal((await adapter.stop()).confirmed, true);
  }
});

test("invalid usage cannot become a zero or fabricated measurement", async (t) => {
  const { adapter } = await setup(t, "invalid_usage");
  const { session_id: id } = await adapter.start();
  await assert.rejects(adapter.send(id, "report"), error("protocol_mismatch"));
  assert.equal(adapter.capabilities().health, "incompatible");
  assert.throws(() => adapter.usage(id), error("unsupported"));
});

test("CLI errors retain no peer secret and missing methods disable the affected operation", async (t) => {
  for (const mode of ["cli_error", "unsupported_send"]) {
    const { adapter } = await setup(t, mode);
    const { session_id: id } = await adapter.start();
    await assert.rejects(adapter.send(id, "text"), error("cli_error"));
    assert.equal(
      adapter.capabilities().operations.send.supported,
      mode === "cli_error",
    );
  }
});

test("timeouts and early exit are failures, never successful starts", async (t) => {
  const a = await setup(t, "timeout", { requestTimeout: 200 });
  await assert.rejects(a.adapter.start(), (e) =>
    ["timeout_result_unknown", "protocol_mismatch"].includes(e.code),
  );
  assert.equal(a.adapter.capabilities().health, "incompatible");
  const b = await setup(t, "early_exit");
  await assert.rejects(b.adapter.start(), (e) =>
    ["connection_closed", "process_exited"].includes(e.code),
  );
});

test("duplicate session identifiers disable the adapter", async (t) => {
  const { adapter } = await setup(t);
  await adapter.start();
  await assert.rejects(adapter.start(), error("duplicate_session"));
  assert.equal(adapter.capabilities().health, "incompatible");
});

test("stop waits for the owned child to exit and escalates when EOF is ignored", async (t) => {
  const { adapter } = await setup(t, "ignore_eof");
  await adapter.start();
  const pid = adapter.child.pid;
  const stopped = await adapter.stop();
  assert.equal(stopped.confirmed, true);
  assert.throws(() => process.kill(pid, 0));
});

test("isolated smoke covers restart/resume and accurately marks unexercised model work", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-smoke-project-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await smokeAdapter({
    command: [process.execPath, fixture],
    cwd: root,
    requestTimeout: 1500,
    stopTimeout: 150,
  });
  assert.equal(result.status, "passed");
  assert.equal(result.checks.resume, "acknowledged");
  assert.equal(result.checks.send, "not_exercised_no_model_request");
  assert.equal(result.checks.stop, "exit_confirmed");
  assert.equal(result.checks.usage, "unavailable");
  assert.equal(result.authentication, "not_verified");
});

test("public CLI exposes catalog/probe/smoke and requires an explicit original executable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-adapter-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
  const catalog = JSON.parse(
    (await run(process.execPath, [cli, "adapters"])).stdout,
  );
  assert.equal(catalog.adapters.length, 4);
  await assert.rejects(
    run(process.execPath, [cli, "adapters", "--cli", "dsh"]),
    (e) => JSON.parse(e.stdout).health === "executable_required",
  );
  const args = [
    "--executable",
    process.execPath,
    "--entrypoint",
    fixture,
    "--project",
    root,
  ];
  const probed = JSON.parse(
    (await run(process.execPath, [cli, "adapters", "--cli", "dsh", ...args]))
      .stdout,
  );
  assert.equal(probed.health, "version_matched");
  assert.equal(probed.operations.start.status, "requires_protocol_check");
  const smoked = JSON.parse(
    (await run(process.execPath, [cli, "adapter-smoke", ...args])).stdout,
  );
  assert.equal(smoked.status, "passed");
  await assert.rejects(run(process.execPath, [cli, "adapter-smoke"]), (e) =>
    e.stderr.includes("Specify the original DSH executable"),
  );
});
