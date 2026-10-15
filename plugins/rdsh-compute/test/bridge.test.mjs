import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComputeBridge, isEnabled } from "../index.js";

test("disabled by default: fallback estimate matches len/4 rule", async (t) => {
  await featureHome(t, undefined);
  delete process.env.RDSH_COMPUTE;
  const b = createComputeBridge();
  const { result, usedRust } = await b.estimate("abcd1234");
  assert.equal(usedRust, false);
  assert.equal(result.tokens, 2);
  await b.close();
});

test("jsEstimate matches Rust heuristic on mixed input", async () => {
  const b = createComputeBridge();
  // ASCII 5 chars -> ceil(5/4)=2 ; single CJK char -> 1
  assert.equal(b.jsEstimate("abcde"), 2);
  assert.equal(b.jsEstimate("あ"), 1);
  await b.close();
});

test("fallback chars counts Unicode scalars, not UTF-8 bytes", async (t) => {
  await featureHome(t, undefined);
  delete process.env.RDSH_COMPUTE;
  const b = createComputeBridge();
  assert.equal((await b.estimate("日本語")).result.chars, 3);
  assert.equal((await b.estimate("é")).result.chars, 1);
  assert.deepEqual((await b.estimateBatch(["日本語", "é", "abc"])).result.chars, [3, 1, 3]);
  await b.close();
});

test("batch fallback matches per-item estimates", async (t) => {
  await featureHome(t, undefined);
  delete process.env.RDSH_COMPUTE;
  const b = createComputeBridge();
  const { result, usedRust } = await b.estimateBatch(["abcd1234", "あ"]);
  assert.equal(usedRust, false);
  assert.deepEqual(result.tokens, [2, 1]);
  assert.equal(result.total, 3);
  await b.close();
});

// Feature switches are read from $DSH_HOME/rdsh.json. Every switch test uses a
// hermetic temp home so the real ~/.dsh/rdsh.json never changes the result.
async function featureHome(t, contents) {
  const home = await mkdtemp(join(tmpdir(), "rdsh-compute-home-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  if (contents !== undefined) await writeFile(join(home, "rdsh.json"), contents);
  return home;
}

test("features.compute=false keeps the bridge off even with RDSH_COMPUTE=1", async (t) => {
  await featureHome(t, JSON.stringify({ features: { compute: false } }));
  process.env.RDSH_COMPUTE = "1";
  t.after(() => { delete process.env.RDSH_COMPUTE; });
  assert.equal(isEnabled(), false);
  let spawned = false;
  const b = createComputeBridge({ spawnImpl: () => { spawned = true; throw new Error("must not spawn"); } });
  const { result, usedRust } = await b.estimate("abcd1234");
  assert.equal(spawned, false);
  assert.equal(usedRust, false);
  assert.equal(result.tokens, 2);
  await b.close();
});

test("features.compute=true with RDSH_COMPUTE=1 reaches spawn and still falls back", async (t) => {
  await featureHome(t, JSON.stringify({ features: { compute: true } }));
  process.env.RDSH_COMPUTE = "1";
  t.after(() => { delete process.env.RDSH_COMPUTE; });
  assert.equal(isEnabled(), true);
  let spawned = false;
  const b = createComputeBridge({ spawnImpl: () => { spawned = true; throw new Error("worker unavailable"); } });
  const { result, usedRust } = await b.estimate("abcd1234");
  assert.equal(spawned, true);
  assert.equal(usedRust, false);
  assert.equal(result.tokens, 2);
  await b.close();
});

test("absent or unreadable rdsh.json follows the RDSH_COMPUTE opt-in", async (t) => {
  await featureHome(t, undefined); // no rdsh.json at all
  process.env.RDSH_COMPUTE = "1";
  t.after(() => { delete process.env.RDSH_COMPUTE; });
  // The feature switch is a veto: without the key the historical env opt-in wins.
  assert.equal(isEnabled(), true);
  await writeFile(join(process.env.DSH_HOME, "rdsh.json"), "{ not json");
  assert.equal(isEnabled(), true);
  await writeFile(join(process.env.DSH_HOME, "rdsh.json"), JSON.stringify({ features: { compute: "yes" } }));
  assert.equal(isEnabled(), true);
  delete process.env.RDSH_COMPUTE;
  assert.equal(isEnabled(), false); // no env opt-in and no explicit true: off
});

test("oversize input is rejected before spawn", async () => {
  process.env.RDSH_COMPUTE = "1";
  let spawned = false;
  const fakeSpawn = () => { spawned = true; throw new Error("must not spawn"); };
  const b = createComputeBridge({ spawnImpl: fakeSpawn });
  // call request path via prune with 2 MiB text
  const big = "x".repeat(2 * 1024 * 1024);
  const { result, usedRust } = await b.prune(big, 100);
  // fallback runs, worker never spawned
  assert.equal(spawned, false);
  assert.equal(usedRust, false);
  assert.equal(typeof result.pruned, "string");
  await b.close();
  delete process.env.RDSH_COMPUTE;
});

async function enableComputeForTest(t) {
  await featureHome(t, JSON.stringify({ features: { compute: true } }));
  const previous = process.env.RDSH_COMPUTE;
  process.env.RDSH_COMPUTE = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.RDSH_COMPUTE;
    else process.env.RDSH_COMPUTE = previous;
  });
}

function fakeWorker({ onKill } = {}) {
  const worker = new EventEmitter();
  worker.exitCode = null;
  worker.signalCode = null;
  worker.stdout = new EventEmitter();
  worker.stdout.setEncoding = () => {};
  worker.stdin = new EventEmitter();
  worker.stdin.writes = [];
  worker.stdin.write = (value) => {
    worker.stdin.writes.push(value);
    return true;
  };
  worker.stdin.end = () => {};
  worker.kill = (signal = "SIGTERM") => {
    if (onKill) return onKill(signal, worker);
    worker.signalCode = signal;
    queueMicrotask(() => {
      worker.emit("exit", null, signal);
      worker.emit("close", null, signal);
    });
    return true;
  };
  return worker;
}

