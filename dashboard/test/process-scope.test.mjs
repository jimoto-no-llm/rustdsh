import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  dockerWorkerLaunch,
  createDockerWorkerController,
  dockerWorkerImage,
  handleSupervisorResponse,
  spawnOwnedProcess,
} from "../process-scope.mjs";
import { windowsJobObservation } from "../process-scope-backends.mjs";
import { startHarness } from "../harness.mjs";
import { RunHistory } from "../run-history.mjs";
import { startDashboard } from "../server.mjs";
import net from "node:net";
const fixture = fileURLToPath(
  new URL("./fixtures/owned-tree.mjs", import.meta.url),
);
const supervisor = fileURLToPath(
  new URL("../process-scope-supervisor.mjs", import.meta.url),
);
const largeOutputFixture = fileURLToPath(
  new URL("./fixtures/supervisor-stdout.mjs", import.meta.url),
);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const exec = promisify(execFile);
const fakeColimaEndpoint = "unix://" + path.join(os.homedir(), ".colima", "default", "docker.sock");
test("Docker controller reports daemon loss as unverifiable and accepts only exact exited proof", { skip: process.platform === "win32" && "requires a POSIX executable fake Docker shim" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-fake-docker-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state.json"), bin = path.join(root, "docker");
  const previousState = process.env.RDSH_DOCKER_FAKE_STATE;
  process.env.RDSH_DOCKER_FAKE_STATE = state;
  t.after(() => { if (previousState === undefined) delete process.env.RDSH_DOCKER_FAKE_STATE; else process.env.RDSH_DOCKER_FAKE_STATE = previousState; });
  await fs.writeFile(state, JSON.stringify({ state: "running", removed: [], owner: null }));
  await fs.writeFile(bin, `#!/usr/bin/env node
const fs=require('fs'); const f=process.env.RDSH_DOCKER_FAKE_STATE; let s=JSON.parse(fs.readFileSync(f)); let a=process.argv.slice(2); if(a[0]=='--context'||a[0]=='--host')a=a.slice(2); const c=a[0]; if(c==='context'){console.log(a[1]==='inspect'?'${fakeColimaEndpoint}':'colima');process.exit()} if(c==='info'){console.log('engine-test');process.exit()} if(c==='version'){console.log('linux/arm64');process.exit()} if(c==='create'){s.owner=a[a.indexOf('--label')+1].slice(11);s.name=a[a.indexOf('--name')+1];fs.writeFileSync(f,JSON.stringify(s));console.log('a'.repeat(64));process.exit()} if(c==='inspect'){if(a.includes('rdsh-'+s.owner.slice(0,5))||a.at(-1)===s.name){console.log('a'.repeat(64)+'\\n'+s.owner)}else console.log(s.state);process.exit()} if(c==='kill'){s.state='exited'} if(c==='rm'){s.removed.push(a.at(-1));} fs.writeFileSync(f,JSON.stringify(s));`);
  await fs.chmod(bin, 0o755);
  const owner = "owner_" + randomUUID();
  const controller = await createDockerWorkerController({ dockerBin: bin, workspace: root, image: "node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392" }, owner);
  controller.markStarted();
  for (const bad of ["dead", "paused", "restarting", "removing", "created"]) {
    const value = JSON.parse(await fs.readFile(state)); value.state = bad; await fs.writeFile(state, JSON.stringify(value));
    await assert.rejects(controller.inspect(), (error) => error.code === "monitor_lost");
  }
  const value = JSON.parse(await fs.readFile(state)); value.state = "exited"; await fs.writeFile(state, JSON.stringify(value));
  assert.equal((await controller.inspect()).status, "exit_confirmed");
  value.state = "missing"; await fs.writeFile(state, JSON.stringify(value));
  await assert.rejects(controller.inspect(), (error) => error.code === "monitor_lost");
  assert.equal(await controller.stopAndRemove(50), false);
});
test("Docker controller recovers an exact labelled ID after create times out post-commit", { skip: process.platform === "win32" && "requires a POSIX executable fake Docker shim" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-fake-docker-timeout-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state.json"), bin = path.join(root, "docker"), owner = "owner_" + randomUUID();
  const previous = process.env.RDSH_DOCKER_TIMEOUT_STATE;
  process.env.RDSH_DOCKER_TIMEOUT_STATE = state;
  t.after(() => { if (previous === undefined) delete process.env.RDSH_DOCKER_TIMEOUT_STATE; else process.env.RDSH_DOCKER_TIMEOUT_STATE = previous; });
  const id = "d".repeat(64), foreign = "f".repeat(64);
  await fs.writeFile(state, JSON.stringify({ owner, name: `rdsh-${owner}`, id, foreign, removed: [] }));
  await fs.writeFile(bin, `#!/usr/bin/env node
const fs=require('fs'),f=process.env.RDSH_DOCKER_TIMEOUT_STATE,s=JSON.parse(fs.readFileSync(f));let a=process.argv.slice(2);if(a[0]=='--context'||a[0]=='--host')a=a.slice(2);if(a[0]=='context'){console.log(a[1]==='inspect'?'${fakeColimaEndpoint}':'colima');process.exit()}if(a[0]=='info'){console.log('engine-test');process.exit()}if(a[0]=='version'){console.log('linux/arm64');process.exit()}if(a[0]=='create'){fs.writeFileSync(f,JSON.stringify(s));setTimeout(()=>process.exit(0),6000);return}if(a[0]=='inspect'){if(a.at(-1)===s.name)console.log(s.id+'\\n'+s.owner);else if(a.at(-1)===s.id)console.log('created');else process.exit(1);process.exit()}if(a[0]=='rm'){s.removed.push(a.at(-1));fs.writeFileSync(f,JSON.stringify(s));}`);
  await fs.chmod(bin, 0o755);
  const controller = await createDockerWorkerController({ dockerBin: bin, workspace: root, image: dockerWorkerImage }, owner);
  assert.equal(controller.id, id);
  assert.equal(await controller.stopAndRemove(1000), true);
  const after = JSON.parse(await fs.readFile(state));
  assert.deepEqual(after.removed, [id]);
  assert.equal(after.foreign, foreign);
});
test("Docker create recovery reports cleanup unconfirmed when exact inspection is unavailable", { skip: process.platform === "win32" && "requires a POSIX executable fake Docker shim" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-fake-docker-inspect-down-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state.json"), bin = path.join(root, "docker"), owner = "owner_" + randomUUID();
  const previous = process.env.RDSH_DOCKER_INSPECT_DOWN_STATE;
  process.env.RDSH_DOCKER_INSPECT_DOWN_STATE = state;
  t.after(() => { if (previous === undefined) delete process.env.RDSH_DOCKER_INSPECT_DOWN_STATE; else process.env.RDSH_DOCKER_INSPECT_DOWN_STATE = previous; });
  await fs.writeFile(state, JSON.stringify({ committed: false }));
  await fs.writeFile(bin, `#!/usr/bin/env node
const fs=require('fs'),f=process.env.RDSH_DOCKER_INSPECT_DOWN_STATE,s=JSON.parse(fs.readFileSync(f));let a=process.argv.slice(2);if(a[0]=='--context'||a[0]=='--host')a=a.slice(2);if(a[0]=='context'){console.log(a[1]==='inspect'?'${fakeColimaEndpoint}':'colima');process.exit()}if(a[0]=='info'){console.log('engine-test');process.exit()}if(a[0]=='version'){console.log('linux/arm64');process.exit()}if(a[0]=='create'){s.committed=true;fs.writeFileSync(f,JSON.stringify(s));setTimeout(()=>process.exit(0),6000);return}if(a[0]=='inspect')process.exit(2);`);
  await fs.chmod(bin, 0o755);
  await assert.rejects(
    createDockerWorkerController({ dockerBin: bin, workspace: root, image: dockerWorkerImage }, owner),
    (error) => error.code === "cleanup_unconfirmed",
  );
  assert.equal(JSON.parse(await fs.readFile(state)).committed, true);
});
test("Docker recovered exact ID reports cleanup unconfirmed when removal fails", { skip: process.platform === "win32" && "requires a POSIX executable fake Docker shim" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-fake-docker-rm-down-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state.json"), bin = path.join(root, "docker"), owner = "owner_" + randomUUID(), id = "e".repeat(64);
  const previous = process.env.RDSH_DOCKER_RM_DOWN_STATE;
  process.env.RDSH_DOCKER_RM_DOWN_STATE = state;
  t.after(() => { if (previous === undefined) delete process.env.RDSH_DOCKER_RM_DOWN_STATE; else process.env.RDSH_DOCKER_RM_DOWN_STATE = previous; });
  await fs.writeFile(state, JSON.stringify({ owner, removed: false }));
  await fs.writeFile(bin, `#!/usr/bin/env node
const fs=require('fs'),f=process.env.RDSH_DOCKER_RM_DOWN_STATE,s=JSON.parse(fs.readFileSync(f));let a=process.argv.slice(2);if(a[0]=='--context'||a[0]=='--host')a=a.slice(2);if(a[0]=='context'){console.log(a[1]==='inspect'?'${fakeColimaEndpoint}':'colima');process.exit()}if(a[0]=='info'){console.log('engine-test');process.exit()}if(a[0]=='version'){console.log('linux/arm64');process.exit()}if(a[0]=='create'){console.log('invalid');process.exit()}if(a[0]=='inspect'){if(a.at(-1).startsWith('rdsh-'))console.log('${id}\\n'+s.owner);else console.log('created');process.exit()}if(a[0]=='rm'){s.removed=true;fs.writeFileSync(f,JSON.stringify(s));process.exit(9);}`);
  await fs.chmod(bin, 0o755);
  await assert.rejects(
    createDockerWorkerController({ dockerBin: bin, workspace: root, image: dockerWorkerImage }, owner),
    (error) => error.code === "cleanup_unconfirmed",
  );
  assert.equal(JSON.parse(await fs.readFile(state)).removed, true);
});
test("Docker controller rejects changed Colima endpoint or Engine ID before create", { skip: process.platform === "win32" && "requires a POSIX executable fake Docker shim" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-fake-docker-transport-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state.json"), bin = path.join(root, "docker"), entry = path.join(root, "entry.mjs");
  const previous = process.env.RDSH_DOCKER_TRANSPORT_STATE;
  process.env.RDSH_DOCKER_TRANSPORT_STATE = state;
  t.after(() => { if (previous === undefined) delete process.env.RDSH_DOCKER_TRANSPORT_STATE; else process.env.RDSH_DOCKER_TRANSPORT_STATE = previous; });
  await fs.writeFile(entry, "process.exit(0);\n");
  await fs.writeFile(state, JSON.stringify({ endpoint: fakeColimaEndpoint, engine: "engine-original", creates: 0 }));
  await fs.writeFile(bin, `#!/usr/bin/env node
const fs=require('fs'),f=process.env.RDSH_DOCKER_TRANSPORT_STATE,s=JSON.parse(fs.readFileSync(f));let a=process.argv.slice(2);if(a[0]=='--context'||a[0]=='--host')a=a.slice(2);if(a[0]=='context'){console.log(s.endpoint);process.exit()}if(a[0]=='info'){console.log(s.engine);process.exit()}if(a[0]=='version'){console.log('linux/arm64');process.exit()}if(a[0]=='create'){s.creates++;fs.writeFileSync(f,JSON.stringify(s));console.log('f'.repeat(64));process.exit()}`);
  await fs.chmod(bin, 0o755);
  const launch = await dockerWorkerLaunch({ command: ["/usr/local/bin/node", entry], cwd: root, dockerWorker: { dockerBin: bin, mountRoots: [root] } });
  let value = JSON.parse(await fs.readFile(state)); value.endpoint = "unix:///tmp/not-colima.sock"; await fs.writeFile(state, JSON.stringify(value));
  await assert.rejects(createDockerWorkerController(launch, "owner_" + randomUUID()), (error) => error.code === "ownership_unavailable");
  value = JSON.parse(await fs.readFile(state)); value.endpoint = fakeColimaEndpoint; value.engine = "engine-changed"; await fs.writeFile(state, JSON.stringify(value));
  await assert.rejects(createDockerWorkerController(launch, "owner_" + randomUUID()), (error) => error.code === "ownership_unavailable");
  assert.equal(JSON.parse(await fs.readFile(state)).creates, 0);
});
test("Docker controller reports cleanup unconfirmed when malformed create recovery cannot prove removal", { skip: process.platform === "win32" && "requires a POSIX executable fake Docker shim" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-fake-docker-recover-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state.json"), bin = path.join(root, "docker"), owner = "owner_" + randomUUID();
  const previous = process.env.RDSH_DOCKER_RECOVERY_STATE;
  process.env.RDSH_DOCKER_RECOVERY_STATE = state;
  t.after(() => { if (previous === undefined) delete process.env.RDSH_DOCKER_RECOVERY_STATE; else process.env.RDSH_DOCKER_RECOVERY_STATE = previous; });
  await fs.writeFile(state, JSON.stringify({ owner, name: `rdsh-${owner}`, removed: [] }));
  await fs.writeFile(bin, `#!/usr/bin/env node
const fs=require('fs'),f=process.env.RDSH_DOCKER_RECOVERY_STATE,s=JSON.parse(fs.readFileSync(f));let a=process.argv.slice(2);if(a[0]=='--context'||a[0]=='--host')a=a.slice(2);if(a[0]=='context'){console.log(a[1]==='inspect'?'${fakeColimaEndpoint}':'colima');process.exit()}if(a[0]=='info'){console.log('engine-test');process.exit()}if(a[0]=='version'){console.log('linux/arm64');process.exit()}if(a[0]=='create'){console.log('invalid');process.exit()}if(a[0]=='inspect'){console.log('b'.repeat(64)+'\\n'+s.owner);process.exit()}if(a[0]=='kill'){}if(a[0]=='rm'){s.removed.push(a.at(-1));fs.writeFileSync(f,JSON.stringify(s));}`);
  await fs.chmod(bin, 0o755);
  await assert.rejects(createDockerWorkerController({ dockerBin: bin, workspace: root, image: "node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392" }, owner), (error) => error.code === "cleanup_unconfirmed");
  assert.deepEqual(JSON.parse(await fs.readFile(state)).removed, []);
});
test("Docker transport start failure reports cleanup unconfirmed when exact removal fails", { skip: process.platform === "win32" && "requires a POSIX executable fake Docker shim" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-fake-docker-attach-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state.json"), bin = path.join(root, "docker"), owner = "owner_" + randomUUID();
  const previous = process.env.RDSH_DOCKER_ATTACH_STATE;
  process.env.RDSH_DOCKER_ATTACH_STATE = state;
  t.after(() => { if (previous === undefined) delete process.env.RDSH_DOCKER_ATTACH_STATE; else process.env.RDSH_DOCKER_ATTACH_STATE = previous; });
  await fs.writeFile(state, JSON.stringify({ state: "running", owner, removed: [], endpoint: fakeColimaEndpoint, startArgs: null, foreign: "f".repeat(64) }));
  await fs.writeFile(bin, `#!/usr/bin/env node
const fs=require('fs'),f=process.env.RDSH_DOCKER_ATTACH_STATE,s=JSON.parse(fs.readFileSync(f));const raw=process.argv.slice(2);let a=raw;if(a[0]=='--context'||a[0]=='--host')a=a.slice(2);if(a[0]=='context'){console.log(a[1]==='inspect'?s.endpoint:'colima');process.exit()}if(a[0]=='info'){console.log('engine-test');process.exit()}if(a[0]=='version'){console.log('linux/arm64');process.exit()}if(a[0]=='create'){s.endpoint='unix:///tmp/changed-engine.sock';fs.writeFileSync(f,JSON.stringify(s));console.log('c'.repeat(64));process.exit()}if(a[0]=='start'){s.startArgs=raw;fs.writeFileSync(f,JSON.stringify(s));process.exit(1)}if(a[0]=='inspect'){if(a.at(-1)===('c'.repeat(64)))console.log(s.state);else {console.error('missing');process.exit(1)}process.exit()}if(a[0]=='kill')s.state='exited';if(a[0]=='rm'){s.removed.push(a.at(-1));fs.writeFileSync(f,JSON.stringify(s));process.exit(9)}fs.writeFileSync(f,JSON.stringify(s));`);
  await fs.chmod(bin, 0o755);
  await assert.rejects(spawnOwnedProcess({ command: ["/usr/local/bin/node", path.join(root, "entry.mjs")], cwd: root, dockerWorker: { dockerBin: bin, mountRoots: [root] }, owner_id: owner, startupTimeoutMs: 50 }), (error) => error.code === "cleanup_unconfirmed");
  const after = JSON.parse(await fs.readFile(state));
  assert.equal(after.endpoint, "unix:///tmp/changed-engine.sock");
  assert.deepEqual(after.startArgs, ["--host", fakeColimaEndpoint, "start", "-ai", "c".repeat(64)]);
  assert.deepEqual(after.removed, ["c".repeat(64)]);
  assert.equal(after.foreign, "f".repeat(64));
});
test("Docker Linux worker requires an explicit pinned image, Linux runtime, and mapped workspace paths", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-docker-worker-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "entry.mjs");
  await fs.writeFile(entry, "process.exit(0);\n");
  const launch = await dockerWorkerLaunch({
    command: ["/usr/local/bin/node", entry],
    cwd: root,
    dockerWorker: { mountRoots: [root] },
  });
  assert.equal(launch.execution_platform, "linux");
  assert.equal(launch.transport, "colima_docker");
  assert.equal(launch.command[0], "/usr/local/bin/node");
  assert.deepEqual(launch.command.slice(1), ["/workspace/entry.mjs"]);
  await assert.rejects(
    dockerWorkerLaunch({
      command: [process.execPath, entry],
      cwd: root,
      dockerWorker: { mountRoots: [root] },
    }),
    (error) => error.code === "ownership_unavailable",
  );
  await assert.rejects(
    dockerWorkerLaunch({
      command: ["/usr/local/bin/node", "/etc/passwd"],
      cwd: root,
      dockerWorker: { mountRoots: [root] },
    }),
    (error) => error.code === "ownership_unavailable",
  );
});
test("Colima Docker scopes stop only their exact containers and preserve a running unrelated canary", { skip: process.platform !== "darwin" && "requires the macOS Colima Docker context" }, async (t) => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".rdsh-colima-scopes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "worker.mjs");
  await fs.writeFile(entry, "setInterval(() => {}, 1000);\n");
  const launch = await dockerWorkerLaunch({
    command: ["/usr/local/bin/node", entry],
    cwd: root,
    dockerWorker: { mountRoots: [root] },
  });
  const canaryName = `rdsh-test-canary-${randomUUID()}`;
  let canaryId = null;
  t.after(async () => {
    if (canaryId)
      await exec(launch.dockerBin, ["--context", "colima", "rm", "-f", canaryId]).catch(() => {});
  });
  ({ stdout: canaryId } = await exec(launch.dockerBin, [
    "--context", "colima", "create", "--name", canaryName,
    "--label", "rdsh.test.canary=true", "--network", "none",
    dockerWorkerImage, "node", "-e", "setInterval(() => {}, 1000)",
  ]));
  canaryId = canaryId.trim();
  await exec(launch.dockerBin, ["--context", "colima", "start", canaryId]);
  const first = await spawnOwnedProcess({
    command: ["/usr/local/bin/node", entry], cwd: root,
    dockerWorker: { mountRoots: [root] }, owner_id: "owner_" + randomUUID(),
  });
  const second = await spawnOwnedProcess({
    command: ["/usr/local/bin/node", entry], cwd: root,
    dockerWorker: { mountRoots: [root] }, owner_id: "owner_" + randomUUID(),
  });
  t.after(async () => { await second.stop({ gracefulTimeout: 50, killTimeout: 1000 }).catch(() => {}); });
  t.after(async () => { await first.stop({ gracefulTimeout: 50, killTimeout: 1000 }).catch(() => {}); });
  await first.release();
  await second.release();
  assert.equal((await first.inspect()).status, "running");
  assert.equal((await second.inspect()).status, "running");
  const stopped = await first.stop({ gracefulTimeout: 50, killTimeout: 1000 });
  assert.equal(stopped.confirmed, true);
  assert.equal(stopped.resources_released, true);
  assert.equal((await second.inspect()).status, "running");
  const canary = await exec(launch.dockerBin, ["--context", "colima", "inspect", "--format", "{{.State.Status}}", canaryId]);
  assert.equal(canary.stdout.trim(), "running");
  const secondStopped = await second.stop({ gracefulTimeout: 50, killTimeout: 1000 });
  assert.equal(secondStopped.confirmed, true);
  assert.equal(secondStopped.resources_released, true);
});

