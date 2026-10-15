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

function fakeRdsh(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rdsh-contract-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "rdsh");
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(executable, 0o755);
  return executable;
}

test("Rust-backed contract and instruction commands forward native arguments", {
  skip: process.platform === "win32",
}, (t) => {
  const executable = fakeRdsh(t, "console.log(JSON.stringify(process.argv.slice(2)));");

  for (const [command, action] of [
    ["question-contracts", "public"],
    ["answer-applications", "schema"],
    ["instruction-queue", "context"],
    ["instruction-queue", "submit"],
    ["instruction-queue", "resolve"],
    ["instruction-queue", "control"],
  ]) {
    const result = run(
      [command, action, "--input-file", "request.json"],
      { RDSH_BIN: executable },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      command,
      action,
      "--input-file",
      "request.json",
    ]);
    assert.equal(result.stderr, "");
  }
});

test("answer application bridge preserves the native exit status", {
  skip: process.platform === "win32",
}, (t) => {
  const executable = fakeRdsh(
    t,
    'console.error("native failure"); process.exitCode = 7;',
  );
  const result = run(
    ["answer-applications", "validate", "--input-file", "request.json"],
    { RDSH_BIN: executable },
  );

  assert.equal(result.status, 7);
  assert.equal(result.stderr, "native failure\n");
});

test("contract bridge rejects invalid actions before resolving rdsh", () => {
  const result = run(
    ["question-contracts", "unknown", "--input-file", "request.json"],
    { RDSH_BIN: "./relative-rdsh" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid question-contracts action\/options/);

  const instruction = run(
    ["instruction-queue", "mutate", "--input-file", "request.json"],
    { RDSH_BIN: "./relative-rdsh" },
  );
  assert.equal(instruction.status, 1);
  assert.match(instruction.stderr, /Invalid instruction-queue action\/options/);
});
