import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identity } from "../state.mjs";
import { SessionLedger, attachRecordedSession } from "../session-ledger.mjs";

const exec = promisify(execFile);
const fixture = fileURLToPath(
  new URL("./fixtures/acp-cli.mjs", import.meta.url),
);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const error = (code) => (value) => value.code === code;
async function setup(t, git = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-ledger-test-"));
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  if (git) {
    await exec("git", ["-C", cwd, "init", "-b", "ledger-qa"]);
    await exec("git", [
      "-C",
      cwd,
      "-c",
      "user.name=Ledger QA",
      "-c",
      "user.email=ledger@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
  }
  const project = await identity(cwd);
  project.directory = path.join(root, "state");
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    DSH_HOME: path.join(root, "dsh"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    APPDATA: path.join(root, "data"),
    LOCALAPPDATA: path.join(root, "local"),
    RDSH_DASHBOARD_HOME: path.join(root, "dashboard"),
    GIT_CEILING_DIRECTORIES: root,
    RDSH_ADAPTER_FIXTURE_TRACE: path.join(root, "trace.jsonl"),
    PROVIDER_API_KEY: "fixture-secret-must-not-be-saved",
  };
  const ledger = await SessionLedger.open(project);
  const command = [process.execPath, fixture];
  const adapters = [];
  t.after(async () => {
    for (const adapter of adapters) await adapter.stop();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("rdsh-ledger-test-"));
    await fs.rm(resolved, { recursive: true });
  });
  return {
    root,
    project,
    ledger,
    env,
    command,
    adapters,
    trace: async () =>
      (await fs.readFile(env.RDSH_ADAPTER_FIXTURE_TRACE, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse),
  };
}

test("same task and display label preserve distinct project/run/native-session identities", async (t) => {
  const { ledger, project, command, env } = await setup(t, true);
  const first = await ledger.record({
    task_id: "task-same",
    label: "同じ画面",
    cli_session_id: "native-A",
    provider: "operator-reported-openai",
    command,
    env,
  });
  const second = await ledger.record({
    task_id: "task-same",
    label: "同じ画面",
    cli_session_id: "native-B",
    command,
    env,
  });
  assert.equal(first.project_id, project.id);
  assert.notEqual(first.run_id, first.project_id);
  assert.notEqual(first.run_id, second.run_id);
  assert.equal(first.task_id, second.task_id);
  assert.equal(first.cli_session_id, "native-A");
  assert.equal(second.cli_session_id, "native-B");
  assert.equal(first.cwd, project.root);
  assert.equal(first.branch, "ledger-qa");
  assert.equal(first.launch.method, "acp-stdio-v1");
  assert.equal(first.binding, "reported");
  assert.equal(second.provider, null);
  assert.deepEqual(
    (await ledger.list()).map((row) => row.run_id),
    [first.run_id, second.run_id],
  );
  const reopened = await SessionLedger.open(project);
  assert.equal(
    (await reopened.resolve(first.run_id)).cli_session_id,
    "native-A",
  );
  assert.equal(
    (await reopened.resolve(second.run_id)).cli_session_id,
    "native-B",
  );
  await assert.rejects(
    reopened.resolve("同じ画面"),
    error("exact_run_id_required"),
  );
  const saved = await fs.readFile(ledger.file, "utf8");
  assert.ok(!saved.includes("fixture-secret-must-not-be-saved"));
  assert.ok(!saved.includes("PROVIDER_API_KEY"));
});

test("unconfirmed IDs and unavailable launch/provider facts stay explicitly unknown", async (t) => {
  const { ledger, command, env } = await setup(t);
  const record = await ledger.record({ label: "未確定" });
  assert.equal(record.cli_session_id, null);
  assert.equal(record.cli_session_display, "不明");
  assert.equal(record.binding, "unknown");
  assert.equal(record.provider, null);
  assert.equal(record.launch, null);
  assert.equal(record.branch, null);
  await assert.rejects(
    attachRecordedSession({ ledger, run_id: record.run_id, command, env }),
    error("session_id_unknown"),
  );
  await assert.rejects(
    ledger.record({ cli_session_id: "" }),
    error("invalid_record"),
  );
  await assert.rejects(
    ledger.record({ cli: "claude", command, env }),
    error("invalid_record"),
  );
  assert.equal((await ledger.list()).length, 1);
});

test("incompatible or malformed disk state is never overwritten or shown as a valid registry", async (t) => {
  const { ledger, project } = await setup(t);
  const record = await ledger.record({ cli_session_id: "native" });
  const value = JSON.parse(await fs.readFile(ledger.file, "utf8"));
  value.project_id = "another-project";
  const original = JSON.stringify(value);
  await fs.writeFile(ledger.file, original);
  await assert.rejects(SessionLedger.open(project), error("invalid_ledger"));
  await assert.rejects(ledger.record(), error("invalid_ledger"));
  assert.equal(await fs.readFile(ledger.file, "utf8"), original);
  await fs.writeFile(ledger.file, "{secret-fixture-invalid-json");
  await assert.rejects(
    ledger.resolve(record.run_id),
    (err) =>
      err.code === "invalid_ledger" && !err.message.includes("secret-fixture"),
  );
});

test("separate writers share an exclusive lock and reload the last durable revision", async (t) => {
  const { ledger, project } = await setup(t);
  const reopened = await SessionLedger.open(project);
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const hold = ledger.mutate(async () => {
    enter();
    await gate;
  });
  await entered;
  await assert.rejects(reopened.record(), error("ledger_busy"));
  release();
  await hold;
  const a = await ledger.record({ label: "a" });
  const b = await reopened.record({ label: "b" });
  assert.deepEqual(
    (await ledger.list()).map((record) => record.run_id),
    [a.run_id, b.run_id],
  );
  assert.equal((await ledger.read()).revision, 3);
  await fs.writeFile(ledger.lock, "stale-owner");
  await assert.rejects(reopened.record(), error("ledger_busy"));
  assert.equal(await fs.readFile(ledger.lock, "utf8"), "stale-owner");
  await fs.unlink(ledger.lock);
});

test("separate public CLI processes start, resolve and resume the same stored native session", async (t) => {
  const { root, project, command, env, trace } = await setup(t, true);
  const args = [
    cli,
    "session-ledger",
    "start",
    "--project",
    project.root,
    "--executable",
    command[0],
    "--entrypoint",
    command[1],
    "--task-id",
    "task-42",
    "--label",
    "同じ画面",
  ];
  const started = JSON.parse(
    (await exec(process.execPath, args, { env, timeout: 15000 })).stdout,
  );
  assert.equal(started.run.binding, "confirmed");
  assert.equal(started.run.cli_session_id, "fixture-session");
  assert.equal(started.run.provider, null);
  assert.equal(started.process.confirmed, true);
  const query = [
    cli,
    "session-ledger",
    "resolve",
    "--project",
    project.root,
    "--run-id",
    started.run.run_id,
  ];
  assert.equal(
    JSON.parse((await exec(process.execPath, query, { env })).stdout).task_id,
    "task-42",
  );
  const resumed = JSON.parse(
    (
      await exec(
        process.execPath,
        [
          cli,
          "session-ledger",
          "resume",
          "--project",
          project.root,
          "--run-id",
          started.run.run_id,
          "--executable",
          command[0],
          "--entrypoint",
          command[1],
        ],
        { env, timeout: 15000 },
      )
    ).stdout,
  );
  assert.equal(resumed.run.run_id, started.run.run_id);
  assert.equal(resumed.run.cli_session_id, started.run.cli_session_id);
  assert.equal(resumed.run.cwd, started.run.cwd);
  assert.equal(resumed.run.cli_version, "0.2.0-rc.2");
  assert.equal(resumed.process.confirmed, true);
  const messages = await trace();
  const resume = messages.find(
    (message) => message.method === "session/resume",
  );
  assert.equal(resume.params.sessionId, started.run.cli_session_id);
  assert.equal(resume.params.cwd, project.root);
  assert.equal(
    messages.some((message) => message.method === "session/prompt"),
    false,
  );
  const saved = await fs.readFile(
    path.join(root, "dashboard", "projects", project.id, "sessions.json"),
    "utf8",
  );
  assert.equal(saved.includes("fixture-secret-must-not-be-saved"), false);
});

test("resume rejects changed executable, home, branch and CLI version before claiming attachment", async (t) => {
  const { ledger, command, env, project, adapters, trace } = await setup(
    t,
    true,
  );
  const started = await attachRecordedSession({
    ledger,
    command,
    env,
    requestTimeout: 1500,
    stopTimeout: 100,
  });
  adapters.push(started.adapter);
  await started.adapter.stop();
  const base = {
    ledger,
    run_id: started.record.run_id,
    command,
    env,
    requestTimeout: 1500,
    stopTimeout: 100,
  };
  await assert.rejects(
    attachRecordedSession({ ...base, command: [process.execPath] }),
    error("launch_changed"),
  );
  await assert.rejects(
    attachRecordedSession({
      ...base,
      env: { ...env, DSH_HOME: path.join(project.root, "other-home") },
    }),
    error("session_scope_changed"),
  );
  await assert.rejects(
    attachRecordedSession({
      ...base,
      env: { ...env, RDSH_ADAPTER_FIXTURE_MODE: "new_version" },
    }),
    error("cli_version_changed"),
  );
  await exec("git", [
    "-C",
    project.root,
    "symbolic-ref",
    "HEAD",
    "refs/heads/another-branch",
  ]);
  await assert.rejects(
    attachRecordedSession(base),
    error("repository_context_changed"),
  );
  assert.equal(
    (await trace()).filter((message) => message.method === "session/resume")
      .length,
    0,
  );
  assert.equal(
    (await ledger.resolve(started.record.run_id)).cli_session_id,
    started.record.cli_session_id,
  );
});

test("failed starts retain an unknown ID; failed resumes retain only the reported identity", async (t) => {
  const { ledger, command, env } = await setup(t);
  await assert.rejects(
    attachRecordedSession({
      ledger,
      command,
      env: { ...env, RDSH_ADAPTER_FIXTURE_MODE: "bad_new" },
      requestTimeout: 500,
      stopTimeout: 100,
    }),
    error("protocol_mismatch"),
  );
  const [unknown] = await ledger.list();
  assert.equal(unknown.binding, "unknown");
  assert.equal(unknown.cli_session_id, null);
  const reported = await ledger.record({
    cli_session_id: "missing",
    command,
    env,
  });
  await assert.rejects(
    attachRecordedSession({
      ledger,
      run_id: reported.run_id,
      command,
      env,
      requestTimeout: 500,
      stopTimeout: 100,
    }),
    error("cli_error"),
  );
  assert.equal((await ledger.resolve(reported.run_id)).binding, "reported");
  assert.equal((await ledger.resolve(reported.run_id)).cli_version, null);
});

test("confirmed native ID cannot be reassigned and labels are never shell or file authority", async (t) => {
  const { ledger } = await setup(t);
  const record = await ledger.record({
    cli_session_id: "../../native session | name",
    label: "$(not-a-command)",
  });
  const before = await fs.readFile(ledger.file, "utf8");
  await assert.rejects(
    ledger.confirm(record.run_id, "replacement", "0.2.0-rc.2"),
    error("session_binding_immutable"),
  );
  assert.equal(await fs.readFile(ledger.file, "utf8"), before);
  assert.equal(
    (await ledger.resolve(record.run_id)).cli_session_id,
    "../../native session | name",
  );
});

test("size limits preserve the last readable durable revision instead of writing an oversized ledger", async (t) => {
  const { ledger } = await setup(t);
  await ledger.record({
    label: "a".repeat(1000),
    task_id: "t".repeat(160),
    provider: "p".repeat(160),
  });
  const before = await fs.readFile(ledger.file, "utf8");
  await assert.rejects(
    ledger.mutate((value) => {
      const seed = value.runs[0];
      value.runs = Array.from({ length: 5000 }, (_, index) => ({
        ...seed,
        run_id:
          "run_00000000-0000-4000-8000-" + index.toString(16).padStart(12, "0"),
      }));
    }),
    error("ledger_full"),
  );
  assert.equal(await fs.readFile(ledger.file, "utf8"), before);
  assert.equal((await ledger.list()).length, 1);
});

test("unreadable Git context is distinct from a non-Git directory and cannot attach a native session", async (t) => {
  const { ledger, project, command, env } = await setup(t);
  await fs.writeFile(
    path.join(project.root, ".git"),
    "gitdir: unavailable-ledger-fixture\n",
  );
  const row = await ledger.record({
    cli_session_id: "reported-session",
    command,
    env,
  });
  assert.equal(row.git.status, "unavailable");
  assert.equal(row.branch, null);
  await assert.rejects(
    attachRecordedSession({ ledger, run_id: row.run_id, command, env }),
    error("repository_context_unknown"),
  );
  await assert.rejects(
    fs.stat(env.RDSH_ADAPTER_FIXTURE_TRACE),
    error("ENOENT"),
  );
});
