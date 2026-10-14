import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { policyResults } from "../worker-scopes.mjs";

test("native policy accepts 4096 shared paths and the legacy path handles 4097", async (t) => {
  const previous = process.env.RDSH_BIN;
  const executable = path.join(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    "target",
    "debug",
    process.platform === "win32" ? "rdsh.exe" : "rdsh",
  );
  try {
    try {
      await fs.access(executable);
    } catch {
      t.skip("build target/debug/rdsh before running the worker-scope boundary test");
      return;
    }

    process.env.RDSH_BIN = executable;
    const withinLimit = policyResults({
      shared_files: Array(4096).fill("Cargo.lock"),
    });
    assert.equal(withinLimit.shared_files.length, 4096);
    assert.ok(withinLimit.shared_files.every(Boolean));

    // The Rust helper caps these arrays at 4096; the JS compatibility path
    // must preserve behavior when a repository has more changed paths.
    process.env.RDSH_BIN = path.join(
      os.tmpdir(),
      `missing-rdsh-worker-scope-${process.pid}-${Date.now()}`,
    );
    const result = policyResults({
      shared_files: Array(4097).fill("Cargo.lock"),
    });
    assert.equal(result.shared_files.length, 4097);
    assert.ok(result.shared_files.every(Boolean));
  } finally {
    if (previous === undefined) delete process.env.RDSH_BIN;
    else process.env.RDSH_BIN = previous;
  }
});

test("an explicitly configured missing helper remains an error within the native limit", () => {
  const previous = process.env.RDSH_BIN;
  process.env.RDSH_BIN = path.join(
    os.tmpdir(),
    `missing-rdsh-worker-scope-${process.pid}-${Date.now()}`,
  );
  try {
    assert.throws(
      () => policyResults({ shared_files: ["Cargo.lock"] }),
      (error) => error.code === "native_worker_policy_unavailable",
    );
  } finally {
    if (previous === undefined) delete process.env.RDSH_BIN;
    else process.env.RDSH_BIN = previous;
  }
});

test("automatic helper discovery skips an executable without worker-scope", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-worker-probe-"));
  const previousBin = process.env.RDSH_BIN;
  const previousPath = process.env.PATH;
  try {
    const dashboard = path.join(root, "dashboard");
    const helperDirectory = path.join(root, "target", "debug");
    await fs.mkdir(dashboard, { recursive: true });
    await fs.mkdir(helperDirectory, { recursive: true });
    const modulePath = path.join(dashboard, "worker-scopes.mjs");
    await fs.copyFile(new URL("../worker-scopes.mjs", import.meta.url), modulePath);

    const helper = path.join(
      helperDirectory,
      process.platform === "win32" ? "rdsh.exe" : "rdsh",
    );
    try {
      await fs.symlink(
        process.execPath,
        helper,
        process.platform === "win32" ? "file" : undefined,
      );
    } catch {
      await fs.link(process.execPath, helper);
    }

    delete process.env.RDSH_BIN;
    process.env.PATH = "";
    const isolatedModule = await import(
      `${pathToFileURL(modulePath).href}?old-helper-${Date.now()}`
    );
    assert.deepEqual(isolatedModule.policyResults({ shared_files: ["Cargo.lock"] }), {
      write_checks: [],
      intersections: [],
      shared_files: [true],
    });
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES" || error.code === "EXDEV") {
      t.skip(`cannot create a portable helper fixture: ${error.code}`);
      return;
    }
    throw error;
  } finally {
    if (previousBin === undefined) delete process.env.RDSH_BIN;
    else process.env.RDSH_BIN = previousBin;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
