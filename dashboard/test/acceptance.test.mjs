import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProjectStore, identity } from "../state.mjs";
import { AcceptanceStore } from "../acceptance.mjs";

const exec = promisify(execFile),
  cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const error = (code) => (failure) => failure.code === code;
async function setup(t) {
  const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "rdsh-acceptance-test-"),
    ),
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
    RDSH_DASHBOARD_HOME: path.join(root, "dashboard"),
    GIT_CEILING_DIRECTORIES: root,
  });
  await fs.writeFile(
    path.join(cwd, "module.mjs"),
    "export const answer = 1;\n",
  );
  await fs.writeFile(
    path.join(cwd, "check.mjs"),
    "import assert from 'node:assert/strict'; import {answer} from './module.mjs'; assert.equal(answer, 1); console.log('fixture-log-secret-not-for-public-output');\n",
  );
  await fs.writeFile(
    path.join(cwd, "other.txt"),
    "Initial unrelated content\n",
  );
  await exec("git", ["-C", cwd, "init", "-b", "acceptance-qa"], { env });
  await exec(
    "git",
    ["-C", cwd, "add", "--", "module.mjs", "check.mjs", "other.txt"],
    { env },
  );
  await exec(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Acceptance Fixture",
      "-c",
      "user.email=acceptance@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Fixture input",
    ],
    { env },
  );
  const project = await identity(cwd);
  project.directory = path.join(
    env.RDSH_DASHBOARD_HOME,
    "projects",
    project.id,
  );
  const state = await ProjectStore.open(project);
  await state.mutate("task", {
    id: "task-qa",
    title: "Fixture task",
    status: "done",
  });
  const store = await AcceptanceStore.open(project),
    definition = [
      {
        id: "correct-result",
        description: "Fixture module returns the required value",
        inputs: ["module.mjs", "check.mjs"],
      },
    ];
  const run = (extra = {}) =>
    store.perform({
      task_id: "task-qa",
      criterion_id: "correct-result",
      argv: [process.execPath, "check.mjs"],
      ...extra,
    });
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-acceptance-test-"));
    await fs.rm(root, { recursive: true });
  });
  return { root, cwd, env, project, state, store, definition, run };
}

test("a task reported done stays unverified until every declared full check has a current observed result", async (t) => {
  const f = await setup(t);
  let view = await f.store.inspect("task-qa");
  assert.equal(view.reported_task_status, "done");
  assert.equal(view.verification.all_declared_full_checks_pass, false);
  await f.store.define("task-qa", f.definition);
  view = await f.store.inspect("task-qa");
  assert.equal(view.conditions[0].status, "not-run");
  assert.equal(view.reported_done_with_verified_checks, false);
  const result = await f.run();
  assert.equal(result.status, "pass");
  assert.equal(result.exit_code, 0);
  view = await f.store.inspect("task-qa");
  assert.equal(view.reported_done_with_verified_checks, true);
  assert.equal(view.verification.human_review, "not_assessed");
  assert.doesNotMatch(JSON.stringify(view), /fixture-log-secret/);
  const record = view.conditions[0].full_result;
  assert.equal(record.artifacts[0].integrity, "intact");
  assert.ok(record.target.head_sha);
  assert.ok(record.target.worktree_hash);
  assert.ok(record.target.environment.node_version);
  assert.match(
    await fs.readFile(
      path.join(record.private_record_directory, "stdout.log"),
      "utf8",
    ),
    /fixture-log-secret/,
  );
  await f.store.define("task-qa", [
    ...f.definition,
    { ...f.definition[0], id: "second-check" },
  ]);
  view = await f.store.inspect("task-qa");
  assert.equal(view.conditions[0].verified_full_check, true);
  assert.equal(view.conditions[1].status, "not-run");
  assert.equal(view.reported_done_with_verified_checks, false);
  await f.run({ criterion_id: "second-check" });
  assert.equal(
    (await f.store.inspect("task-qa")).reported_done_with_verified_checks,
    true,
  );
});

test("a reported pass and a partial observed pass cannot turn an unexecuted full criterion into verified", async (t) => {
  const f = await setup(t);
  await f.store.define("task-qa", f.definition);
  await f.store.perform({
    task_id: "task-qa",
    criterion_id: "correct-result",
    reported: { status: "pass", reason: "Agent says the work is complete" },
  });
  await f.run({ scope: "partial" });
  const view = await f.store.inspect("task-qa");
  assert.equal(view.verification.all_declared_full_checks_pass, false);
  assert.equal(view.conditions[0].full_result.source, "operator_reported");
  assert.equal(view.conditions[0].partial_result.status, "pass");
});

