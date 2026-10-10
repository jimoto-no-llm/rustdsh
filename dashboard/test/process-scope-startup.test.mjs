import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnOwnedProcess } from "../process-scope.mjs";

test("startup timeout waits for the exact monitor to exit before rejecting", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-monitor-start-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const delayedImport = path.join(root, "delayed-import.mjs");
  await fs.writeFile(
    delayedImport,
    "await new Promise((resolve) => setTimeout(resolve, 300));\n",
  );
  const previousOptions = process.env.NODE_OPTIONS,
    started = Date.now();
  process.env.NODE_OPTIONS = [
    previousOptions,
    "--import=" + pathToFileURL(delayedImport).href,
  ]
    .filter(Boolean)
    .join(" ");
  let pending;
  try {
    pending = spawnOwnedProcess({
      command: [process.execPath, "-e", "process.exit(80)"],
      cwd: root,
      startupTimeoutMs: 75,
    });
  } finally {
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousOptions;
  }
  await assert.rejects(
    pending,
    (error) =>
      ["ownership_unavailable", "cleanup_unconfirmed"].includes(error.code),
  );
  assert(
    Date.now() - started >= 250,
    "startup rejection must wait for the delayed monitor process to exit",
  );
});

test("forced monitor termination stays unconfirmed without an owned-scope receipt", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-monitor-stuck-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const delayedImport = path.join(root, "stuck-import.mjs");
  await fs.writeFile(
    delayedImport,
    "process.on('SIGTERM', () => {});\n" +
      "await new Promise((resolve) => setTimeout(resolve, 10000));\n",
  );
  const previousOptions = process.env.NODE_OPTIONS,
    started = Date.now();
  process.env.NODE_OPTIONS = [
    previousOptions,
    "--import=" + pathToFileURL(delayedImport).href,
  ]
    .filter(Boolean)
    .join(" ");
  let pending;
  try {
    pending = spawnOwnedProcess({
      command: [process.execPath, "-e", "process.exit(80)"],
      cwd: root,
      startupTimeoutMs: 75,
    });
  } finally {
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousOptions;
  }
  await assert.rejects(
    pending,
    (error) => error.code === "cleanup_unconfirmed",
  );
  const elapsed = Date.now() - started;
  assert(
    elapsed >= 4900,
    "the supervisor gets a bounded graceful cleanup window",
  );
  assert(elapsed < 8000, "startup cancellation remains bounded");
});
