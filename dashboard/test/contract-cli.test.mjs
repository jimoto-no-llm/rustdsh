import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identity } from "../state.mjs";

test("set-contract reports malformed or inconsistent server responses without echoing their contents", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-contract-cli-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repo");
  await fs.mkdir(root);
  const project = await identity(root);
  const stateHome = path.join(temp, "state");
  const directory = path.join(stateHome, "projects", project.id);
  await fs.mkdir(directory, { recursive: true });
  const contractFile = path.join(temp, "contract.json");
  await fs.writeFile(contractFile, JSON.stringify({ task_id: "T1" }));
  let responseBody = "<html>dummy-secret-response</html>";
  const server = http.createServer((req, res) => { req.resume(); res.end(responseBody); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await fs.writeFile(path.join(directory, "runtime.json"), JSON.stringify({
    kind: "project", project_id: project.id, token: "dummy-secret-token",
    local_url: `http://127.0.0.1:${server.address().port}/`,
  }));
  const run = () => promisify(execFile)(process.execPath, [
    path.resolve("cli.mjs"), "set-contract", "--project", root, "--file", contractFile,
  ], { windowsHide: true, env: { ...process.env, RDSH_DASHBOARD_HOME: stateHome } });
  for (const [body, message] of [
    [responseBody, "invalid contract response"],
    [JSON.stringify({ contracts: [] }), "missing the saved contract version"],
    ["null", "missing the saved contract version"],
    [JSON.stringify({ contracts: [{ task_id: "T1", versions: { at: 1 } }] }), "missing the saved contract version"],
    [JSON.stringify({ contracts: [{ task_id: "T1", versions: [{ version: "dummy-secret-response" }] }] }), "missing the saved contract version"],
  ]) {
    responseBody = body;
    await assert.rejects(run, (error) => {
      assert.equal(error.code, 1);
      assert.ok(error.stderr.includes(message));
      assert.ok(error.stderr.includes("verify saved state before retrying"));
      assert.ok(!error.stderr.includes("dummy-secret"));
      assert.ok(!error.stdout.includes("saved:"));
      return true;
    });
  }
});
