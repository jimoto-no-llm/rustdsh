import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, createComputeBridge, isEnabled } from "../index.js";

test("disabled by default: fallback estimate matches len/4 rule", async () => {
  delete process.env.RDSH_COMPUTE;
  const b = createComputeBridge();
  const { result, usedRust } = await b.estimate("abcd1234");
  assert.equal(usedRust, false);
  assert.equal(result.tokens, 2);
  b.close();
});

test("jsEstimate matches Rust heuristic on mixed input", async () => {
  const b = createComputeBridge();
  // ASCII 5 chars -> ceil(5/4)=2 ; single CJK char -> 1
  assert.equal(b.jsEstimate("abcde"), 2);
  assert.equal(b.jsEstimate("あ"), 1);
  b.close();
});

test("fallback chars counts Unicode scalars, not UTF-8 bytes", async () => {
  delete process.env.RDSH_COMPUTE;
  const b = createComputeBridge();
  assert.equal((await b.estimate("日本語")).result.chars, 3);
  assert.equal((await b.estimate("é")).result.chars, 1);
  assert.deepEqual((await b.estimateBatch(["日本語", "é", "abc"])).result.chars, [3, 1, 3]);
  b.close();
});

test("batch fallback matches per-item estimates", async () => {
  delete process.env.RDSH_COMPUTE;
  const b = createComputeBridge();
  const { result, usedRust } = await b.estimateBatch(["abcd1234", "あ"]);
  assert.equal(usedRust, false);
  assert.deepEqual(result.tokens, [2, 1]);
  assert.equal(result.total, 3);
  b.close();
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
  b.close();
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
  b.close();
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
  b.close();
  delete process.env.RDSH_COMPUTE;
});

test("cordis entry exposes ctx.rdshCompute and closes it on dispose", async (t) => {
  // Hermetic home: compute stays off, so the resolved bin is never spawned.
  await featureHome(t, JSON.stringify({ features: { compute: false } }));
  const previousBin = process.env.RDSH_BIN;
  process.env.RDSH_BIN = "/nonexistent/rdsh-for-test";
  t.after(() => {
    if (previousBin === undefined) delete process.env.RDSH_BIN;
    else process.env.RDSH_BIN = previousBin;
  });

  const handlers = [];
  const ctx = { on: (event, fn) => handlers.push([event, fn]) };
  apply(ctx);
  const bridge = ctx.rdshCompute;
  assert.equal(typeof bridge.estimate, "function");
  assert.equal(typeof bridge.prune, "function");
  const { usedRust } = await bridge.estimate("abcd1234");
  assert.equal(usedRust, false); // disabled: fallback, no spawn

  let closed = false;
  bridge.close = () => { closed = true; };
  for (const [event, fn] of handlers) if (event === "dispose") fn();
  assert.equal(closed, true);
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

function fakeWorker() {
  const worker = new EventEmitter();
  worker.stdout = new EventEmitter();
  worker.stdout.setEncoding = () => {};
  worker.stdin = new EventEmitter();
  worker.stdin.writes = [];
  worker.stdin.write = (value) => {
    worker.stdin.writes.push(value);
    return true;
  };
  worker.kill = () => {};
  return worker;
}

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
    b.close();
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
    b.close();
  }
});
