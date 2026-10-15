import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  parseProcStat,
  procGroupHasLiveMember,
  terminateGroup,
  stopGroup,
  groupAlive,
  scanProcGroup,
  establishOwnership,
  submit,
  status,
  result,
  cancel,
  list,
  waitForJob,
  runnerCatalog,
  sanitizeText,
  cancelWaitMs,
  supervisorStopMs,
  supervise,
} from "../agent-runners.mjs";
import { readProcessIdentity } from "../process-identity.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const SECRET = "SECRET-PROMPT-TEXT-48151623";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-agents-"));
process.env.RDSH_DASHBOARD_HOME = path.join(root, "state");
// Windows keeps a file busy briefly after its process exits; retry the cleanup.
test.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

// The fakes pick their behaviour from `MODE:<name>` in the prompt and never
// echo the prompt, so tests can prove it is not stored in job metadata.
const cursorFake = `const fs = require("fs"), path = require("path"), cp = require("child_process");
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("2026.10.01-fake"); process.exit(0); }
if (a[0] === "status") { console.log("Logged in as someone@example.invalid"); process.exit(0); }
fs.writeFileSync(path.join(__dirname, "argv.json"), JSON.stringify({ argv: a, cwd: process.cwd() }));
const mode = (a[a.length - 1].match(/MODE:(\\w+)/) || [])[1];
const done = (o) => process.stdout.write(JSON.stringify(o));
const stubborn = () => {
  // A descendant in the same group that ignores SIGTERM; wait until it is armed.
  const pidFile = path.join(__dirname, "stubborn.pid");
  const c = cp.spawn(process.execPath, ["-e",
    "process.on('SIGTERM',()=>{});require('fs').writeFileSync(" + JSON.stringify(pidFile) + ",String(process.pid));setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000)"], { stdio: "ignore" });
  c.unref();
  while (!fs.existsSync(pidFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
};
if (mode === "stubborn") stubborn();
if (mode === "slow") {
  const c = cp.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(__dirname, "grandchild.pid"), String(c.pid));

  setInterval(() => {}, 1000);
} else if (mode === "iserror") {
  done({ type: "result", subtype: "error", is_error: true, result: "boom", session_id: "s1" });
} else if (mode === "badjson") process.stdout.write("{nope");
else if (mode === "wrongtype") done({ type: "other" });
else if (mode === "big") process.stdout.write("x".repeat(2 * 1024 * 1024));
else if (mode === "exit3") { console.error("failure detail"); process.exit(3); }
else done({ type: "result", subtype: "success", is_error: false, duration_ms: 7457,
  result: "OK\\u001b[31m\\u0007done", session_id: "5b7c-session", request_id: "r",
  usage: { inputTokens: 11242, outputTokens: 30, cacheReadTokens: 5888, cacheWriteTokens: 0 } });
`;
const devinFake = `const fs = require("fs"), path = require("path"), cp = require("child_process");
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("devin 3000.11.3 (fake)"); process.exit(0); }
if (a[0] === "auth") { console.log("Logged in as someone@example.invalid"); process.exit(0); }
fs.writeFileSync(path.join(__dirname, "argv.json"), JSON.stringify({ argv: a, cwd: process.cwd() }));
const arg = (n) => a[a.indexOf(n) + 1];
const prompt = fs.readFileSync(arg("--prompt-file"), "utf8");
const mode = (prompt.match(/MODE:(\\w+)/) || [])[1];
const exp = arg("--export");
const stubborn = () => {
  // A descendant in the same group that ignores SIGTERM; wait until it is armed.
  const pidFile = path.join(__dirname, "stubborn.pid");
  const c = cp.spawn(process.execPath, ["-e",
    "process.on('SIGTERM',()=>{});require('fs').writeFileSync(" + JSON.stringify(pidFile) + ",String(process.pid));setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000)"], { stdio: "ignore" });
  c.unref();
  while (!fs.existsSync(pidFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
};
if (mode === "stubborn") stubborn();
const good = { schema_version: "ATIF-v1.7", session_id: "feather-louse",
  agent: { name: "devin", version: "3000.11.3", model_name: "SWE-2 High" }, steps: [{}, {}, {}] };
if (mode === "slow") {
  const c = cp.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(__dirname, "grandchild.pid"), String(c.pid));
  setInterval(() => {}, 1000);
} else if (mode === "untrusted") {
  console.error("Error: Refusing to run in an untrusted workspace /secret/path"); process.exit(1);
} else if (mode === "exit3") process.exit(3);
else if (mode === "big") process.stdout.write("y".repeat(2 * 1024 * 1024));
else {
  if (mode === "badexport") fs.writeFileSync(exp, "{broken");
  else if (mode !== "noexport") fs.writeFileSync(exp, JSON.stringify(good));
  if (mode !== "big") process.stdout.write("OK\\n");
}
`;

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(root, "fx-"));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  const write = async (name, body) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, body, { mode: 0o755 });
    return file;
  };
  const f = {
    dir,
    project,
    // Run as `node <fake.cjs>` so the tests work on every OS.
    cursorBin: await write("cursor-fake.cjs", cursorFake),
    devinBin: await write("devin-fake.cjs", devinFake),
    // Directly executable shebang scripts (not runnable on Windows).
    cursorShebang: await write("cursor-agent", "#!/usr/bin/env node\n" + cursorFake),
    devinShebang: await write("devin", "#!/usr/bin/env node\n" + devinFake),
    argv: async () => JSON.parse(await fs.readFile(path.join(dir, "argv.json"), "utf8")),
    prompt: async (mode, extra = "") => {
      const file = path.join(dir, `prompt-${Math.random().toString(16).slice(2)}.txt`);
      await fs.writeFile(file, `MODE:${mode} ${SECRET} ${extra}`);
      return file;
    },
  };
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return f;
}
async function run(f, runner, mode, options = {}) {
  const job = await submit({
    runner,
    project: f.project,
    promptFile: await f.prompt(mode),
    executable: process.execPath,
    entrypoint: runner === "devin" ? f.devinBin : f.cursorBin,
    ...options,
  });
  await waitForJob(job.id, { timeoutMs: 30000 });
  return job;
}
async function gone(pid) {
  for (let i = 0; i < 60; i++) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      return e.code === "ESRCH";
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
async function jobFiles(id) {
  const dir = path.join(process.env.RDSH_DASHBOARD_HOME, "agent-jobs", id);
  return { dir, job: await fs.readFile(path.join(dir, "job.json"), "utf8") };
}
const rejects = (code) => (e) => e.code === code;

test("catalog lists both runners with full permission mappings", () => {
  const catalog = runnerCatalog();
  assert.deepEqual(catalog.map((r) => r.id), ["cursor-agent", "devin"]);
  for (const r of catalog) {
    assert.ok(r.executable && r.version_command && r.login_command);
    assert.deepEqual(Object.keys(r.permissions), ["read-only", "edit", "full"]);
    assert.equal(typeof r.buildArgv, "function");
    assert.equal(typeof r.parse, "function");
  }
});

test("cursor-agent: submit, status, result with parsed fields and clean metadata", async (t) => {
  const f = await fixture(t);
  const job = await submit({
    runner: "cursor-agent",
    project: f.project,
    promptFile: await f.prompt("ok"),
    executable: process.execPath,
    entrypoint: f.cursorBin,
    model: "auto",
  });
  assert.match(job.id, /^job_[a-f0-9]{24}$/);
  assert.equal(job.permission, "read-only");
  assert.equal(job.version, "2026.10.01-fake");
  assert.equal(job.executable, await fs.realpath(process.execPath));
  assert.equal(job.entrypoint, await fs.realpath(f.cursorBin));
  const final = await waitForJob(job.id, { timeoutMs: 30000 });
  assert.equal(final.state, "succeeded");
  // Windows cannot observe descendants of an exited leader: never confirmed.
  assert.equal(final.cleanup, expectedCleanup);
  assert.equal(final.cleanup_code, expectedCleanupCode);
  const res = await result(job.id);
  assert.equal(res.provenance, "untrusted_data");
  assert.equal(res.result.text, "OKdone");
  assert.equal(res.result.session_id, "5b7c-session");
  assert.equal(res.result.duration_ms, 7457);
  assert.deepEqual(res.result.usage, {
    input_tokens: 11242,
    output_tokens: 30,
    cache_read_tokens: 5888,
    cache_write_tokens: 0,
  });
  const seen = await f.argv();
  assert.deepEqual(seen.argv.slice(0, 7), [
    "-p", "--output-format", "json", "--trust", "--workspace", await fs.realpath(f.project), "--model",
  ]);
  assert.ok(seen.argv.join(" ").includes("--mode ask --sandbox enabled"));
  assert.ok(!seen.argv.includes("--force"));
  assert.ok(seen.argv.at(-1).includes(SECRET)); // cursor only takes argv
  assert.equal(seen.cwd, await fs.realpath(f.project));

  const files = await jobFiles(job.id);
  for (const name of ["job.json", "prompt.txt", "stdout", "stderr", "result.json"]) {
    const stat = await fs.stat(path.join(files.dir, name));
    if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600, name);
  }
  if (process.platform !== "win32")
    assert.equal((await fs.stat(files.dir)).mode & 0o777, 0o700);
  const meta = files.job + (await fs.readFile(path.join(files.dir, "result.json"), "utf8"));
  assert.ok(!meta.includes(SECRET));
  assert.ok(!JSON.stringify([job, final, res]).includes(SECRET));
  assert.ok((await fs.readFile(path.join(files.dir, "prompt.txt"), "utf8")).includes(SECRET));
});