test("a Docker worker proves only Engine exit after a natural root exit with detached descendants", { skip: process.platform !== "darwin" && "requires the macOS Colima Docker context" }, async (t) => {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".rdsh-colima-root-exit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "root-exit.cjs"), trace = path.join(root, "detached.log");
  await fs.writeFile(entry, `const { spawn } = require("node:child_process");
const child = spawn("/usr/local/bin/node", ["-e", "const fs=require('fs'); const p=process.argv[1]; fs.appendFileSync(p, 'x'); setInterval(()=>fs.appendFileSync(p, 'x'), 20)", "/workspace/detached.log"], { detached: true, stdio: "ignore" });
child.unref(); setTimeout(() => process.exit(0), 80);\n`);
  const scope = await spawnOwnedProcess({
    command: ["/usr/local/bin/node", entry], cwd: root,
    dockerWorker: { mountRoots: [root] }, owner_id: "owner_" + randomUUID(),
  });
  t.after(async () => { await scope.stop({ gracefulTimeout: 50, killTimeout: 1000 }).catch(() => {}); });
  await scope.release();
  await waitFor(async () => (await scope.inspect()).status === "exit_confirmed", 10000);
  const firstSize = (await fs.stat(trace)).size;
  await pause(150);
  assert.equal((await fs.stat(trace)).size, firstSize);
  const stopped = await scope.stop({ gracefulTimeout: 50, killTimeout: 1000 });
  assert.equal(stopped.confirmed, true);
  assert.equal(stopped.resources_released, true);
});
test("a Windows job cannot be confirmed empty when membership and accounting disagree", () => {
  const exitedBetweenQueries = windowsJobObservation(1, [12345], true);
  assert.equal(exitedBetweenQueries.status, "running");
  assert.deepEqual(exitedBetweenQueries.remaining_pids, [12345]);
  assert.equal(exitedBetweenQueries.remaining_count, 1);
  const spawnedBetweenQueries = windowsJobObservation(0, [], false);
  assert.equal(spawnedBetweenQueries.status, "running");
  assert.equal(spawnedBetweenQueries.remaining_count, null);
  assert.equal(spawnedBetweenQueries.members_truncated, true);
  assert.deepEqual(windowsJobObservation(0, [], true), {
    status: "exit_confirmed",
    remaining_pids: [],
    remaining_count: 0,
    members_truncated: false,
  });
});
test("a late supervisor response is discarded without blocking a later response", () => {
  const pending = new Map();
  assert.equal(
    handleSupervisorResponse(
      { type: "response", id: 41, result: { status: "stale" } },
      pending,
    ),
    true,
  );

  let laterResult = null;
  pending.set(42, {
    resolve(value) {
      laterResult = value;
    },
    reject(error) {
      throw error;
    },
  });
  assert.equal(
    handleSupervisorResponse(
      { type: "response", id: 42, result: { status: "exit_confirmed" } },
      pending,
    ),
    true,
  );
  assert.deepEqual(laterResult, { status: "exit_confirmed" });
  assert.equal(pending.size, 0);
  assert.equal(
    handleSupervisorResponse({ type: "response", id: 0, result: null }, pending),
    false,
  );
});
test("remote Docker scope is persisted without substituting its macOS transport PID", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-remote-scope-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const history = await RunHistory.open({ id: "remote-scope", directory: root });
  const runId = "run_" + randomUUID();
  await history.register(runId, null);
  await history.scopeIntent(runId);
  const container = "a".repeat(64);
  await history.bindScope(runId, {
    owner_id: history.owner_id,
    kind: "docker_linux_container",
    kernel_id: container,
    root_identity: null,
    root_pid: null,
    execution_platform: "linux",
    transport: "colima_docker",
  });
  const loaded = await history.inspect(runId);
  assert.equal(loaded.scope.descriptor.kernel_id, container);
  assert.equal(loaded.scope.descriptor.root_pid, null);
  assert.equal(loaded.process, null);
});
async function waitFor(check, budget = 10000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(25);
  }
  throw new Error("Fixture did not reach the expected state");
}
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-scope-"));
  const owned = [];
  t.after(async () => {
    for (const p of owned)
      await p.stop({ gracefulTimeout: 100, killTimeout: 1000 });
    await fs.rm(root, { recursive: true, force: true });
  });
  const rows = async (trace) =>
    (await fs.readFile(trace, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  const tree = async (mode = "stubborn") => {
    const trace = path.join(root, "trace-" + owned.length + ".jsonl"),
      stages = [];
    const p = await spawnOwnedProcess({
      command: [process.execPath, fixture, "root", mode, trace],
      cwd: root,
      onStage: (e) => {
        stages.push(e);
      },
    });
    owned.push(p);
    p.child.stdout.resume();
    p.child.stderr.resume();
    await p.release();
    await waitFor(async () =>
      (await rows(trace)).some(
        (r) => r.role === "grandchild" && r.type === "started",
      ),
    );
    return { p, trace, stages };
  };
  return { root, rows, tree, own: (p) => owned.push(p) };
}
test(
  "framed supervisor drains queued child output before input-close exit",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "rdsh-framed-output-"),
      ),
      written = path.join(root, "written"),
      exited = path.join(root, "exited"),
      expected = Buffer.alloc(4 * 1024 * 1024, 0x61),
      child = spawn(process.execPath, [supervisor], {
        cwd: root,
        stdio: ["pipe", "pipe", "ignore"],
      });
    let buffer = "",
      readyFrame = null,
      monitorError = null;
    const frames = [];
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = JSON.parse(line);
        frames.push(frame);
        if (frame.type === "ready") {
          readyFrame = frame;
          child.stdout.pause();
        } else if (frame.type === "monitor_error") monitorError = frame;
      }
    });
    child.once("error", (error) => {
      monitorError = error;
    });
    const closed = new Promise((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdout.resume();
        child.stdin.end();
        let timer;
        await Promise.race([
          closed,
          new Promise((resolve) => {
            timer = setTimeout(resolve, 5000);
          }),
        ]);
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
      await fs.rm(root, { recursive: true, force: true });
    });
    const send = (frame) => child.stdin.write(JSON.stringify(frame) + "\n"),
      exists = async (file) =>
        fs
          .access(file)
          .then(() => true)
          .catch(() => false);
    send({
      op: "start",
      owner_id: "owner_" + randomUUID(),
      command: [process.execPath, largeOutputFixture, written, exited],
      cwd: root,
      env: { PATH: process.env.PATH },
      framed: true,
    });
    await waitFor(() => Promise.resolve(readyFrame || monitorError));
    assert(readyFrame, "Framed supervisor did not become ready");
    send({ id: 1, op: "release" });
    await waitFor(() => exists(written));
    await waitFor(() => exists(exited));
    child.stdin.end();
    await pause(500);
    const exitedBeforeDrain = child.exitCode !== null;
    child.stdout.resume();
    let closeTimer;
    let result;
    try {
      result = await Promise.race([
        closed,
        new Promise((_, reject) => {
          closeTimer = setTimeout(
            () =>
              reject(
                new Error(
                  "Framed supervisor did not exit after output drain",
                ),
              ),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(closeTimer);
    }
    assert.equal(buffer, "");
    const output = Buffer.concat(
      frames
        .filter((frame) => frame.type === "stdout")
        .map((frame) => Buffer.from(frame.data, "base64")),
    );
    assert.equal(exitedBeforeDrain, false);
    assert.equal(result.code, 0);
    assert.deepEqual(output, expected);
    t.diagnostic(
      JSON.stringify({
        expected_bytes: expected.length,
        received_bytes: output.length,
        exited_before_drain: exitedBeforeDrain,
        exit_code: result.code,
      }),
    );
    assert(
      frames.some(
        (frame) =>
          frame.type === "response" &&
          frame.id === 1 &&
          frame.result?.released === true,
      ),
    );
  },
);
test("owned children and detached grandchildren stop in order after a bounded graceful deadline, with duplicate requests sharing one result", async (t) => {
  const { tree, rows } = await setup(t),
    { p, trace, stages } = await tree("detached");
  const live = await p.inspect();
  assert.equal(live.status, "running");
  assert(live.remaining_count >= 3);
  const start = Date.now();
  const first = p.stop({ gracefulTimeout: 200, killTimeout: 1000 }),
    second = p.stop({ gracefulTimeout: 200, killTimeout: 1000 });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(a.confirmed, true);
  assert.equal(a.remaining_count, 0);
  assert.equal(a.resources_released, true);
  assert(Date.now() - start >= 190);
  assert.deepEqual(
    stages.filter((e) => e.phase === "request").map((e) => e.stage),
    ["input_interrupt", "graceful", "termination", "kill"],
  );
  assert.equal(stages.at(-1).stage, "verification");
  assert.equal(stages.at(-1).status, "exit_confirmed");
  const stopped = (await rows(trace)).length;
  await pause(180);
  assert.equal((await rows(trace)).length, stopped);
});
test("cooperative EOF/TERM exits require no forced kill on Linux and retain truthful Windows graceful capability", async (t) => {
  const { tree } = await setup(t),
    { p, stages } = await tree("cooperative");
  const result = await p.stop({ gracefulTimeout: 400, killTimeout: 1000 });
  assert.equal(result.confirmed, true);
  if (process.platform === "linux")
    assert(!stages.some((s) => s.stage === "kill"));
  else
    assert(
      stages.some(
        (s) => s.stage === "termination" && s.status === "unsupported",
      ),
    );
});
test("root exit cannot confirm descendant exit and changing the exposed PID to an independent canary never redirects a kernel-handle stop", async (t) => {
  const { root, tree, rows, own } = await setup(t),
    { p, trace } = await tree("root_exit"),
    { p: other, trace: otherTrace } = await tree();
  const canaryTrace = path.join(root, "human-terminal.jsonl");
  const canary = spawn(
    process.execPath,
    [fixture, "canary", "stubborn", canaryTrace],
    { stdio: "ignore", windowsHide: true },
  );
  // Stop every trace writer before setup removes their shared directory.
  own({
    stop: async () => {
      if (canary.exitCode !== null || canary.signalCode !== null) return;
      const closed = new Promise((r) => canary.once("close", r));
      canary.kill("SIGKILL");
      await closed;
    },
  });
  await waitFor(async () =>
    (await rows(canaryTrace)).some((r) => r.type === "heartbeat"),
  );
  p.child.stdin.end();
  await waitFor(async () => {
    const state = await p.inspect();
    return (
      !state.remaining_pids.includes(p.descriptor.root_pid) &&
      state.remaining_count >= 2
    );
  });
  assert.equal((await p.inspect()).confirmed, false);
  p.child.pid = canary.pid; // Deterministic reused-PID fault; authority stays in the live kernel group.
  assert.equal(
    (await p.stop({ gracefulTimeout: 150, killTimeout: 1000 })).confirmed,
    true,
  );
  assert.equal((await other.inspect()).status, "running");
  assert((await other.inspect()).remaining_count >= 3);
  assert((await rows(otherTrace)).every((r) => r.type !== "term"));
  assert((await rows(canaryTrace)).every((r) => r.type !== "term"));
  const n = (await rows(canaryTrace)).length;
  await pause(150);
  assert((await rows(canaryTrace)).length > n);
  assert((await rows(trace)).some((r) => r.type === "eof"));
});
test("monitor disconnect is unverifiable, sends no guessed PID kill, and never produces a confirmed stop", async (t) => {
  const { tree, rows } = await setup(t),
    { p, trace, stages } = await tree();
  p.disconnectMonitor();
  const result = await p.stop({ gracefulTimeout: 100, killTimeout: 1000 });
  assert.equal(result.status, "unverifiable");
  assert.equal(result.confirmed, false);
  assert.deepEqual(
    stages.map((e) => e.stage),
    ["verification"],
  );
  // The supervisor's EOF cleanup is still confined to its original group.
  await pause(1300);
  const n = (await rows(trace)).length;
  await pause(180);
  assert.equal((await rows(trace)).length, n);
});
test("managed Harness stores ownership before release and every stop stage including final empty-group proof; reloaded history cannot recreate signal authority", async (t) => {
  const { root, own } = await setup(t),
    trace = path.join(root, "harness.jsonl"),
    project = { id: "scope-history", directory: path.join(root, "state") };
  const h = await startHarness(3081, 38081, {
    project,
    cwd: root,
    command: [process.execPath, fixture, "root", "stubborn", trace],
    stopTimeout: 150,
  });
  own(h);
  const before = await h.inspect();
  assert(before.scope.remaining_count >= 3);
  assert.equal((await h.stop()).confirmed, true);
  const history = await RunHistory.open(project),
    result = await history.inspect(h.run_id),
    events = (await history.events(h.run_id)).events;
  assert(
    events.findIndex((e) => e.type === "scope_intent") <
      events.findIndex((e) => e.type === "scope_bound"),
  );
  assert(
    events.some(
      (e) =>
        e.type === "stop_stage" &&
        e.data.stage === "kill" &&
        e.data.phase === "request",
    ),
  );
  assert.equal(result.scope_observation.status, "exit_confirmed");
  assert.equal(result.scope_observation.stop_authority, false);
  assert.equal(result.scope.stages.at(-1).remaining_count, 0);
  assert.equal(result.commands.filter((c) => c.operation === "stop").length, 1);
});

test("authenticated Harness API separates stopping from verified empty descendants, duplicate human requests stop once, and MCP credentials cannot stop the owned run", async (t) => {
  const { root, own } = await setup(t),
    previous = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(root, "dashboard-home");
  t.after(() => {
    if (previous === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = previous;
  });
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const d = await startDashboard({
    kind: "harness",
    port,
    tailscale: false,
    harnessOptions: {
      cwd: root,
      command: [
        process.execPath,
        fixture,
        "root",
        "stubborn",
        path.join(root, "api-tree.jsonl"),
      ],
      stopTimeout: 400,
    },
  });
  own({ stop: () => d.close() });
  const runtime = JSON.parse(
    await fs.readFile(path.join(d.directory, "runtime.json"), "utf8"),
  );
  const url = d.localUrl + "_rdsh/api/",
    admin = { authorization: "Bearer " + runtime.token };
  assert.equal(
    (await fetch(url + "managed-stop", { method: "POST" })).status,
    401,
  );
  assert.equal(
    (
      await fetch(url + "managed-stop", {
        method: "POST",
        headers: { authorization: "Bearer " + runtime.mcp_token },
      })
    ).status,
    401,
  );
  const entry = new URL(d.browserUrl);
  const bootstrap = await fetch(entry, { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
  const headers = { cookie };
  const responses = await Promise.all([
    fetch(url + "managed-stop", { method: "POST", headers }),
    fetch(url + "managed-stop", { method: "POST", headers }),
  ]);
  assert(responses.every((r) => r.status === 202));
  assert.equal(
    (await (await fetch(url + "managed-process", { headers })).json()).scope
      .status,
    "stopping",
  );
  let state;
  await waitFor(async () => {
    state = await (await fetch(url + "managed-process", { headers })).json();
    return state.scope.status === "exit_confirmed";
  });
  assert.equal(state.scope.remaining_count, 0);
  assert.equal(state.scope.confirmed, true);
  assert.equal(
    state.stages.filter((s) => s.stage === "kill" && s.phase === "request")
      .length,
    1,
  );
  const history = await RunHistory.open({
    id: "managed-harness",
    directory: d.directory,
  });
  assert.equal(
    (await history.inspect(state.run_id)).commands.filter(
      (c) => c.operation === "stop",
    ).length,
    1,
  );
  assert.equal(
    (await fetch(url + "stop", { method: "POST", headers })).status,
    401,
  );
  assert.equal(
    (await fetch(url + "stop", { method: "POST", headers: admin })).status,
    200,
  );
});

test("lost Harness monitor remains unverifiable in HTTP responses and administrator shutdown refuses to hide the uncertain result", async (t) => {
  const { root } = await setup(t),
    previous = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(root, "lost-home");
  t.after(() => {
    if (previous === undefined) delete process.env.RDSH_DASHBOARD_HOME;
    else process.env.RDSH_DASHBOARD_HOME = previous;
  });
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  let h;
  const d = await startDashboard({
    kind: "harness",
    port,
    tailscale: false,
    observeHarness: (value) => {
      h = value;
    },
    harnessOptions: {
      cwd: root,
      command: [
        process.execPath,
        fixture,
        "root",
        "stubborn",
        path.join(root, "lost-tree.jsonl"),
      ],
      stopTimeout: 150,
    },
  });
  const runtime = JSON.parse(
      await fs.readFile(path.join(d.directory, "runtime.json"), "utf8"),
    ),
    headers = { authorization: "Bearer " + runtime.token },
    url = d.localUrl + "_rdsh/api/";
  h.disconnectMonitor();
  assert.equal(
    (await fetch(url + "managed-stop", { method: "POST", headers })).status,
    202,
  );
  await waitFor(
    async () =>
      (await (await fetch(url + "managed-process", { headers })).json()).scope
        .status === "unverifiable",
  );
  const response = await fetch(url + "stop", { method: "POST", headers });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).managed_stop.confirmed, false);
  assert.equal((await fetch(url + "managed-process", { headers })).status, 200);
  const history = await RunHistory.open({
    id: "managed-harness",
    directory: d.directory,
  });
  assert.equal(
    (await history.inspect(h.run_id)).scope_observation.status,
    "unverifiable",
  );
  assert((await fs.stat(path.join(d.directory, "server.lock"))).isFile());
  // Test teardown closes this exact HTTP server after the supervisor's owned cleanup;
  // it does not invoke a persisted PID or reconstruct a stop authority.
  await pause(1300);
  d.server.closeAllConnections();
  await new Promise((r) => d.server.close(r));
});
