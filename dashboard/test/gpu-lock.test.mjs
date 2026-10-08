import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gpuDirectory, lockGpuLedger } from "../gpu-lock.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-gpu-path-long-name-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("rdsh-gpu-path-long-name-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test("canonical GPU state directories accept spaces and Unicode", async (t) => {
  const root = await fixture(t);
  const home = path.join(root, "GPU state \u4e88\u7d04");
  await gpuDirectory(home);
  const unlock = await lockGpuLedger(path.join(home, "leases.lock"));
  await unlock();
  assert((await fs.stat(home)).isDirectory());
});

test("GPU state directories reject a directory link and a redirected ancestor", async (t) => {
  const root = await fixture(t);
  const target = path.join(root, "target"),
    link = path.join(root, "redirected");
  await fs.mkdir(path.join(target, "existing-state"), { recursive: true });
  await fs.symlink(
    target,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const directory of [link, path.join(link, "existing-state")]) {
    await assert.rejects(gpuDirectory(directory), {
      code: "gpu_directory_untrusted",
    });
    await assert.rejects(lockGpuLedger(path.join(directory, "leases.lock")), {
      code: "gpu_directory_untrusted",
    });
  }
  await assert.rejects(fs.access(path.join(target, "leases.lock")), {
    code: "ENOENT",
  });
  await assert.rejects(
    fs.access(path.join(target, "existing-state", "leases.lock")),
    { code: "ENOENT" },
  );
});

test(
  "Windows 8.3 and long paths share one kernel lock without permitting junctions",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await fixture(t);
    const { default: koffi } = await import("koffi");
    const shortPath = koffi
      .load("kernel32.dll")
      .func(
        "uint32_t __stdcall GetShortPathNameW(str16 path, void *buffer, uint32_t size)",
      );
    const buffer = Buffer.alloc(65536);
    const length = shortPath(
      path.toNamespacedPath(root),
      buffer,
      buffer.length / 2,
    );
    assert(length > 0 && length < buffer.length / 2);
    const short = buffer.toString("utf16le", 0, length * 2);
    const real = path.toNamespacedPath(await fs.realpath(root));
    if (short.toLowerCase() === real.toLowerCase()) {
      t.skip("The fixture volume does not provide an 8.3 alias");
      return;
    }
    assert.equal((await fs.lstat(short)).isSymbolicLink(), false);
    // This is a real filesystem alias, including any short-named ancestors from
    // os.tmpdir(); no mocked path or native API supplies the acceptance proof.
    await gpuDirectory(short);
    const longFile = path.join(root, "leases.lock"),
      shortFile = path.join(short, "leases.lock");
    const unlock = await lockGpuLedger(longFile);
    try {
      await assert.rejects(lockGpuLedger(shortFile, 100), {
        code: "gpu_ledger_busy",
      });
    } finally {
      await unlock();
    }
    const unlockAlias = await lockGpuLedger(shortFile);
    await unlockAlias();
    assert.equal((await fs.stat(longFile)).ino, (await fs.stat(shortFile)).ino);

    const target = path.join(root, "junction target");
    await fs.mkdir(path.join(target, "existing-state"), { recursive: true });
    const link = path.join(short, "junction");
    await fs.symlink(target, link, "junction");
    await assert.rejects(gpuDirectory(path.join(link, "existing-state")), {
      code: "gpu_directory_untrusted",
    });
  },
);