test("cursor-agent permission mapping: --force only for full", async (t) => {
  const f = await fixture(t);
  for (const [permission, expected] of [
    ["read-only", ["--mode", "ask", "--sandbox", "enabled"]],
    ["edit", []],
    ["full", ["--force"]],
  ]) {
    await run(f, "cursor-agent", "ok", { permission });
    const { argv } = await f.argv();
    const tail = argv.slice(0, -1).filter((x) => ["--mode", "ask", "--sandbox", "enabled", "--force"].includes(x));
    assert.deepEqual(tail, expected, permission);
  }
});

test("cursor-agent failures map to distinct codes", async (t) => {
  const f = await fixture(t);
  for (const [mode, code] of [
    ["iserror", "agent_error"],
    ["badjson", "invalid_json"],
    ["wrongtype", "invalid_output"],
    ["big", "output_too_large"],
    ["exit3", "nonzero_exit"],
  ]) {
    const job = await run(f, "cursor-agent", mode);
    const info = await status(job.id);
    assert.equal(info.state, "failed", mode);
    assert.equal(info.code, code, mode);
  }
  const files = await jobFiles((await list()).jobs.find((j) => j.code === "output_too_large").id);
  assert.ok((await fs.stat(path.join(files.dir, "stdout"))).size <= 1024 * 1024);
  const agentError = await run(f, "cursor-agent", "iserror");
  assert.equal((await result(agentError.id)).result.text, "boom");
});