test("related code changes stale a pass and only a new successful check restores current verification", async (t) => {
  const f = await setup(t);
  await f.store.define("task-qa", f.definition);
  await f.run();
  await fs.writeFile(
    path.join(f.cwd, "module.mjs"),
    "export const answer = 2;\n",
  );
  let view = await f.store.inspect("task-qa");
  assert.equal(view.conditions[0].full_result.freshness.state, "stale");
  assert.equal(view.reported_done_with_verified_checks, false);
  const failed = await f.run();
  assert.equal(failed.status, "fail");
  assert.equal(failed.exit_code, 1);
  await f.run({
    scope: "partial",
    argv: [
      process.execPath,
      "--input-type=module",
      "--eval",
      "import assert from 'node:assert/strict'; import {answer} from './module.mjs'; assert.equal(answer, 2);",
    ],
  });
  view = await f.store.inspect("task-qa");
  assert.equal(view.conditions[0].full_result.status, "fail");
  assert.equal(view.conditions[0].partial_result.status, "pass");
  await fs.writeFile(
    path.join(f.cwd, "module.mjs"),
    "export const answer = 1; // repaired\n",
  );
  await f.run();
  view = await f.store.inspect("task-qa");
  assert.equal(view.reported_done_with_verified_checks, true);
  assert.equal(view.conditions[0].evidence.length, 4);
  assert.equal(view.conditions[0].evidence[0].freshness.state, "stale");
});

test("changes outside the declared input scope require reevaluation and definition or SHA changes cannot borrow an old pass", async (t) => {
  const f = await setup(t);
  await f.store.define("task-qa", f.definition);
  await f.run();
  await fs.writeFile(path.join(f.cwd, "other.txt"), "Changed unrelated file\n");
  let view = await f.store.inspect("task-qa");
  assert.equal(view.conditions[0].full_result.freshness.state, "unknown");
  assert.equal(
    view.conditions[0].full_result.freshness.reason,
    "impact_scope_unknown",
  );
  await f.run();
  await f.store.define("task-qa", [
    {
      ...f.definition[0],
      description: "Changed requirement needs a new check",
    },
  ]);
  view = await f.store.inspect("task-qa");
  assert.equal(
    view.conditions[0].full_result.freshness.reason,
    "acceptance_definition_changed",
  );
  await f.run();
  await exec(
    "git",
    [
      "-C",
      f.cwd,
      "-c",
      "user.name=Acceptance Fixture",
      "-c",
      "user.email=acceptance@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "New target SHA",
    ],
    { env: f.env },
  );
  view = await f.store.inspect("task-qa");
  assert.equal(
    view.conditions[0].full_result.freshness.reason,
    "git_target_changed",
  );
});

