import test from "node:test";
import assert from "node:assert/strict";
import { readDarwinProcess } from "../darwin-process-identity.mjs";

const scope = "a".repeat(64);
const pid = 42424;

function bsdInfo({ status = 2, processId = pid, uid = 501 } = {}) {
  const buffer = Buffer.alloc(136);
  buffer.writeUInt32LE(status, 4);
  buffer.writeUInt32LE(processId, 12);
  buffer.writeUInt32LE(uid, 20);
  buffer.writeBigUInt64LE(1_700_000_000n, 120);
  buffer.writeBigUInt64LE(1n, 128);
  return buffer;
}

const observedApi = (options) => async () => ({
  procPidInfo: (_pid, _flavor, _arg, buffer) => {
    bsdInfo(options).copy(buffer);
    return buffer.length;
  },
  errno: () => 0,
});

test("Darwin reader fails closed for scope, API and ABI failures", async () => {
  const unavailableScope = await readDarwinProcess(pid, {
    scopeReader: async () => {
      throw new Error("scope unavailable");
    },
  });
  assert.deepEqual(unavailableScope, { status: "unknown", identity: null });

  for (const nativeReader of [
    async () => ({
      procPidInfo: () => 0,
      errno: () => 1,
    }),
    async () => ({
      procPidInfo: () => 135,
      errno: () => 0,
    }),
    async () => ({
      procPidInfo: () => 136,
      errno: () => 0,
    }),
  ])
    assert.deepEqual(
      await readDarwinProcess(pid, {
        scopeReader: async () => scope,
        nativeReader,
      }),
      { status: "unknown", identity: null },
    );
});

test("Darwin reader reports gone only for ESRCH after a validated scope", async () => {
  assert.deepEqual(
    await readDarwinProcess(pid, {
      scopeReader: async () => scope,
      nativeReader: async () => ({
        procPidInfo: () => 0,
        errno: () => 3,
      }),
    }),
    { status: "gone", identity: null, platform: "darwin", scope },
  );
});

test("Darwin reader reports a validated zombie as gone", async () => {
  assert.deepEqual(
    await readDarwinProcess(pid, {
      scopeReader: async () => scope,
      nativeReader: observedApi({ status: 5 }),
    }),
    { status: "gone", identity: null, platform: "darwin", scope },
  );
});

test("Darwin reader never treats a mismatched PID as gone", async () => {
  assert.deepEqual(
    await readDarwinProcess(pid, {
      scopeReader: async () => scope,
      nativeReader: observedApi({ status: 5, processId: pid + 1 }),
    }),
    { status: "unknown", identity: null },
  );
});

test("Darwin reader caches a validated scope but retries a failed read", async () => {
  let scopeCalls = 0;
  const stableScope = async () => {
    scopeCalls += 1;
    return scope;
  };
  const nativeReader = observedApi();
  assert.equal(
    (await readDarwinProcess(pid, { scopeReader: stableScope, nativeReader }))
      .status,
    "observed",
  );
  assert.equal(
    (await readDarwinProcess(pid, { scopeReader: stableScope, nativeReader }))
      .status,
    "observed",
  );
  assert.equal(scopeCalls, 1);

  let failures = 0;
  const retryingScope = async () => {
    failures += 1;
    if (failures === 1) throw new Error("sysctl unavailable");
    return scope;
  };
  assert.deepEqual(
    await readDarwinProcess(pid, { scopeReader: retryingScope, nativeReader }),
    { status: "unknown", identity: null },
  );
  assert.equal(
    (await readDarwinProcess(pid, { scopeReader: retryingScope, nativeReader }))
      .status,
    "observed",
  );
  assert.equal(failures, 2);
});
