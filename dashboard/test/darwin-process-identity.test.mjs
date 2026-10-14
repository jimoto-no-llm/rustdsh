import test from "node:test";
import assert from "node:assert/strict";
import { readDarwinProcess } from "../darwin-process-identity.mjs";

const scope = "a".repeat(64);
const pid = 42424;

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
