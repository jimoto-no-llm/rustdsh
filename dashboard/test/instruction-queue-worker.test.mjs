import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  InstructionQueueWorker,
  resolveRdshExecutable,
  supportsInstructionQueueServe,
} from "../instruction-queue-worker.mjs";

function fakeWorker(t, onSpawn = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rdsh-iq-worker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "fake-worker.mjs");
  fs.writeFileSync(
    script,
    `import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.exit) process.exit(7);
  if (request.malformed) return process.stdout.write("not-json\\n");
  if (request.fail) return process.stdout.write(JSON.stringify({ error: "conflict", status: 409 }) + "\\n");
  process.stdout.write(JSON.stringify({ id: request.id }) + "\\n");
});
input.on("close", () => process.exit(0));\n`,
  );
  return new InstructionQueueWorker(process.execPath, {
    prefixArgs: [script],
    spawnProcess(...args) {
      const child = spawn(...args);
      onSpawn(child);
      return child;
    },
    requestTimeoutMs: 2_000,
    closeTimeoutMs: 2_000,
  });
}

test("resolveRdshExecutable accepts an absolute override and searches absolute PATH entries", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rdsh-iq-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const name = process.platform === "win32" ? "rdsh.exe" : "rdsh";
  const binary = path.join(root, name);
  fs.writeFileSync(binary, "test executable");
  if (process.platform !== "win32") fs.chmodSync(binary, 0o755);

  assert.equal(await resolveRdshExecutable({ RDSH_BIN: binary }), binary);
  await assert.rejects(
    resolveRdshExecutable({ RDSH_BIN: "./rdsh" }),
    /RDSH_BIN must be an absolute path/,
  );
  assert.equal(
    await resolveRdshExecutable({ PATH: `${root}${path.delimiter}/relative` }),
    binary,
  );
});

test("serve capability probe requires the current worker protocol", async () => {
  const reply = (value) => {
    const line = JSON.stringify(`${JSON.stringify(value)}\n`);
    return `process.stdin.resume(); process.stdin.on(\"end\", () => process.stdout.write(${line}));`;
  };
  const supported = reply({
    operation: "capabilities",
    protocol: 1,
    features: { prevalidated_state: true },
  });
  const unsupported = reply({
    error: "Invalid instruction-queue action/options",
    status: 400,
  });
  assert.equal(
    await supportsInstructionQueueServe(process.execPath, {
      prefixArgs: ["-e", supported],
    }),
    true,
  );
  assert.equal(
    await supportsInstructionQueueServe(process.execPath, {
      prefixArgs: ["-e", unsupported],
    }),
    false,
  );
  assert.equal(
    await supportsInstructionQueueServe(process.execPath, {
      prefixArgs: ["-e", "process.exit(64)"],
    }),
    false,
  );
  assert.equal(
    await supportsInstructionQueueServe(process.execPath, {
      prefixArgs: ["-e", "process.stdin.resume()"],
      timeoutMs: 50,
    }),
    false,
  );
});

test("worker serializes requests and preserves Rust error status", async (t) => {
  const worker = fakeWorker(t);
  const results = await Promise.all([
    worker.request({ id: "first" }),
    worker.request({ id: "second" }),
  ]);
  assert.deepEqual(results, [{ id: "first" }, { id: "second" }]);
  await assert.rejects(worker.request({ fail: true }), (error) => {
    assert.equal(error.message, "conflict");
    assert.equal(error.status, 409);
    return true;
  });
  assert.deepEqual(await worker.request({ id: "after-error" }), {
    id: "after-error",
  });
  await worker.close();
});

test("worker rejects malformed output and unexpected process exits, then restarts", async (t) => {
  const worker = fakeWorker(t);
  await assert.rejects(worker.request({ malformed: true }), /invalid JSON/);
  await assert.rejects(worker.request({ exit: true }), /exited unexpectedly/);
  assert.deepEqual(await worker.request({ id: "restarted" }), {
    id: "restarted",
  });
  await worker.close();
});

test("worker reports spawn failures and closes cleanly", async (t) => {
  const missing = path.join(os.tmpdir(), `rdsh-missing-${process.pid}`);
  const broken = new InstructionQueueWorker(missing, { requestTimeoutMs: 2_000 });
  await assert.rejects(broken.request({ id: "missing" }), /spawn|ENOENT/i);
  await broken.close();

  const worker = fakeWorker(t);
  assert.deepEqual(await worker.request({ id: "before-close" }), {
    id: "before-close",
  });
  await worker.close();
  await assert.rejects(worker.request({ id: "after-close" }), /closed/);
});

test("close drains requests accepted before shutdown", async (t) => {
  const worker = fakeWorker(t);
  const request = worker.request({ id: "accepted-before-close" });
  const closing = worker.close();
  assert.deepEqual(await request, { id: "accepted-before-close" });
  await closing;
});

test("close force-kills a worker that ignores graceful shutdown and waits for exit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rdsh-iq-stubborn-worker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "stubborn-worker.mjs");
  fs.writeFileSync(
    script,
    `import { createInterface } from "node:readline";
process.on("SIGTERM", () => {});
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => process.stdout.write(JSON.stringify({ id: JSON.parse(line).id }) + "\\n"));
setInterval(() => {}, 1000);
`,
  );
  let child;
  const worker = new InstructionQueueWorker(process.execPath, {
    prefixArgs: [script],
    closeTimeoutMs: 30,
    spawnProcess(...args) {
      child = spawn(...args);
      return child;
    },
  });
  assert.deepEqual(await worker.request({ id: "still-running" }), {
    id: "still-running",
  });
  await worker.close();
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(worker.record, null);
});

test("worker kills its child after request serialization fails", async (t) => {
  const children = [];
  t.after(() => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const worker = fakeWorker(t, (child) => children.push(child));
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(worker.request(cyclic), /circular/i);
  assert.deepEqual(await worker.request({ id: "after-serialization-error" }), {
    id: "after-serialization-error",
  });
  await worker.close();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(children[0].exitCode !== null || children[0].signalCode !== null);
  assert.equal(children.length, 2);
});
