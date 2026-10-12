import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRdshBin } from "../index.js";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

// Only the listed paths "exist"; the real filesystem is never consulted.
function found(...paths) {
  const set = new Set(paths);
  return (path) => set.has(path);
}

test("RDSH_BIN wins over PATH and the well-known locations", () => {
  const env = { RDSH_BIN: "/opt/rdsh/bin/rdsh", PATH: "/usr/bin", HOME: "/home/u" };
  assert.equal(resolveRdshBin(env, "linux", () => true), "/opt/rdsh/bin/rdsh");
});

test("empty RDSH_BIN is ignored", () => {
  const env = { RDSH_BIN: "   ", PATH: "/usr/bin", HOME: "/home/u" };
  assert.equal(resolveRdshBin(env, "linux", found("/usr/local/bin/rdsh")), "/usr/local/bin/rdsh");
});

test("PATH hit returns the bare name before any well-known location", () => {
  const env = { PATH: "/opt/bin:/usr/bin", HOME: "/home/u" };
  // Both exist; the PATH hit must win, so the bare name is returned.
  assert.equal(resolveRdshBin(env, "linux", found(join("/opt/bin", "rdsh"), "/usr/local/bin/rdsh")), "rdsh");
});

test("well-known install locations are searched in order", () => {
  const env = { PATH: "/usr/bin", HOME: "/home/u" };
  assert.equal(resolveRdshBin(env, "linux", found("/home/u/.local/bin/rdsh")), "/home/u/.local/bin/rdsh");
  assert.equal(resolveRdshBin(env, "linux", found("/usr/local/bin/rdsh")), "/usr/local/bin/rdsh");
  assert.equal(resolveRdshBin(env, "linux", found("/home/u/.cargo/bin/rdsh")), "/home/u/.cargo/bin/rdsh");
});

test("nothing found falls back to the historical bare name", () => {
  assert.equal(resolveRdshBin({ PATH: "/usr/bin", HOME: "/home/u" }, "linux", () => false), "rdsh");
  assert.equal(resolveRdshBin({ PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\u" }, "win32", () => false), "rdsh");
});

test("win32 searches PATH, LOCALAPPDATA, USERPROFILE and CARGO_HOME", () => {
  const env = {
    PATH: "C:\\bin",
    USERPROFILE: "C:\\Users\\u",
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    CARGO_HOME: "C:\\cargo",
  };
  const exe = join("C:\\Users\\u\\AppData\\Local", "rdsh", "bin", "rdsh.exe");
  const cargo = join("C:\\cargo", "bin", "rdsh.exe");
  const home = join("C:\\Users\\u", ".local", "bin", "rdsh.exe");
  const onPath = join("C:\\bin", "rdsh.exe");
  assert.equal(resolveRdshBin(env, "win32", found(onPath)), "rdsh"); // spawn() resolves .exe via PATHEXT
  assert.equal(resolveRdshBin(env, "win32", found(exe, cargo, home)), exe);
  assert.equal(resolveRdshBin(env, "win32", found(home, cargo)), home);
  assert.equal(resolveRdshBin(env, "win32", found(cargo)), cargo);
  // Without CARGO_HOME the Cargo bin falls back to %USERPROFILE%\.cargo.
  const noCargoHome = { ...env, CARGO_HOME: "" };
  const fallbackCargo = join("C:\\Users\\u", ".cargo", "bin", "rdsh.exe");
  assert.equal(resolveRdshBin(noCargoHome, "win32", found(fallbackCargo)), fallbackCargo);
});

test("package.json declares the DSH bundle patch and the target file exists", () => {
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  const patch = manifest.dsh?.bundle?.patch;
  assert.equal(patch, "./cordis.patch.yml");
  // A profile can only enable the package when the referenced file is present.
  assert.equal(existsSync(join(dirname(packagePath), patch)), true);
});
