import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identity } from "../state.mjs";
import { SessionLedger, attachRecordedSession } from "../session-ledger.mjs";
import { Checkpoints } from "../checkpoints.mjs";
import { runWithRetry, RetryFailure, RetryHistory } from "../retry.mjs";

const exec = promisify(execFile);
const fixture = fileURLToPath(
  new URL("./fixtures/acp-cli.mjs", import.meta.url),
);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const error = (code) => (failure) => failure.code === code;
async function setup(t, { subdirectory = false } = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-checkpoint-test-"),
  );
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const cwd = subdirectory ? path.join(projectRoot, "worktree") : projectRoot;
  if (subdirectory) await fs.mkdir(cwd);
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
    RDSH_ADAPTER_FIXTURE_TRACE: path.join(root, "trace.jsonl"),
    PROVIDER_API_KEY: "fixture-key-not-for-checkpoint",
  });
  await exec("git", ["-C", projectRoot, "init", "-b", "checkpoint-qa"], {
    env,
    windowsHide: true,
  });
  const project = await identity(projectRoot);
  project.directory = path.join(
    env.RDSH_DASHBOARD_HOME,
    "projects",
    project.id,
  );
  const ledger = await SessionLedger.open(project),
    store = await Checkpoints.open(project),
    command = [process.execPath, fixture];
  const attached = await attachRecordedSession({ ledger, command, env, cwd });
  await attached.adapter.stop();
  const options = { command, env },
    record = async (extra = {}) =>
      store.record({ run_id: attached.record.run_id, ...options, ...extra });
  const trace = async () =>
    (await fs.readFile(env.RDSH_ADAPTER_FIXTURE_TRACE, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  t.after(async () => {
    await attached.adapter.stop();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-checkpoint-test-"));
    await fs.rm(root, { recursive: true });
  });
  return {
    root,
    project,
    projectRoot,
    cwd,
    env,
    ledger,
    store,
    attached,
    command,
    options,
    record,
    trace,
  };
}

test("checkpoints bind the native ID, branch, durable event and timestamp without copying conversation or credentials", async (t) => {
  const f = await setup(t),
    checkpoint = await f.record();
  assert.equal(checkpoint.cli_session_id, f.attached.record.cli_session_id);
  assert.equal(checkpoint.context.branch, "checkpoint-qa");
  assert.ok(checkpoint.journal.last_confirmed_event.event_id);
  assert.ok(checkpoint.saved_at);
  assert.equal(checkpoint.journal.unresolved_count, 0);
  const bytes = await fs.readFile(f.store.file(checkpoint.checkpoint_id)),
    before = await f.trace();
  const view = await f.store.inspect(checkpoint.checkpoint_id, f.options);
  assert.equal(view.candidates.formal_resume.available, false);
  assert.equal(view.native.status, "not_checked");
  assert.equal(view.candidates.summary_start_new.same_session, false);
  assert.equal(view.replayed_operations, 0);
  assert.equal(view.uncertainty_since_checkpoint.control_event_count, 0);
  assert.deepEqual(await f.trace(), before);
  assert.deepEqual(
    await fs.readFile(f.store.file(checkpoint.checkpoint_id)),
    bytes,
  );
  assert.doesNotMatch(
    bytes.toString(),
    /fixture-key|prompt|fixture-title-secret/,
  );
});

test("a fresh formal session-list observation enables a candidate without pretending a resume acknowledgement", async (t) => {
  const f = await setup(t),
    checkpoint = await f.record(),
    before = (await f.trace()).length;
  const view = await f.store.inspect(checkpoint.checkpoint_id, {
    ...f.options,
    verify_native: true,
  });
  assert.equal(view.native.status, "listed");
  assert.equal(view.native.resume_verified, false);
  assert.equal(view.candidates.formal_resume.available, true);
  const operations = (await f.trace()).slice(before).map((item) => item.method);
  assert.deepEqual(operations, ["initialize", "session/list"]);
  assert.doesNotMatch(JSON.stringify(view), /fixture-title-secret/);
});

test("formal checkpoint resume confirms the same native ID and repeated recovery never replays it", async (t) => {
  const f = await setup(t),
    checkpoint = await f.record();
  const result = await f.store.recover(checkpoint.checkpoint_id, {
    ...f.options,
    mode: "resume",
  });
  assert.equal(result.native_resume_verified, true);
  assert.equal(result.cli_session_id, checkpoint.cli_session_id);
  assert.equal(result.run_id, checkpoint.run_id);
  assert.equal(result.same_session, true);
  assert.equal(result.owned_root_exit_confirmed, true);
  assert.ok(
    (await f.store.inspect(checkpoint.checkpoint_id, f.options))
      .uncertainty_since_checkpoint.control_event_count > 0,
  );
  const trace = await f.trace(),
    bytes = await fs.readFile(
      f.store.file(checkpoint.checkpoint_id, ".recovery.json"),
    );
  const repeated = await (
    await Checkpoints.open(f.project)
  ).recover(checkpoint.checkpoint_id, { ...f.options, mode: "resume" });
  assert.equal(repeated.reused_recovery, true);
  assert.deepEqual(await f.trace(), trace);
  assert.deepEqual(
    await fs.readFile(f.store.file(checkpoint.checkpoint_id, ".recovery.json")),
    bytes,
  );
  assert.equal(
    trace.filter((item) => item.method === "session/resume").length,
    1,
  );
  assert.equal(
    trace.filter((item) => item.method === "session/prompt").length,
    0,
  );
});

test("missing and expired-session fixtures require a new-session choice, while unsupported or malformed native evidence is distinct", async (t) => {
  const f = await setup(t),
    checkpoint = await f.record();
  for (const mode of [
    "missing_session",
    "expired_session",
    "missing_resume",
    "missing_list",
    "list_cwd_mismatch",
    "list_error",
    "bad_list",
    "list_loop",
  ]) {
    const view = await f.store.inspect(checkpoint.checkpoint_id, {
      command: f.command,
      env: { ...f.env, RDSH_ADAPTER_FIXTURE_MODE: mode },
      verify_native: true,
    });
    assert.equal(view.candidates.formal_resume.available, false);
    if (["missing_session", "expired_session"].includes(mode)) {
      assert.equal(view.native.status, "not_listed");
      assert.equal(view.candidates.summary_start_new.available, true);
      assert.match(
        view.lost_context.at(-1),
        /deletion or expiry cannot be distinguished/,
      );
    }
    if (["list_error", "bad_list", "list_loop"].includes(mode))
      assert.equal(view.candidates.unavailable.selected, true);
  }
});

test("explicit context-loss choice creates a new native ID and sends the operator summary once with a checkpoint reference", async (t) => {
  const f = await setup(t),
    checkpoint = await f.record();
  const options = {
    command: f.command,
    env: { ...f.env, RDSH_ADAPTER_FIXTURE_MODE: "expired_session" },
    mode: "start_new",
    summary: "Fixture operator summary: fixture-summary-secret-do-not-store",
    accept_context_loss: true,
  };
  await assert.rejects(
    f.store.recover(checkpoint.checkpoint_id, {
      ...options,
      accept_context_loss: false,
    }),
    error("explicit_summary_and_context_loss_choice_required"),
  );
  const result = await f.store.recover(checkpoint.checkpoint_id, options);
  assert.notEqual(result.cli_session_id, checkpoint.cli_session_id);
  assert.notEqual(result.run_id, checkpoint.run_id);
  assert.equal(result.source_checkpoint, checkpoint.checkpoint_id);
  assert.equal(result.same_session, false);
  assert.equal(result.summary_status, "response_observed");
  assert.equal(result.summary_is_semantic_acceptance, false);
  const trace = await f.trace();
  assert.equal(
    trace.filter((item) => item.method === "session/prompt").length,
    1,
  );
  assert.equal(
    trace.find((item) => item.method === "session/prompt").params.prompt[0]
      .text,
    options.summary,
  );
  const history = await fs.readFile(f.attached.history.file, "utf8"),
    action = await fs.readFile(
      f.store.file(checkpoint.checkpoint_id, ".recovery.json"),
      "utf8",
    );
  assert.doesNotMatch(
    history + action + JSON.stringify(result),
    /fixture-summary-secret|fixture-key/,
  );
  await f.store.recover(checkpoint.checkpoint_id, options);
  assert.deepEqual(await f.trace(), trace);
});

test("worktree moves, changed branch and changed HEAD block recovery before native profile boot", async (t) => {
  const moved = await setup(t, { subdirectory: true }),
    checkpoint = await moved.record();
  await fs.rename(moved.cwd, path.join(moved.projectRoot, "relocated"));
  const before = await moved.trace();
  const missing = await moved.store.inspect(checkpoint.checkpoint_id, {
    ...moved.options,
    verify_native: true,
  });
  assert.ok(
    missing.candidates.unavailable.reasons.includes(
      "recorded_worktree_unavailable",
    ),
  );
  assert.deepEqual(await moved.trace(), before);
  for (const mutation of ["branch", "head"]) {
    const f = await setup(t),
      saved = await f.record(),
      original = await f.trace();
    if (mutation === "branch")
      await exec("git", ["-C", f.cwd, "switch", "-c", "changed-branch"], {
        env: f.env,
      });
    else
      await exec(
        "git",
        [
          "-C",
          f.cwd,
          "-c",
          "user.name=Checkpoint Fixture",
          "-c",
          "user.email=checkpoint@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--allow-empty",
          "-m",
          "Fixture head",
        ],
        { env: f.env },
      );
    const view = await f.store.inspect(saved.checkpoint_id, {
      ...f.options,
      verify_native: true,
    });
    assert.equal(view.candidates.unavailable.selected, true);
    assert.ok(
      view.candidates.unavailable.reasons.includes(
        mutation === "branch"
          ? "repository_context_changed"
          : "checkpoint_worktree_or_head_changed",
      ),
    );
    assert.deepEqual(await f.trace(), original);
  }
});

test("unconfirmed control commands block recovery and completed external effects are never replayed", async (t) => {
  const f = await setup(t);
  const id = await f.attached.history.recordCommand(
    f.attached.record.run_id,
    "send",
  );
  await f.attached.history.commandPhase(id, "dispatched");
  const checkpoint = await f.record(),
    original = await f.trace();
  const view = await f.store.inspect(checkpoint.checkpoint_id, {
    ...f.options,
    verify_native: true,
  });
  assert.equal(checkpoint.journal.unresolved_count, 1);
  assert.ok(
    view.candidates.unavailable.reasons.includes(
      "unconfirmed_control_operation",
    ),
  );
  await assert.rejects(
    f.store.recover(checkpoint.checkpoint_id, { ...f.options, mode: "resume" }),
    error("recovery_blocked"),
  );
  assert.deepEqual(await f.trace(), original);
});

test("referenced external outcomes must be known before resume, including an applied operation whose response was lost", async (t) => {
  for (const applied of [true, false]) {
    const f = await setup(t),
      retry = await RetryHistory.open(f.project),
      scope_digest = "a".repeat(64);
    let sends = 0;
    const report = await runWithRetry({
      history: retry,
      kind: "external_send",
      scope_digest,
      authorize: async () => ({ allowed: true, scope_digest }),
      execute: async () => {
        sends++;
        throw new RetryFailure("timeout");
      },
      reconcile: applied
        ? async ({ operation_id }) => ({
            operation_id,
            scope_digest,
            outcome: "applied",
            source: "authoritative_operation_status",
            evidence_id: "fixture-receipt",
            observed_at: new Date().toISOString(),
          })
        : null,
    });
    const checkpoint = await f.record({
      retry_operations: [report.operation_id],
    });
    const view = await f.store.inspect(checkpoint.checkpoint_id, {
      ...f.options,
      verify_native: true,
    });
    assert.equal(view.candidates.formal_resume.available, applied);
    if (applied)
      await f.store.recover(checkpoint.checkpoint_id, {
        ...f.options,
        mode: "resume",
      });
    else
      assert.ok(
        view.candidates.unavailable.reasons.includes(
          "unconfirmed_external_operation",
        ),
      );
    assert.equal(sends, 1);
  }
});

test("corrupt checkpoint data and missing committed journal events refuse recovery without overwriting evidence", async (t) => {
  const f = await setup(t),
    checkpoint = await f.record();
  const file = f.store.file(checkpoint.checkpoint_id),
    original = await fs.readFile(file);
  const malformed = JSON.parse(original);
  malformed.cli_session_id = "changed-native-id";
  await fs.writeFile(file, JSON.stringify(malformed));
  const bad = await fs.readFile(file);
  await assert.rejects(
    f.store.read(checkpoint.checkpoint_id),
    error("checkpoint_checksum_mismatch"),
  );
  assert.deepEqual(await fs.readFile(file), bad);
  await fs.writeFile(file, original);
  const lines = (await fs.readFile(f.attached.history.file, "utf8"))
    .trim()
    .split("\n");
  await fs.writeFile(
    f.attached.history.file,
    lines.slice(0, -1).join("\n") + "\n",
  );
  const view = await f.store.inspect(checkpoint.checkpoint_id, {
    ...f.options,
    verify_native: true,
  });
  assert.ok(
    view.candidates.unavailable.reasons.includes(
      "checkpoint_event_missing_or_changed",
    ),
  );
});

test("a lost summary response leaves the new session link uncertain and never dispatches the summary again", async (t) => {
  const f = await setup(t),
    checkpoint = await f.record(),
    counter = path.join(f.root, "summary-effects");
  const options = {
    command: f.command,
    env: {
      ...f.env,
      RDSH_ADAPTER_FIXTURE_MODE: "summary_response_lost",
      RDSH_ADAPTER_FIXTURE_SUMMARY_COUNTER: counter,
    },
    mode: "start_new",
    summary: "Harmless fixture summary",
    accept_context_loss: true,
  };
  await assert.rejects(
    f.store.recover(checkpoint.checkpoint_id, options),
    error("recovery_result_unknown"),
  );
  const result = await (
    await Checkpoints.open(f.project)
  ).action(checkpoint.checkpoint_id);
  assert.equal(result.status, "unknown");
  assert.equal(result.summary_status, "unknown");
  assert.notEqual(result.cli_session_id, checkpoint.cli_session_id);
  const trace = await f.trace();
  await assert.rejects(
    f.store.recover(checkpoint.checkpoint_id, options),
    error("recovery_action_uncertain"),
  );
  assert.deepEqual(await f.trace(), trace);
  assert.equal(
    (await fs.readFile(counter, "utf8")).trim().split("\n").length,
    1,
  );
});

test("a flushed recovery intent blocks later clients if persistence fails before dispatch", async (t) => {
  const f = await setup(t),
    checkpoint = await f.record(),
    save = f.store.saveAction.bind(f.store);
  f.store.saveAction = async (value) => {
    await save(value);
    throw new Error("fixture-failure-after-flush");
  };
  await assert.rejects(
    f.store.recover(checkpoint.checkpoint_id, { ...f.options, mode: "resume" }),
    /fixture-failure-after-flush/,
  );
  const trace = await f.trace();
  const reopened = await Checkpoints.open(f.project);
  await assert.rejects(
    reopened.recover(checkpoint.checkpoint_id, {
      ...f.options,
      mode: "resume",
    }),
    error("recovery_action_uncertain"),
  );
  assert.deepEqual(await f.trace(), trace);
  assert.equal(
    trace.filter((item) => item.method === "session/resume").length,
    0,
  );
});

test("a surviving checkpoint writer lock remains visible and is never stolen to recover a session", async (t) => {
  const f = await setup(t),
    checkpoint = await f.record(),
    lock = f.store.file(checkpoint.checkpoint_id, ".lock");
  await fs.writeFile(lock, "fixture-stale-checkpoint-lock");
  const trace = await f.trace();
  const view = await f.store.inspect(checkpoint.checkpoint_id, {
    ...f.options,
    verify_native: true,
  });
  assert.equal(view.writer_lock_present, true);
  assert.equal(view.automatic_lock_removal, false);
  assert.ok(
    view.candidates.unavailable.reasons.includes("checkpoint_writer_present"),
  );
  await assert.rejects(
    f.store.recover(checkpoint.checkpoint_id, { ...f.options, mode: "resume" }),
    error("checkpoint_busy"),
  );
  assert.equal(
    await fs.readFile(lock, "utf8"),
    "fixture-stale-checkpoint-lock",
  );
  assert.deepEqual(await f.trace(), trace);
});

test("separate public CLI clients record, inspect, resume and reject unsafe summary options", async (t) => {
  const f = await setup(t);
  const base = [
    "--project",
    f.project.root,
    "--executable",
    process.execPath,
    "--entrypoint",
    fixture,
  ];
  const call = async (...args) =>
    JSON.parse(
      (
        await exec(process.execPath, [cli, "checkpoint", ...args, ...base], {
          env: f.env,
          windowsHide: true,
          timeout: 20000,
          maxBuffer: 256 * 1024,
        })
      ).stdout,
    );
  const checkpoint = await call("record", "--run-id", f.attached.record.run_id);
  const view = await call(
    "inspect",
    "--checkpoint-id",
    checkpoint.checkpoint_id,
    "--verify-native",
  );
  assert.equal(view.candidates.formal_resume.available, true);
  const result = await call(
    "resume",
    "--checkpoint-id",
    checkpoint.checkpoint_id,
  );
  assert.equal(result.cli_session_id, checkpoint.cli_session_id);
  await assert.rejects(
    call("start-new", "--checkpoint-id", checkpoint.checkpoint_id),
    (failure) =>
      /--summary-file and --accept-context-loss/.test(failure.stderr),
  );
});