async function startedBridge(t, onKill) {
  await enableComputeForTest(t);
  const worker = fakeWorker({ onKill });
  let spawned = 0;
  const bridge = createComputeBridge({
    timeoutMs: 20,
    spawnImpl: () => {
      spawned += 1;
      return worker;
    },
    shutdownGraceMs: 5,
    shutdownTimeoutMs: 10,
  });
  const result = bridge.estimate("abcd1234");
  const request = JSON.parse(worker.stdin.writes[0]);
  worker.stdout.emit("data", JSON.stringify({
    id: request.id,
    ok: true,
    tokens: 2,
    chars: 8,
    elapsed_us: 1,
  }) + "\n");
  await result;
  return { bridge, worker, spawned: () => spawned };
}

async function settledWithin(promise, timeoutMs = 100) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: "timed-out" }), timeoutMs);
  });
  const settled = Promise.resolve(promise).then(
    () => ({ state: "fulfilled" }),
    (error) => ({ state: "rejected", error }),
  );
  const outcome = await Promise.race([settled, timedOut]);
  clearTimeout(timer);
  return outcome;
}

test("close rejects rather than hanging when SIGTERM cannot be delivered", async (t) => {
  const { bridge } = await startedBridge(t, () => false);
  const outcome = await settledWithin(bridge.close());
  assert.equal(outcome.state, "rejected");
  assert.match(outcome.error.message, /did not exit/);
});

test("close rejects rather than hanging when signaling throws", async (t) => {
  const { bridge } = await startedBridge(t, () => { throw new Error("signal denied"); });
  const outcome = await settledWithin(bridge.close());
  assert.equal(outcome.state, "rejected");
  assert.match(outcome.error.message, /did not exit/);
});

test("close escalates an unresponsive worker to SIGKILL and waits for close", async (t) => {
  const signals = [];
  const { bridge } = await startedBridge(t, (signal, worker) => {
    signals.push(signal);
    if (signal === "SIGKILL") {
      worker.signalCode = signal;
      worker.emit("exit", null, signal);
      worker.emit("close", null, signal);
    }
    return true;
  });
  const outcome = await settledWithin(bridge.close());
  assert.equal(outcome.state, "fulfilled");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("concurrent close calls share one worker shutdown", async (t) => {
  const signals = [];
  const { bridge } = await startedBridge(t, (signal, worker) => {
    signals.push(signal);
    worker.signalCode = signal;
    queueMicrotask(() => worker.emit("close", null, signal));
    return true;
  });
  const first = bridge.close();
  const second = bridge.close();
  assert.strictEqual(first, second);
  assert.equal(typeof first?.then, "function");
  await first;
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("a closed active bridge falls back without starting another worker", async (t) => {
  const { bridge, spawned } = await startedBridge(t);
  await bridge.close();
  const [estimate, batch, prune] = await Promise.all([
    bridge.estimate("abcd1234"),
    bridge.estimateBatch(["abcd", "あ"]),
    bridge.prune("abcd1234", 1),
  ]);
  assert.equal(estimate.usedRust, false);
  assert.equal(batch.usedRust, false);
  assert.equal(prune.usedRust, false);
  assert.equal(spawned(), 1);
});

test("an unused closed bridge is terminal and shares its close promise", async (t) => {
  await enableComputeForTest(t);
  let spawned = 0;
  const bridge = createComputeBridge({ timeoutMs: 20, spawnImpl: () => { spawned += 1; return fakeWorker(); } });
  const first = bridge.close();
  const second = bridge.close();
  assert.strictEqual(first, second);
  assert.equal(typeof first?.then, "function");
  await first;
  const result = await bridge.estimate("abcd1234");
  assert.equal(result.usedRust, false);
  assert.equal(spawned, 0);
});

test("stdin EPIPE from an exited worker falls back without terminating the host", {
  skip: process.platform === "win32",
}, async (t) => {
  await enableComputeForTest(t);
  const b = createComputeBridge({ bin: "/bin/false" });
  try {
    const { result, usedRust } = await b.estimate("x".repeat(1_048_576));
    assert.equal(usedRust, false);
    assert.deepEqual(result, { tokens: 262_144, chars: 1_048_576 });
  } finally {
    await b.close();
  }
});

test("an old worker stream error cannot reject a newer worker request", async (t) => {
  await enableComputeForTest(t);
  const workers = [fakeWorker(), fakeWorker()];
  let spawnCount = 0;
  const b = createComputeBridge({
    spawnImpl: () => workers[spawnCount++],
  });
  try {
    const oldRequests = [b.estimate("old"), b.estimate("also old")];
    assert.equal(spawnCount, 1);
    workers[0].stdout.emit("error", new Error("stdout closed"));
    const oldResults = await Promise.all(oldRequests);
    assert.deepEqual(oldResults.map((result) => result.usedRust), [false, false]);

    const newRequest = b.estimate("new");
    assert.equal(spawnCount, 2);
    workers[0].stdin.emit("error", new Error("late stdin failure"));
    workers[0].emit("exit", 0, null);

    const request = JSON.parse(workers[1].stdin.writes[0]);
    workers[1].stdout.emit("data", JSON.stringify({
      id: request.id,
      ok: true,
      tokens: 7,
      chars: 3,
      elapsed_us: 10,
    }) + "\n");

    const newResult = await newRequest;
    assert.equal(newResult.usedRust, true);
    assert.equal(newResult.result.tokens, 7);
  } finally {
    await b.close();
  }
});
