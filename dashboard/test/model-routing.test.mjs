import { requiresOwnershipBackend } from "./ownership-support.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { identity } from "../state.mjs";
import { SessionLedger, attachRecordedSession } from "../session-ledger.mjs";
import { createCliAdapter } from "../adapters.mjs";
import { ModelRouting } from "../model-routing.mjs";
import { Checkpoints } from "../checkpoints.mjs";
import {
  requestedSelection,
  nativeSelection,
  compareSelection,
} from "../model-selection.mjs";
const exec = promisify(execFile),
  fixture = fileURLToPath(new URL("./fixtures/acp-cli.mjs", import.meta.url)),
  cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const first = {
    provider: "fixture-provider",
    model: "model-A",
    effort: "high",
  },
  second = { ...first, model: "model-B" };
const error = (code) => (failure) => failure.code === code;
async function setup(t, mode = "route_normal") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-routing-test-")),
    cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|LANG|LC_ALL)$/i.test(
        key,
      ),
    ),
  );
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    DSH_HOME: path.join(root, "dsh"),
    RDSH_DASHBOARD_HOME: path.join(root, "dashboard"),
    GIT_CEILING_DIRECTORIES: root,
    RDSH_ADAPTER_FIXTURE_MODE: mode,
    RDSH_ADAPTER_FIXTURE_TRACE: path.join(root, "trace.jsonl"),
    PROVIDER_API_KEY: "fixture-routing-secret-not-for-state",
  });
  await exec("git", ["-C", cwd, "init", "-b", "routing-qa"], { env });
  await exec(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Routing Fixture",
      "-c",
      "user.email=routing@example.invalid",
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
  project.directory = path.join(
    env.RDSH_DASHBOARD_HOME,
    "projects",
    project.id,
  );
  const ledger = await SessionLedger.open(project),
    store = ModelRouting.open(project),
    command = [process.execPath, fixture],
    adapters = [];
  const attach = async (run_id) => {
    const attached = await attachRecordedSession({
      ledger,
      command,
      env,
      run_id: run_id ?? null,
      requestTimeout: 3000,
      stopTimeout: 500,
    });
    adapters.push(attached.adapter);
    return attached;
  };
  const trace = async () =>
    (await fs.readFile(env.RDSH_ADAPTER_FIXTURE_TRACE, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
  t.after(async () => {
    for (const adapter of adapters) await adapter.stop();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-routing-test-"));
    await fs.rm(root, { recursive: true });
  });
  return {
    root,
    cwd,
    project,
    env,
    ledger,
    store,
    command,
    adapters,
    attach,
    trace,
  };
}
test("existing DSH role priorities preserve explicit environment, saved role and parent inheritance without changing routing", () => {
  const parent = { ...first, effort: "low" },
    input = { role: "worker", parent },
    saved = { version: 1, routes: { worker: second } };
  assert.deepEqual(requestedSelection(input, {}, saved).selection, second);
  assert.deepEqual(
    requestedSelection(
      input,
      {
        OMDSH_WORKER_PROVIDER: "environment",
        OMDSH_WORKER_MODEL: "explicit-model",
        OMDSH_WORKER_EFFORT: "medium",
      },
      saved,
    ).selection,
    { provider: "environment", model: "explicit-model", effort: "medium" },
  );
  assert.deepEqual(
    requestedSelection(input, {}, { version: 1, routes: {} }).selection,
    parent,
  );
  const partial = requestedSelection(
    input,
    { OMDSH_WORKER_PROVIDER: "environment" },
    saved,
  );
  assert.deepEqual(partial.selection, parent);
  assert.equal(
    partial.provenance.warning,
    "partial_environment_suppressed_saved_route",
  );
  assert.equal(
    requestedSelection(input, { OMDSH_WORKER_EFFORT: "medium" }, saved)
      .selection.effort,
    "high",
  );
  assert.equal(
    requestedSelection(
      input,
      {},
      {
        version: 1,
        routes: { worker: { provider: first.provider, model: first.model } },
      },
    ).selection.effort,
    "low",
  );
  assert.equal(
    requestedSelection(
      input,
      {},
      {
        version: 1,
        routes: { worker: { provider: second.provider, model: second.model } },
      },
    ).provenance.effort_source,
    "provider_default_unverified",
  );
  for (const role of ["scout", "reviewer", "architect"])
    assert.deepEqual(
      requestedSelection({ role, parent }, {}, { version: 1, routes: {} })
        .selection,
      parent,
    );
  assert.deepEqual(
    requestedSelection(first, { OMDSH_WORKER_MODEL: "ignored" }, saved)
      .selection,
    first,
  );
});
test("unsupported and malformed config options retain unknown values and never copy peer titles or claim actual model execution", () => {
  const options = [
    {
      id: "model",
      type: "select",
      currentValue: JSON.stringify([first.provider, first.model]),
      options: [
        {
          group: "fixture",
          options: [
            {
              value: JSON.stringify([first.provider, first.model]),
              name: "peer-title-secret",
            },
          ],
        },
      ],
    },
    {
      id: "reasoning_effort",
      type: "select",
      currentValue: "high",
      options: [{ value: "high", name: "High" }],
    },
  ];
  const observation = nativeSelection(options, "acp_session_new", "0.2.0-rc.2");
  assert.equal(compareSelection(first, observation).matches, true);
  assert.equal(observation.actual_execution_verified, false);
  assert.doesNotMatch(JSON.stringify(observation), /peer-title-secret/);
  assert.equal(
    nativeSelection(options.slice(0, 1), "acp_session_new", "0.2.0-rc.2")
      .status,
    "unknown",
  );
  assert.equal(
    nativeSelection([], "acp_session_new", "0.2.0-rc.2").selection,
    null,
  );
  assert.equal(
    compareSelection({ ...first, effort: null }, observation).status,
    "unknown",
  );
  assert.equal(
    nativeSelection([options[0], options[0]], "acp_session_new", "0.2.0-rc.2")
      .status,
    "unknown",
  );
});
test("a declared run persists requested and native configuration separately and guards an actual prompt without storing its body", requiresOwnershipBackend, async (t) => {
  const f = await setup(t),
    attached = await f.attach();
  await f.store.bind(attached.record, requestedSelection(first));
  await assert.rejects(
    f.store.bind(attached.record, requestedSelection(second)),
    error("route_request_immutable"),
  );
  const result = await attached.adapter.send(
    attached.record.cli_session_id,
    "fixture prompt body not for routing history",
  );
  assert.equal(result.stop_reason, "end_turn");
  const view = await f.store.inspect(attached.record);
  assert.deepEqual(view.requested, first);
  assert.deepEqual(view.observation.selection, first);
  assert.equal(view.comparison.status, "matches_native_configuration");
  assert.equal(view.actual_model_execution_verified, false);
  assert.equal(view.observation_is_historical, true);
  const bytes = await fs.readFile(f.store.file(attached.record));
  await f.store.inspect(attached.record);
  assert.deepEqual(await fs.readFile(f.store.file(attached.record)), bytes);
  assert.doesNotMatch(
    bytes.toString(),
    /fixture prompt body|fixture-routing-secret/,
  );
  assert.equal(
    (await f.trace()).filter((item) => item.method === "session/prompt").length,
    1,
  );
});
test("mismatched, absent or malformed native routes block a tracked prompt before dispatch and never select another model", requiresOwnershipBackend, async (t) => {
  for (const mode of [
    "route_changed",
    "normal",
    "route_invalid",
    "route_no_effort",
  ]) {
    const f = await setup(t, mode),
      attached = await f.attach();
    await f.store.bind(attached.record, requestedSelection(first));
    const before = (await attached.history.read()).commands.size;
    await assert.rejects(
      attached.adapter.send(
        attached.record.cli_session_id,
        "should never dispatch",
      ),
      error(mode === "route_changed" ? "route_mismatch" : "route_unverified"),
    );
    assert.equal((await attached.history.read()).commands.size, before);
    const view = await f.store.inspect(attached.record);
    assert.equal(view.prompt_allowed_by_route_assertion, false);
    assert.equal(
      (await f.trace()).filter((item) =>
        ["session/prompt", "session/set_config_option"].includes(item.method),
      ).length,
      0,
    );
    assert.doesNotMatch(JSON.stringify(view), /fixture-peer-secret/);
    // Finish each owned fixture before opening the next one. Cleanup hooks still
    // cover failures, but must not leave several Windows stop sequences competing.
    const stopped = await attached.adapter.stop();
    assert.equal(stopped.confirmed, true);
    assert.equal(stopped.scope.status, "exit_confirmed");
    assert.equal(stopped.scope.resources_released, true);
  }
});
test("only an exact unexpired operator authorization accepts a changed native route and its history retains before, after and source", requiresOwnershipBackend, async (t) => {
  const f = await setup(t),
    original = await f.attach();
  await f.store.bind(original.record, requestedSelection(first));
  await f.store.observe(original.record, original.adapter);
  await original.adapter.stop();
  f.env.RDSH_ADAPTER_FIXTURE_MODE = "route_changed";
  const attached = await f.attach(original.record.run_id);
  await assert.rejects(
    attached.adapter.send(attached.record.cli_session_id, "blocked"),
    error("route_mismatch"),
  );
  const before = await f.store.inspect(attached.record),
    issued = Date.now();
  const auth = {
    authorization_id: "fixture-explicit-change",
    source: "explicit_operator_cli",
    run_id: before.run_id,
    session_id: before.session_id,
    context_hash: before.context_hash,
    from: first,
    to: second,
    request_revision: before.revision,
    issued_at: new Date(issued - 1000).toISOString(),
    expires_at: new Date(issued + 60000).toISOString(),
  };
  const bytes = await fs.readFile(f.store.file(attached.record));
  for (const bad of [
    { ...auth, session_id: "another-native-id" },
    { ...auth, context_hash: "0".repeat(64) },
    { ...auth, from: second },
    { ...auth, request_revision: auth.request_revision + 1 },
    { ...auth, expires_at: new Date(issued - 1).toISOString() },
  ])
    await assert.rejects(
      f.store.allowChange(attached.record, second, bad),
      error("route_authorization_scope_or_time_mismatch"),
    );
  assert.deepEqual(await fs.readFile(f.store.file(attached.record)), bytes);
  const allowed = await f.store.allowChange(attached.record, second, auth);
  assert.equal(allowed.native_route_changed, false);
  assert.equal(allowed.permission_expanded, false);
  await attached.adapter.send(
    attached.record.cli_session_id,
    "one explicitly scoped fixture request",
  );
  const after = await f.store.inspect(attached.record);
  assert.deepEqual(after.requested, first);
  assert.deepEqual(after.active_route, second);
  assert.deepEqual(after.observation.selection, second);
  assert.equal(
    after.active_authorization.authorization_id,
    auth.authorization_id,
  );
  assert.ok(
    after.events.some(
      (event) => event.observation?.selection?.model === first.model,
    ),
  );
  assert.ok(after.events.some((event) => event.type === "change_authorized"));
  t.mock.method(Date, "now", () => issued + 120000);
  await assert.rejects(
    attached.adapter.send(attached.record.cli_session_id, "expired"),
    error("route_authorization_expired"),
  );
  t.mock.restoreAll();
  assert.equal(
    (await f.trace()).filter((item) => item.method === "session/prompt").length,
    1,
  );
  assert.equal(
    (await f.trace()).filter(
      (item) => item.method === "session/set_config_option",
    ).length,
    0,
  );
});
test("the adapter repeats the assertion at its final send boundary after a native configuration update", requiresOwnershipBackend, async (t) => {
  const f = await setup(t, "route_drift"),
    adapter = createCliAdapter({
      command: f.command,
      cwd: f.cwd,
      env: f.env,
      requestTimeout: 3000,
      stopTimeout: 500,
    });
  f.adapters.push(adapter);
  const started = await adapter.start();
  adapter.requireRouting(started.session_id, first);
  await adapter.send(started.session_id, "first fixture request");
  assert.equal(adapter.routing(started.session_id).source, "acp_config_update");
  await assert.rejects(
    adapter.send(started.session_id, "must be blocked"),
    error("routing_mismatch"),
  );
  assert.equal(
    (await f.trace()).filter((item) => item.method === "session/prompt").length,
    1,
  );
});
test("corrupt route policies and surviving locks are preserved and block prompts instead of guessing an allowed route", requiresOwnershipBackend, async (t) => {
  const f = await setup(t),
    attached = await f.attach();
  await f.store.bind(attached.record, requestedSelection(first));
  const file = f.store.file(attached.record),
    original = await fs.readFile(file),
    damaged = JSON.parse(original);
  damaged.record_hash = "0".repeat(64);
  await fs.writeFile(file, JSON.stringify(damaged));
  const damagedBytes = await fs.readFile(file);
  await assert.rejects(
    attached.adapter.send(attached.record.cli_session_id, "blocked"),
    error("route_policy_checksum_mismatch"),
  );
  assert.deepEqual(await fs.readFile(file), damagedBytes);
  await fs.writeFile(file, original);
  await fs.unlink(file);
  await assert.rejects(
    attached.adapter.send(
      attached.record.cli_session_id,
      "lost policy must stay blocked",
    ),
    error("route_policy_missing"),
  );
  assert.ok(await fs.stat(file + ".required"));
  await fs.writeFile(file, original);
  await fs.writeFile(file + ".lock", "fixture-owned-elsewhere");
  assert.equal((await f.store.inspect(attached.record)).writer_lock, "present");
  await assert.rejects(
    attached.adapter.send(attached.record.cli_session_id, "also blocked"),
    error("route_policy_busy"),
  );
  assert.equal(
    await fs.readFile(file + ".lock", "utf8"),
    "fixture-owned-elsewhere",
  );
  assert.deepEqual(await fs.readFile(file), original);
  assert.equal(
    (await f.trace()).filter((item) => item.method === "session/prompt").length,
    0,
  );
});
test("separate public clients bind, probe and inspect a native configuration without sending a prompt or modifying DSH routing", requiresOwnershipBackend, async (t) => {
  const f = await setup(t),
    attached = await f.attach();
  await attached.adapter.stop();
  const request = path.join(f.root, "route.json");
  await fs.writeFile(request, JSON.stringify(first));
  const call = async (action, ...args) => {
    const started = performance.now();
    try {
      const { stdout } = await exec(
        process.execPath,
        [
          cli,
          "routing",
          action,
          "--project",
          f.cwd,
          "--run-id",
          attached.record.run_id,
          ...args,
        ],
        {
          env: f.env,
          // Keep the existing fixture deadline; diagnostics above show
          // whether a timeout occurred during a specific routing action.
          timeout: process.platform === "win32" ? 60000 : 20000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
      t.diagnostic(
        JSON.stringify({
          routing_phase: action,
          elapsed_ms: performance.now() - started,
          exit_code: 0,
        }),
      );
      return JSON.parse(stdout);
    } catch (error) {
      t.diagnostic(
        JSON.stringify({
          routing_phase: action,
          elapsed_ms: performance.now() - started,
          exit_code: error.code ?? null,
          signal: error.signal ?? null,
          killed: !!error.killed,
          stderr_bytes: Buffer.byteLength(error.stderr ?? ""),
        }),
      );
      throw error;
    }
  };
  await call("bind", "--route-file", request);
  const proof = await call(
    "probe",
    "--executable",
    process.execPath,
    "--entrypoint",
    fixture,
  );
  assert.equal(proof.comparison.matches, true);
  assert.equal(proof.model_prompts_sent, 0);
  assert.equal(proof.owned_root_stopped, true);
  const view = await call("inspect");
  assert.equal(view.observation_is_historical, true);
  assert.equal(view.actual_model_execution_verified, false);
  assert.equal(
    (await f.trace()).filter((item) =>
      ["session/prompt", "session/set_config_option"].includes(item.method),
    ).length,
    0,
  );
  await assert.rejects(
    exec(
      process.execPath,
      [
        cli,
        "session-ledger",
        "list",
        "--project",
        f.cwd,
        "--route-file",
        request,
      ],
      { env: f.env },
    ),
    (failure) => /Model route options require routing/.test(failure.stderr),
  );
});

test("a checkpoint cannot drop a declared model assertion while starting a new conversation with a summary", requiresOwnershipBackend, async (t) => {
  const f = await setup(t),
    attached = await f.attach();
  await f.store.bind(attached.record, requestedSelection(first));
  const checkpoints = await Checkpoints.open(f.project);
  const checkpoint = await checkpoints.record({
    run_id: attached.record.run_id,
    command: f.command,
    env: f.env,
  });
  await attached.adapter.stop();
  const plan = await checkpoints.inspect(checkpoint.checkpoint_id, {
    command: f.command,
    env: f.env,
  });
  assert.equal(plan.candidates.summary_start_new.available, false);
  assert.equal(
    plan.candidates.summary_start_new.new_run_requires_model_declaration,
    true,
  );
  const before = (await f.trace()).filter(
    (item) => item.method === "session/new",
  ).length;
  await assert.rejects(
    checkpoints.recover(checkpoint.checkpoint_id, {
      mode: "start_new",
      command: f.command,
      env: f.env,
      summary: "explicit fixture summary",
      accept_context_loss: true,
    }),
    error("recovery_mode_unavailable"),
  );
  assert.equal(
    (await f.trace()).filter((item) => item.method === "session/new").length,
    before,
  );
  assert.equal(
    (await f.trace()).filter((item) => item.method === "session/prompt").length,
    0,
  );
});

// The next two tests use a confirmed run record directly: they exercise the
// routing lock and policy file only, without an ACP session or owned scope.
const declaredRun = (f) => ({
  run_id: "run_" + randomUUID(),
  project_id: f.project.id,
  binding: "confirmed",
  cli: "dsh",
  cli_session_id: "fixture-routing-session",
  cwd: f.cwd,
  branch: "routing-qa",
  launch: null,
  scope: null,
});

test("a committed route change survives a lock cleanup failure without reporting the write as lost", async (t) => {
  const f = await setup(t),
    record = declaredRun(f),
    lock = f.store.file(record) + ".lock",
    originalUnlink = fs.unlink;
  let failure;
  t.mock.method(fs, "unlink", async (file, ...args) => {
    if (path.resolve(String(file)) === path.resolve(lock)) {
      const error = new Error("fixture lock cleanup failure");
      error.code = "EACCES";
      throw error;
    }
    return originalUnlink(file, ...args);
  });

  await assert.rejects(
    f.store.bind(record, requestedSelection(first)),
    (error) => {
      failure = error;
      return error.code === "route_lock_cleanup_unconfirmed";
    },
  );
  assert.equal(failure.committed, true);
  assert.equal(failure.lock_cleanup_unconfirmed, true);
  const view = await f.store.inspect(record);
  assert.equal(view.route_required, true);
  assert.deepEqual(view.requested, first);
  assert.equal(view.writer_lock, "present");
  assert.deepEqual(
    failure.event_ids,
    view.events.map((event) => event.event_id),
  );
  await assert.rejects(
    f.store.bind(record, requestedSelection(first)),
    error("route_policy_busy"),
  );
});

// The assertion above runs on the first mutation, where prior is null and the
// whole event list is the delta. This one mutates an existing policy, which is
// where reading the pre-mutation event count too late used to yield an empty
// event_ids for a write that really did add an event.
test("a committed route change onto an existing policy reports only the events it added", async (t) => {
  const f = await setup(t),
    record = declaredRun(f),
    lock = f.store.file(record) + ".lock",
    originalUnlink = fs.unlink;
  await f.store.bind(record, requestedSelection(first));
  const before = (await f.store.inspect(record)).events.map(
    (event) => event.event_id,
  );
  let failure;
  t.mock.method(fs, "unlink", async (file, ...args) => {
    if (path.resolve(String(file)) === path.resolve(lock)) {
      const error = new Error("fixture lock cleanup failure");
      error.code = "EACCES";
      throw error;
    }
    return originalUnlink(file, ...args);
  });

  await assert.rejects(
    f.store.mutate(record, (value) => {
      f.store.event(value, "native_selection_observed", {
        status: "observed",
        selection: first,
        reason: null,
        source: "acp_config_update",
        cli_version: null,
        observed_at: new Date().toISOString(),
        actual_execution_verified: false,
      });
      value.revision++;
      return { value, result: null };
    }),
    (error) => {
      failure = error;
      return error.code === "route_lock_cleanup_unconfirmed";
    },
  );
  const after = (await f.store.inspect(record)).events.map(
    (event) => event.event_id,
  );
  assert.ok(
    after.length > before.length,
    "the mutation under test did not add an event",
  );
  assert.equal(failure.committed, true);
  assert.equal(failure.lock_cleanup_unconfirmed, true);
  assert.deepEqual(failure.event_ids, after.slice(before.length));
  assert.ok(
    failure.event_ids.length > 0,
    "a committed addition was reported with no event_ids",
  );
});

test("a route mutation failure keeps its own code when the lock cleanup also fails", async (t) => {
  const f = await setup(t),
    record = declaredRun(f),
    lock = f.store.file(record) + ".lock",
    originalUnlink = fs.unlink;
  await f.store.bind(record, requestedSelection(first));
  const committed = await fs.readFile(f.store.file(record));
  let failure;
  t.mock.method(fs, "unlink", async (file, ...args) => {
    if (path.resolve(String(file)) === path.resolve(lock)) {
      const error = new Error("fixture lock cleanup failure");
      error.code = "EACCES";
      throw error;
    }
    return originalUnlink(file, ...args);
  });

  await assert.rejects(
    f.store.bind(record, requestedSelection(second)),
    (error) => {
      failure = error;
      return error.code === "route_request_immutable";
    },
  );
  assert.equal(failure.committed, false);
  assert.equal(failure.lock_cleanup_unconfirmed, true);
  assert.deepEqual(failure.event_ids, []);
  assert.deepEqual(await fs.readFile(f.store.file(record)), committed);
  assert.equal((await f.store.inspect(record)).writer_lock, "present");
});
