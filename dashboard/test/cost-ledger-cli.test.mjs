import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repo, "dashboard/cli.mjs");

test(
  "cost-ledger CLI invokes rdsh with a private temporary request file",
  { skip: process.platform === "win32" },
  async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-cost-ledger-cli-"));
    const native = path.join(temp, "rdsh");
    const dashboardHome = path.join(temp, "dashboard");
    const inputFile = path.join(temp, "request.json");
    const request = {
      operation: "schema",
      state: { schema: 1, project: { id: "project-1" } },
    };

    try {
      await fs.writeFile(
        native,
        `#!/usr/bin/env node
const fs = require("node:fs");
const requestPath = process.argv.at(-1);
const mode = fs.statSync(requestPath).mode & 0o777;
const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
process.stdout.write(JSON.stringify({ mode, request }));
`,
        { mode: 0o700 },
      );
      await fs.chmod(native, 0o700);
      await fs.writeFile(inputFile, JSON.stringify(request));

      const result = spawnSync(
        process.execPath,
        [cli, "cost-ledger", "schema", "--input-file", inputFile],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            RDSH_BIN: native,
            RDSH_DASHBOARD_HOME: dashboardHome,
          },
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const observed = JSON.parse(result.stdout);
      assert.equal(observed.mode, 0o600);
      assert.deepEqual(observed.request, request);
      assert.deepEqual(await fs.readdir(dashboardHome), []);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  },
);
