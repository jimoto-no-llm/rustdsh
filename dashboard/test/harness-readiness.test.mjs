import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { resolveHarnessProvider } from "../harness-providers.mjs";

function fixture(t, timeout = 1000) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  t.after(() => {
    child.stdout.destroy();
    child.stderr.destroy();
  });
  const provider = resolveHarnessProvider({ command: ["unused"] });
  return { child, ready: provider.waitUntilReady(child, { port: 3081, timeout }) };
}

function assertDetached(child) {
  for (const stream of [child.stdout, child.stderr]) {
    assert.equal(stream.listenerCount("data"), 0);
    assert.equal(stream.listenerCount("end"), 0);
  }
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("exit"), 0);
}

test("readiness preserves credentials across fragmented and interleaved output", async (t) => {
  const { child, ready } = fixture(t);
  child.stdout.write("dsh web: http://127.0.0.1:3081/");
  child.stderr.write("another startup message\n");
  child.stdout.write("?token=sentinel#session");
  child.stdout.write("\r\n");
  assert.equal((await ready).href, "http://127.0.0.1:3081/?token=sentinel#session");
  assertDetached(child);
});

test("readiness decodes a final unterminated UTF-8 line at stream end", async (t) => {
  const { child, ready } = fixture(t);
  const line = Buffer.from("dsh web: http://127.0.0.1:3081/?label=日本語");
  const split = line.indexOf(Buffer.from("日")) + 1;
  let completed = false;
  void ready.then(() => { completed = true; });
  child.stderr.write(line.subarray(0, split));
  child.stderr.write(line.subarray(split));
  await new Promise(setImmediate);
  assert.equal(completed, false);
  child.stderr.end();
  assert.equal((await ready).searchParams.get("label"), "日本語");
  assertDetached(child);
});

test("invalid readiness URLs reject without escaping the stream callback", async (t) => {
  const { child, ready } = fixture(t);
  const result = ready.then(() => null, (error) => error);
  let thrown;
  try {
    child.stdout.write("dsh web: http://127.0.0.1:99999/?token=sentinel\n");
  } catch (error) {
    thrown = error;
    child.emit("exit", 1);
  }
  const error = await result;
  assert.equal(thrown, undefined);
  assert.match(error.message, /invalid readiness URL/);
  assert.equal(error.message.includes("sentinel"), false);
  assertDetached(child);
});

test("a partial readiness line does not bypass the startup deadline", async (t) => {
  const { child, ready } = fixture(t, 50);
  child.stdout.write("dsh web: http://127.0.0.1:3081/");
  await assert.rejects(ready, /startup timed out/);
  assertDetached(child);
});
