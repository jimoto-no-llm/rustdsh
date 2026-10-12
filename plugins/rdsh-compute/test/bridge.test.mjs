import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComputeBridge, isEnabled } from "../index.js";

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
