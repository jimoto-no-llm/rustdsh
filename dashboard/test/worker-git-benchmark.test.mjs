import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const benchmark = path.join(root, "scripts", "bench-worker-git.mjs");

function run(binary, env = {}) {
  return spawnSync(process.execPath, [benchmark], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      RDSH_BENCH_BIN: binary,
      ...env,
    },
  });
}

async function fakeRdsh(t, body) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-worker-git-benchmark-"));
  const executable = path.join(fixture, "rdsh");
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node\n${typeof body === "function" ? body(executable) : body}\n`,
  );
  await fs.chmod(executable, 0o755);
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  return executable;
}

const capableWorkerGit = String.raw`
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const dirty = (root) => execFileSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8" }).split("\0").filter(Boolean).map((row) => row.slice(3)).sort();
if (process.argv[2] === "worker-git" && process.argv[3] === "--help") {
  console.log("Internal JSON bridge for dashboard Git observations");
  process.exit(0);
}
if (process.argv[2] !== "worker-git") process.exit(2);
if (__MARKER__) fs.appendFileSync(__MARKER__, process.argv[1] + "\n");
if (__REPLACE_SOURCE__) fs.appendFileSync(__REPLACE_SOURCE__, "\n// source binary replaced during benchmark\n");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
const repository = (root) => ({
  root: fs.realpathSync(root),
  git_common_dir: fs.realpathSync(require("node:path").resolve(root, git(root, "rev-parse", "--git-common-dir"))),
  head_sha: git(root, "rev-parse", "--verify", "HEAD"),
  branch: (() => { try { return git(root, "symbolic-ref", "--quiet", "--short", "HEAD"); } catch { return null; } })(),
});
let response;
if (request.op === "repository") response = repository(request.root);
else if (request.op === "dirty-paths") response = dirty(request.root);
else if (request.op === "source-snapshot") response = { ...repository(request.root), dirty_paths: dirty(request.root) };
else if (request.op === "observe-worktree") response = { head_sha: repository(request.root).head_sha, dirty_paths: dirty(request.root), committed_paths: [], changed_paths: dirty(request.root) };
else process.exit(3);
process.stdout.write(JSON.stringify(response));
`;

function median(samples) {
  return [...samples].sort((left, right) => left - right)[
    Math.floor(samples.length / 2)
  ];
}

test("benchmark CLI rejects a missing native binary before producing measurements", () => {
  const result = run(path.join(os.tmpdir(), `missing-rdsh-benchmark-${process.pid}`));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RDSH_BENCH_BIN must support worker-git/);
  assert.equal(result.stdout, "");
});

test("benchmark CLI rejects an unsupported executable before producing measurements", () => {
  const result = run(process.execPath);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RDSH_BENCH_BIN must support worker-git/);
  assert.equal(result.stdout, "");
});

test("benchmark CLI fails when a capable native binary fails a request", {
  skip: process.platform === "win32",
}, async (t) => {
  const executable = await fakeRdsh(t, String.raw`
if (process.argv[2] === "worker-git" && process.argv[3] === "--help") {
  console.log("Internal JSON bridge for dashboard Git observations");
  process.exit(0);
}
process.stderr.write("native request failed\\n");
process.exit(23);
`);
  const result = run(executable);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /native request failed/);
  assert.match(result.stdout, /"benchmark":"worker-git"/);
  assert.doesNotMatch(result.stdout, /"operation":"repository"/);
});

test("benchmark CLI does not fall back when its native binary disappears after the capability check", {
  skip: process.platform === "win32",
}, async (t) => {
  const executable = await fakeRdsh(t, String.raw`
const fs = require("node:fs");
if (process.argv[2] === "worker-git" && process.argv[3] === "--help") {
  console.log("Internal JSON bridge for dashboard Git observations");
  fs.unlinkSync(process.argv[1]);
  process.exit(0);
}
process.exit(24);
`);
  const result = run(executable);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
  assert.doesNotMatch(result.stdout, /"operation":"repository"/);
});

test("benchmark CLI compares a capable native worker-git binary with the JS oracle", {
  skip: process.platform === "win32",
}, async (t) => {
  let marker;
  const executable = await fakeRdsh(t, (executable) => {
    marker = path.join(path.dirname(executable), "native-requests");
    return capableWorkerGit
      .replaceAll("__MARKER__", JSON.stringify(marker))
      .replaceAll("__REPLACE_SOURCE__", "false");
  });
  const result = run(executable);

  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].nativeBinary.sourcePath, executable);
  assert.ok(path.isAbsolute(rows[0].nativeBinary.executionPath));
  assert.notEqual(rows[0].nativeBinary.executionPath, executable);
  assert.equal(
    rows[0].nativeBinary.sha256,
    createHash("sha256").update(await fs.readFile(executable)).digest("hex"),
  );
  assert.deepEqual(rows[0].measurementBoundary, {
    timingScope: "operation-request-only",
    excludes: [
      "native-binary-discovery",
      "worker-git-capability-preflight",
      "fixture-setup",
      "output-parity-check",
      "warmup",
    ],
  });
  assert.deepEqual(rows[0].fixture, { tracked: 128, dirty: 8 });
  assert.equal(rows[0].warmupsPerMode, 1);
  assert.equal(rows[0].alternatingPairs, 7);
  assert.deepEqual(rows.slice(1).map((row) => row.operation), [
    "repository",
    "sourceSnapshot",
    "dirtyPaths",
    "observeWorktree",
  ]);
  assert.ok(rows.slice(1).every((row) => row.outputsMatch === true));
  assert.ok(rows.slice(1).every((row) =>
    [row.javascriptSamplesMs, row.rustSamplesMs].every((samples) =>
      Array.isArray(samples) && samples.length === 7 && samples.every(Number.isFinite),
    ),
  ));
  for (const row of rows.slice(1)) {
    assert.equal(row.javascriptMedianMs, Number(median(row.javascriptSamplesMs).toFixed(2)));
    assert.equal(row.rustMedianMs, Number(median(row.rustSamplesMs).toFixed(2)));
    assert.equal(
      row.rustOverJavascript,
      Number((median(row.rustSamplesMs) / median(row.javascriptSamplesMs)).toFixed(2)),
    );
  }
  const requests = (await fs.readFile(marker, "utf8")).trim().split("\n");
  assert.equal(requests.length, 36);
  assert.ok(requests.every((request) => request === rows[0].nativeBinary.executionPath));
});

test("benchmark records an immutable execution copy when its source binary changes", {
  skip: process.platform === "win32",
}, async (t) => {
  let marker;
  const executable = await fakeRdsh(t, (sourcePath) => {
    marker = path.join(path.dirname(sourcePath), "native-requests");
    return capableWorkerGit
      .replaceAll("__MARKER__", JSON.stringify(marker))
      .replaceAll("__REPLACE_SOURCE__", JSON.stringify(sourcePath));
  });
  const sourceSha256 = createHash("sha256").update(await fs.readFile(executable)).digest("hex");
  const result = run(executable);

  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trim().split("\n").map(JSON.parse);
  const native = rows[0].nativeBinary;
  assert.equal(native.sourcePath, executable);
  assert.notEqual(native.executionPath, native.sourcePath);
  assert.equal(native.sha256, sourceSha256);
  assert.notEqual(
    createHash("sha256").update(await fs.readFile(executable)).digest("hex"),
    native.sha256,
  );
  const requests = (await fs.readFile(marker, "utf8")).trim().split("\n");
  assert.equal(requests.length, 36);
  assert.ok(requests.every((request) => request === native.executionPath));
});