test("input validation uses error codes and prompt size is capped for cursor", async (t) => {
  const f = await fixture(t);
  const base = { runner: "cursor-agent", project: f.project, executable: process.execPath, entrypoint: f.cursorBin };
  const prompt = await f.prompt("ok");
  const big = path.join(f.dir, "big.txt");
  await fs.writeFile(big, "a".repeat(100 * 1024 + 1));
  await assert.rejects(submit({ ...base, promptFile: big }), rejects("prompt_too_large"));
  await assert.rejects(submit({ ...base, promptFile: prompt, permission: "root" }), rejects("invalid_permission"));
  await assert.rejects(submit({ ...base, promptFile: prompt, model: "--force" }), rejects("invalid_model"));
  await assert.rejects(submit({ ...base, promptFile: prompt, resume: "-x" }), rejects("invalid_resume"));
  await assert.rejects(submit({ ...base, promptFile: prompt, runner: "gemini" }), rejects("invalid_runner"));
  await assert.rejects(submit({ ...base, promptFile: prompt, project: path.join(f.dir, "nope") }), rejects("invalid_project"));
  await assert.rejects(submit({ ...base, promptFile: prompt, executable: path.join(f.dir, "missing") }), rejects("executable_not_found"));
  for (const entrypoint of [path.join(f.dir, "missing.cjs"), f.dir, "", 5])
    await assert.rejects(submit({ ...base, promptFile: prompt, entrypoint }), rejects("invalid_entrypoint"));
  await assert.rejects(submit({ ...base, promptFile: prompt, trustWorkspace: true }), rejects("trust_workspace_unsupported"));
  await assert.rejects(status("../etc"), rejects("invalid_job_id"));
  await assert.rejects(status("job_" + "0".repeat(24)), rejects("job_not_found"));
});

test("cursor-agent prompt beginning with a dash is not parsed as an option", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "dash.txt");
  await fs.writeFile(file, "--force MODE:ok");
  const job = await submit({ runner: "cursor-agent", project: f.project, promptFile: file, executable: process.execPath, entrypoint: f.cursorBin });
  await waitForJob(job.id, { timeoutMs: 30000 });
  assert.ok(!(await f.argv()).argv.at(-1).startsWith("-"));
});

test("devin: export parsed, argv mapping per permission, trust flag gated", async (t) => {
  const f = await fixture(t);
  const job = await run(f, "devin", "ok", { model: "swe-2-high" });
  const res = await result(job.id);
  assert.equal(res.state, "succeeded");
  assert.equal(res.result.text, "OK\n");
  assert.equal(res.result.export, "available");
  assert.equal(res.result.session_id, "feather-louse");
  assert.equal(res.result.model_name, "SWE-2 High");
  assert.equal(res.result.steps, 3);
  const files = await jobFiles(job.id);
  if (process.platform !== "win32")
    assert.equal((await fs.stat(path.join(files.dir, "export.json"))).mode & 0o777, 0o600);
  let seen = (await f.argv()).argv;
  assert.deepEqual(seen.slice(0, 2), ["-p", "--prompt-file"]);
  assert.equal(seen[2], path.join(files.dir, "prompt.txt"));
  assert.ok(!seen.join(" ").includes(SECRET)); // prompt is a file, never argv
  assert.equal(seen[seen.indexOf("--export") + 1], path.join(files.dir, "export.json"));
  assert.equal(seen[seen.indexOf("--model") + 1], "swe-2-high");
  assert.ok(!seen.includes("--respect-workspace-trust"));
  assert.ok(!files.job.includes(SECRET));

  for (const [permission, mode] of [
    ["read-only", "auto"],
    ["edit", "accept-edits"],
    ["full", "dangerous"],
  ]) {
    await run(f, "devin", "ok", { permission });
    seen = (await f.argv()).argv;
    assert.equal(seen[seen.indexOf("--permission-mode") + 1], mode);
    assert.equal(seen.includes("dangerous"), permission === "full");
  }
  await run(f, "devin", "ok", { trustWorkspace: true, resume: "feather-louse" });
  seen = (await f.argv()).argv;
  assert.deepEqual(seen.slice(seen.indexOf("--respect-workspace-trust"), seen.indexOf("--respect-workspace-trust") + 2), ["--respect-workspace-trust", "false"]);
  assert.equal(seen[seen.indexOf("--resume") + 1], "feather-louse");
});

test("devin: missing or broken export still succeeds as unavailable", async (t) => {
  const f = await fixture(t);
  for (const mode of ["noexport", "badexport"]) {
    const job = await run(f, "devin", mode);
    const res = await result(job.id);
    assert.equal(res.state, "succeeded", mode);
    assert.equal(res.result.export, "unavailable", mode);
    assert.equal(res.result.text, "OK\n");
    assert.equal(res.result.session_id, null);
  }
});

test("devin: untrusted workspace is classified without leaking stderr", async (t) => {
  const f = await fixture(t);
  const job = await run(f, "devin", "untrusted");
  const info = await status(job.id);
  assert.equal(info.state, "failed");
  assert.equal(info.code, "workspace_untrusted");
  const files = await jobFiles(job.id);
  const stored = await fs.readFile(path.join(files.dir, "result.json"), "utf8");
  assert.ok(!stored.includes("/secret/path") && !stored.includes("Refusing"));
  assert.ok((await fs.readFile(path.join(files.dir, "stderr"), "utf8")).includes("Refusing"));
  assert.equal((await status((await run(f, "devin", "exit3")).id)).code, "nonzero_exit");
  const big = await result((await run(f, "devin", "big")).id);
  assert.equal(big.state, "succeeded");
  assert.equal(big.stdout_truncated, true);
});

