import test from "node:test";
import assert from "node:assert/strict";
import { createComputeBridge } from "../index.js";

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
