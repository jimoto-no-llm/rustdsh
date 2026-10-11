import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline";

const launcher = fileURLToPath(
  new URL("../windows-launcher.mjs", import.meta.url),
);
function run(args, env, powershell = false) {
  const script = fileURLToPath(
    new URL("../rdsh-dashboard.ps1", import.meta.url),
  );
  const command = powershell ? "pwsh.exe" : process.execPath;
  const parameters = powershell
    ? [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        ...args,
      ]
    : [launcher, ...args];
  const child = spawn(command, parameters, {
    env,
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
  return { child, finished };
}
async function port() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const chosen = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return chosen;
}
async function runtime(root, name) {
  for (let n = 0; n < 150; n++) {
    try {
      const projects = path.join(root, "state", "projects");
      for (const id of await fs.readdir(projects)) {
        const data = JSON.parse(
          await fs.readFile(path.join(projects, id, "runtime.json"), "utf8"),
        );
        if (data.port === name) return data;
      }
    } catch {}
    await delay(100);
  }
  throw new Error("Own test dashboard runtime not available");
}

test("launcher help remains foreground", async () => {
  const result = await run(["project", "--help"], process.env).finished;
  assert.equal(result.code, 0);
  assert.match(result.output, /Project mode:/);
});

test(
  "native PowerShell wrapper forwards help in foreground",
  {
    skip: process.platform !== "win32",
    timeout: 25000,
  },
  async () => {
    const script = fileURLToPath(
      new URL("../rdsh-dashboard.ps1", import.meta.url),
    );
    const child = spawn(
      "pwsh.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "--help",
      ],
      { windowsHide: true },
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0, output);
    assert.match(output, /Project mode:/);
    assert.doesNotMatch(output, /System\.Threading\.Tasks\.VoidTaskResult/);
  },
);

test(
  "Windows tray launcher detaches only after ready; scoped stop preserves another project",
  {
    skip: process.platform !== "win32",
    timeout: 60000,
  },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh tray test "));
    // Shell metacharacters, quotes and Japanese are argument data, never code.
    const projects = [
      path.join(root, "project ' & $` 日本語"),
      path.join(root, "canary"),
    ];
    await Promise.all(projects.map((p) => fs.mkdir(p)));
    const env = Object.fromEntries(
      [
        "PATH",
        "Path",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "COMSPEC",
        "PATHEXT",
      ]
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    );
    Object.assign(env, {
      USERPROFILE: root,
      HOME: root,
      LOCALAPPDATA: root,
      RDSH_DASHBOARD_HOME: path.join(root, "state"),
    });
    const instances = [];
    async function stop(instance) {
      return fetch(`${instance.local_url}api/stop`, {
        method: "POST",
        headers: { authorization: `Bearer ${instance.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    }
    try {
      for (const project of projects) {
        const chosen = await port();
        const result = await run(
          [
            "project",
            "--project",
            project,
            "--port",
            String(chosen),
            "--no-tailscale",
          ],
          env,
          project === projects[0],
        ).finished;
        assert.equal(result.code, 0, result.output);
        assert.match(result.output, /notification area/);
        instances.push(await runtime(root, chosen));
      }
      const duplicate = await run(
        ["project", "--project", projects[0], "--no-tailscale"],
        env,
      ).finished;
      assert.equal(duplicate.code, 1);
      assert.match(duplicate.output, /already running/);
      assert.equal((await stop(instances[0])).status, 200);
      for (let n = 0; n < 100; n++) {
        try {
          process.kill(instances[0].pid, 0);
        } catch {
          break;
        }
        await delay(100);
      }
      assert.throws(() => process.kill(instances[0].pid, 0));
      const response = await fetch(`${instances[1].local_url}api/config`, {
        headers: { authorization: `Bearer ${instances[1].token}` },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      assert.equal(
        (await response.json()).instance_id,
        instances[1].instance_id,
      );
    } finally {
      for (const instance of instances) await stop(instance).catch(() => {});
      // Wait for owned shutdown before removing only the temporary fixture.
      await delay(1000);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "native PowerShell foreground wrapper preserves MCP stdin/stdout",
  {
    skip: process.platform !== "win32",
    timeout: 25000,
  },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-mcp-tray-"));
    const env = Object.fromEntries(
      [
        "PATH",
        "Path",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "COMSPEC",
        "PATHEXT",
      ]
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    );
    Object.assign(env, {
      USERPROFILE: root,
      HOME: root,
      LOCALAPPDATA: root,
      RDSH_DASHBOARD_HOME: path.join(root, "state"),
    });
    const { child, finished } = run(["mcp", "--project", root], env, true);
    const lines = createInterface({ input: child.stdout });
    const reply = new Promise((resolve, reject) => {
      child.once("error", reject);
      lines.on("line", (line) => {
        try {
          const message = JSON.parse(line);
          if (message.id === 1) resolve(message);
        } catch (error) {
          reject(error);
        }
      });
      child.once("exit", () =>
        reject(new Error("MCP wrapper exited before response")),
      );
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "dummy 日本語", version: "1" },
        },
      }) + "\n",
    );
    try {
      assert.equal(
        (await reply).result.serverInfo.name,
        "rdsh-project-dashboard",
      );
    } finally {
      child.stdin.end();
      lines.close();
      const result = await finished;
      assert.equal(result.code, 0, result.output);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