for (const [runner, bin] of [
  ["cursor-agent", "cursorBin"],
  ["devin", "devinBin"],
]) {
  test(`${runner}: cancel terminates the agent and its descendants`, async (t) => {
    const f = await fixture(t);
    const job = await submit({
      runner,
      project: f.project,
      promptFile: await f.prompt("slow"),
      executable: process.execPath,
      entrypoint: f[bin],
    });
    const pidFile = path.join(f.dir, "grandchild.pid");
    for (let i = 0; i < 200; i++) {
      if (await fs.access(pidFile).then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const grandchild = Number(await fs.readFile(pidFile, "utf8"));
    const running = await status(job.id);
    assert.equal(running.state, "running");
    let agent_pid;
    for (let i = 0; i < 100 && !agent_pid; i++) {
      agent_pid = JSON.parse((await jobFiles(job.id)).job).agent_pid;
      if (!agent_pid) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(agent_pid, "supervisor recorded the agent pid");
    const info = await cancel(job.id, { termMs: 3000, killMs: 3000 });
    assert.equal(info.state, "cancelled");
    assert.ok(await gone(grandchild), "descendant is gone");
    assert.ok(await gone(agent_pid), "agent is gone");
    assert.equal((await status(job.id)).state, "cancelled");
    assert.equal(info.cleanup, expectedCleanup);
    assert.equal(info.cleanup_code, expectedCleanupCode);
    assert.equal((await cancel(job.id)).state, "cancelled"); // idempotent
  });
}

test("a dead supervisor without a result is reported as supervisor_lost", async (t) => {
  const f = await fixture(t);
  const dead = (await import("node:child_process")).spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => dead.once("exit", r));
  const id = "job_" + "ab".repeat(12);
  const dir = path.join(process.env.RDSH_DASHBOARD_HOME, "agent-jobs", id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, "job.json"), JSON.stringify({
    id, runner: "devin", project: f.project, permission: "read-only",
    created_at: new Date().toISOString(), started_at: new Date().toISOString(),
    supervisor_pid: dead.pid, state: "running",
  }));
  const info = await status(id);
  assert.equal(info.state, "failed");
  assert.equal(info.code, "supervisor_lost");
});

// POSIX verifies the process group gone; win32 can only see the leader PID.
const expectedCleanup = process.platform === "win32" ? "unconfirmed" : "confirmed";
const expectedCleanupCode = process.platform === "win32" ? "windows_tree_unobservable" : null;
const identityPlatform = ["linux", "darwin", "win32"].includes(process.platform);
const posixOnly = { skip: process.platform === "win32" && "process groups are POSIX only" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForFile(file) {
  for (let i = 0; i < 200; i++) {
    if (await fs.access(file).then(() => true, () => false)) return;
    await sleep(50);
  }
  throw new Error("timeout waiting for " + file);
}

for (const [runner, bin] of [
  ["cursor-agent", "cursorBin"],
  ["devin", "devinBin"],
]) {
  test(`${runner}: a TERM-ignoring descendant after success is killed and the stop confirmed`, posixOnly, async (t) => {
    const f = await fixture(t);
    const job = await submit({
      runner,
      project: f.project,
      promptFile: await f.prompt("stubborn"),
      executable: process.execPath,
      entrypoint: f[bin],
    });
    const final = await waitForJob(job.id, { timeoutMs: 30000 });
    assert.equal(final.state, "succeeded");
    assert.equal(final.cleanup, "confirmed");
    assert.equal(final.agent_group_alive, false);
    const pid = Number(await fs.readFile(path.join(f.dir, "stubborn.pid"), "utf8"));
    assert.ok(await gone(pid), "TERM-ignoring descendant was escalated to KILL");
    assert.equal((await result(job.id)).cleanup, "confirmed");
  });
}

test("cancel after supervisor_lost kills the still-running agent group", posixOnly, async (t) => {
  const f = await fixture(t);
  const job = await submit({
    runner: "cursor-agent",
    project: f.project,
    promptFile: await f.prompt("slow"),
    executable: process.execPath,
    entrypoint: f.cursorBin,
  });
  const pidFile = path.join(f.dir, "grandchild.pid");
  await waitForFile(pidFile);
  const grandchild = Number(await fs.readFile(pidFile, "utf8"));
  // The grandchild can start before the supervisor records the agent group.
  let recorded = JSON.parse((await jobFiles(job.id)).job);
  for (let i = 0; i < 100 && !(recorded.agent_pgid && (recorded.agent_identity || !identityPlatform)); i++) {
    await sleep(50);
    recorded = JSON.parse((await jobFiles(job.id)).job);
  }
  const { supervisor_pid, agent_pid, agent_pgid } = recorded;
  assert.ok(agent_pgid);
  process.kill(supervisor_pid, "SIGKILL");
  assert.ok(await gone(supervisor_pid));
  const lost = await status(job.id);
  assert.equal(lost.state, "failed");
  assert.equal(lost.code, "supervisor_lost");
  assert.equal(lost.cleanup, "unconfirmed");
  assert.equal(lost.agent_group_alive, true);
  assert.ok(groupAlive(agent_pgid));
  if (!identityPlatform) {
    // No process identity on this platform: a group is never signalled by number.
    t.after(() => { try { process.kill(-agent_pgid, "SIGKILL"); } catch {} });
    await assert.rejects(cancel(job.id, { termMs: 300, killMs: 300 }), { code: "cancel_unconfirmed" });
    assert.ok(groupAlive(agent_pgid), "no signal was sent");
    const after = await status(job.id);
    assert.equal(after.cleanup, "unconfirmed");
    assert.equal(after.cleanup_code, "ownership_unknown");
    return;
  }
  const info = await cancel(job.id, { termMs: 3000, killMs: 3000 });
  assert.equal(info.state, "cancelled");
  assert.equal(info.cleanup, "confirmed");
  assert.equal(info.agent_group_alive, false);
  assert.ok(await gone(agent_pid), "agent is gone");
  assert.ok(await gone(grandchild), "descendant is gone");
});

test("cancel acts on leftover processes of an already finished job", posixOnly, async (t) => {
  const f = await fixture(t);
  const leftover = (await import("node:child_process")).spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),30000)"],
    { detached: true, stdio: "ignore" },
  );
  t.after(() => { try { process.kill(-leftover.pid, "SIGKILL"); } catch {} });
  await sleep(300); // let the TERM handler arm
  const id = "job_" + "cd".repeat(12);
  const dir = path.join(process.env.RDSH_DASHBOARD_HOME, "agent-jobs", id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const agent_identity = (await readProcessIdentity(leftover.pid)).identity;
  await fs.writeFile(path.join(dir, "job.json"), JSON.stringify({
    id, runner: "devin", project: f.project, permission: "read-only", created_at: now,
    started_at: now, supervisor_pid: 1, agent_pid: leftover.pid, agent_pgid: leftover.pid,
    agent_identity, state: "succeeded",
  }));
  await fs.writeFile(path.join(dir, "result.json"), JSON.stringify({
    state: "succeeded", code: null, finished_at: now, parsed: null, cleanup: "unconfirmed",
  }));
  assert.equal((await status(id)).agent_group_alive, true);
  if (!agent_identity) {
    await assert.rejects(cancel(id, { termMs: 300, killMs: 300 }), { code: "cancel_unconfirmed" });
    assert.ok(groupAlive(leftover.pid), "no signal without ownership");
    assert.equal((await status(id)).cleanup_code, "ownership_unknown");
    return;
  }
  const info = await cancel(id, { termMs: 500, killMs: 3000 });
  assert.equal(info.state, "succeeded"); // the recorded outcome is kept
  assert.equal(info.cleanup, "confirmed");
  assert.equal(info.agent_group_alive, false);
  assert.ok(await gone(leftover.pid));
});

