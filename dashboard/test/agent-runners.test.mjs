import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  submit,
  status,
  result,
  cancel,
  list,
  waitForJob,
  runnerCatalog,
  sanitizeText,
} from "../agent-runners.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const SECRET = "SECRET-PROMPT-TEXT-48151623";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-agents-"));
process.env.RDSH_DASHBOARD_HOME = path.join(root, "state");
test.after(() => fs.rm(root, { recursive: true, force: true }));

// The fakes pick their behaviour from `MODE:<name>` in the prompt and never
// echo the prompt, so tests can prove it is not stored in job metadata.
const cursorFake = `const fs = require("fs"), path = require("path"), cp = require("child_process");
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("2026.10.01-fake"); process.exit(0); }
if (a[0] === "status") { console.log("Logged in as someone@example.invalid"); process.exit(0); }
fs.writeFileSync(path.join(__dirname, "argv.json"), JSON.stringify({ argv: a, cwd: process.cwd() }));
const mode = (a[a.length - 1].match(/MODE:(\\w+)/) || [])[1];
const done = (o) => process.stdout.write(JSON.stringify(o));
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
  assert.ok(seen.argv.join(" ").includes("--mode ask"));
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
    ["read-only", ["--mode", "ask"]],
    ["edit", []],
    ["full", ["--force"]],
  ]) {
    await run(f, "cursor-agent", "ok", { permission });
    const { argv } = await f.argv();
    const tail = argv.slice(0, -1).filter((x) => ["--mode", "ask", "--force"].includes(x));
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
    const { agent_pid } = JSON.parse((await jobFiles(job.id)).job);
    const info = await cancel(job.id, { termMs: 3000, killMs: 3000 });
    assert.equal(info.state, "cancelled");
    assert.ok(await gone(grandchild), "descendant is gone");
    assert.ok(await gone(agent_pid), "agent is gone");
    assert.equal((await status(job.id)).state, "cancelled");
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