test("image payloads keep their original target metadata and cannot claim a known capture target or visual review", async (t) => {
  const f = await setup(t);
  await fs.writeFile(
    path.join(f.cwd, "capture.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await f.store.define("task-qa", f.definition);
  await f.run({ images: ["capture.png"] });
  let view = await f.store.inspect("task-qa"),
    image = view.conditions[0].full_result.artifacts.find(
      (item) => item.mime === "image/png",
    );
  assert.equal(image.captured_at, null);
  assert.ok(image.imported_at);
  assert.equal(image.visual_review, "not_assessed");
  assert.match(image.target_binding, /capture_target_unverified/);
  await fs.writeFile(
    path.join(f.cwd, "module.mjs"),
    "export const answer = 2;\n",
  );
  view = await f.store.inspect("task-qa");
  image = view.conditions[0].full_result.artifacts.find(
    (item) => item.mime === "image/png",
  );
  assert.equal(image.freshness.state, "stale");
  assert.equal(image.integrity, "intact");
});

test("lost or modified commands/log artifacts and corrupt metadata cannot remain an eligible pass", async (t) => {
  const f = await setup(t);
  await f.store.define("task-qa", f.definition);
  const result = await f.run();
  const commandFile = path.join(
    result.private_record_directory,
    "command.json",
  );
  await fs.writeFile(
    commandFile,
    JSON.stringify({ argv: [process.execPath, "--eval", "void 0"] }),
  );
  let view = await f.store.inspect("task-qa");
  assert.equal(view.conditions[0].full_result.command_integrity, "changed");
  assert.equal(view.reported_done_with_verified_checks, false);
  await fs.unlink(commandFile);
  view = await f.store.inspect("task-qa");
  assert.equal(view.conditions[0].full_result.command_integrity, "missing");
  await fs.writeFile(
    path.join(result.private_record_directory, "stdout.log"),
    "Changed log",
  );
  view = await f.store.inspect("task-qa");
  assert.equal(view.reported_done_with_verified_checks, false);
  assert.equal(
    view.conditions[0].full_result.artifacts[0].integrity,
    "changed",
  );
  await fs.unlink(path.join(result.private_record_directory, "stderr.log"));
  view = await f.store.inspect("task-qa");
  assert.equal(
    view.conditions[0].full_result.artifacts[1].integrity,
    "missing",
  );
  assert.equal(view.reported_done_with_verified_checks, false);
  const recordFile = path.join(result.private_record_directory, "record.json"),
    raw = JSON.parse(await fs.readFile(recordFile, "utf8"));
  raw.exit_code = 7;
  await fs.writeFile(recordFile, JSON.stringify(raw));
  const before = await fs.readFile(recordFile);
  await assert.rejects(
    f.store.inspect("task-qa"),
    error("evidence_checksum_mismatch"),
  );
  assert.deepEqual(await fs.readFile(recordFile), before);
});

test("explicit checks use a credential-free home and a timed-out process stays blocked without automatic replay", async (t) => {
  const f = await setup(t);
  await f.store.define("task-qa", f.definition);
  const priorKeys = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    PROVIDER_API_KEY: process.env.PROVIDER_API_KEY,
  };
  Object.assign(process.env, {
    OPENAI_API_KEY: "fixture-do-not-copy",
    PROVIDER_API_KEY: "fixture-do-not-copy",
  });
  t.after(() => {
    for (const [key, value] of Object.entries(priorKeys)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const isolated = await f.run({
    argv: [
      process.execPath,
      "--eval",
      "if(process.env.OPENAI_API_KEY || process.env.PROVIDER_API_KEY) process.exit(3); console.log(process.env.HOME);",
    ],
  });
  assert.equal(isolated.status, "pass");
  const output = await fs.readFile(
    path.join(isolated.private_record_directory, "stdout.log"),
    "utf8",
  );
  assert.ok(
    output.includes(path.join(isolated.private_record_directory, "home")),
  );
  const blocked = await f.run({
    argv: [process.execPath, "--eval", "setInterval(()=>{},1000)"],
    timeout_ms: 500,
  });
  assert.equal(blocked.status, "blocked");
  const before = await fs.readFile(
    path.join(blocked.private_record_directory, "record.json"),
  );
  const view = await f.store.inspect("task-qa");
  assert.equal(view.replayed_tests, 0);
  assert.equal(view.conditions[0].full_result.status, "blocked");
  assert.deepEqual(
    await fs.readFile(
      path.join(blocked.private_record_directory, "record.json"),
    ),
    before,
  );
});

test("separate public CLI clients define, execute and inspect acceptance without extending task/MCP schemas", async (t) => {
  const f = await setup(t),
    definition = path.join(f.root, "criteria.json"),
    argv = path.join(f.root, "argv.json");
  await fs.writeFile(definition, JSON.stringify(f.definition));
  await fs.writeFile(argv, JSON.stringify([process.execPath, "check.mjs"]));
  const call = async (...args) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [
            cli,
            "acceptance",
            ...args,
            "--project",
            f.cwd,
            "--task-id",
            "task-qa",
          ],
          {
            env: f.env,
            windowsHide: true,
            timeout: 20000,
            maxBuffer: 1024 * 1024,
          },
        )
      ).stdout,
    );
  await call("define", "--criteria-file", definition);
  const result = await call(
    "run",
    "--criterion-id",
    "correct-result",
    "--argv-file",
    argv,
  );
  assert.equal(result.status, "pass");
  const view = await call("inspect");
  assert.equal(view.reported_done_with_verified_checks, true);
  assert.doesNotMatch(JSON.stringify(view), /fixture-log-secret/);
  assert.equal((await ProjectStore.open(f.project)).value.schema, 1);
  await assert.rejects(
    exec(
      process.execPath,
      [cli, "session-ledger", "list", "--project", f.cwd, "--argv-file", argv],
      { env: f.env },
    ),
    (failure) => /Acceptance options require acceptance/.test(failure.stderr),
  );
});

test("deleting a required input stales earlier evidence and prevents a new command from executing", async (t) => {
  const f = await setup(t);
  await f.store.define("task-qa", f.definition);
  await f.run();
  await fs.unlink(path.join(f.cwd, "module.mjs"));
  let view = await f.store.inspect("task-qa");
  assert.equal(view.conditions[0].full_result.freshness.state, "stale");
  assert.equal(
    view.conditions[0].full_result.freshness.reason,
    "related_input_missing_or_ignored",
  );
  const blocked = await f.run({
    argv: [process.execPath, "--eval", "throw Error('should not execute')"],
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.exit_code, null);
  assert.equal(blocked.reason, "criterion_inputs_missing_or_ignored");
  assert.deepEqual(
    (await fs.readdir(blocked.private_record_directory)).sort(),
    ["command.json", "record.json"],
  );
  await fs.writeFile(
    path.join(f.cwd, "module.mjs"),
    "export const answer = 1; // restored\n",
  );
  await f.run();
  view = await f.store.inspect("task-qa");
  assert.equal(view.reported_done_with_verified_checks, true);
});

test("a successful command that changes its observed code target remains blocked", async (t) => {
  const f = await setup(t);
  await f.store.define("task-qa", f.definition);
  const result = await f.run({
    argv: [
      process.execPath,
      "--eval",
      "require('node:fs').writeFileSync('module.mjs', 'export const answer = 2;\\n')",
    ],
  });
  assert.equal(result.exit_code, 0);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "target_changed_or_unobservable_during_test");
  const view = await f.store.inspect("task-qa");
  assert.equal(view.reported_done_with_verified_checks, false);
  assert.equal(view.conditions[0].full_result.stable_target, false);
});