test("win32 stop: never confirmed; taskkill /T /F only while the leader is alive", async () => {
  const calls = [];
  const taskkill = async (pid) => { calls.push(pid); return true; };
  // Leader exited: the tree cannot be observed, nothing is killed.
  const gone = await stopGroup(4242, { platform: "win32", taskkill, isAlive: () => false });
  assert.deepEqual(gone, { cleanup: "unconfirmed", code: "windows_tree_unobservable" });
  assert.deepEqual(calls, []);
  // Leader alive: the tree is killed (awaited), the result still unconfirmed.
  const live = await stopGroup(4242, { platform: "win32", taskkill, isAlive: () => true });
  assert.deepEqual(live, { cleanup: "unconfirmed", code: "windows_tree_unobservable" });
  assert.deepEqual(calls, [4242]);
  // taskkill itself failed: a distinct code.
  const failed = await stopGroup(4242, { platform: "win32", taskkill: async () => false, isAlive: () => true });
  assert.deepEqual(failed, { cleanup: "unconfirmed", code: "windows_taskkill_failed" });
  assert.equal(await terminateGroup(4242, { platform: "win32", taskkill, isAlive: () => false }), "unconfirmed");
  // No group recorded: nothing to stop.
  assert.deepEqual(await stopGroup(null, { platform: "win32", taskkill }), { cleanup: "confirmed" });
});

test("win32 cancel: a terminal job with the leader gone stays unconfirmed and signals nothing", async () => {
  const calls = [];
  const taskkill = async (pid) => { calls.push(pid); return true; };
  const id = "job_" + "f1".repeat(12);
  await writeJob(id, { agent_pid: 2 ** 22 + 777, agent_pgid: 2 ** 22 + 777 }, { cleanup: "unconfirmed", cleanup_code: "windows_tree_unobservable" });
  const info = await cancel(id, { termMs: 100, killMs: 100, platform: "win32", taskkill });
  assert.equal(info.cleanup, "unconfirmed");
  assert.equal(info.cleanup_code, "windows_tree_unobservable");
  assert.deepEqual(calls, []);
});

test("win32 cancel: a lost supervisor with the leader gone is left unconfirmed, not promoted to confirmed", async () => {
  const calls = [];
  const taskkill = async (pid) => { calls.push(pid); return true; };
  const id = "job_" + "f2".repeat(12);
  await writeJob(id, { agent_pid: 2 ** 22 + 778, agent_pgid: 2 ** 22 + 778, state: "failed" }, { state: "failed", code: "supervisor_lost", cleanup: "unconfirmed" });
  const info = await cancel(id, { termMs: 100, killMs: 100, platform: "win32", taskkill });
  assert.equal(info.code, "supervisor_lost");
  assert.equal(info.cleanup, "unconfirmed");
  assert.deepEqual(calls, []);
});

test("terminateGroup treats a missing group as confirmed", async () => {
  assert.equal(await terminateGroup(null), "confirmed");
  // win32 sees only the leader PID, so a non-null group is never confirmed there.
  assert.equal(await terminateGroup(2 ** 22 + 12345), expectedCleanup);
});

test("/proc parser: zombie-only groups are not alive, comm may contain parentheses", async (t) => {
  assert.deepEqual(parseProcStat("12 (a) b (c) S 1 50 50 0"), { state: "S", ppid: 1, pgrp: 50, starttime: null });
  assert.equal(parseProcStat("garbage"), null);
  const proc = await fs.mkdtemp(path.join(root, "proc-"));
  t.after(() => fs.rm(proc, { recursive: true, force: true }));
  const entry = async (pid, line) => {
    await fs.mkdir(path.join(proc, String(pid)));
    await fs.writeFile(path.join(proc, String(pid), "stat"), line);
  };
  await entry(10, "10 (sh) Z 1 50 50 0 -1");
  await entry(11, "11 (worker) S 1 60 60 0 -1");
  await entry(12, "12 (my (odd) name) X 1 70 70 0 -1");
  await fs.mkdir(path.join(proc, "13")); // vanished: no stat file
  await fs.mkdir(path.join(proc, "self"));
  assert.equal(procGroupHasLiveMember(50, proc), false); // zombie only
  assert.equal(procGroupHasLiveMember(60, proc), true);
  assert.equal(procGroupHasLiveMember(70, proc), false); // dead
  assert.equal(procGroupHasLiveMember(99, proc), false);
  await entry(14, "14 (live one) R 10 50 50 0 -1");
  assert.equal(procGroupHasLiveMember(50, proc), true); // one live member among zombies
  assert.equal(procGroupHasLiveMember(50, path.join(proc, "missing")), undefined); // no /proc
});

