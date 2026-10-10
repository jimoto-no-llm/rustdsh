import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerDashboardShutdown } from "../shutdown.mjs";

function fakeProcess() {
  const value = new EventEmitter();
  value.exitCode = 0;
  value.exited = null;
  value.output = { stdout: [], stderr: [] };
  value.stdout = {
    write(text, callback) {
      value.output.stdout.push(text);
      callback();
      return true;
    },
  };
  value.stderr = {
    write(text, callback) {
      value.output.stderr.push(text);
      callback();
      return true;
    },
  };
  value.exit = (code) => {
    value.exited = code;
  };
  return value;
}

test("signal shutdown flushes output and exits cleanly after close succeeds", async () => {
  const processRef = fakeProcess();
  let calls = 0;
  const shutdown = registerDashboardShutdown(async () => {
    calls++;
  }, processRef);

  processRef.emit("SIGINT");
  await shutdown.wait();

  assert.equal(calls, 1);
  assert.deepEqual(processRef.output.stdout, [""]);
  assert.deepEqual(processRef.output.stderr, []);
  assert.equal(processRef.exited, 0);
});

test("close rejection is reported once without an unhandled promise", async () => {
  const processRef = fakeProcess();
  let calls = 0;
  const shutdown = registerDashboardShutdown(async () => {
    calls++;
    throw new Error("mcp close failed\nwith stack-like details");
  }, processRef);

  processRef.emit("SIGTERM");
  processRef.emit("SIGINT");
  await shutdown.wait();

  assert.equal(calls, 1);
  assert.deepEqual(processRef.output.stdout, []);
  assert.deepEqual(processRef.output.stderr, [
    "[rdsh-dashboard] SIGTERM shutdown failed: mcp close failed with stack-like details\n",
  ]);
  assert.equal(processRef.exitCode, 1);
  assert.equal(processRef.exited, 1);
});

test("a synchronous close throw is also handled", async () => {
  const processRef = fakeProcess();
  const shutdown = registerDashboardShutdown(() => {
    throw new Error("owned Harness exit unverified");
  }, processRef);

  processRef.emit("SIGINT");
  await shutdown.wait();

  assert.match(processRef.output.stderr[0], /SIGINT shutdown failed/);
  assert.equal(processRef.exited, 1);
});
