import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { openSync, writeSync, closeSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import * as helper from "../private-json-file.mjs";

const document = { operation: "schema", state: { note: "日本語 / 中文 {id}" } };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-private-json-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, "要求 日本語.json") };
}
function writer() {
  return helper.createPrivateJsonFile;
}
function fakeWindows({ verifyError, descriptorError, chunkSize, writeError } = {}) {
  const calls = [];
  const owned = new Map();
  const api = {
    descriptor() {
      calls.push("descriptor");
      if (descriptorError) throw descriptorError;
      return {};
    },
    create(file) { calls.push("create"); const handle = openSync(file, "wx", 0o600); owned.set(handle, file); return handle; },
    verify() { calls.push("verify"); if (verifyError) throw verifyError; },
    write(handle, bytes) {
      calls.push("write");
      if (writeError) throw writeError;
      return writeSync(handle, bytes, 0, Math.min(bytes.length, chunkSize ?? bytes.length));
    },
    close(handle) { calls.push("close"); closeSync(handle); unlinkSync(owned.get(handle)); owned.delete(handle); },
    release() { calls.push("release"); },
  };
  return { api, calls };
}

test("POSIX request lease preserves UTF-8 JSON, mode 0600 and exact disposal", { skip: process.platform === "win32" }, async (t) => {
  const create = writer();
  const { file } = await fixture(t);
  const lease = await create(file, document);
  assert.equal(await fs.readFile(file, "utf8"), JSON.stringify(document));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await lease.dispose();
  await lease.dispose();
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test("exclusive creation never deletes an existing caller file", async (t) => {
  const create = writer();
  const { file } = await fixture(t);
  await fs.writeFile(file, "existing 日本語");
  for (const options of [{ platform: "posix" }, { platform: "win32", nativeReader: async () => fakeWindows().api }]) {
    await assert.rejects(create(file, document, options), { code: "EEXIST" });
    assert.equal(await fs.readFile(file, "utf8"), "existing 日本語");
  }
});

test("Windows verifies protection before payload bytes and keeps its creator handle until disposal", async (t) => {
  const create = writer();
  const { file } = await fixture(t);
  const { api, calls } = fakeWindows({ chunkSize: 3 });
  const lease = await create(file, document, { platform: "win32", nativeReader: async () => api });
  assert.deepEqual(calls.slice(0, 3), ["descriptor", "create", "verify"]);
  assert.equal(calls.includes("close"), false);
  assert.equal(calls.at(-1), "release");
  assert.ok(calls.filter(call => call === "write").length > 1);
  assert.equal(await fs.readFile(file, "utf8"), JSON.stringify(document));
  await lease.dispose();
  await lease.dispose();
  assert.equal(calls.filter(call => call === "close").length, 1);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test("Windows verification failure writes zero payload bytes and closes/unlinks only its new empty file", async (t) => {
  const create = writer();
  const { file } = await fixture(t);
  const failure = new helper.PrivateJsonFileError("ACL verification", "UNVERIFIED_DACL");
  const { api, calls } = fakeWindows({ verifyError: failure });
  await assert.rejects(create(file, document, { platform: "win32", nativeReader: async () => api }), error => error === failure);
  assert.equal(calls.includes("write"), false);
  assert.equal(calls.filter(call => call === "close").length, 1);
  assert.equal(calls.filter(call => call === "release").length, 1);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test("Windows unavailable identity/ACL API never creates a file or writes payload", async (t) => {
  const create = writer();
  const { file } = await fixture(t);
  const failure = new helper.PrivateJsonFileError("OpenProcessToken", 5);
  const { api, calls } = fakeWindows({ descriptorError: failure });
  await assert.rejects(create(file, document, { platform: "win32", nativeReader: async () => api }), error => error === failure);
  assert.deepEqual(calls, ["descriptor"]);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test("Windows write failure closes/unlinks the owned file and preserves the failure", async (t) => {
  const create = writer();
  const { file } = await fixture(t);
  const failure = new helper.PrivateJsonFileError("WriteFile", 112);
  const { api, calls } = fakeWindows({ writeError: failure });
  await assert.rejects(create(file, document, { platform: "win32", nativeReader: async () => api }), error => error === failure);
  assert.equal(calls.filter(call => call === "close").length, 1);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test("Windows zero-progress writes fail instead of returning a readable lease", async (t) => {
  const create = writer();
  const { file } = await fixture(t);
  const { api, calls } = fakeWindows();
  api.write = () => 0;
  await assert.rejects(create(file, document, { platform: "win32", nativeReader: async () => api }), { code: "INVALID_BYTE_COUNT" });
  assert.equal(calls.filter(call => call === "close").length, 1);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test("Windows cleanup never unlinks a foreign reuse of the request name", async (t) => {
  const create = writer();
  const { file } = await fixture(t);
  const { api } = fakeWindows();
  const closeOwned = api.close;
  api.close = handle => {
    closeOwned(handle);
    if (existsSync(file)) unlinkSync(file);
    writeFileSync(file, "foreign replacement");
  };
  const lease = await create(file, document, { platform: "win32", nativeReader: async () => api });
  await lease.dispose();
  assert.equal(await fs.readFile(file, "utf8"), "foreign replacement");
});