test("a relative state home still works for devin (job files are absolute)", async (t) => {
  const f = await fixture(t);
  const home = path.join(f.dir, "rel-state");
  const relative = path.relative(process.cwd(), home);
  if (path.isAbsolute(relative)) return t.skip("no relative path to the temp directory");
  const before = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = relative;
  try {
    const job = await run(f, "devin", "ok");
    const res = await result(job.id);
    assert.equal(res.state, "succeeded");
    assert.equal(res.result.export, "available");
    const { argv } = await f.argv();
    assert.ok(path.isAbsolute(argv[argv.indexOf("--prompt-file") + 1]));
    assert.ok(path.isAbsolute(argv[argv.indexOf("--export") + 1]));
    assert.equal(argv[argv.indexOf("--prompt-file") + 1], path.join(path.resolve(home), "agent-jobs", job.id, "prompt.txt"));
  } finally {
    process.env.RDSH_DASHBOARD_HOME = before;
  }
});

const noShebang = { skip: process.platform === "win32" && "shebang scripts are not executable on Windows" };

test("a directly executable shebang script works without an entrypoint", noShebang, async (t) => {
  const f = await fixture(t);
  const job = await submit({
    runner: "cursor-agent",
    project: f.project,
    promptFile: await f.prompt("ok"),
    executable: f.cursorShebang,
  });
  assert.equal(job.entrypoint, null);
  assert.equal(job.executable, await fs.realpath(f.cursorShebang));
  assert.equal((await waitForJob(job.id, { timeoutMs: 30000 })).state, "succeeded");
});

test("list --probe reports version and a login boolean only", noShebang, async (t) => {
  const f = await fixture(t);
  const before = process.env.PATH;
  process.env.PATH = f.dir + path.delimiter + before;
  try {
    const plain = await list();
    assert.equal(plain.runners.length, 2);
    assert.ok(!("version" in plain.runners[0]));
    const probed = await list({ probe: true });
    const cursor = probed.runners.find((r) => r.id === "cursor-agent");
    const devin = probed.runners.find((r) => r.id === "devin");
    assert.equal(cursor.version, "2026.10.01-fake");
    assert.equal(devin.version, "devin 3000.11.3 (fake)");
    assert.equal(cursor.logged_in, true);
    assert.equal(devin.logged_in, true);
    assert.ok(!JSON.stringify(probed).includes("example.invalid"));
  } finally {
    process.env.PATH = before;
  }
  process.env.PATH = path.join(f.dir, "empty");
  try {
    const probed = await list({ probe: true });
    assert.equal(probed.runners[0].resolved_executable, null);
    assert.equal(probed.runners[0].probe_error, "executable_not_found");
  } finally {
    process.env.PATH = before;
  }
});

test("sanitizeText strips ANSI and control characters but keeps newline and tab", () => {
  assert.equal(sanitizeText("a\x1b[1;31mb\x00c\x07\td\ne\x7f"), "abc\td\ne");
  assert.equal(sanitizeText("x".repeat(10), 4), "xxxx");
});

test("CLI end-to-end with fake agents", async (t) => {
  const f = await fixture(t);
  const env = { ...process.env, RDSH_DASHBOARD_HOME: path.join(f.dir, "cli-state") };
  const node = (...args) => exec(process.execPath, [cli, "agents", ...args], { env });
  const promptFile = await f.prompt("ok");
  const submitted = JSON.parse(
    (await node("submit", "--agent", "devin", "--project", f.project, "--prompt-file", promptFile, "--executable", process.execPath, "--entrypoint", f.devinBin, "--permission", "edit")).stdout,
  );
  assert.match(submitted.id, /^job_/);
  assert.equal(submitted.permission, "edit");
  let info;
  for (let i = 0; i < 200; i++) {
    info = JSON.parse((await node("status", submitted.id)).stdout);
    if (info.state === "succeeded") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(info.state, "succeeded");
  const res = JSON.parse((await node("result", submitted.id)).stdout);
  assert.equal(res.result.session_id, "feather-louse");
  assert.equal(res.provenance, "untrusted_data");

  const waited = await node("submit", "--agent", "cursor-agent", "--project", f.project, "--prompt-file", promptFile, "--executable", process.execPath, "--entrypoint", f.cursorBin, "--wait");
  assert.ok(!waited.stdout.includes(SECRET));
  assert.equal(JSON.parse(waited.stdout).result.text, "OKdone");

  const failing = await node("submit", "--agent", "cursor-agent", "--project", f.project, "--prompt-file", await f.prompt("exit3"), "--executable", process.execPath, "--entrypoint", f.cursorBin, "--wait").catch((e) => e);
  assert.equal(failing.code, 1);
  assert.equal(JSON.parse(failing.stdout).code, "nonzero_exit");

  const listed = JSON.parse((await node("list")).stdout);
  assert.equal(listed.jobs.length, 3);
  const cancelled = JSON.parse((await node("cancel", submitted.id)).stdout);
  assert.equal(cancelled.state, "succeeded"); // finished jobs are left alone

  await assert.rejects(node("submit", "--agent", "gemini", "--project", f.project, "--prompt-file", promptFile), (e) => /invalid_runner/.test(e.stderr));
  await assert.rejects(node("frobnicate"), (e) => /Invalid agents action/.test(e.stderr));
  await assert.rejects(node("submit", "--agent", "devin"), (e) => /requires --agent/.test(e.stderr));
});

// --- ownership of a recorded process group number -------------------------

async function writeJob(id, job, resultValue) {
  const dir = path.join(process.env.RDSH_DASHBOARD_HOME, "agent-jobs", id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  await fs.writeFile(path.join(dir, "job.json"), JSON.stringify({
    id, runner: "devin", project: root, permission: "read-only", created_at: now,
    started_at: now, supervisor_pid: 1, state: "succeeded", ...job,
  }));
  await fs.writeFile(path.join(dir, "result.json"), JSON.stringify({
    state: "succeeded", code: null, finished_at: now, parsed: null, ...resultValue,
  }));
}
function unrelatedGroup(t) {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
    detached: true,
    stdio: "ignore",
  });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  return child;
}

