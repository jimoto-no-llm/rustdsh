import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createComputeBridge } from "../index.js";

// Regression test for #378: a worker that exits before/during stdin write
// must not kill the Node host with an unhandled 'error' (EPIPE); the call
// falls back to JS compute instead.
test("worker exiting early falls back to JS compute without killing host", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "rdsh-compute-epipe-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  process.env.RDSH_COMPUTE = "1";
  t.after(async () => {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    delete process.env.RDSH_COMPUTE;
    await rm(home, { recursive: true, force: true });
  });
  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.once("uncaughtException", onUnhandled);
  t.after(() => { process.removeListener("uncaughtException", onUnhandled); });
  const bridge = createComputeBridge({ bin: "/bin/false" });
  t.after(() => bridge.close());
  const value = await bridge.estimate("x".repeat(1024 * 1024));
  assert.equal(value.usedRust, false);
  assert.equal(value.result.tokens, 262144);
  assert.equal(unhandled, null);
});

// A delayed event from a replaced worker must not reject the new worker's
// pending requests.
test("stale worker events do not touch newer pending requests", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "rdsh-compute-stale-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  process.env.RDSH_COMPUTE = "1";
  t.after(async () => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    delete process.env.RDSH_COMPUTE;
    await rm(home, { recursive: true, force: true });
  });

  class FakeStdio extends EventEmitter {
    constructor() { super(); this.lastLine = null; }
    write(chunk) { this.lastLine = String(chunk); return true; }
    setEncoding() {}
  }
  class FakeProc extends EventEmitter {
    constructor() {
      super();
      this.stdin = new FakeStdio();
      this.stdout = new FakeStdio();
    }
    kill() { return true; }
  }
  const procs = [];
  const bridge = createComputeBridge({
    bin: "fake",
    timeoutMs: 2000,
    spawnImpl: () => {
      const p = new FakeProc();
      procs.push(p);
      return p;
    },
  });
  t.after(() => bridge.close());
  // First request pends on proc #0; killing it falls back and drops it.
  const first = bridge.estimate("hello");
  await new Promise((r) => setImmediate(r));
  assert.equal(procs.length, 1);
  procs[0].emit("exit", 1);
  assert.equal((await first).usedRust, false);
  // Second request spawns proc #1.
  const second = bridge.estimate("world");
  await new Promise((r) => setImmediate(r));
  assert.equal(procs.length, 2);
  // Late events from dead proc #0 must not reject proc #1's call.
  procs[0].stdin.emit("error", new Error("write EPIPE (stale)"));
  procs[0].emit("error", new Error("stale"));
  // Proc #1 answers normally; capture its request id from stdin.
  const sent = JSON.parse(procs[1].stdin.lastLine);
  procs[1].stdout.emit(
    "data",
    JSON.stringify({ id: sent.id, ok: true, tokens: 7, chars: 5, elapsed_us: 1 }) + "\n",
  );
  const v2 = await second;
  assert.equal(v2.usedRust, true);
  assert.equal(v2.result.tokens, 7);
});
