// A persistent kernel-locked file, never a TTL/unlink-based lock. A crashed
// writer loses its OS handle without letting two reclaimers delete a new lock.
import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { GpuError } from "./gpu-telemetry.mjs";

let api;
async function bindings() {
  if (api) return api;
  const { default: koffi } = await import("koffi");
  if (process.platform === "win32") {
    const lib = koffi.load("kernel32.dll");
    api = {
      open: lib.func(
        "uintptr_t __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, void *templateFile)",
      ),
      error: lib.func("uint32_t __stdcall GetLastError()"),
      close: lib.func("int __stdcall CloseHandle(uintptr_t handle)"),
      longPath: lib.func(
        "uint32_t __stdcall GetLongPathNameW(str16 name, void *buffer, uint32_t size)",
      ),
      attributes: lib.func("uint32_t __stdcall GetFileAttributesW(str16 name)"),
    };
  } else if (process.platform === "linux") {
    const lib = koffi.load("libc.so.6");
    const errno = lib.func("int *__errno_location(void)");
    api = {
      flock: lib.func("int flock(int fd, int operation)"),
      error: () => koffi.decode(errno(), "int"),
    };
  } else throw new GpuError("gpu_lock_platform_unsupported");
  return api;
}
async function windowsLongDirectory(directory) {
  const native = await bindings();
  // A short name is an alias, not a redirect. Reject actual reparse points in
  // every ancestor before expanding aliases; checking only the leaf permits
  // a junction farther up the path to redirect ledger writes.
  for (let cursor = directory; ; ) {
    // Preserve an already namespaced drive root: toNamespacedPath can remove
    // its final separator, producing an invalid native attribute query.
    const attributes = native.attributes(
      cursor.startsWith("\\\\?\\") ? cursor : path.toNamespacedPath(cursor),
    );
    if (attributes === 0xffffffff || attributes & 0x400)
      throw new GpuError("gpu_directory_untrusted");
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const buffer = Buffer.alloc(65536);
  const length = native.longPath(
    path.toNamespacedPath(directory),
    buffer,
    buffer.length / 2,
  );
  if (length === 0 || length >= buffer.length / 2)
    throw new GpuError("gpu_directory_untrusted");
  return buffer.toString("utf16le", 0, length * 2);
}
export async function gpuDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  const real = path.resolve(await fs.realpath(directory)),
    requested = path.resolve(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform === "win32"
      ? path.toNamespacedPath(real).toLowerCase() !==
        (await windowsLongDirectory(requested)).toLowerCase()
      : real !== requested)
  )
    throw new GpuError("gpu_directory_untrusted");
}
async function regular(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new GpuError("gpu_lock_file_invalid");
    return stat;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export async function lockGpuLedger(file, timeout = 10000) {
  await gpuDirectory(path.dirname(file));
  const native = await bindings();
  const end = performance.now() + timeout;
  while (true) {
    await regular(file);
    if (process.platform === "win32") {
      // No share access, no inheritance, no truncate/delete-on-close, and no
      // final reparse-point traversal. The file remains after handle close.
      const handle = native.open(
        path.toNamespacedPath(file),
        0xc0000000,
        0,
        null,
        4,
        0x00200080,
        null,
      );
      if (BigInt.asUintN(64, BigInt(handle)) !== 0xffffffffffffffffn) {
        try {
          await regular(file);
        } catch (error) {
          native.close(handle);
          throw error;
        }
        return async () => {
          if (!native.close(handle))
            throw new GpuError("gpu_lock_close_failed");
        };
      }
      if (![32, 33].includes(native.error()))
        throw new GpuError("gpu_lock_unavailable");
    } else {
      const handle = await fs.open(
        file,
        constants.O_CREAT |
          constants.O_RDWR |
          (constants.O_NOFOLLOW || 0) |
          (constants.O_NONBLOCK || 0),
        0o600,
      );
      try {
        const held = await handle.stat(),
          current = await regular(file);
        if (
          !current ||
          held.ino !== current.ino ||
          held.dev !== current.dev ||
          !held.isFile()
        )
          throw new GpuError("gpu_lock_file_invalid");
        if (native.flock(handle.fd, 2 | 4) === 0) return () => handle.close();
        if (native.error() !== 11) throw new GpuError("gpu_lock_unavailable");
      } catch (error) {
        await handle.close();
        throw error;
      }
      await handle.close();
    }
    if (performance.now() >= end) throw new GpuError("gpu_ledger_busy");
    await delay(25);
  }
}