test("cancel on a terminal, confirmed job sends nothing to a reused group number", posixOnly, async (t) => {
  const stranger = unrelatedGroup(t);
  await sleep(200);
  const id = "job_" + "e1".repeat(12);
  await writeJob(id, { agent_pid: stranger.pid, agent_pgid: stranger.pid, agent_identity: null }, { cleanup: "confirmed" });
  const info = await cancel(id, { termMs: 300, killMs: 300 });
  assert.equal(info.state, "succeeded");
  assert.equal(info.cleanup, "confirmed");
  assert.equal(info.agent_group_alive, false); // reported without probing the number
  await sleep(400);
  assert.ok(groupAlive(stranger.pid), "the unrelated group was not signalled");
  assert.equal(stranger.exitCode, null);
  assert.equal(stranger.signalCode, null);
});

test("an unconfirmed job without a recorded identity is never signalled by number", posixOnly, async (t) => {
  const stranger = unrelatedGroup(t);
  await sleep(200);
  const id = "job_" + "e2".repeat(12);
  await writeJob(id, { agent_pid: stranger.pid, agent_pgid: stranger.pid }, { cleanup: "unconfirmed" });
  await assert.rejects(cancel(id, { termMs: 300, killMs: 300 }), { code: "cancel_unconfirmed" });
  await sleep(300);
  assert.equal(stranger.signalCode, null);
  assert.ok(groupAlive(stranger.pid));
  const info = await status(id);
  assert.equal(info.cleanup, "unconfirmed");
  assert.equal(info.cleanup_code, "ownership_unknown");
});

test("cancel: a reused number (pid_reused) is not signalled and is recorded as pgid_reused", { skip: process.platform !== "linux" && "needs /proc process identity" }, async (t) => {
  const stranger = unrelatedGroup(t);
  await sleep(200);
  const real = (await readProcessIdentity(stranger.pid)).identity;
  const identity = { ...real, birth: String(BigInt(real.birth) + 1000n) }; // another incarnation
  const id = "job_" + "e3".repeat(12);
  await writeJob(id, { agent_pid: stranger.pid, agent_pgid: stranger.pid, agent_identity: identity }, { cleanup: "unconfirmed" });
  const info = await cancel(id, { termMs: 300, killMs: 300 });
  assert.equal(info.cleanup, "unconfirmed");
  assert.equal(info.cleanup_code, "pgid_reused");
  await sleep(300);
  assert.equal(stranger.signalCode, null);
  assert.ok(groupAlive(stranger.pid));
});

test("establishOwnership: only a matching live leader is owned", async () => {
  const scope = "a".repeat(64);
  const identity = { platform: "linux", pid: 500, birth: "1000", scope };
  const observed = (birth, pid = 500) => ({ status: "observed", identity: { platform: "linux", pid, birth, scope } });
  const gone = { status: "gone", identity: null, platform: "linux", scope };
  const check = (read, id = identity) => establishOwnership(500, id, { read });
  assert.equal(await check(async () => observed("1000")), "owned");
  assert.equal(await check(async () => observed("2000")), "pid_reused");
  assert.equal(await check(async () => ({ status: "unknown", identity: null })), "unknown");
  assert.equal(await check(async () => observed("1000"), null), "unknown"); // nothing recorded
  // Leader gone is never owned, whatever the remaining members look like.
  assert.equal(await check(async () => gone), "unknown");
});

test("cancel never revives ownership of a recycled group from its members (leader gone)", { skip: process.platform !== "linux" && "needs /proc process identity" }, async (t) => {
  // A new group whose leader is alive, then whose leader exits leaving children.
  const script = "const {spawn}=require('node:child_process');" +
    "spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'}).unref();" +
    "process.stdout.write('ready\\n');setTimeout(()=>process.exit(0),1500);";
  const leader = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { try { process.kill(-leader.pid, "SIGKILL"); } catch {} });
  await new Promise((resolve) => leader.stdout.once("data", resolve));
  const real = (await readProcessIdentity(leader.pid)).identity;
  // The old, lost job's recorded birth predates this group entirely.
  const identity = { ...real, birth: "1" };
  const id = "job_" + "e4".repeat(12);
  await writeJob(id, { agent_pid: leader.pid, agent_pgid: leader.pid, agent_identity: identity }, { cleanup: "unconfirmed" });

  // Leader alive: a different incarnation, no signal.
  const reused = await cancel(id, { termMs: 300, killMs: 300 });
  assert.equal(reused.cleanup_code, "pgid_reused");
  assert.equal(leader.signalCode, null);

  // Leader exited, children remain: still no signal, and they survive.
  await new Promise((resolve) => leader.once("exit", resolve));
  assert.ok(groupAlive(leader.pid), "children keep the group alive");
  await assert.rejects(cancel(id, { termMs: 300, killMs: 300 }), { code: "cancel_unconfirmed" });
  const info = await status(id);
  assert.equal(info.cleanup, "unconfirmed");
  assert.equal(info.cleanup_code, "ownership_unknown");
  await sleep(300);
  assert.ok(groupAlive(leader.pid), "the unrelated children were not signalled");
});

