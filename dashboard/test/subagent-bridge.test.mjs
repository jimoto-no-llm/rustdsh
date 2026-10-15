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
    env: { ...process.env, ...env, RDSH_LANG: "en" },
  });
}

test("legacy subagents command validates options before launching rdsh", () => {
  const missing = run(["subagents", "plan"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Invalid subagents action\/options/);

  const relative = run(["subagents", "plan", "--input-file", "request.json"], {
    RDSH_BIN: "./rdsh",
  });
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /RDSH_BIN must be an absolute path/);
});

test("legacy subagents command forwards arguments and exit status", {
  skip: process.platform === "win32",
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rdsh-subagent-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeRdsh = path.join(root, "rdsh");
  fs.writeFileSync(fakeRdsh, `#!/usr/bin/env node
console.log(JSON.stringify(process.argv.slice(2)));
console.error("native stderr");
process.exitCode = 7;
`);
  fs.chmodSync(fakeRdsh, 0o755);

  const result = run(["subagents", "plan", "--input-file", "request.json"], {
    RDSH_BIN: fakeRdsh,
  });
  assert.equal(result.status, 7);
  assert.deepEqual(JSON.parse(result.stdout), [
    "subagents", "plan", "--input-file", "request.json",
  ]);
  assert.equal(result.stderr, "native stderr\n");
});

test("legacy subagents command skips a non-executable PATH candidate", {
  skip: process.platform === "win32",
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rdsh-subagent-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const blocked = path.join(root, "blocked");
  const usable = path.join(root, "usable");
  fs.mkdirSync(blocked);
  fs.mkdirSync(usable);
  fs.writeFileSync(path.join(blocked, "rdsh"), "not executable\n", { mode: 0o644 });
  fs.writeFileSync(path.join(usable, "rdsh"), `#!/usr/bin/env node
console.log("usable rdsh");
`);
  fs.chmodSync(path.join(usable, "rdsh"), 0o755);

  const result = run(["subagents", "plan", "--input-file", "request.json"], {
    RDSH_BIN: "",
    PATH: [blocked, usable, process.env.PATH || ""].join(path.delimiter),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "usable rdsh\n");
});
