import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnOwnedProcess } from "../process-scope.mjs";

test(
  "deferred Windows release allows its bounded identity observation to finish",
  { skip: process.platform !== "win32", timeout: 25000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-release-"));
    const observation = path.join(root, "observation.json");
    const started = path.join(root, "started.json");
    const preload = path.join(root, "slow-identity.mjs");
    let owned;
    t.after(async () => {
      if (owned) {
        const result = await owned.stop({
          gracefulTimeout: 100,
          killTimeout: 1000,
        });
        assert.equal(result.confirmed, true);
        assert.equal(result.resources_released, true);
      }
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });
    // Exercise the real Windows observation's existing 5s deadline. Only the
    // owned supervisor's observation is delayed; its parent and target are not.
    await fs.writeFile(
      preload,
      `import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
if (process.argv[1]?.endsWith("process-scope-supervisor.mjs")) {
  const original = cp.execFile;
  function delayed(...args) {
    const callback = args.pop();
    const selected = args[0] === process.execPath && args[1]?.[0]?.endsWith("process-identity-windows.mjs");
    if (selected) args[1].unshift("--import=data:text/javascript," + encodeURIComponent("await new Promise(resolve => setTimeout(resolve, 6000));"));
    return original(...args, (error, stdout, stderr) => {
      if (selected) fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ timeout: args[2]?.timeout, killed: error?.killed === true }));
      callback(error, stdout, stderr);
    });
  }
  delayed[promisify.custom] = (...args) => new Promise((resolve, reject) => delayed(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
  cp.execFile = delayed;
  syncBuiltinESMExports();
}
`,
    );
    owned = await spawnOwnedProcess({
      command: [
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(started)}, JSON.stringify({ pid: process.pid })); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`,
      ],
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          "--import=" + pathToFileURL(preload).href,
        ]
          .filter(Boolean)
          .join(" "),
      },
      deferStart: true,
    });
    owned.child.stdout.resume();
    owned.child.stderr.resume();
    assert.equal(await fs.readFile(started, "utf8").catch(() => null), null);
    const result = await owned.release();
    assert.equal(result.released, true);
    assert.equal(result.root_pid, owned.child.pid);
    assert.equal(owned.descriptor.root_pid, result.root_pid);
    assert.equal(owned.descriptor.root_identity, null);
    assert.deepEqual(JSON.parse(await fs.readFile(observation, "utf8")), {
      timeout: 5000,
      killed: true,
    });
    assert.equal(
      JSON.parse(await fs.readFile(started, "utf8")).pid,
      result.root_pid,
    );
    assert.equal((await owned.inspect()).status, "running");
  },
);
