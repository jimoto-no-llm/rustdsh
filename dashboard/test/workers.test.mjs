import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identity } from "../state.mjs";
import { WorkerWorkspaces } from "../workers.mjs";
import { declaration } from "../worker-scopes.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const scope = (id, writes = ["src/a.txt"], role = "edit") => ({
  worker_id: id,
  role,
  read_paths: ["."],
  write_paths: writes,
  modules: ["fixture"],
  forbidden_paths: ["src/private"],
  lease_seconds: 60,
});
const error = (code) => (e) => e.code === code;
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-workers-qa-"));
  const repo = path.join(root, "project");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await fs.mkdir(path.join(repo, "tests"));
  const git = async (cwd, ...args) =>
    (await exec("git", ["-C", cwd, ...args], { windowsHide: true })).stdout;
  await git(repo, "init", "-b", "fixture-main");
  await git(repo, "config", "user.name", "Workspace QA");
  await git(repo, "config", "user.email", "worker@example.invalid");
  await git(repo, "config", "commit.gpgsign", "false");
  await git(repo, "config", "core.autocrlf", "false");
  for (const [name, value] of Object.entries({
    "src/a.txt": "a\n",
    "src/b.txt": "b\n",
    "tests/t.txt": "test\n",
    "Cargo.lock": "fixture\n",
    "package.json": '{"name":"fixture"}\n',
  }))
    await fs.writeFile(path.join(repo, name), value);
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "fixture");
  const project = await identity(repo);
  project.directory = path.join(root, "state");
  let now = Date.now();
  const workers = await WorkerWorkspaces.open(project, { now: () => now });
  const prepare = async (request) => {
    const plan = await workers.plan(request);
    assert.equal(plan.can_prepare, true, JSON.stringify(plan.warnings));
    const result = await workers.prepare(request, {
      expectedRevision: plan.revision,
      expectedHead: plan.source.head_sha,
    });
    assert.equal(result.provisioning_error, null);
    assert.equal(result.worker.tree.status, "observed");
    return result;
  };
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rdsh-workers-qa-"));
    await fs.rm(root, { recursive: true });
  });
  return {
    root,
    repo,
    git,
    project,
    workers,
    prepare,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("editors get separate real branches/checkouts; review defaults to no write scope", async (t) => {
  const f = await setup(t);
  const a = await f.prepare(scope("editor-a"));
  const b = await f.prepare(scope("editor-b", ["src/b.txt"]));
  const r = await f.prepare(scope("reviewer", [], "review"));
  assert.notEqual(a.worker.worktree, b.worker.worktree);
  assert.notEqual(a.worker.branch, b.worker.branch);
  assert.deepEqual(r.worker.declaration.write_paths, []);
  assert.equal(
    await f.git(a.worker.worktree, "branch", "--show-current"),
    a.worker.branch + "\n",
  );
  await fs.writeFile(path.join(a.worker.worktree, "src/a.txt"), "worker a\n");
  assert.equal(
    await fs.readFile(path.join(f.repo, "src/a.txt"), "utf8"),
    "a\n",
  );
  assert.equal(
    await fs.readFile(path.join(b.worker.worktree, "src/a.txt"), "utf8"),
    "a\n",
  );
  await fs.writeFile(
    path.join(r.worker.worktree, "src/b.txt"),
    "unauthorized review edit\n",
  );
  const report = await f.workers.inspect();
  assert.deepEqual(
    report.workers.find((w) => w.worker_id === "reviewer").tree
      .scope_violations,
    ["src/b.txt"],
  );
  assert.equal(
    report.runtime_policy,
    "declarations_and_git_change_scan; native_DSH_tool_policy_and_sandbox_are_separate",
  );
});

test("scope and common configuration overlap are found before creating a checkout", async (t) => {
  const f = await setup(t);
  await f.prepare(scope("first", ["src", "package.json"]));
  const candidate = scope("second", ["src/b.txt", "package.json"]);
  const plan = await f.workers.plan(candidate);
  assert.equal(plan.can_prepare, false);
  assert.ok(
    plan.warnings.some(
      (w) => w.code === "worker_scope_overlap" && w.path === "src/b.txt",
    ),
  );
  assert.ok(
    plan.warnings.some(
      (w) => w.code === "shared_file_overlap" && w.path === "package.json",
    ),
  );
  await assert.rejects(
    f.workers.prepare(candidate, {
      expectedRevision: plan.revision,
      expectedHead: plan.source.head_sha,
    }),
    (e) => e.code === "worker_preparation_conflict" && e.details.length > 0,
  );
  await assert.rejects(fs.stat(plan.proposed_worktree), { code: "ENOENT" });
  assert.equal((await f.workers.inspect()).workers.length, 1);
});

test("tracked/untracked source changes are detected and preserved; unrelated dirty files remain", async (t) => {
  const f = await setup(t);
  await fs.writeFile(path.join(f.repo, "src/a.txt"), "human changes\n");
  await fs.writeFile(path.join(f.repo, "src/new.txt"), "human untracked\n");
  const plan = await f.workers.plan(scope("overlap", ["src"]));
  assert.equal(plan.can_prepare, false);
  assert.deepEqual(plan.source.dirty_paths, ["src/a.txt", "src/new.txt"]);
  await assert.rejects(
    f.workers.prepare(scope("overlap", ["src"]), {
      expectedRevision: plan.revision,
      expectedHead: plan.source.head_sha,
    }),
    error("worker_preparation_conflict"),
  );
  const separate = await f.prepare(scope("tests-worker", ["tests"]));
  assert.deepEqual(separate.source_after.dirty_paths, plan.source.dirty_paths);
  assert.equal(
    await fs.readFile(path.join(f.repo, "src/a.txt"), "utf8"),
    "human changes\n",
  );
  assert.equal(
    await fs.readFile(path.join(f.repo, "src/new.txt"), "utf8"),
    "human untracked\n",
  );
});

test("post-change scans find shared lockfile changes even with disjoint declared scopes", async (t) => {
  const f = await setup(t);
  const a = await f.prepare(scope("first")),
    b = await f.prepare(scope("second", ["src/b.txt"]));
  for (const row of [a, b])
    await fs.writeFile(
      path.join(row.worker.worktree, "Cargo.lock"),
      "changed lock\n",
    );
  await f.git(a.worker.worktree, "add", "Cargo.lock");
  await f.git(a.worker.worktree, "commit", "-m", "committed outside scope");
  const report = await f.workers.inspect();
  assert.deepEqual(report.conflicts, [
    {
      code: "shared_file_changes",
      workers: ["first", "second"],
      path: "Cargo.lock",
    },
  ]);
  const first = report.workers[0].tree;
  assert.equal(first.dirty, false);
  assert.deepEqual(first.committed_paths, ["Cargo.lock"]);
  assert.deepEqual(first.scope_violations, ["Cargo.lock"]);
  assert.deepEqual(report.workers[1].tree.dirty_paths, ["Cargo.lock"]);
});

test("expiry, dirty state, renewal and explicit release preserve worktree and branch contents", async (t) => {
  const f = await setup(t);
  const a = await f.prepare({ ...scope("short"), lease_seconds: 1 });
  await fs.writeFile(
    path.join(a.worker.worktree, "src/a.txt"),
    "unfinished edit\n",
  );
  await fs.writeFile(
    path.join(a.worker.worktree, "notes.txt"),
    "untracked original\n",
  );
  f.advance(2000);
  let report = await f.workers.inspect();
  assert.equal(report.workers[0].lease.state, "expired");
  assert.equal(report.workers[0].tree.dirty, true);
  assert.equal((await f.workers.plan(scope("new-owner"))).can_prepare, false);
  const renewed = await f.workers.renew("short", 120, report.revision);
  assert.equal(renewed.worker.lease.state, "active");
  const released = await f.workers.release("short", renewed.revision);
  assert.equal(released.worker.lease.state, "released");
  assert.equal(released.worker.tree.dirty, true);
  assert.equal(
    await fs.readFile(path.join(a.worker.worktree, "src/a.txt"), "utf8"),
    "unfinished edit\n",
  );
  assert.equal(
    await fs.readFile(path.join(a.worker.worktree, "notes.txt"), "utf8"),
    "untracked original\n",
  );
  assert.equal(
    await f.git(a.worker.worktree, "branch", "--show-current"),
    a.worker.branch + "\n",
  );
  const next = await f.workers.plan(scope("new-owner"));
  assert.ok(
    next.warnings.some((w) => w.code === "released_worker_scope_overlap"),
  );
});

test("human edits after allocation warn against worker ownership and changed lockfiles", async (t) => {
  const f = await setup(t);
  const row = await f.prepare(scope("editor"));
  await fs.writeFile(path.join(f.repo, "src/a.txt"), "later human edit\n");
  await fs.writeFile(path.join(f.repo, "Cargo.lock"), "human lock\n");
  await fs.writeFile(
    path.join(row.worker.worktree, "Cargo.lock"),
    "worker lock\n",
  );
  const report = await f.workers.inspect();
  assert.ok(
    report.conflicts.some(
      (c) => c.code === "human_worker_scope_overlap" && c.path === "src/a.txt",
    ),
  );
  assert.ok(
    report.conflicts.some(
      (c) => c.code === "human_shared_file_changes" && c.path === "Cargo.lock",
    ),
  );
  assert.equal(
    await fs.readFile(path.join(f.repo, "src/a.txt"), "utf8"),
    "later human edit\n",
  );
});

test("stale ledger revisions and changed source commits block assignment without Git changes", async (t) => {
  const f = await setup(t);
  const stale = await f.workers.plan(scope("later", ["src/b.txt"]));
  await f.prepare(scope("first"));
  await assert.rejects(
    f.workers.prepare(scope("later", ["src/b.txt"]), {
      expectedRevision: stale.revision,
      expectedHead: stale.source.head_sha,
    }),
    error("worker_registry_revision_changed"),
  );
  const plan = await f.workers.plan(scope("later", ["src/b.txt"]));
  await fs.writeFile(path.join(f.repo, "change.txt"), "new commit\n");
  await f.git(f.repo, "add", "change.txt");
  await f.git(f.repo, "commit", "-m", "source advanced");
  await assert.rejects(
    f.workers.prepare(scope("later", ["src/b.txt"]), {
      expectedRevision: plan.revision,
      expectedHead: plan.source.head_sha,
    }),
    error("source_head_changed"),
  );
  await assert.rejects(fs.stat(plan.proposed_worktree), { code: "ENOENT" });
});

test("path escape, globs, unknown fields and review writes are rejected", () => {
  for (const file of [
    "../escape",
    "/absolute",
    "C:/outside",
    "src\\file",
    "src/**",
    ".git/config",
    "src//a",
  ])
    assert.throws(
      () => declaration(scope("bad", [file])),
      error("invalid_scope_path"),
    );
  assert.throws(
    () => declaration(scope("review", ["src"], "review")),
    error("review_worker_is_read_only"),
  );
  assert.throws(
    () => declaration({ ...scope("bad"), execute: "arbitrary command" }),
    error("invalid_worker_declaration"),
  );
  assert.throws(
    () => declaration({ ...scope("bad"), read_paths: ["tests"] }),
    error("write_scope_must_be_readable"),
  );
});

test("renamed/deleted paths and forbidden paths remain visible in scope diagnostics", async (t) => {
  const f = await setup(t);
  const row = await f.prepare(scope("rename", ["src"]));
  await fs.mkdir(path.join(row.worker.worktree, "src/private"));
  await fs.rename(
    path.join(row.worker.worktree, "src/a.txt"),
    path.join(row.worker.worktree, "src/private/a.txt"),
  );
  await f.git(row.worker.worktree, "add", "-A");
  const report = await f.workers.inspect();
  assert.deepEqual(report.workers[0].tree.dirty_paths, [
    "src/a.txt",
    "src/private/a.txt",
  ]);
  assert.deepEqual(report.workers[0].tree.scope_violations, [
    "src/private/a.txt",
  ]);
});

test("a missing or reassigned worktree is unavailable, never reported clean", async (t) => {
  const f = await setup(t);
  const row = await f.prepare(scope("missing"));
  await fs.rename(row.worker.worktree, row.worker.worktree + "-retained");
  const report = await f.workers.inspect();
  assert.equal(report.workers[0].tree.status, "unavailable");
  assert.equal(report.workers[0].tree.dirty, null);
  assert.equal((await f.workers.plan(scope("overlap"))).can_prepare, false);
  assert.equal(
    await fs.readFile(
      path.join(row.worker.worktree + "-retained", "src/a.txt"),
      "utf8",
    ),
    "a\n",
  );
});

test("registry corruption and an existing writer lock fail closed without replacing data", async (t) => {
  const f = await setup(t);
  const plan = await f.workers.plan(scope("writer"));
  await fs.mkdir(f.workers.directory, { recursive: true });
  await fs.writeFile(f.workers.lock, "preserved lock");
  await assert.rejects(
    f.workers.prepare(scope("writer"), {
      expectedRevision: 0,
      expectedHead: plan.source.head_sha,
    }),
    error("worker_registry_busy"),
  );
  assert.equal(await fs.readFile(f.workers.lock, "utf8"), "preserved lock");
  await fs.unlink(f.workers.lock);
  await fs.writeFile(f.workers.file, "{corrupt registry");
  await assert.rejects(
    f.workers.inspect(),
    error("worker_registry_unreadable"),
  );
  assert.equal(await fs.readFile(f.workers.file, "utf8"), "{corrupt registry");
});

test("concurrent allocators cannot claim the same revision or overwrite each other", async (t) => {
  const f = await setup(t);
  const other = await WorkerWorkspaces.open(f.project);
  const plan = await f.workers.plan(scope("first"));
  const options = { expectedRevision: 0, expectedHead: plan.source.head_sha };
  const results = await Promise.allSettled([
    f.workers.prepare(scope("first"), options),
    other.prepare(scope("second", ["src/b.txt"]), options),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const blocked = results.find((r) => r.status === "rejected").reason;
  assert.ok(
    ["worker_registry_busy", "worker_registry_revision_changed"].includes(
      blocked.code,
    ),
  );
  assert.equal((await f.workers.inspect()).workers.length, 1);
});

test("the existing CLI allocates/inspects leases and rejects execution or publication options", async (t) => {
  const f = await setup(t);
  const input = path.join(f.root, "worker.json");
  await fs.writeFile(input, JSON.stringify(scope("cli-worker")));
  const env = {
    ...process.env,
    RDSH_DASHBOARD_HOME: path.join(f.root, "cli-state"),
  };
  const run = async (...args) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [cli, "workers", ...args, "--project", f.repo],
          { env, windowsHide: true },
        )
      ).stdout,
    );
  const plan = await run("plan", "--input-file", input);
  const result = await run(
    "prepare",
    "--input-file",
    input,
    "--expected-revision",
    String(plan.revision),
    "--expected-head",
    plan.source.head_sha,
  );
  assert.equal(result.worker.state, "ready");
  assert.equal((await run("inspect")).workers[0].worker_id, "cli-worker");
  await assert.rejects(
    exec(
      process.execPath,
      [
        cli,
        "workers",
        "prepare",
        "--project",
        f.repo,
        "--input-file",
        input,
        "--executable",
        "dsh",
      ],
      { env, windowsHide: true },
    ),
    (e) => e.stderr.includes("Invalid workers action/options"),
  );
  assert.equal(
    await f.git(f.repo, "branch", "--show-current"),
    "fixture-main\n",
  );
  assert.equal((await f.git(f.repo, "remote")).trim(), "");
});
