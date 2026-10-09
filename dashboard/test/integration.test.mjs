import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identity } from "../state.mjs";
import { IntegrationQueue } from "../integration.mjs";
import { AcceptanceStore } from "../acceptance.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const error = (code) => (e) => e.code === code;
const guard = (r) => ({
  expectedRevision: r.revision,
  expectedHead: r.queue.target_sha,
});
async function setup(
  t,
  commands = ["process.stdout.write('full check passed\\n')"],
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-integration-qa-")),
    repo = path.join(root, "project");
  await fs.mkdir(repo);
  const git = async (cwd, ...args) =>
    (
      await exec("git", ["-C", cwd, ...args], { windowsHide: true })
    ).stdout.trim();
  await git(repo, "init", "-b", "fixture-main");
  for (const [key, val] of [
    ["user.name", "Integration QA"],
    ["user.email", "queue@example.invalid"],
    ["commit.gpgsign", "false"],
    ["core.autocrlf", "false"],
  ])
    await git(repo, "config", key, val);
  await fs.writeFile(path.join(repo, "a.txt"), "base a\n");
  await fs.writeFile(path.join(repo, "b.txt"), "base b\n");
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored.txt\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "base");
  const base = await git(repo, "rev-parse", "HEAD"),
    project = await identity(repo);
  project.directory = path.join(root, "state");
  const queue = await IntegrationQueue.open(project),
    checks = commands.map((command, index) => ({
      id: "full-" + index,
      description: "Fixture complete check " + index,
      inputs: ["a.txt", "b.txt"],
      argv: [process.execPath, "-e", command],
      timeout_ms: 1000,
    }));
  const init = () =>
    queue.init({ checks }, { expectedRevision: 0, expectedHead: base });
  const source = async (name, file, content) => {
    const tree = path.join(root, name);
    await git(repo, "worktree", "add", "-b", name, tree, base);
    await fs.writeFile(path.join(tree, file), content);
    await git(tree, "add", "-f", "--", file);
    await git(tree, "commit", "-m", name);
    return {
      label: name,
      source_base_sha: base,
      source_head_sha: await git(tree, "rev-parse", "HEAD"),
    };
  };
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-integration-qa-"));
    await fs.rm(root, { recursive: true });
  });
  return { root, repo, git, base, project, queue, checks, init, source };
}
test("fixed commits integrate in order; full checks gate every subsequent source", async (t) => {
  const f = await setup(t),
    a = await f.source("worker-a", "a.txt", "worker a\n"),
    b = await f.source("worker-b", "b.txt", "worker b\n");
  await fs.writeFile(path.join(f.repo, "human-note.txt"), "keep human work\n");
  let r = await f.init();
  assert.equal(r.queue.state, "ready");
  const initial = r.queue.target_sha;
  r = await f.queue.enqueue(a, r.revision);
  r = await f.queue.enqueue(b, r.revision);
  const worker = path.join(f.root, "worker-a");
  await fs.writeFile(
    path.join(worker, "a.txt"),
    "later, unqueued worker edit\n",
  );
  await f.git(worker, "add", "a.txt");
  await f.git(worker, "commit", "-m", "not queued");
  assert.equal(r.queue.target_sha, initial);
  assert.equal(r.publish_authority, false);
  assert.equal(await f.git(f.repo, "rev-parse", "HEAD"), f.base);
  r = await f.queue.apply(guard(r));
  assert.equal(r.queue.entries[0].state, "integrated");
  assert.equal(r.queue.entries[1].state, "queued");
  assert.equal(r.validation.verified, false);
  assert.equal(r.can_apply, false);
  await assert.rejects(
    f.queue.apply(guard(r)),
    error("previous_integration_validation_required"),
  );
  r = await f.queue.validate(guard(r));
  assert.equal(r.validation.verified, true);
  assert.equal(r.ready_for_review, false);
  const first = r.queue.target_sha;
  r = await f.queue.apply(guard(r));
  assert.notEqual(r.queue.target_sha, first);
  assert.equal(r.validation.status, "stale");
  assert.equal(r.queue.entries[1].target_before, first);
  assert.deepEqual(
    (
      await f.git(
        r.queue.worktree,
        "show",
        "-s",
        "--format=%P",
        r.queue.target_sha,
      )
    ).split(" "),
    [first, b.source_head_sha],
  );
  r = await f.queue.validate(guard(r));
  assert.equal(r.ready_for_review, true);
  assert.equal(
    await fs.readFile(path.join(r.queue.worktree, "a.txt"), "utf8"),
    "worker a\n",
  );
  assert.equal(
    await fs.readFile(path.join(r.queue.worktree, "b.txt"), "utf8"),
    "worker b\n",
  );
  assert.equal(
    await fs.readFile(path.join(f.repo, "human-note.txt"), "utf8"),
    "keep human work\n",
  );
  assert.equal(await f.git(f.repo, "rev-parse", "HEAD"), f.base);
  assert.equal(await f.git(f.repo, "remote"), "");
});
test("a failed check cannot borrow another attempt's passes; retry executes the entire suite", async (t) => {
  const f = await setup(t, [
    "console.log('first check')",
    "process.exit(require('node:fs').existsSync('../permit') ? 0 : 7)",
  ]);
  let r = await f.init();
  r = await f.queue.enqueue(await f.source("a", "a.txt", "new\n"), r.revision);
  r = await f.queue.apply(guard(r));
  r = await f.queue.validate(guard(r));
  assert.equal(r.validation.verified, false);
  assert.equal(r.validation.status, "failed");
  assert.equal(r.validation.retryable, true);
  assert.equal(r.queue.attempts.at(-1).results[1].exit_code, 7);
  assert.equal(r.validation.checks[0].verified, true);
  const refs = r.queue.attempts.at(-1).results.map((c) => c.evidence_id);
  await fs.writeFile(
    path.join(f.queue.directory, "permit"),
    "operator retry\n",
  );
  r = await f.queue.validate(guard(r));
  assert.equal(r.ready_for_review, true);
  assert.ok(
    r.queue.attempts
      .at(-1)
      .results.every((c, index) => c.evidence_id !== refs[index]),
  );
});
test("conflict retains the exact source and target, blocks later entries, and can be explicitly rejected", async (t) => {
  const f = await setup(t);
  let r = await f.init();
  for (const [name, file, text] of [
    ["a", "a.txt", "first\n"],
    ["conflict", "a.txt", "second\n"],
    ["last", "b.txt", "last\n"],
  ])
    r = await f.queue.enqueue(await f.source(name, file, text), r.revision);
  r = await f.queue.apply(guard(r));
  r = await f.queue.validate(guard(r));
  const target = r.queue.target_sha;
  r = await f.queue.apply(guard(r));
  assert.equal(r.queue.entries[1].state, "conflict");
  assert.ok(r.queue.entries[1].conflicts.includes("a.txt"));
  assert.equal(r.queue.target_sha, target);
  assert.equal(r.queue.entries[2].state, "queued");
  r = await f.queue.apply(guard(r));
  assert.equal(r.queue.entries[1].state, "conflict");
  r = await f.queue.reject(
    { reason: "Replaced by a separately reviewed fix" },
    r.revision,
  );
  r = await f.queue.apply(guard(r));
  r = await f.queue.validate(guard(r));
  assert.equal(r.validation.verified, true);
  assert.equal(r.ready_for_review, false);
  assert.equal(r.queue.entries[1].state, "rejected");
});
test("new target commit and dirty files invalidate verification; retarget requires a full rerun", async (t) => {
  const f = await setup(t);
  let r = await f.init();
  r = await f.queue.enqueue(await f.source("a", "a.txt", "new\n"), r.revision);
  r = await f.queue.apply(guard(r));
  r = await f.queue.validate(guard(r));
  const tree = r.queue.worktree;
  await fs.writeFile(path.join(tree, "human.txt"), "retain\n");
  r = await f.queue.inspect();
  assert.equal(r.validation.status, "stale");
  assert.equal(r.ready_for_review, false);
  await assert.rejects(
    f.queue.validate(guard(r)),
    error("integration_checkout_dirty_or_unavailable"),
  );
  await f.git(tree, "add", "--", "human.txt");
  await f.git(tree, "commit", "-m", "operator correction");
  const head = await f.git(tree, "rev-parse", "HEAD");
  r = await f.queue.inspect();
  assert.equal(r.validation.verified, false);
  await assert.rejects(
    f.queue.validate({ expectedRevision: r.revision, expectedHead: head }),
    error("integration_target_changed"),
  );
  r = await f.queue.retarget({
    expectedRevision: r.revision,
    expectedHead: head,
  });
  assert.equal(r.validation.status, "stale");
  r = await f.queue.validate(guard(r));
  assert.equal(r.ready_for_review, true);
  assert.equal(
    await fs.readFile(path.join(tree, "human.txt"), "utf8"),
    "retain\n",
  );
});
test("a check that changes the commit cannot verify either the old or new target", async (t) => {
  const f = await setup(t, [
    "require('node:child_process').execFileSync('git',['-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','changed during check'])",
  ]);
  let r = await f.init();
  r = await f.queue.validate(guard(r));
  assert.equal(r.validation.verified, false);
  assert.equal(r.validation.status, "stale");
  assert.equal(r.queue.attempts.at(-1).status, "blocked");
});
test("timeouts and interrupted intent never pass or automatically replay", async (t) => {
  const f = await setup(t, ["setTimeout(() => {}, 5000)"]);
  let r = await f.init();
  r = await f.queue.validate(guard(r));
  assert.equal(r.validation.verified, false);
  assert.equal(r.validation.status, "blocked");
  const state = await f.queue.read();
  state.queue.attempts.at(-1).phase = "running";
  state.queue.attempts.at(-1).status = "unconfirmed";
  await f.queue.save(state);
  r = await f.queue.inspect();
  assert.equal(r.validation.status, "unconfirmed");
  assert.equal(r.validation.retryable, false);
  r = await f.queue.enqueue(
    await f.source(
      "after-unknown",
      "a.txt",
      "queued after uncertain dispatch\n",
    ),
    r.revision,
  );
  assert.equal(r.can_apply, false);
  await assert.rejects(
    f.queue.apply(guard(r)),
    error("interrupted_operation_requires_inspection"),
  );
  await assert.rejects(
    f.queue.validate(guard(r)),
    error("interrupted_operation_requires_inspection"),
  );
});
test("unconfirmed dispatch errors cannot be retried or bypassed by retarget", async (t) => {
  const f = await setup(t);
  let r = await f.init();
  const original = AcceptanceStore.prototype.perform;
  AcceptanceStore.prototype.perform = async () => {
    throw new Error("lost execution outcome");
  };
  try {
    r = await f.queue.validate(guard(r));
  } finally {
    AcceptanceStore.prototype.perform = original;
  }
  assert.equal(r.validation.status, "unconfirmed");
  assert.equal(r.validation.retryable, false);
  await assert.rejects(
    f.queue.validate(guard(r)),
    error("interrupted_operation_requires_inspection"),
  );
  await assert.rejects(
    f.queue.retarget(guard(r)),
    error("interrupted_operation_requires_inspection"),
  );
});
test("a corrupted registry cannot disable validation after an integration", async (t) => {
  const f = await setup(t);
  let r = await f.init();
  r = await f.queue.enqueue(await f.source("a", "a.txt", "new\n"), r.revision);
  r = await f.queue.apply(guard(r));
  const state = await f.queue.read();
  state.queue.requires_validation = false;
  const forged = JSON.stringify(state);
  await fs.writeFile(f.queue.file, forged);
  await assert.rejects(
    f.queue.inspect(),
    error("invalid_integration_validation_gate"),
  );
  assert.equal(await fs.readFile(f.queue.file, "utf8"), forged);
});
test("integration never overwrites ignored human files", async (t) => {
  const f = await setup(t);
  let r = await f.init();
  await fs.writeFile(
    path.join(r.queue.worktree, "ignored.txt"),
    "human original\n",
  );
  r = await f.queue.enqueue(
    await f.source("ignored-source", "ignored.txt", "worker addition\n"),
    r.revision,
  );
  r = await f.queue.apply(guard(r));
  assert.equal(r.queue.entries[0].state, "unconfirmed");
  assert.equal(r.can_apply, false);
  assert.equal(
    await fs.readFile(path.join(r.queue.worktree, "ignored.txt"), "utf8"),
    "human original\n",
  );
  assert.equal(await f.git(r.queue.worktree, "rev-parse", "HEAD"), f.base);
});
test("immutable definitions, stale revisions/heads and concurrent writers are rejected", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.queue.init(
      { checks: f.checks, push: true },
      { expectedRevision: 0, expectedHead: f.base },
    ),
    error("invalid_queue_definition"),
  );
  let r = await f.init();
  const source = await f.source("a", "a.txt", "new\n");
  const outcomes = await Promise.allSettled([
    f.queue.enqueue(source, r.revision),
    f.queue.enqueue(source, r.revision),
  ]);
  assert.equal(outcomes.filter((v) => v.status === "fulfilled").length, 1);
  r = await f.queue.inspect();
  await assert.rejects(
    f.queue.apply({ expectedRevision: r.revision - 1, expectedHead: f.base }),
    error("integration_revision_changed"),
  );
  await assert.rejects(
    f.queue.apply({
      expectedRevision: r.revision,
      expectedHead: "0".repeat(40),
    }),
    error("integration_target_changed"),
  );
  await assert.rejects(
    f.queue.enqueue(source, r.revision),
    error("duplicate_or_full_queue"),
  );
});
test("corrupt/linked registry and old locks stay intact; storage inside the repo is forbidden", async (t) => {
  const f = await setup(t);
  await f.init();
  await fs.writeFile(f.queue.lock, "retained old lock");
  await assert.rejects(
    f.queue.validate({ expectedRevision: 2, expectedHead: f.base }),
    error("integration_queue_busy"),
  );
  assert.equal(await fs.readFile(f.queue.lock, "utf8"), "retained old lock");
  await fs.unlink(f.queue.lock);
  await fs.writeFile(f.queue.file, "{invalid");
  await assert.rejects(
    f.queue.inspect(),
    error("integration_registry_unreadable"),
  );
  assert.equal(await fs.readFile(f.queue.file, "utf8"), "{invalid");
  const link = path.join(f.root, "registry-link.json");
  await fs.link(f.queue.file, link);
  await assert.rejects(
    f.queue.inspect(),
    error("integration_registry_unobservable"),
  );
  assert.equal(await fs.readFile(link, "utf8"), "{invalid");
  await assert.rejects(
    IntegrationQueue.open({
      ...f.project,
      directory: path.join(f.repo, "state"),
    }),
    error("integration_storage_must_be_outside_project"),
  );
});
test("changed argv or removed logs invalidate recorded success without running checks", async (t) => {
  const f = await setup(t);
  let r = await f.init();
  r = await f.queue.validate(guard(r));
  assert.equal(r.validation.verified, true);
  const ref = r.queue.attempts.at(-1).results[0].evidence_id;
  const dir = path.join(
    f.queue.directory,
    "verification",
    "acceptance",
    "evidence",
    ref,
  );
  await fs.writeFile(
    path.join(dir, "command.json"),
    JSON.stringify({ argv: [process.execPath, "-e", "process.exit(0)"] }),
  );
  r = await f.queue.inspect();
  assert.equal(r.validation.verified, false);
  r = await f.queue.validate(guard(r));
  assert.equal(r.validation.verified, true);
  const freshDir = path.join(
    f.queue.directory,
    "verification",
    "acceptance",
    "evidence",
    r.queue.attempts.at(-1).results[0].evidence_id,
  );
  await fs.unlink(path.join(freshDir, "stdout.log"));
  r = await f.queue.inspect();
  assert.equal(r.validation.verified, false);
});
test("unavailable and reassigned worktrees do not reuse passes or modify retained human files", async (t) => {
  const f = await setup(t);
  let r = await f.init();
  r = await f.queue.validate(guard(r));
  await f.git(r.queue.worktree, "switch", "-c", "human-branch");
  await fs.writeFile(path.join(r.queue.worktree, "human.txt"), "retain\n");
  r = await f.queue.inspect();
  assert.equal(r.target.status, "unavailable");
  assert.equal(r.validation.verified, false);
  await assert.rejects(
    f.queue.validate(guard(r)),
    error("integration_checkout_dirty_or_unavailable"),
  );
  assert.equal(
    await fs.readFile(path.join(r.queue.worktree, "human.txt"), "utf8"),
    "retain\n",
  );
});
test("public CLI registration does not execute validation or publish and rejects unrelated options", async (t) => {
  const f = await setup(t),
    home = path.join(f.root, "cli-state"),
    file = path.join(f.root, "checks.json");
  await fs.writeFile(file, JSON.stringify({ checks: f.checks }));
  const run = async (...args) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [cli, "integration", ...args, "--project", f.repo],
          {
            env: { ...process.env, RDSH_DASHBOARD_HOME: home },
            windowsHide: true,
          },
        )
      ).stdout,
    );
  let r = await run(
    "init",
    "--input-file",
    file,
    "--expected-revision",
    "0",
    "--expected-head",
    f.base,
  );
  assert.deepEqual(r.queue.attempts, []);
  assert.equal(r.publish_authority, false);
  const source = await f.source("cli-source", "a.txt", "CLI\n"),
    input = path.join(f.root, "source.json");
  await fs.writeFile(input, JSON.stringify(source));
  r = await run(
    "enqueue",
    "--input-file",
    input,
    "--expected-revision",
    String(r.revision),
  );
  assert.equal(r.queue.target_sha, f.base);
  assert.deepEqual(r.queue.attempts, []);
  assert.equal((await run("inspect")).next_sequence, 1);
  await assert.rejects(run("inspect", "--executable", process.execPath), (e) =>
    e.stderr.includes("Invalid integration action/options"),
  );
  await assert.rejects(run("push"), (e) =>
    e.stderr.includes("Invalid integration action/options"),
  );
  r = await run(
    "apply",
    "--expected-revision",
    String(r.revision),
    "--expected-head",
    r.queue.target_sha,
  );
  r = await run(
    "validate",
    "--expected-revision",
    String(r.revision),
    "--expected-head",
    r.queue.target_sha,
  );
  assert.equal(r.ready_for_review, true);
  assert.equal(await f.git(f.repo, "rev-parse", "HEAD"), f.base);
});
