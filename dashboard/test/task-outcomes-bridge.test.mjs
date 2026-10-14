import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("legacy task-outcomes command validates options before launching rdsh", () => {
  const missing = run(["task-outcomes", "apply"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Invalid task-outcomes action\/options/);

  const unknown = run(["task-outcomes", "frobnicate", "--input-file", "in.json"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Invalid task-outcomes action\/options/);

  const extra = run([
    "task-outcomes",
    "apply",
    "--input-file",
    "in.json",
    "--task-id",
    "goal",
  ]);
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /Invalid task-outcomes action\/options/);

  const relative = run(["task-outcomes", "apply", "--input-file", "in.json"], {
    RDSH_BIN: "./rdsh",
  });
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /RDSH_BIN must be an absolute path/);
});

test("legacy task-outcomes command forwards arguments and exit status", {
  skip: process.platform === "win32",
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rdsh-outcome-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeRdsh = path.join(root, "rdsh");
  fs.writeFileSync(fakeRdsh, `#!/usr/bin/env node
console.log(JSON.stringify(process.argv.slice(2)));
console.error("native stderr");
process.exitCode = 7;
`);
  fs.chmodSync(fakeRdsh, 0o755);

  const result = run(
    ["task-outcomes", "apply", "--input-file", "request.json"],
    { RDSH_BIN: fakeRdsh },
  );
  assert.equal(result.status, 7);
  assert.deepEqual(JSON.parse(result.stdout), [
    "task-outcomes",
    "apply",
    "--input-file",
    "request.json",
  ]);
  assert.equal(result.stderr, "native stderr\n");
});

test("legacy task-outcomes command forwards the successful exit status", {
  skip: process.platform === "win32",
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rdsh-outcome-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeRdsh = path.join(root, "rdsh");
  fs.writeFileSync(fakeRdsh, `#!/usr/bin/env node
console.log(JSON.stringify(process.argv.slice(2)));
`);
  fs.chmodSync(fakeRdsh, 0o755);

  for (const action of ["apply", "validate", "schema"]) {
    const result = run(
      ["task-outcomes", action, "--input-file", "request.json"],
      { RDSH_BIN: fakeRdsh },
    );
    assert.equal(result.status, 0, action);
    assert.deepEqual(JSON.parse(result.stdout), [
      "task-outcomes",
      action,
      "--input-file",
      "request.json",
    ]);
  }
});