test("/proc scanner: only ENOENT is gone; EACCES and garbage are unknown", async (t) => {
  const proc = await fs.mkdtemp(path.join(root, "scan-"));
  t.after(async () => {
    await fs.chmod(path.join(proc, "20", "stat"), 0o600).catch(() => {});
    await fs.rm(proc, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(proc, "10")); // vanished: stat missing -> ENOENT
  assert.equal(procGroupHasLiveMember(60, proc), false);
  assert.equal(groupAlive(2 ** 22 + 777, proc), false);
  await fs.mkdir(path.join(proc, "20"));
  await fs.writeFile(path.join(proc, "20", "stat"), "20 (x) S 1 60 60 0 -1");
  assert.equal(procGroupHasLiveMember(60, proc), true);
  await fs.writeFile(path.join(proc, "20", "stat"), "garbage");
  assert.equal(procGroupHasLiveMember(60, proc), "unknown");
  assert.equal(scanProcGroup(60, proc).unknown, true);
  const unreadable = process.platform === "win32" || (process.getuid && process.getuid() === 0);
  if (unreadable) return t.diagnostic("EACCES case skipped (root or Windows)");
  await fs.writeFile(path.join(proc, "20", "stat"), "20 (x) S 1 60 60 0 -1");
  await fs.chmod(path.join(proc, "20", "stat"), 0o000);
  assert.equal(procGroupHasLiveMember(60, proc), "unknown");
  // A live member elsewhere still wins over an unreadable entry.
  await fs.mkdir(path.join(proc, "21"));
  await fs.writeFile(path.join(proc, "21", "stat"), "21 (y) S 1 60 60 0 -1");
  assert.equal(procGroupHasLiveMember(60, proc), true);
});

test("groupAlive treats an unreadable /proc as possibly alive and falls back to kill(-pgid, 0)", posixOnly, async (t) => {
  const proc = await fs.mkdtemp(path.join(root, "unk-"));
  t.after(() => fs.rm(proc, { recursive: true, force: true }));
  await fs.mkdir(path.join(proc, "30"));
  await fs.writeFile(path.join(proc, "30", "stat"), "garbage"); // makes the scan "unknown"
  const live = unrelatedGroup(t);
  await sleep(200);
  assert.equal(procGroupHasLiveMember(live.pid, proc), "unknown");
  assert.equal(groupAlive(live.pid, proc), true); // kill(-pgid, 0) sees the group
  process.kill(-live.pid, "SIGKILL");
  await new Promise((r) => live.once("exit", r));
  assert.equal(groupAlive(live.pid, proc), false); // ESRCH establishes absence
});

test("cancel waits at least the supervisor's whole stop budget for a running job", () => {
  // One taskkill (10 s) plus the 2 s pipe grace must fit, and so must two
  // POSIX TERM/KILL rounds (2 x 5 s) plus the grace.
  assert.ok(supervisorStopMs() >= 10000 + 2000);
  assert.ok(supervisorStopMs() >= 2 * (2000 + 3000) + 2000);
  assert.equal(cancelWaitMs({ running: true, termMs: 3000, killMs: 3000 }), supervisorStopMs());
  assert.equal(cancelWaitMs({ running: true, termMs: 60000, killMs: 60000 }), 123000);
  // A terminal job is not waited on through the supervisor.
  assert.equal(cancelWaitMs({ running: false, termMs: 3000, killMs: 3000 }), 9000);
});

// Supervisor failure paths: supervise() is driven directly, with injected I/O,
// on a hand-made job directory (no real supervisor is spawned for it).
async function manualJob(t, mode) {
  const f = await fixture(t);
  const directory = path.join(process.env.RDSH_DASHBOARD_HOME, "agent-jobs", "job_" + path.basename(f.dir));
  await fs.mkdir(directory, { recursive: true });
  await fs.copyFile(await f.prompt(mode), path.join(directory, "prompt.txt"));
  const job = {
    id: path.basename(directory),
    runner: "cursor-agent",
    project: f.project,
    permission: "read-only",
    executable: process.execPath,
    entrypoint: f.cursorBin,
    agent_pid: null,
    agent_pgid: null,
    state: "queued",
  };
  await fs.writeFile(path.join(directory, "job.json"), JSON.stringify(job));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { f, directory };
}
// Counts sink fds still open; `fail` decides which writeJson / writeSync calls throw.
function seam({ failJson = () => false, failWrite = false } = {}) {
  const open = new Set();
  const seen = { pid: null }; // the agent pid, as the supervisor recorded it
  const eio = () => Object.assign(new Error("EIO"), { code: "EIO" });
  return {
    open,
    seen,
    deps: {
      writeJson: async (file, value) => {
        if (value.agent_pid) seen.pid = value.agent_pid;
        if (failJson(file, value)) throw eio();
        await fs.writeFile(file, JSON.stringify(value));
      },
      openSync: (...a) => {
        const fd = fsSync.openSync(...a);
        open.add(fd);
        return fd;
      },
      writeSync: (fd, ...a) => {
        if (failWrite) throw eio();
        return fsSync.writeSync(fd, ...a);
      },
      closeSync: (fd) => {
        open.delete(fd);
        fsSync.closeSync(fd);
      },
    },
  };
}
const afterSpawn = (file, value) => path.basename(file) === "job.json" && value.agent_pid;
const readResult = (directory) =>
  fs.readFile(path.join(directory, "result.json"), "utf8").then(JSON.parse, () => null);
const expectedStop = process.platform === "win32" ? "unconfirmed" : "confirmed";

test("supervise: a failed job.json write after spawn stops the agent and records supervisor_init_failed", async (t) => {
  const { directory } = await manualJob(t, "slow");
  const io = seam({ failJson: afterSpawn });
  await supervise(directory, io.deps);
  assert.ok(await gone(io.seen.pid), "agent is stopped");
  assert.equal(io.open.size, 0, "both sinks closed");
  const r = await readResult(directory);
  assert.equal(r.state, "failed");
  assert.equal(r.code, "supervisor_init_failed");
  assert.equal(r.cleanup, expectedStop);
});

test("supervise: when the result cannot be written either, the agent is still stopped", async (t) => {
  const { directory } = await manualJob(t, "slow");
  let spawned = false;
  const io = seam({
    failJson: (file, value) => {
      if (afterSpawn(file, value)) spawned = true;
      return spawned;
    },
  });
  await supervise(directory, io.deps); // resolves instead of rejecting
  assert.ok(await gone(io.seen.pid), "agent is stopped");
  assert.equal(io.open.size, 0, "both sinks closed");
  assert.equal(await readResult(directory), null);
});

test("supervise: a sink write failure stops the agent and records output_write_failed", async (t) => {
  const { directory } = await manualJob(t, "big");
  const io = seam({ failWrite: true });
  await supervise(directory, io.deps);
  const r = await readResult(directory);
  assert.equal(r.state, "failed");
  assert.equal(r.code, "output_write_failed");
  assert.equal(r.cleanup, expectedStop);
  assert.equal(io.open.size, 0, "both sinks closed");
});
